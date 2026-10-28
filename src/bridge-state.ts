import { ResponsePolicyStore } from './response-policy-store.js';
import { DurableObject } from 'cloudflare:workers';
import { TYPING_PREFIX, TYPING_GLOBAL_KEY, TYPING_TIMEOUT_MS, TYPING_LEASE_MS, triggerTyping, type TypingChannel } from './typing.js';
import {
  MENTION_EVENT_NAME,
  canonicalJson,
  toMentionEvent,
  type EventSubscription,
  type EventAuthorizationReference,
  type EventSubscriptionIdentity,
} from './events.js';
import { DiscordGatewayProtocol, type GatewayCommand, type GatewaySession } from './gateway.js';
import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';
import { postSignedEvent, retryDelayMs, validateCallbackUrl } from './mcp-events.js';
import {
  ingestMention,
  type OriginStore,
  type MentionRecoveryStore,
  type ReplyState,
  type ChannelAccessStore,
  type MemberAuthorizationFailureReason,
  type MemberAuthorizationResult,
  type StandaloneMessageState,
  type StandaloneMessageStore,
} from './origin-store.js';
import {
  applyAuthorizationMutation,
  emptyDiscordAuthorization,
  hasDiscordAccess,
  isAllowedOrigin,
  isDiscordAuthorization,
  type AuthorizationMutation,
  type DiscordAuthorization,
  type GatewayMentionCandidate,
  type OriginMessage,
} from './policy.js';
import { secureWebhookFetch } from './secure-webhook-fetch.js';
import { canonicalIssuer } from './issuer.js';
import type { EventSubscriptionInput } from './mcp-events.js';
import {
  isLinkedDiscordAccount,
  selectableDiscordRoles,
  type DiscordGuildCandidate,
  type DiscordRoleOption,
  type LinkedDiscordAccount,
} from './discord-account.js';
import type { Env } from './types.js';
import { logSubscriptionDiagnostic, type SubscriptionPhase } from './subscription-diagnostics.js';

interface PendingDelivery {
  subscriptionId: string;
  event: ReturnType<typeof toMentionEvent>;
  attempts: number;
  nextAttemptAt: number;
}

export interface AdminRuntimeStatus {
  state: 'idle' | 'connecting' | 'connected' | 'unavailable';
  activeSubscriptions: number | null;
}

interface OAuthTokenRecord {
  id?: string;
  userId?: string;
  grantId?: string;
  expiresAt?: number;
  audience?: string | string[];
  scope?: string[];
  grant?: { clientId?: string; scope?: string[] };
}

const SESSION_KEY = 'gateway:session';
const GATEWAY_ALARM_KEY = 'gateway:next-alarm-at';
const SUBSCRIPTION_PREFIX = 'subscription:';
const DELIVERY_PREFIX = 'delivery:';
const CALLBACK_PREFIX = 'callback-verified:';
const RECOVERY_CURSOR_KEY = 'recovery:cursor-key';
const AUTHORIZATION_KEY = 'discord:authorization';
const DISCORD_ROLE_NAMES_KEY = 'discord:role-names';
const DISCORD_OAUTH_STATE_KEY = 'discord:oauth-state';
const DISCORD_LINK_KEY_PREFIX = 'discord:linked-account:';
const OUTBOUND_MESSAGE_PREFIX = 'outbound-message:';
const DISCORD_GUILD_NAMES_KEY = 'discord:guild-names';
const DISCORD_OAUTH_STATE_TTL_MS = 10 * 60_000;
const DISCORD_GUILD_CANDIDATE_TTL_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 6;
const MAX_DELIVERIES_PER_ALARM = 20;
const RECOVERY_SCAN_BUDGET_MS = 5_000;
const ORIGIN_TTL_MS = 7 * 24 * 60 * 60_000;
const MEMBER_LOOKUP_MAX_RETRIES = 1;
const MEMBER_LOOKUP_MAX_RETRY_DELAY_MS = 1_000;

interface StoredOrigin extends OriginMessage {
  expiresAt: number;
  recipients?: Array<{ id: string; recoveryId: string }>;
  reply?: ReplyState;
}

interface StandaloneMessageRecord {
  channelId: string;
  requestHash: string;
  nonce: string;
  status: 'message_started' | 'sent';
  messageId?: string;
}

export interface BridgeStateRuntime {
  fetch?: typeof fetch;
  discordFetch?: typeof fetch;
  gatewayUrl?: (token: string) => Promise<string>;
  now?: () => number;
  webSocket?: (url: string) => WebSocket;
}

/** Owns the single Discord Gateway session, validated origins, and durable event outbox. */
export class BridgeStateDO extends DurableObject<Env> implements OriginStore, MentionRecoveryStore, ChannelAccessStore, StandaloneMessageStore {
  private typingWork: Promise<void> | null = null;
  private gatewaySocket: WebSocket | null = null;
  private gatewayProtocol: DiscordGatewayProtocol | null = null;
  private readonly webhookFetch: typeof fetch;
  private readonly discordFetch: typeof fetch;
  private readonly gatewayUrl: (token: string) => Promise<string>;
  private readonly now: () => number;
  private readonly webSocket: (url: string) => WebSocket;

  constructor(ctx: DurableObjectState, env: Env, runtime: BridgeStateRuntime = {}) {
    super(ctx, env);
    this.webhookFetch = runtime.fetch ?? secureWebhookFetch;
    this.discordFetch = runtime.discordFetch ?? fetch;
    this.gatewayUrl = runtime.gatewayUrl ?? fetchDiscordGatewayUrl;
    this.now = runtime.now ?? Date.now;
    this.webSocket = runtime.webSocket ?? ((url) => new WebSocket(url));
  }

  async getResponsePolicy(ownerEmail: string) {
    this.assertAdminOwner(ownerEmail);
    return new ResponsePolicyStore(this.ctx.storage, this.now).current();
  }

  async listResponsePolicyRevisions(ownerEmail: string, beforeRevision?: number) {
    this.assertAdminOwner(ownerEmail);
    return new ResponsePolicyStore(this.ctx.storage, this.now).history(beforeRevision);
  }

  async updateResponsePolicy(ownerEmail: string, expectedRevision: number, markdown: string, via: 'admin' | 'mcp') {
    this.assertAdminOwner(ownerEmail);
    return new ResponsePolicyStore(this.ctx.storage, this.now).update(expectedRevision, markdown, via);
  }

  async rollbackResponsePolicy(ownerEmail: string, expectedRevision: number, revision: number, via: 'admin' | 'mcp') {
    this.assertAdminOwner(ownerEmail);
    return new ResponsePolicyStore(this.ctx.storage, this.now).rollback(expectedRevision, revision, via);
  }

  async recordMention(candidate: GatewayMentionCandidate) {
    return ingestMention(candidate, this.env.DISCORD_BOT_USER_ID, this);
  }

  async recordOriginOnce(origin: OriginMessage): Promise<'accepted' | 'duplicate' | 'rejected'> {
    if (!isAllowedOrigin(origin, this.env.DISCORD_BOT_USER_ID)) return 'rejected';
    const config = await this.getDiscordAuthorization();
    if (!config.guilds[origin.guildId]) return 'rejected';
    const member = await this.getCurrentMemberRoles(origin.guildId, origin.authorId);
    if (member.status !== 'member' || !hasDiscordAccess(config, origin.guildId, origin.authorId, member.roleIds)) {
      return 'rejected';
    }

    const originKey = `origin:${origin.eventId}`;
    const now = this.now();
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const current = decodeDiscordAuthorization(await transaction.get<unknown>(AUTHORIZATION_KEY));
      if (!hasDiscordAccess(current, origin.guildId, origin.authorId, member.roleIds)) return 'rejected' as const;
      if (await transaction.get<OriginMessage>(originKey)) return false;
      if (!await transaction.get(RECOVERY_CURSOR_KEY)) {
        await transaction.put(RECOVERY_CURSOR_KEY, crypto.getRandomValues(new Uint8Array(32)));
      }
      const recipients: NonNullable<StoredOrigin['recipients']> = [];
      const subscriptions = await transaction.list<EventSubscription>({ prefix: SUBSCRIPTION_PREFIX });
      const event = toMentionEvent(origin);
      for (const subscription of subscriptions.values()) {
        if (subscription.name !== MENTION_EVENT_NAME || Date.parse(subscription.refreshBefore) <= now) continue;
        // Existing subscriptions gain recovery ownership on their next accepted mention.
        subscription.recoveryId ??= crypto.randomUUID();
        await transaction.put(`${SUBSCRIPTION_PREFIX}${subscription.id}`, subscription);
        recipients.push({ id: subscription.id, recoveryId: subscription.recoveryId });
        const key = deliveryKey(subscription.id, event.eventId);
        await transaction.put<PendingDelivery>(key, {
          subscriptionId: subscription.id,
          event,
          attempts: 0,
          nextAttemptAt: now + 1_000,
        });
      }
      await transaction.put<StoredOrigin>(originKey, { ...origin, expiresAt: now + ORIGIN_TTL_MS, recipients });
      if (recipients.length) {
        const key = `${TYPING_PREFIX}${origin.channelId}`;
        const typing = await transaction.get<TypingChannel>(key) ?? { events: {}, nextAttemptAt: now, failures: 0 };
        typing.events[origin.eventId] = now + TYPING_TIMEOUT_MS;
        await transaction.put(key, typing);
      }
      return 'accepted' as const;
    });
    if (result === 'accepted') {
      await this.scheduleNextWake();
      this.startTypingWork();
    }
    return result === false ? 'duplicate' : result;
  }

  async getOrigin(eventId: string): Promise<OriginMessage | null> {
    if (!/^\d{17,20}$/.test(eventId)) return null;
    const stored = await this.ctx.storage.get<StoredOrigin>(`origin:${eventId}`);
    if (!stored || typeof stored.expiresAt !== 'number' || stored.expiresAt <= this.now()) {
      if (stored) await this.ctx.storage.delete(`origin:${eventId}`);
      return null;
    }
    const { expiresAt: _expiresAt, recipients: _recipients, reply: _reply, ...origin } = stored;
    const status = await this.checkOriginAuthorization(origin);
    if (status !== 'authorized') {
      if (status === 'revoked') await this.removeOriginAndDeliveries(eventId);
      return null;
    }
    return origin;
  }

  async isOriginAuthorized(origin: OriginMessage): Promise<boolean> {
    const stored = await this.ctx.storage.get<StoredOrigin>(`origin:${origin.eventId}`);
    if (!stored || stored.expiresAt <= this.now() || !sameOrigin(stored, origin)) return false;
    const status = await this.checkOriginAuthorization(origin);
    if (status === 'revoked') await this.removeOriginAndDeliveries(origin.eventId);
    return status === 'authorized';
  }

  async listPendingMentions(
    principal: string,
    authorization: EventAuthorizationReference,
    limit: number,
    cursor?: string,
  ): ReturnType<MentionRecoveryStore['listPendingMentions']> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (cursor !== undefined && cursor.length > 200)) {
      throw new TypeError('Invalid recovery page.');
    }
    const deadline = this.now() + RECOVERY_SCAN_BUDGET_MS;
    const material = await this.ctx.storage.get<Uint8Array>(RECOVERY_CURSOR_KEY);
    if (!material) return { events: [], nextCursor: null };
    const access = canonicalJson({ principal, ...authorization });
    const after = cursor ? await recoveryCursor(cursor, material, access, false) : undefined;
    const entries = await this.ctx.storage.list<StoredOrigin>({
      prefix: 'origin:', limit, ...(after ? { startAfter: `origin:${after}` } : {}),
    });
    const events: Awaited<ReturnType<MentionRecoveryStore['listPendingMentions']>>['events'] = [];
    let scanned = 0;
    let lastEventId: string | undefined;
    for (const stored of entries.values()) {
      // Finish the current check, then paginate rather than accumulating slow member requests.
      if (scanned > 0 && this.now() >= deadline) break;
      scanned += 1;
      lastEventId = stored.eventId;
      if (stored.expiresAt <= this.now() || stored.reply?.status === 'replied' || !stored.recipients?.length) continue;
      if (!await this.canRecover(stored, principal, authorization)) continue;
      // Use the same live guild/member checks as origin reads; do not consume the event.
      const origin = await this.getOrigin(stored.eventId);
      if (!origin || !await this.canRecover(stored, principal, authorization)) continue;
      const current = await this.ctx.storage.get<StoredOrigin>(`origin:${stored.eventId}`);
      if (!current || current.expiresAt <= this.now() || current.reply?.status === 'replied') continue;
      events.push({ eventId: origin.eventId, messageId: origin.messageId, timestamp: origin.timestamp,
        status: current.reply?.status ?? 'pending' });
    }
    return { events, nextCursor: lastEventId && (scanned < entries.size || entries.size === limit)
      ? await recoveryCursor(lastEventId, material, access, true) : null };
  }

  private async canRecover(stored: StoredOrigin, principal: string, authorization: EventAuthorizationReference): Promise<boolean> {
    for (const recipient of stored.recipients ?? []) {
      const subscription = await this.ctx.storage.get<EventSubscription>(`${SUBSCRIPTION_PREFIX}${recipient.id}`);
      const access = subscription?.authorization;
      if (subscription?.principal === principal && subscription.recoveryId === recipient.recoveryId && access &&
          access.grantId === authorization.grantId && access.clientId === authorization.clientId &&
          access.audience === authorization.audience && Date.parse(subscription.refreshBefore) > this.now() &&
          await this.isSubscriptionAuthorized(subscription)) return true;
    }
    return false;
  }

  async beginReply(origin: OriginMessage): Promise<ReplyState | null> {
    if (!await this.isOriginAuthorized(origin)) throw new TypeError('Origin is no longer authorized.');
    return this.ctx.storage.transaction(async (transaction) => {
      const key = `origin:${origin.eventId}`;
      const stored = await transaction.get<StoredOrigin>(key);
      if (!stored || stored.expiresAt <= this.now() || !sameOrigin(stored, origin)) throw new TypeError('Origin is unavailable.');
      if (stored.reply) return stored.reply;
      // Reserve before the external send; an ambiguous outcome must never trigger another send.
      await transaction.put(key, { ...stored, reply: { status: 'reply_started' } });
      return null;
    });
  }

  async completeReply(origin: OriginMessage, replyMessageId: string): Promise<void> {
    if (!/^\d{17,20}$/.test(replyMessageId)) throw new TypeError('Invalid reply ID.');
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `origin:${origin.eventId}`;
      const stored = await transaction.get<StoredOrigin>(key);
      if (!stored || stored.expiresAt <= this.now() || !sameOrigin(stored, origin)) {
        throw new TypeError('Reply completion could not be persisted for this origin.');
      }
      if (stored.reply?.status === 'replied' && stored.reply.replyMessageId === replyMessageId) return;
      if (stored.reply?.status !== 'reply_started') throw new TypeError('Reply reservation is unavailable or already completed.');
      await transaction.put(key, { ...stored, reply: { status: 'replied', replyMessageId } });
    });
  }

  async isChannelAuthorized(ownerEmail: string, guildId: string): Promise<boolean> {
    this.assertAdminOwner(ownerEmail);
    if (!/^\d{17,20}$/.test(guildId)) return false;
    const link = await this.getLinkedDiscordAccount(ownerEmail);
    if (!link) return false;
    const first = await this.getCurrentMemberRoles(guildId, link.userId);
    if (first.status === 'unavailable') throw new Error('Current Discord membership could not be verified.');
    if (first.status === 'revoked') return false;
    const current = await this.getDiscordAuthorization();
    if (!current.guilds[guildId] || !hasDiscordAccess(current, guildId, link.userId, first.roleIds)) return false;
    const latest = await this.getLinkedDiscordAccount(ownerEmail);
    if (!latest || latest.userId !== link.userId) return false;
    const second = await this.getCurrentMemberRoles(guildId, latest.userId);
    if (second.status === 'unavailable') throw new Error('Current Discord membership could not be verified.');
    if (second.status === 'revoked') return false;
    const finalAuthorization = await this.getDiscordAuthorization();
    return Boolean(finalAuthorization.guilds[guildId] &&
      hasDiscordAccess(finalAuthorization, guildId, latest.userId, second.roleIds));
  }

  async isAuthorizedMember(guildId: string, userId: string): Promise<MemberAuthorizationResult> {
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(userId)) return { status: 'denied' };
    let initial: DiscordAuthorization;
    try {
      initial = await this.getDiscordAuthorization();
    } catch {
      return { status: 'unavailable', reason: 'member_access_storage_error' };
    }
    if (!initial.guilds[guildId]) return { status: 'denied' };
    const member = await this.getCurrentMemberRoles(guildId, userId);
    if (member.status === 'unavailable') return member;
    if (member.status === 'revoked') return { status: 'denied' };
    let latest: DiscordAuthorization;
    try {
      latest = await this.getDiscordAuthorization();
    } catch {
      return { status: 'unavailable', reason: 'member_access_storage_error' };
    }
    return latest.guilds[guildId] && hasDiscordAccess(latest, guildId, userId, member.roleIds)
      ? { status: 'authorized' }
      : { status: 'denied' };
  }

  async beginStandaloneMessage(
    ownerEmail: string,
    idempotencyKey: string,
    channelId: string,
    requestHash: string,
    nonce: string,
  ): Promise<StandaloneMessageState> {
    this.assertAdminOwner(ownerEmail);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128 ||
        !/^\d{17,20}$/.test(channelId) || !/^[a-f0-9]{64}$/.test(requestHash) ||
        typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 25) {
      throw new TypeError('Standalone message reservation is invalid.');
    }
    const key = `${OUTBOUND_MESSAGE_PREFIX}${await hashKey(`${ownerEmail}\n${idempotencyKey}`)}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(key);
      if (current !== undefined) {
        if (!isStandaloneMessageRecord(current) || current.channelId !== channelId || current.requestHash !== requestHash || current.nonce !== nonce) {
          throw new TypeError('This idempotency key was already used for a different message.');
        }
        return current.status === 'sent'
          ? { status: 'sent', messageId: current.messageId! }
          : { status: 'message_started' };
      }
      await transaction.put(key, { channelId, requestHash, nonce, status: 'message_started' });
      return { status: 'new' };
    });
  }

  async completeStandaloneMessage(
    ownerEmail: string,
    idempotencyKey: string,
    channelId: string,
    requestHash: string,
    messageId: string,
  ): Promise<void> {
    this.assertAdminOwner(ownerEmail);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128 ||
        !/^\d{17,20}$/.test(channelId) || !/^[a-f0-9]{64}$/.test(requestHash) || !/^\d{17,20}$/.test(messageId)) {
      throw new TypeError('Standalone message receipt is invalid.');
    }
    const key = `${OUTBOUND_MESSAGE_PREFIX}${await hashKey(`${ownerEmail}\n${idempotencyKey}`)}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(key);
      if (!isStandaloneMessageRecord(current) || current.channelId !== channelId || current.requestHash !== requestHash) {
        throw new TypeError('Standalone message reservation is unavailable.');
      }
      if (current.status === 'sent') {
        if (current.messageId !== messageId) throw new TypeError('Standalone message receipt conflicts with a previous result.');
        return;
      }
      await transaction.put(key, { ...current, status: 'sent', messageId });
    });
  }

  async getDiscordAuthorization(): Promise<DiscordAuthorization> {
    return decodeDiscordAuthorization(await this.ctx.storage.get<unknown>(AUTHORIZATION_KEY));
  }

  async getAdminRuntimeStatus(ownerEmail: string, now: number): Promise<AdminRuntimeStatus> {
    this.assertAdminOwner(ownerEmail);
    if (!Number.isFinite(now)) throw new TypeError('Runtime status time is invalid.');
    const subscriptions = await this.ctx.storage.list<EventSubscription>({ prefix: SUBSCRIPTION_PREFIX });
    const unexpired = [...subscriptions.values()].filter((item) => Date.parse(item.refreshBefore) > now);
    if (!unexpired.length) return { state: 'idle', activeSubscriptions: 0 };
    if (!this.env.OAUTH_KV || !canonicalIssuer(this.env.MCP_ISSUER_URL) || !this.env.ACCESS_OWNER_EMAIL?.trim()) {
      return { state: 'unavailable', activeSubscriptions: null };
    }

    let activeSubscriptions = 0;
    try {
      for (const subscription of unexpired) {
        if (await this.isSubscriptionAuthorized(subscription)) activeSubscriptions += 1;
      }
    } catch {
      return { state: 'unavailable', activeSubscriptions: null };
    }
    if (!activeSubscriptions) return { state: 'idle', activeSubscriptions: 0 };
    if (this.gatewaySocket?.readyState === 1 && this.gatewayProtocol?.isReady === true) {
      return { state: 'connected', activeSubscriptions };
    }
    if (!this.env.DISCORD_BOT_TOKEN?.trim() || await this.ctx.storage.get<number>('gateway:terminal-close-code')) {
      return { state: 'unavailable', activeSubscriptions };
    }
    return { state: 'connecting', activeSubscriptions };
  }

  async getDiscordRoleNames(ownerEmail: string): Promise<Record<string, Record<string, string>>> {
    this.assertAdminOwner(ownerEmail);
    const [authorization, stored] = await Promise.all([
      this.getDiscordAuthorization(),
      this.ctx.storage.get<unknown>(DISCORD_ROLE_NAMES_KEY),
    ]);
    if (stored === undefined) return {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || Object.keys(stored).length > 50) {
      throw new TypeError('Stored Discord role names are invalid.');
    }
    const names: Record<string, Record<string, string>> = {};
    for (const [guildId, roles] of Object.entries(stored)) {
      if (!authorization.guilds[guildId] || !roles || typeof roles !== 'object' || Array.isArray(roles) ||
          Object.keys(roles).length > 100) continue;
      const grantedRoleIds = new Set(authorization.guilds[guildId]!.roleIds);
      for (const [roleId, name] of Object.entries(roles)) {
        if (grantedRoleIds.has(roleId) && typeof name === 'string' && name.length > 0 && name.length <= 100) {
          (names[guildId] ??= {})[roleId] = name;
        }
      }
    }
    return names;
  }

  async mutateDiscordAuthorization(mutation: AuthorizationMutation): Promise<DiscordAuthorization> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = decodeDiscordAuthorization(await transaction.get<unknown>(AUTHORIZATION_KEY));
      const updated = applyAuthorizationMutation(current, mutation);
      await transaction.put(AUTHORIZATION_KEY, updated);
      if (mutation.action === 'revoke-server') {
        const names = await transaction.get<Record<string, string>>(DISCORD_GUILD_NAMES_KEY) ?? {};
        delete names[mutation.guildId];
        await transaction.put(DISCORD_GUILD_NAMES_KEY, names);
        const roleNames = await transaction.get<Record<string, Record<string, string>>>(DISCORD_ROLE_NAMES_KEY) ?? {};
        delete roleNames[mutation.guildId];
        await transaction.put(DISCORD_ROLE_NAMES_KEY, roleNames);
      } else if (mutation.action === 'revoke-role') {
        const roleNames = await transaction.get<Record<string, Record<string, string>>>(DISCORD_ROLE_NAMES_KEY) ?? {};
        if (roleNames[mutation.guildId]) {
          delete roleNames[mutation.guildId]![mutation.id];
          if (!Object.keys(roleNames[mutation.guildId]!).length) delete roleNames[mutation.guildId];
          await transaction.put(DISCORD_ROLE_NAMES_KEY, roleNames);
        }
      }
      return updated;
    });
  }

  async beginDiscordOAuth(ownerEmail: string, stateHash: string, expiresAt: number): Promise<void> {
    this.assertAdminOwner(ownerEmail);
    if (!/^[a-f0-9]{64}$/.test(stateHash) || !Number.isFinite(expiresAt) ||
        expiresAt <= this.now() || expiresAt > this.now() + DISCORD_OAUTH_STATE_TTL_MS) {
      throw new TypeError('Discord account linking state is invalid.');
    }
    await this.ctx.storage.put(DISCORD_OAUTH_STATE_KEY, { ownerEmail, stateHash, expiresAt });
    await this.scheduleNextWake();
  }

  async consumeDiscordOAuthState(ownerEmail: string, stateHash: string, now: number): Promise<boolean> {
    this.assertAdminOwner(ownerEmail);
    if (!/^[a-f0-9]{64}$/.test(stateHash) || !Number.isFinite(now)) return false;
    const consumed = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<{ ownerEmail?: string; stateHash?: string; expiresAt?: number }>(DISCORD_OAUTH_STATE_KEY);
      if (stored && (stored.expiresAt ?? 0) <= now) await transaction.delete(DISCORD_OAUTH_STATE_KEY);
      if (!stored || stored.ownerEmail !== ownerEmail || stored.stateHash !== stateHash ||
          typeof stored.expiresAt !== 'number' || stored.expiresAt <= now) return false;
      await transaction.delete(DISCORD_OAUTH_STATE_KEY);
      return true;
    });
    await this.scheduleNextWake();
    return consumed;
  }

  async getLinkedDiscordAccount(ownerEmail: string): Promise<LinkedDiscordAccount | null> {
    this.assertAdminOwner(ownerEmail);
    return this.ctx.storage.transaction(async (transaction) => {
      const key = `${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`;
      const value = await transaction.get<unknown>(key);
      if (value === undefined) return null;
      if (!isLinkedDiscordAccount(value)) throw new TypeError('Stored Discord account link is invalid.');
      if (value.candidates.length && value.candidatesExpireAt <= this.now()) {
        const expired = { ...value, candidates: [] };
        await transaction.put(key, expired);
        return expired;
      }
      return value;
    });
  }

  async saveLinkedDiscordAccount(ownerEmail: string, link: LinkedDiscordAccount): Promise<void> {
    this.assertAdminOwner(ownerEmail);
    if (!isLinkedDiscordAccount(link) || link.linkedAt > this.now() + 60_000 ||
        link.candidatesExpireAt <= this.now() ||
        link.candidatesExpireAt > this.now() + DISCORD_GUILD_CANDIDATE_TTL_MS + 60_000) {
      throw new TypeError('Discord account link is invalid.');
    }
    await this.ctx.storage.put(`${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`, link);
    await this.scheduleNextWake();
  }

  async unlinkDiscordAccount(ownerEmail: string): Promise<void> {
    this.assertAdminOwner(ownerEmail);
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(`${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`);
      await transaction.delete(DISCORD_OAUTH_STATE_KEY);
    });
    await this.scheduleNextWake();
  }

  async approveLinkedServer(ownerEmail: string, guildId: string, now: number): Promise<DiscordAuthorization> {
    this.assertAdminOwner(ownerEmail);
    if (!/^\d{17,20}$/.test(guildId) || !Number.isFinite(now)) {
      throw new TypeError('Choose a valid server from the linked account list.');
    }
    const initial = await this.getEligibleLinkedCandidate(ownerEmail, guildId, now);
    await this.requireBotMembership(guildId);

    return this.ctx.storage.transaction(async (transaction) => {
      const link = await transaction.get<unknown>(`${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`);
      if (!isLinkedDiscordAccount(link) || link.userId !== initial.link.userId ||
          link.candidatesExpireAt <= now || !link.candidates.some((item) => item.guildId === guildId)) {
        throw new TypeError('The linked account or server list changed. Refresh the list and try again.');
      }
      const candidate = link.candidates.find((item) => item.guildId === guildId)!;
      const current = decodeDiscordAuthorization(await transaction.get<unknown>(AUTHORIZATION_KEY));
      const updated = applyAuthorizationMutation(current, { action: 'approve-server', guildId });
      const names = await transaction.get<Record<string, string>>(DISCORD_GUILD_NAMES_KEY) ?? {};
      names[guildId] = candidate.name;
      await transaction.put(AUTHORIZATION_KEY, updated);
      await transaction.put(DISCORD_GUILD_NAMES_KEY, names);
      return updated;
    });
  }

  async grantLinkedAccountToServer(ownerEmail: string, guildId: string, now: number): Promise<DiscordAuthorization> {
    this.assertAdminOwner(ownerEmail);
    if (!/^\d{17,20}$/.test(guildId) || !Number.isFinite(now)) {
      throw new TypeError('Choose a valid server from the linked account list.');
    }
    const initial = await this.getEligibleLinkedCandidate(ownerEmail, guildId, now);
    await this.requireBotMembership(guildId);

    return this.ctx.storage.transaction(async (transaction) => {
      const link = await transaction.get<unknown>(`${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`);
      if (!isLinkedDiscordAccount(link) || link.userId !== initial.link.userId ||
          link.candidatesExpireAt <= now || !link.candidates.some((item) => item.guildId === guildId)) {
        throw new TypeError('The linked account or server list changed. Refresh the list and try again.');
      }
      const currentCandidate = link.candidates.find((item) => item.guildId === guildId)!;
      const current = decodeDiscordAuthorization(await transaction.get<unknown>(AUTHORIZATION_KEY));
      const approved = applyAuthorizationMutation(current, { action: 'approve-server', guildId });
      const updated = applyAuthorizationMutation(approved, { action: 'grant-user', guildId, id: link.userId });
      const names = await transaction.get<Record<string, string>>(DISCORD_GUILD_NAMES_KEY) ?? {};
      names[guildId] = currentCandidate.name;
      await transaction.put(AUTHORIZATION_KEY, updated);
      await transaction.put(DISCORD_GUILD_NAMES_KEY, names);
      return updated;
    });
  }

  async grantUserToServer(
    ownerEmail: string,
    guildId: string,
    userId: string,
    now: number,
  ): Promise<DiscordAuthorization> {
    this.assertAdminOwner(ownerEmail);
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(userId) || userId === guildId || !Number.isFinite(now)) {
      throw new TypeError('Enter a valid server and Discord user ID.');
    }
    const current = await this.getDiscordAuthorization();
    if (!current.guilds[guildId]) throw new TypeError('Approve the server before granting an individual user access.');
    await this.requireBotMembership(guildId);
    const member = await this.getCurrentMemberRoles(guildId, userId);
    if (member.status === 'revoked') throw new TypeError('That Discord user is not a current human member of this server.');
    if (member.status !== 'member') throw new TypeError('Discord could not verify that user. Check the bot setup and try again.');

    return this.ctx.storage.transaction(async (transaction) => {
      const latest = decodeDiscordAuthorization(await transaction.get<unknown>(AUTHORIZATION_KEY));
      if (!latest.guilds[guildId]) throw new TypeError('The server was removed before the user grant could be saved.');
      const updated = applyAuthorizationMutation(latest, { action: 'grant-user', guildId, id: userId });
      await transaction.put(AUTHORIZATION_KEY, updated);
      return updated;
    });
  }

  async getLinkedServerRoles(ownerEmail: string, guildId: string, now: number): Promise<DiscordRoleOption[]> {
    this.assertAdminOwner(ownerEmail);
    if (!/^\d{17,20}$/.test(guildId) || !Number.isFinite(now)) {
      throw new TypeError('Choose a valid server from the linked account list.');
    }
    const initial = await this.getEligibleLinkedCandidate(ownerEmail, guildId, now);
    await this.requireBotMembership(guildId);
    const roles = await this.fetchGuildRoles(guildId);
    const current = await this.getEligibleLinkedCandidate(ownerEmail, guildId, now);
    if (initial.link.userId !== current.link.userId) {
      throw new TypeError('The linked account changed. Refresh the server list and try again.');
    }
    return roles;
  }

  async grantLinkedRoleToServer(
    ownerEmail: string,
    guildId: string,
    roleId: string,
    now: number,
  ): Promise<DiscordAuthorization> {
    this.assertAdminOwner(ownerEmail);
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(roleId) || roleId === guildId || !Number.isFinite(now)) {
      throw new TypeError('Choose a valid server and a non-@everyone role.');
    }
    const initial = await this.getEligibleLinkedCandidate(ownerEmail, guildId, now);
    await this.requireBotMembership(guildId);
    const roles = await this.fetchGuildRoles(guildId);
    if (!roles.some((role) => role.roleId === roleId)) {
      throw new TypeError('That role is not available in the selected server. Reload roles and try again.');
    }

    return this.ctx.storage.transaction(async (transaction) => {
      const link = await transaction.get<unknown>(`${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`);
      if (!isLinkedDiscordAccount(link) || link.userId !== initial.link.userId ||
          link.candidatesExpireAt <= now || !link.candidates.some((item) => item.guildId === guildId)) {
        throw new TypeError('The linked account or server list changed. Refresh the list and try again.');
      }
      const current = decodeDiscordAuthorization(await transaction.get<unknown>(AUTHORIZATION_KEY));
      const approved = applyAuthorizationMutation(current, { action: 'approve-server', guildId });
      const updated = applyAuthorizationMutation(approved, { action: 'grant-role', guildId, id: roleId });
      const role = roles.find((item) => item.roleId === roleId)!;
      const roleNames = await transaction.get<Record<string, Record<string, string>>>(DISCORD_ROLE_NAMES_KEY) ?? {};
      const namesForGuild = roleNames[guildId] ?? {};
      namesForGuild[roleId] = role.name;
      roleNames[guildId] = namesForGuild;
      const names = await transaction.get<Record<string, string>>(DISCORD_GUILD_NAMES_KEY) ?? {};
      names[guildId] = initial.candidate.name;
      await transaction.put(AUTHORIZATION_KEY, updated);
      await transaction.put(DISCORD_GUILD_NAMES_KEY, names);
      await transaction.put(DISCORD_ROLE_NAMES_KEY, roleNames);
      return updated;
    });
  }

  async getDiscordGuildNames(): Promise<Record<string, string>> {
    const names = await this.ctx.storage.get<unknown>(DISCORD_GUILD_NAMES_KEY);
    if (names === undefined) return {};
    if (!names || typeof names !== 'object' || Array.isArray(names) || Object.entries(names).length > 50 ||
        !Object.entries(names).every(([guildId, name]) => /^\d{17,20}$/.test(guildId) &&
          typeof name === 'string' && name.length > 0 && name.length <= 100)) {
      throw new TypeError('Stored Discord server names are invalid.');
    }
    return names as Record<string, string>;
  }

  async subscribe(input: EventSubscriptionInput): Promise<{ id: string; refreshBefore: string }> {
    let phase: SubscriptionPhase = 'validation';
    let subscriptionStored = false;
    try {
      const url = validateCallbackUrl(input.url);
      const now = this.now();
      phase = 'storage';
      await this.pruneExpiredSubscriptions();
      phase = 'validation';
      const expiration = Date.parse(input.refreshBefore);
      if (!Number.isFinite(expiration) || expiration <= now) throw new TypeError('Subscription expiry must be in the future.');
      const refreshBefore = new Date(expiration).toISOString();
      const key = `${SUBSCRIPTION_PREFIX}${input.id}`;
      phase = 'storage';
      const current = await this.ctx.storage.get<EventSubscription>(key);
      const rotated = current && current.secret !== input.secret;
      const subscription: EventSubscription = {
        id: input.id,
        principal: input.principal,
        name: input.name,
        arguments: input.arguments,
        url,
        secret: input.secret,
        refreshBefore,
        authorization: input.authorization,
        ...(rotated
          ? { previousSecret: current.secret, previousSecretUntil: now + 5 * 60_000 }
          : current?.previousSecret && (current.previousSecretUntil ?? 0) > now
            ? { previousSecret: current.previousSecret, previousSecretUntil: current.previousSecretUntil }
            : {}),
      };
      phase = 'authorization';
      if (!await this.isSubscriptionAuthorized(subscription)) {
        throw new TypeError('The OAuth authorization is no longer active.');
      }
      phase = 'storage';
      await this.ctx.storage.transaction(async (transaction) => {
        // Intake or unsubscribe may have run during the OAuth check above.
        const latest = await transaction.get<EventSubscription>(key);
        subscription.recoveryId = latest?.authorization?.grantId === input.authorization?.grantId &&
          latest?.authorization?.clientId === input.authorization?.clientId &&
          latest?.authorization?.audience === input.authorization?.audience
          ? latest?.recoveryId ?? crypto.randomUUID() : crypto.randomUUID();
        await transaction.put(key, subscription);
      });
      subscriptionStored = true;
      logSubscriptionDiagnostic(phase, 'succeeded', { subscriptionStored });
      await this.ctx.storage.delete('gateway:terminal-close-code');
      phase = 'gateway';
      logSubscriptionDiagnostic(phase, 'started', { subscriptionStored });
      await this.ensureGateway();
      logSubscriptionDiagnostic(phase, 'returned', { subscriptionStored });
      phase = 'storage';
      await this.processDueDeliveries();
      await this.scheduleNextDelivery();
      return { id: input.id, refreshBefore };
    } catch (error) {
      logSubscriptionDiagnostic(phase, 'failed', { subscriptionStored });
      throw error;
    }
  }

  async unsubscribe(identity: EventSubscriptionIdentity): Promise<void> {
    const key = `${SUBSCRIPTION_PREFIX}${identity.id}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<EventSubscription>(key);
      if (!current || current.principal !== identity.principal || current.name !== identity.name ||
          current.url !== identity.url || canonicalJson(current.arguments) !== canonicalJson(identity.arguments)) return;
      await transaction.delete(key);
      const outbox = await transaction.list<PendingDelivery>({ prefix: `${DELIVERY_PREFIX}${identity.id}:` });
      for (const deliveryKey of outbox.keys()) await transaction.delete(deliveryKey);
    });
    await this.ensureGateway();
    await this.scheduleNextWake();
  }

  async callbackVerified(principal: string, url: string, now: number): Promise<boolean> {
    const cachedCallbacks = await this.ctx.storage.list<number>({ prefix: CALLBACK_PREFIX });
    for (const [cachedKey, expiresAt] of cachedCallbacks) {
      if (expiresAt <= now) await this.ctx.storage.delete(cachedKey);
    }
    const key = `${CALLBACK_PREFIX}${await hashKey(`${principal}\n${url}`)}`;
    const expiresAt = await this.ctx.storage.get<number>(key);
    if (typeof expiresAt === 'number' && expiresAt <= now) await this.ctx.storage.delete(key);
    return typeof expiresAt === 'number' && expiresAt > now;
  }

  async recordCallbackVerification(principal: string, url: string, expiresAt: number): Promise<void> {
    const key = `${CALLBACK_PREFIX}${await hashKey(`${principal}\n${url}`)}`;
    await this.ctx.storage.put(key, expiresAt);
  }

  async alarm(): Promise<void> {
    await this.pruneExpiredSubscriptions();
    await this.pruneExpiredOrigins();
    await this.pruneExpiredDiscordCandidates();
    await this.pruneExpiredDiscordOAuthState();
    await this.ensureGateway();
    const gatewayAlarmAt = await this.ctx.storage.get<number>(GATEWAY_ALARM_KEY);
    if (typeof gatewayAlarmAt === 'number' && gatewayAlarmAt <= this.now()) {
      await this.ctx.storage.delete(GATEWAY_ALARM_KEY);
    }
    if (typeof gatewayAlarmAt === 'number' && gatewayAlarmAt <= this.now() && this.gatewayProtocol) {
      await this.applyGatewayCommands(this.gatewayProtocol.alarm());
    }
    this.startTypingWork();
    await this.processDueDeliveries();
    await this.scheduleNextWake();
  }

  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  }

  private assertAdminOwner(ownerEmail: string): void {
    const configuredOwner = this.env.ACCESS_OWNER_EMAIL?.trim().toLowerCase();
    if (!configuredOwner || ownerEmail !== configuredOwner) {
      throw new TypeError('Owner authentication required.');
    }
  }

  private async getEligibleLinkedCandidate(
    ownerEmail: string,
    guildId: string,
    now: number,
  ): Promise<{ link: LinkedDiscordAccount; candidate: DiscordGuildCandidate }> {
    const link = await this.getLinkedDiscordAccount(ownerEmail);
    const candidate = link?.candidates.find((item) => item.guildId === guildId);
    if (!link || link.candidatesExpireAt <= now || !candidate) {
      throw new TypeError('That server is not in the current linked account list. Refresh the list and try again.');
    }
    return { link, candidate };
  }

  private async requireBotMembership(guildId: string): Promise<void> {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    const botUserId = this.env.DISCORD_BOT_USER_ID?.trim();
    if (!token || !botUserId || !/^\d{17,20}$/.test(botUserId)) {
      throw new TypeError('Discord bot membership could not be verified.');
    }
    let response: Response;
    try {
      response = await fetchWithoutRedirect(this.discordFetch, `https://discord.com/api/v10/guilds/${guildId}/members/${botUserId}`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bot ${token}`, accept: 'application/json' },
      });
    } catch {
      throw new TypeError('Discord bot membership could not be verified.');
    }
    if (response.status === 404) throw new TypeError('The bot must be in this server before access can be granted.');
    if (!response.ok) throw new TypeError('Discord bot membership could not be verified.');
    let member: unknown;
    try {
      member = await response.json();
    } catch {
      throw new TypeError('Discord bot membership could not be verified.');
    }
    if (!member || typeof member !== 'object' ||
        (member as { user?: { id?: unknown } }).user?.id !== botUserId) {
      throw new TypeError('Discord bot membership could not be verified.');
    }
  }

  private async fetchGuildRoles(guildId: string): Promise<DiscordRoleOption[]> {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) throw new TypeError('Discord roles could not be loaded.');
    let response: Response;
    try {
      response = await fetchWithoutRedirect(this.discordFetch, `https://discord.com/api/v10/guilds/${guildId}/roles`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bot ${token}`, accept: 'application/json' },
      });
    } catch {
      throw new TypeError('Discord roles could not be loaded.');
    }
    if (response.status === 404) throw new TypeError('The bot must be in this server before roles can be loaded.');
    if (!response.ok) throw new TypeError('Discord roles could not be loaded.');
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TypeError('Discord returned an invalid role list.');
    }
    return selectableDiscordRoles(payload, guildId);
  }

  private async ensureGateway(): Promise<void> {
    const subscriptions = await this.ctx.storage.list<EventSubscription>({ prefix: SUBSCRIPTION_PREFIX });
    if (![...subscriptions.values()].some((subscription) => Date.parse(subscription.refreshBefore) > this.now())) {
      await this.stopGateway();
      return;
    }
    if (this.gatewaySocket && (this.gatewaySocket.readyState === 0 || this.gatewaySocket.readyState === 1)) {
      logSubscriptionDiagnostic('gateway', 'cached');
      return;
    }
    if (await this.ctx.storage.get<number>('gateway:terminal-close-code')) {
      logSubscriptionDiagnostic('gateway', 'terminal_stopped');
      return;
    }
    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) {
      logSubscriptionDiagnostic('gateway', 'configuration_missing');
      await this.setGatewayAlarm(30_000);
      return;
    }

    if (!this.gatewayProtocol) {
      const session = await this.ctx.storage.get<GatewaySession>(SESSION_KEY);
      const gatewayUrl = await this.gatewayUrl(token);
      this.gatewayProtocol = new DiscordGatewayProtocol(token, session ?? null, Math.random, gatewayUrl);
    }
    try {
      const socket = this.webSocket(this.gatewayProtocol.connectUrl);
      this.gatewaySocket = socket;
      socket.addEventListener('message', (event) => {
        this.ctx.waitUntil(this.onGatewayMessage(socket, event.data));
      });
      socket.addEventListener('close', (event) => {
        if (this.gatewaySocket !== socket) return;
        this.gatewaySocket = null;
        this.ctx.waitUntil(this.onGatewayClosed(event.code));
      });
      socket.addEventListener('error', () => {
        if (this.gatewaySocket === socket) {
          logSubscriptionDiagnostic('gateway', 'socket_failed');
          socket.close(4000, 'Gateway socket error');
        }
      });
      await this.setGatewayAlarm(30_000);
    } catch {
      logSubscriptionDiagnostic('gateway', 'socket_failed');
      if (this.gatewayProtocol) {
        await this.applyGatewayCommands(this.gatewayProtocol.closed(1006));
      } else {
        await this.setGatewayAlarm(30_000);
      }
    }
  }

  private async onGatewayMessage(socket: WebSocket, data: string | ArrayBuffer | Blob): Promise<void> {
    if (this.gatewaySocket !== socket || !this.gatewayProtocol) return;
    let raw: string;
    if (typeof data === 'string') raw = data;
    else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
    else raw = await data.text();
    await this.applyGatewayCommands(this.gatewayProtocol.receive(raw));
  }

  private async onGatewayClosed(code: number): Promise<void> {
    if (!this.gatewayProtocol) return;
    await this.applyGatewayCommands(this.gatewayProtocol.closed(code));
  }

  private async applyGatewayCommands(commands: GatewayCommand[]): Promise<void> {
    for (const command of commands) {
      if (command.type === 'send') {
        if (this.gatewaySocket?.readyState === 1) this.gatewaySocket.send(JSON.stringify(command.payload));
      } else if (command.type === 'schedule') {
        await this.setGatewayAlarm(command.delayMs);
      } else if (command.type === 'close') {
        if (this.gatewaySocket?.readyState === 1) this.gatewaySocket.close(command.code, command.reason);
      } else if (command.type === 'session') {
        await this.ctx.storage.put(SESSION_KEY, command.value);
      } else if (command.type === 'mention') {
        await this.recordMention(command.candidate);
      } else if (command.type === 'terminal') {
        await this.ctx.storage.put('gateway:terminal-close-code', command.code);
      }
    }
  }

  private async checkOriginAuthorization(origin: OriginMessage): Promise<'authorized' | 'revoked' | 'unavailable'> {
    if (!isAllowedOrigin(origin, this.env.DISCORD_BOT_USER_ID)) return 'revoked';
    let authorization: DiscordAuthorization;
    try {
      authorization = await this.getDiscordAuthorization();
    } catch {
      return 'unavailable';
    }
    if (!authorization.guilds[origin.guildId]) return 'revoked';

    const member = await this.getCurrentMemberRoles(origin.guildId, origin.authorId);
    if (member.status !== 'member') return member.status;

    try {
      authorization = await this.getDiscordAuthorization();
    } catch {
      return 'unavailable';
    }
    return hasDiscordAccess(authorization, origin.guildId, origin.authorId, member.roleIds)
      ? 'authorized'
      : 'revoked';
  }

  private async getCurrentMemberRoles(
    guildId: string,
    userId: string,
  ): Promise<
    | { status: 'member'; roleIds: string[] }
    | { status: 'revoked' }
    | { status: 'unavailable'; reason: MemberAuthorizationFailureReason; httpStatus?: number }
  > {
    const token = this.env.DISCORD_BOT_TOKEN?.trim();
    if (!token) return { status: 'unavailable', reason: 'member_access_unconfigured' };
    let response: Response;
    let retries = 0;
    while (true) {
      try {
        response = await fetchWithoutRedirect(
          this.discordFetch,
          `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
          {
            method: 'GET',
            cache: 'no-store',
            signal: AbortSignal.timeout(10_000),
            headers: { authorization: `Bot ${token}`, accept: 'application/json' },
          },
        );
      } catch (error) {
        return error instanceof RedirectResponseError
          ? { status: 'unavailable', reason: 'member_access_redirect_rejected', httpStatus: error.status }
          : { status: 'unavailable', reason: 'member_access_request_failed' };
      }
      if (response.status !== 429 || retries >= MEMBER_LOOKUP_MAX_RETRIES) break;
      const delayMs = await memberLookupRetryDelayMs(response);
      if (delayMs === null) break;
      retries++;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    if (response.status === 404) return { status: 'revoked' };
    if (!response.ok) return { status: 'unavailable', reason: 'member_access_http_error', httpStatus: response.status };

    let member: unknown;
    try {
      member = await response.json();
    } catch {
      return { status: 'unavailable', reason: 'member_access_invalid_response' };
    }
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      return { status: 'unavailable', reason: 'member_access_invalid_response' };
    }
    const value = member as { user?: unknown; roles?: unknown };
    if (!value.user || typeof value.user !== 'object' || Array.isArray(value.user)) {
      return { status: 'unavailable', reason: 'member_access_invalid_response' };
    }
    const user = value.user as { id?: unknown; bot?: unknown };
    if (user.id !== userId) return { status: 'unavailable', reason: 'member_access_invalid_response' };
    if (user.bot === true) return { status: 'revoked' };
    if (!Array.isArray(value.roles) || value.roles.some((role) => typeof role !== 'string' || !/^\d{17,20}$/.test(role))) {
      return { status: 'unavailable', reason: 'member_access_invalid_response' };
    }
    return { status: 'member', roleIds: value.roles as string[] };
  }

  private async removeOriginAndDeliveries(eventId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(`origin:${eventId}`);
      const deliveries = await transaction.list<PendingDelivery>({ prefix: DELIVERY_PREFIX });
      for (const [key, delivery] of deliveries) {
        if (delivery.event.eventId === eventId) await transaction.delete(key);
      }
    });
    await this.scheduleNextWake();
  }

  private async processDueDeliveries(): Promise<void> {
    const entries = await this.ctx.storage.list<PendingDelivery>({ prefix: DELIVERY_PREFIX });
    const due = [...entries.entries()]
      .filter(([, delivery]) => delivery.nextAttemptAt <= this.now())
      .sort(([, left], [, right]) => left.nextAttemptAt - right.nextAttemptAt)
      .slice(0, MAX_DELIVERIES_PER_ALARM);
    for (const [key, delivery] of due) {
      const subscription = await this.ctx.storage.get<EventSubscription>(`${SUBSCRIPTION_PREFIX}${delivery.subscriptionId}`);
      const stored = await this.ctx.storage.get<StoredOrigin>(`origin:${delivery.event.eventId}`);
      if (!subscription || !stored || stored.expiresAt <= this.now() || Date.parse(subscription.refreshBefore) <= this.now()) {
        await this.ctx.storage.delete(key);
        continue;
      }
      let authorized: boolean;
      try {
        authorized = await this.isSubscriptionAuthorized(subscription);
      } catch {
        await this.retryDelivery(key, delivery);
        continue;
      }
      if (!authorized) {
        await this.removeSubscription(subscription);
        continue;
      }
      const { expiresAt: _expiresAt, recipients: _recipients, reply: _reply, ...origin } = stored;
      const authorization = await this.checkOriginAuthorization(origin);
      if (authorization === 'revoked') {
        await this.removeOriginAndDeliveries(origin.eventId);
        continue;
      }
      if (authorization === 'unavailable') {
        await this.retryDelivery(key, delivery);
        continue;
      }
      let status = 0;
      try {
        validateCallbackUrl(subscription.url);
        const result = await postSignedEvent(subscription, delivery.event, this.webhookFetch, this.now());
        status = result.status;
        if (result.accepted || status === 410 || status === 413) {
          await this.ctx.storage.delete(key);
          continue;
        }
      } catch {
        status = 0;
      }
      await this.retryDelivery(key, delivery);
    }
  }

  private async isSubscriptionAuthorized(subscription: EventSubscription): Promise<boolean> {
    const configuredOwner = this.env.ACCESS_OWNER_EMAIL?.trim().toLowerCase();
    const authorization = subscription.authorization;
    const issuer = canonicalIssuer(this.env.MCP_ISSUER_URL);
    const kv = this.env.OAUTH_KV;
    if (!configuredOwner || subscription.principal.trim().toLowerCase() !== configuredOwner ||
        subscription.name !== MENTION_EVENT_NAME || !authorization || !issuer || !kv ||
        authorization.audience !== `${issuer}/mcp`) return false;
    const token = await kv.get<OAuthTokenRecord>(
      `token:${subscription.principal}:${authorization.grantId}:${authorization.tokenId}`,
      { type: 'json' },
    );
    if (!token || token.id !== authorization.tokenId || token.userId !== subscription.principal ||
        token.grantId !== authorization.grantId || typeof token.expiresAt !== 'number' ||
        token.expiresAt * 1_000 <= this.now() || token.grant?.clientId !== authorization.clientId) return false;
    const audience = token.audience;
    if (!(audience === authorization.audience || Array.isArray(audience) && audience.includes(authorization.audience))) return false;
    const scopes = token.scope ?? token.grant?.scope ?? [];
    return scopes.includes('discord:read') && scopes.includes('discord:reply');
  }

  private async retryDelivery(key: string, delivery: PendingDelivery): Promise<void> {
    const attempts = delivery.attempts + 1;
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.ctx.storage.delete(key);
      return;
    }
    await this.ctx.storage.put<PendingDelivery>(key, {
      ...delivery,
      attempts,
      nextAttemptAt: this.now() + retryDelayMs(attempts),
    });
  }

  private async removeSubscription(subscription: EventSubscription): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${SUBSCRIPTION_PREFIX}${subscription.id}`;
      const current = await transaction.get<EventSubscription>(key);
      if (!current || current.refreshBefore !== subscription.refreshBefore ||
          current.authorization?.tokenId !== subscription.authorization?.tokenId) return;
      await transaction.delete(key);
      const outbox = await transaction.list<PendingDelivery>({ prefix: `${DELIVERY_PREFIX}${subscription.id}:` });
      for (const key of outbox.keys()) await transaction.delete(key);
    });
  }

  /** End only this mention, including failed or ambiguous reply attempts. */
  async stopTyping(origin: OriginMessage): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${TYPING_PREFIX}${origin.channelId}`;
      const channel = await transaction.get<TypingChannel>(key);
      if (!channel) return;
      delete channel.events[origin.eventId];
      // Keep the channel cooldown: a new mention must not bypass a rate limit.
      await transaction.put(key, channel);
    });
    await this.scheduleNextWake();
  }

  private startTypingWork(): void {
    if (this.typingWork) return;
    this.typingWork = this.processTyping().catch(() => {
      // Typing is optional; an alarm can retry persisted work after storage/I/O failure.
    }).finally(async () => {
      this.typingWork = null;
      try { await this.scheduleNextWake(); } catch { /* Existing alarm remains the fallback. */ }
    });
    this.ctx.waitUntil(this.typingWork);
  }

  private async processTyping(): Promise<void> {
    const channels = await this.ctx.storage.list<TypingChannel>({ prefix: TYPING_PREFIX });
    for (const [key] of channels) {
      const claim = await this.ctx.storage.transaction(async (transaction) => {
        const channel = await transaction.get<TypingChannel>(key);
        if (!channel) return null;
        for (const [eventId, deadline] of Object.entries(channel.events)) {
          const origin = await transaction.get<StoredOrigin>(`origin:${eventId}`);
          if (deadline <= this.now() || !origin || origin.expiresAt <= this.now() || origin.reply?.status === 'replied') {
            delete channel.events[eventId];
          }
        }
        if (!Object.keys(channel.events).length) {
          if (channel.nextAttemptAt <= this.now()) await transaction.delete(key);
          else await transaction.put(key, channel);
          return null;
        }
        const global = await transaction.get<number>(TYPING_GLOBAL_KEY) ?? 0;
        if (channel.nextAttemptAt > this.now() || global > this.now()) {
          await transaction.put(key, channel);
          return null;
        }
        channel.nextAttemptAt = this.now() + TYPING_LEASE_MS;
        await transaction.put(key, channel);
        return structuredClone(channel);
      });
      if (!claim) continue;
      // Install the recovery alarm before any external request.
      await this.scheduleNextWake();
      const token = this.env.DISCORD_BOT_TOKEN?.trim();
      if (!token || await this.ctx.storage.get('gateway:terminal-close-code')) {
        for (const eventId of Object.keys(claim.events)) {
          const origin = await this.ctx.storage.get<StoredOrigin>(`origin:${eventId}`);
          if (origin) await this.stopTyping(origin);
        }
        continue;
      }
      let eligible: StoredOrigin | undefined;
      for (const eventId of Object.keys(claim.events)) {
        const origin = await this.ctx.storage.get<StoredOrigin>(`origin:${eventId}`);
        if (!origin) continue;
        const policy = await this.getDiscordAuthorization();
        const recipient = await this.typingRecipient(origin);
        if (!recipient || await this.checkOriginAuthorization(origin) !== 'authorized' ||
            !await this.isSubscriptionAuthorized(recipient)) {
          await this.stopTyping(origin);
          continue;
        }
        // Network checks yield to replies, unsubscribe and local revocation. Validate the
        // checked snapshots and deadline transactionally immediately before the POST.
        const valid = await this.ctx.storage.transaction(async (transaction) => {
          const channel = await transaction.get<TypingChannel>(key);
          const stored = await transaction.get<StoredOrigin>(`origin:${eventId}`);
          const subscription = await transaction.get<EventSubscription>(`${SUBSCRIPTION_PREFIX}${recipient.id}`);
          const currentPolicy = decodeDiscordAuthorization(await transaction.get(AUTHORIZATION_KEY));
          return !!channel && (channel.events[eventId] ?? 0) > this.now() && !!stored &&
            stored.expiresAt > this.now() && stored.reply?.status !== 'replied' &&
            canonicalJson(currentPolicy) === canonicalJson(policy) && !!subscription &&
            canonicalJson(subscription) === canonicalJson(recipient) &&
            Date.parse(subscription.refreshBefore) > this.now();
        });
        if (valid) { eligible = origin; break; }
      }
      if (!eligible) continue;
      const result = await triggerTyping(this.discordFetch, token, eligible.channelId, claim.failures);
      await this.ctx.storage.transaction(async (transaction) => {
        const latest = await transaction.get<TypingChannel>(key);
        if (!latest) return;
        if (result.terminal) {
          // Stop the batch, but do not erase mentions that arrived during this request.
          for (const eventId of Object.keys(claim.events)) delete latest.events[eventId];
        }
        latest.nextAttemptAt = this.now() + result.delayMs;
        latest.failures = result.failed ? claim.failures + 1 : 0;
        await transaction.put(key, latest);
        // Pace typing across channels as well as respecting Discord's global Retry-After.
        await transaction.put(TYPING_GLOBAL_KEY, Math.max(
          await transaction.get<number>(TYPING_GLOBAL_KEY) ?? 0,
          result.global ? latest.nextAttemptAt : this.now() + 250,
        ));
      });
    }
  }

  private async typingRecipient(origin: StoredOrigin): Promise<EventSubscription | null> {
    for (const recipient of origin.recipients ?? []) {
      const subscription = await this.ctx.storage.get<EventSubscription>(`${SUBSCRIPTION_PREFIX}${recipient.id}`);
      if (subscription?.recoveryId === recipient.recoveryId &&
          Date.parse(subscription.refreshBefore) > this.now() && await this.isSubscriptionAuthorized(subscription)) return subscription;
    }
    return null;
  }

  private async scheduleNextDelivery(): Promise<void> {
    await this.scheduleNextWake();
  }

  private async setGatewayAlarm(delayMs: number): Promise<void> {
    await this.ctx.storage.put(GATEWAY_ALARM_KEY, this.now() + Math.max(1_000, delayMs));
    await this.scheduleNextWake();
  }

  private async scheduleNextWake(): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const deliveries = await transaction.list<PendingDelivery>({ prefix: DELIVERY_PREFIX });
      const origins = await transaction.list<StoredOrigin>({ prefix: 'origin:' });
      const gatewayAlarmAt = await transaction.get<number>(GATEWAY_ALARM_KEY);
      const ownerEmail = this.env.ACCESS_OWNER_EMAIL?.trim().toLowerCase();
      const linkedAccount = ownerEmail
        ? await transaction.get<unknown>(`${DISCORD_LINK_KEY_PREFIX}${ownerEmail}`)
        : undefined;
      const candidateExpiry = isLinkedDiscordAccount(linkedAccount) && linkedAccount.candidates.length
        ? linkedAccount.candidatesExpireAt
        : Number.POSITIVE_INFINITY;
      const oauthState = await transaction.get<{ expiresAt?: number }>(DISCORD_OAUTH_STATE_KEY);
      const oauthStateExpiry = typeof oauthState?.expiresAt === 'number' && oauthState.expiresAt > this.now()
        ? oauthState.expiresAt
        : Number.POSITIVE_INFINITY;
      const originExpiryTimes = [...origins.values()]
        .map((origin) => origin.expiresAt)
        .filter((expiresAt): expiresAt is number => typeof expiresAt === 'number');
      const typing = await transaction.list<TypingChannel>({ prefix: TYPING_PREFIX });
      const globalBackoff = await transaction.get<number>(TYPING_GLOBAL_KEY) ?? 0;
      const typingTimes = [...typing.values()].flatMap((channel) => [
        // An in-flight check may cross a deadline. Avoid repeatedly scheduling in the past.
        Math.max(this.now() + 250, channel.nextAttemptAt, globalBackoff),
        ...Object.values(channel.events).filter((deadline) => deadline > this.now()),
      ]);
      const next = Math.min(
        typeof gatewayAlarmAt === 'number' ? gatewayAlarmAt : Number.POSITIVE_INFINITY,
        ...typingTimes,
        candidateExpiry,
        oauthStateExpiry,
        ...[...deliveries.values()].map((delivery) => delivery.nextAttemptAt),
        ...originExpiryTimes,
      );
      if (Number.isFinite(next)) await transaction.setAlarm(Math.max(this.now() + 1, next));
      else await transaction.deleteAlarm();
    });
  }

  private async pruneExpiredSubscriptions(): Promise<void> {
    const now = this.now();
    const subscriptions = await this.ctx.storage.list<EventSubscription>({ prefix: SUBSCRIPTION_PREFIX });
    for (const [key, subscription] of subscriptions) {
      let authorized = false;
      if (Date.parse(subscription.refreshBefore) > now) {
        try {
          authorized = await this.isSubscriptionAuthorized(subscription);
        } catch {
          continue;
        }
      }
      if (authorized) continue;
      await this.removeSubscription(subscription);
    }
    const cachedCallbacks = await this.ctx.storage.list<number>({ prefix: CALLBACK_PREFIX });
    for (const [key, expiresAt] of cachedCallbacks) {
      if (expiresAt <= now) await this.ctx.storage.delete(key);
    }
  }

  private async pruneExpiredOrigins(): Promise<void> {
    const origins = await this.ctx.storage.list<StoredOrigin>({ prefix: 'origin:' });
    for (const [key, origin] of origins) {
      if (typeof origin.expiresAt !== 'number' || origin.expiresAt <= this.now()) await this.ctx.storage.delete(key);
    }
  }

  private async pruneExpiredDiscordCandidates(): Promise<void> {
    const ownerEmail = this.env.ACCESS_OWNER_EMAIL?.trim().toLowerCase();
    if (!ownerEmail) return;
    await this.getLinkedDiscordAccount(ownerEmail);
  }

  private async pruneExpiredDiscordOAuthState(): Promise<void> {
    const state = await this.ctx.storage.get<{ expiresAt?: number }>(DISCORD_OAUTH_STATE_KEY);
    if (typeof state?.expiresAt === 'number' && state.expiresAt <= this.now()) {
      await this.ctx.storage.delete(DISCORD_OAUTH_STATE_KEY);
    }
  }

  private async stopGateway(): Promise<void> {
    const socket = this.gatewaySocket;
    this.gatewaySocket = null;
    this.gatewayProtocol = null;
    await this.ctx.storage.delete(GATEWAY_ALARM_KEY);
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close(1000, 'No active subscriptions');
  }
}

function deliveryKey(subscriptionId: string, eventId: string): string {
  return `${DELIVERY_PREFIX}${subscriptionId}:${eventId}`;
}

async function memberLookupRetryDelayMs(response: Response): Promise<number | null> {
  let body: unknown;
  try { body = await response.json(); } catch { /* A valid rate-limit body is optional. */ }
  const retryAfter = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { retry_after?: unknown }).retry_after
    : undefined;
  const seconds = [retryAfter, response.headers.get('retry-after'), response.headers.get('x-ratelimit-reset-after')]
    .filter((value): value is number | string => typeof value === 'number' || typeof value === 'string')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!seconds.length) return null;
  const delayMs = Math.ceil(Math.max(...seconds) * 1_000);
  return delayMs <= MEMBER_LOOKUP_MAX_RETRY_DELAY_MS ? delayMs : null;
}

async function hashKey(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeDiscordAuthorization(value: unknown): DiscordAuthorization {
  if (value === undefined) return emptyDiscordAuthorization();
  if (!isDiscordAuthorization(value)) throw new TypeError('Stored Discord authorization is invalid.');
  return value;
}

function isStandaloneMessageRecord(value: unknown): value is StandaloneMessageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StandaloneMessageRecord>;
  return /^\d{17,20}$/.test(record.channelId ?? '') && /^[a-f0-9]{64}$/.test(record.requestHash ?? '') &&
    typeof record.nonce === 'string' && record.nonce.length > 0 && record.nonce.length <= 25 &&
    (record.status === 'message_started' || record.status === 'sent') &&
    (record.status !== 'sent' || /^\d{17,20}$/.test(record.messageId ?? ''));
}

function sameOrigin(stored: OriginMessage, candidate: OriginMessage): boolean {
  return stored.eventId === candidate.eventId && stored.guildId === candidate.guildId &&
    stored.channelId === candidate.channelId && stored.messageId === candidate.messageId &&
    stored.authorId === candidate.authorId && stored.timestamp === candidate.timestamp &&
    stored.content === candidate.content;
}

async function fetchDiscordGatewayUrl(token: string): Promise<string> {
  const response = await fetchWithoutRedirect(fetch, 'https://discord.com/api/v10/gateway/bot', {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bot ${token}`, accept: 'application/json' },
  });
  if (!response.ok) throw new TypeError('Discord Gateway discovery failed.');
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new TypeError('Discord Gateway discovery returned invalid data.');
  }
  if (!payload || typeof payload !== 'object' || typeof (payload as { url?: unknown }).url !== 'string') {
    throw new TypeError('Discord Gateway discovery returned no WSS URL.');
  }
  return (payload as { url: string }).url;
}

// Scan positions can reference denied origins, so keep IDs opaque even to the token owner.
async function recoveryCursor(value: string, material: Uint8Array, access: string, encode: boolean): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(material), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const additionalData = new TextEncoder().encode(access);
  if (encode) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, new TextEncoder().encode(value)));
    return btoa(String.fromCharCode(...iv, ...encrypted));
  }
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData }, key, bytes.slice(12)));
}
