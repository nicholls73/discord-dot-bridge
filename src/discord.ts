import { isDiscordSnowflake, type OriginMessage } from './policy.js';
import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';
import { ChannelReadDiagnosticError, type ChannelReadPermission, type ChannelReadStage } from './channel-read-diagnostics.js';

const API = 'https://discord.com/api/v10';
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;
const PERMISSION_MAX_RETRY_DELAY_MS = 1_000;
export const NONCE_RECONCILIATION_LIMIT = 100;

export interface DiscordGuildChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
}

export interface DiscordChannelMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorDisplayName: string;
  authorIsBot: boolean;
  content: string;
  timestamp: string;
  nonce?: string;
}

export interface DiscordChannelPage {
  guildId: string;
  messages: DiscordChannelMessage[];
  nextBefore: string | null;
}

export type DiscordNonceReconciliation =
  | { status: 'found'; guildId: string; messageId: string; scannedMessages: number; scanLimit: number }
  | { status: 'not_found'; guildId: string; scannedMessages: number; scanLimit: number; olderHistoryMayContainMessage: boolean };

export interface DiscordMessenger {
  replyToOrigin(origin: OriginMessage, text: string, isAuthorized: () => Promise<boolean>): Promise<{ messageId: string }>;
  validateChannelWrite(channelId: string, authorizeGuild: (guildId: string) => Promise<boolean>): Promise<string>;
  listChannelMessages(
    channelId: string,
    before: string | undefined,
    limit: number,
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<DiscordChannelPage>;
  findOwnMessageByNonce(
    channelId: string,
    nonce: string,
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<DiscordNonceReconciliation>;
  sendChannelMessage(
    channelId: string,
    text: string,
    mentionUserIds: string[],
    nonce: string,
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<{ guildId: string; messageId: string }>;
  editOwnChannelMessage(
    channelId: string,
    messageId: string,
    text: string,
    mentionUserIds: string[],
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<{ guildId: string; messageId: string }>;
}

export class DiscordRestMessenger implements DiscordMessenger {
  constructor(
    private readonly token: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly botUserId?: string,
  ) {}

  async listGuildChannels(guildId: string): Promise<DiscordGuildChannel[]> {
    if (!isDiscordSnowflake(guildId)) throw new TypeError('Invalid Discord guild ID.');
    const response = await this.request(`${API}/guilds/${guildId}/channels`, { method: 'GET' });
    return (await readArray(response)).map((value) => parseGuildChannel(value, guildId));
  }

  async replyToOrigin(
    origin: OriginMessage,
    text: string,
    isAuthorized: () => Promise<boolean>,
  ): Promise<{ messageId: string }> {
    if (!isDiscordSnowflake(origin.guildId) || !isDiscordSnowflake(origin.channelId) ||
        !isDiscordSnowflake(origin.messageId) || origin.eventId !== origin.messageId || !await isAuthorized()) {
      throw new TypeError('Discord origin is no longer authorized.');
    }
    const content = normalizeMessageText(text);
    const response = await this.request(`${API}/channels/${origin.channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        message_reference: {
          message_id: origin.messageId,
          channel_id: origin.channelId,
          guild_id: origin.guildId,
          fail_if_not_exists: true,
        },
        allowed_mentions: { parse: [], replied_user: false },
      }),
    });
    const message = await readJson(response);
    if (!isDiscordSnowflake(message.id)) throw new TypeError('Discord returned an invalid reply ID.');
    return { messageId: message.id };
  }

  async validateChannelWrite(channelId: string, authorizeGuild: (guildId: string) => Promise<boolean>): Promise<string> {
    const channel = await this.getGuildTextChannel(channelId);
    if (!await authorizeGuild(channel.guildId)) throw new TypeError('Discord server access is no longer authorized.');
    await this.requirePermissions(channel, VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY);
    return channel.guildId;
  }

  async listChannelMessages(
    channelId: string,
    before: string | undefined,
    limit: number,
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<DiscordChannelPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (before && !isDiscordSnowflake(before))) {
      throw new TypeError('Invalid Discord channel page.');
    }
    let stage: ChannelReadStage = 'channel_lookup';
    try {
      const channel = await this.getGuildTextChannel(channelId);
      stage = 'server_authorization';
      let authorized: boolean;
      try {
        authorized = await authorizeGuild(channel.guildId);
      } catch {
        throw new ChannelReadDiagnosticError(stage, 'authorization_check_failed');
      }
      if (!authorized) throw new ChannelReadDiagnosticError(stage, 'access_denied');

      stage = 'bot_permissions';
      await this.requirePermissions(channel, VIEW_CHANNEL | READ_MESSAGE_HISTORY);
      const query = new URLSearchParams({ limit: String(limit) });
      if (before) query.set('before', before);
      stage = 'message_history_request';
      const response = await this.request(`${API}/channels/${channelId}/messages?${query}`, { method: 'GET' });
      stage = 'message_history_response';
      const values = await readArray(response);
      if (values.length > limit) throw new TypeError('Discord returned an oversized channel page.');
      stage = 'message_validation';
      const messages = values.map((value) => parseMessage(value, channelId));
      return {
        guildId: channel.guildId,
        messages,
        nextBefore: values.length === limit ? messages.at(-1)?.id ?? null : null,
      };
    } catch (error) {
      if (error instanceof ChannelReadDiagnosticError) throw error;
      if (error instanceof DiscordHttpError) {
        throw new ChannelReadDiagnosticError(stage,
          stage === 'bot_permissions' && error.status === 429 ? 'discord_rate_limited' : 'discord_http_error',
          { httpStatus: error.status, retryAfterMs: error.retryAfterMs });
      }
      if (error instanceof RedirectResponseError) {
        throw new ChannelReadDiagnosticError(stage, 'redirect_rejected', { httpStatus: error.status });
      }
      if (error instanceof DiscordMissingPermissionsError) {
        const missingPermissions = error.missingPermissions.filter(
          (permission): permission is ChannelReadPermission => permission !== 'SEND_MESSAGES',
        );
        throw new ChannelReadDiagnosticError(stage, 'permission_denied', { missingPermissions });
      }
      const reason = stage === 'channel_lookup'
        ? 'channel_lookup_failed'
        : stage === 'bot_permissions'
          ? 'permission_check_failed'
          : stage === 'message_history_request'
            ? 'request_failed'
            : stage === 'message_history_response' || stage === 'message_validation'
              ? 'invalid_response'
              : 'unexpected_failure';
      throw new ChannelReadDiagnosticError(stage, reason);
    }
  }

  async findOwnMessageByNonce(
    channelId: string,
    nonce: string,
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<DiscordNonceReconciliation> {
    if (!nonce || nonce.length > 25) throw new TypeError('Invalid Discord message nonce.');
    const channel = await this.getGuildTextChannel(channelId);
    if (!await authorizeGuild(channel.guildId)) throw new TypeError('Discord server access is no longer authorized.');
    await this.requirePermissions(channel, VIEW_CHANNEL | READ_MESSAGE_HISTORY);
    const response = await this.request(`${API}/channels/${channelId}/messages?limit=${NONCE_RECONCILIATION_LIMIT}`, { method: 'GET' });
    const values = await readArray(response);
    if (values.length > NONCE_RECONCILIATION_LIMIT) throw new TypeError('Discord returned an oversized channel page.');
    for (const value of values) {
      const message = parseMessage(value, channelId);
      if (message.authorId === this.botUserId && message.nonce === nonce) {
        return {
          status: 'found',
          guildId: channel.guildId,
          messageId: message.id,
          scannedMessages: values.length,
          scanLimit: NONCE_RECONCILIATION_LIMIT,
        };
      }
    }
    return {
      status: 'not_found',
      guildId: channel.guildId,
      scannedMessages: values.length,
      scanLimit: NONCE_RECONCILIATION_LIMIT,
      olderHistoryMayContainMessage: values.length === NONCE_RECONCILIATION_LIMIT,
    };
  }

  async sendChannelMessage(
    channelId: string,
    text: string,
    mentionUserIds: string[],
    nonce: string,
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<{ guildId: string; messageId: string }> {
    if (!nonce || nonce.length > 25) throw new TypeError('Invalid Discord message nonce.');
    const content = normalizeMessageText(text);
    const mentions = validateMentionUserIds(mentionUserIds);
    const channel = await this.getGuildTextChannel(channelId);
    if (!await authorizeGuild(channel.guildId)) throw new TypeError('Discord server access is no longer authorized.');
    await this.requirePermissions(channel, VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY);
    const response = await this.request(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        nonce,
        enforce_nonce: true,
        allowed_mentions: mentions.length ? { users: mentions } : { parse: [] },
      }),
    });
    const message = await readJson(response);
    if (!isDiscordSnowflake(message.id) || message.channel_id !== channelId || message.author?.id !== this.botUserId) {
      throw new TypeError('Discord did not confirm the bot-authored message.');
    }
    return { guildId: channel.guildId, messageId: message.id };
  }

  async editOwnChannelMessage(
    channelId: string,
    messageId: string,
    text: string,
    mentionUserIds: string[],
    authorizeGuild: (guildId: string) => Promise<boolean>,
  ): Promise<{ guildId: string; messageId: string }> {
    if (!isDiscordSnowflake(messageId)) throw new TypeError('Invalid Discord message ID.');
    const content = normalizeMessageText(text);
    const mentions = validateMentionUserIds(mentionUserIds);
    const channel = await this.getGuildTextChannel(channelId);
    if (!await authorizeGuild(channel.guildId)) throw new TypeError('Discord server access is no longer authorized.');
    await this.requirePermissions(channel, VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY);
    const currentResponse = await this.request(`${API}/channels/${channelId}/messages/${messageId}`, { method: 'GET' });
    const current = await readJson(currentResponse);
    if (current.id !== messageId || current.channel_id !== channelId || current.author?.id !== this.botUserId) {
      throw new TypeError('Only the bot’s own messages can be edited.');
    }
    if (!await authorizeGuild(channel.guildId)) throw new TypeError('Discord server access is no longer authorized.');
    const response = await this.request(`${API}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        content,
        allowed_mentions: mentions.length ? { users: mentions } : { parse: [] },
      }),
    });
    const updated = await readJson(response);
    if (updated.id !== messageId || updated.channel_id !== channelId || updated.author?.id !== this.botUserId) {
      throw new TypeError('Discord did not confirm the bot-authored edit.');
    }
    return { guildId: channel.guildId, messageId };
  }

  private async getGuildTextChannel(channelId: string): Promise<DiscordChannel> {
    if (!isDiscordSnowflake(channelId)) throw new TypeError('Invalid Discord channel ID.');
    const response = await this.request(`${API}/channels/${channelId}`, { method: 'GET' });
    const value = await readJson(response);
    if (value.id !== channelId || !isDiscordSnowflake(value.guild_id) || ![0, 5].includes(value.type)) {
      throw new TypeError('Only guild text and announcement channels are supported.');
    }
    if (!Array.isArray(value.permission_overwrites) || value.permission_overwrites.some((item: unknown) => !isPermissionOverwrite(item))) {
      throw new TypeError('Discord channel permissions could not be verified.');
    }
    return {
      id: channelId,
      guildId: value.guild_id,
      overwrites: value.permission_overwrites,
    };
  }

  private async requirePermissions(channel: DiscordChannel, required: bigint): Promise<void> {
    if (!this.botUserId || !isDiscordSnowflake(this.botUserId)) throw new TypeError('Discord bot identity is not configured.');
    const [memberResponse, rolesResponse] = await Promise.all([
      this.request(`${API}/guilds/${channel.guildId}/members/${this.botUserId}`, { method: 'GET' }, true),
      this.request(`${API}/guilds/${channel.guildId}/roles`, { method: 'GET' }, true),
    ]);
    const member = await readJson(memberResponse);
    const roles = await readArray(rolesResponse);
    if (member.user?.id !== this.botUserId || !Array.isArray(member.roles) ||
        member.roles.some((id: unknown) => typeof id !== 'string' || !isDiscordSnowflake(id)) ||
        roles.some((role) => typeof role.id !== 'string' || !isDiscordSnowflake(role.id) || !validPermissionString(role.permissions))) {
      throw new TypeError('Discord bot permissions could not be verified.');
    }

    const rolesById = new Map(roles.map((role) => [String(role.id), parsePermissions(role.permissions)]));
    const everyone = rolesById.get(channel.guildId);
    if (everyone === undefined) throw new TypeError('Discord server permissions could not be verified.');
    let permissions = everyone;
    for (const roleId of member.roles as string[]) {
      permissions |= rolesById.get(roleId) ?? 0n;
    }
    if ((permissions & ADMINISTRATOR) !== 0n) return;

    const overwrites = channel.overwrites as PermissionOverwrite[];
    const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === channel.guildId && overwrite.type === 0);
    if (everyoneOverwrite) permissions = applyOverwrite(permissions, everyoneOverwrite);
    const roleIds = new Set(member.roles as string[]);
    const roleOverwrites = overwrites.filter((overwrite) => overwrite.type === 0 && roleIds.has(overwrite.id));
    if (roleOverwrites.length) {
      const denied = roleOverwrites.reduce((mask, overwrite) => mask | parsePermissions(overwrite.deny), 0n);
      const allowed = roleOverwrites.reduce((mask, overwrite) => mask | parsePermissions(overwrite.allow), 0n);
      permissions = (permissions & ~denied) | allowed;
    }
    const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === this.botUserId);
    if (memberOverwrite) permissions = applyOverwrite(permissions, memberOverwrite);
    const missing = required & ~permissions;
    if (missing !== 0n) {
      const missingPermissions: DiscordPermissionName[] = [];
      if ((missing & VIEW_CHANNEL) !== 0n) missingPermissions.push('VIEW_CHANNEL');
      if ((missing & READ_MESSAGE_HISTORY) !== 0n) missingPermissions.push('READ_MESSAGE_HISTORY');
      if ((missing & SEND_MESSAGES) !== 0n) missingPermissions.push('SEND_MESSAGES');
      throw new DiscordMissingPermissionsError(missingPermissions);
    }
  }

  private async request(url: string, init: RequestInit, retryPermissionRead = false): Promise<Response> {
    const token = this.token?.trim();
    if (!token) throw new TypeError('Discord transport is not configured.');
    for (let attempt = 0; ; attempt++) {
      const response = await fetchWithoutRedirect(this.fetcher, url, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bot ${token}`,
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      if (!response.ok) {
        const retryAfterMs = response.status === 429 && retryPermissionRead
          ? await permissionRetryDelayMs(response) : undefined;
        if (retryPermissionRead && init.method === 'GET' && attempt === 0 && retryAfterMs !== undefined &&
            retryAfterMs <= PERMISSION_MAX_RETRY_DELAY_MS) {
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
          continue;
        }
        throw new DiscordHttpError(response.status, retryAfterMs);
      }
      return response;
    }
  }
}

interface DiscordChannel {
  id: string;
  guildId: string;
  overwrites: unknown[];
}

type DiscordPermissionName = ChannelReadPermission | 'SEND_MESSAGES';

class DiscordHttpError extends TypeError {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`Discord API request failed with status ${status}.`);
    this.name = 'DiscordHttpError';
  }
}

async function permissionRetryDelayMs(response: Response): Promise<number | undefined> {
  let body: unknown;
  try { body = await response.json(); } catch { /* Rate-limit headers may suffice. */ }
  const retryAfter = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { retry_after?: unknown }).retry_after : undefined;
  const seconds = [retryAfter, response.headers.get('retry-after'), response.headers.get('x-ratelimit-reset-after')]
    .filter((value): value is number | string => typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!seconds.length) return undefined;
  const delayMs = Math.ceil(Math.max(...seconds) * 1_000);
  return Number.isSafeInteger(delayMs) ? delayMs : undefined;
}

class DiscordMissingPermissionsError extends TypeError {
  constructor(readonly missingPermissions: DiscordPermissionName[]) {
    super('The bot lacks the required channel permissions.');
    this.name = 'DiscordMissingPermissionsError';
  }
}

function normalizeMessageText(text: string): string {
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content || content.length > 2000) throw new TypeError('Discord message text must be 1 to 2000 characters.');
  return content;
}

function validateMentionUserIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => !isDiscordSnowflake(id)) || new Set(ids).size !== ids.length) {
    throw new TypeError('Discord mentions must be a list of at most 20 unique user IDs.');
  }
  return ids;
}

function applyOverwrite(permissions: bigint, overwrite: PermissionOverwrite): bigint {
  const allow = parsePermissions(overwrite.allow);
  const deny = parsePermissions(overwrite.deny);
  return (permissions & ~deny) | allow;
}

interface PermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

function isPermissionOverwrite(value: unknown): value is PermissionOverwrite {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PermissionOverwrite>;
  return isDiscordSnowflake(item.id ?? '') && (item.type === 0 || item.type === 1) &&
    validPermissionString(item.allow) && validPermissionString(item.deny);
}

function validPermissionString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,24}$/.test(value);
}

function parsePermissions(value: unknown): bigint {
  if (!validPermissionString(value)) throw new TypeError('Discord permissions are invalid.');
  return BigInt(value);
}

async function readJson(response: Response): Promise<any> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new TypeError('Discord returned an invalid response.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Discord returned an invalid response.');
  return value;
}

async function readArray(response: Response): Promise<any[]> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new TypeError('Discord returned an invalid response.'); }
  if (!Array.isArray(value)) throw new TypeError('Discord returned an invalid response.');
  return value;
}

function parseGuildChannel(value: unknown, expectedGuildId: string): DiscordGuildChannel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Discord returned an invalid channel.');
  const channel = value as Record<string, unknown>;
  const { guild_id: guildId, id, name, type, parent_id: parentId } = channel;
  if (guildId !== expectedGuildId || typeof id !== 'string' || !isDiscordSnowflake(id) ||
      typeof name !== 'string' || name.length < 1 || name.length > 100 ||
      typeof type !== 'number' || !Number.isSafeInteger(type) || type < 0 ||
      (parentId !== undefined && parentId !== null && (typeof parentId !== 'string' || !isDiscordSnowflake(parentId)))) {
    throw new TypeError('Discord returned an invalid channel.');
  }
  return {
    id,
    name,
    type,
    parentId: typeof parentId === 'string' ? parentId : null,
  };
}

function parseMessage(value: unknown, expectedChannelId: string): DiscordChannelMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Discord returned an invalid message.');
  const message = value as Record<string, any>;
  const author = message.author;
  if (!isDiscordSnowflake(message.id) || message.channel_id !== expectedChannelId ||
      !author || !isDiscordSnowflake(author.id) || typeof message.content !== 'string' ||
      typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp)) || message.content.length > 2000) {
    throw new TypeError('Discord returned an invalid message.');
  }
  const memberName = typeof message.member?.nick === 'string' ? message.member.nick : undefined;
  const globalName = typeof author.global_name === 'string' ? author.global_name : undefined;
  const username = typeof author.username === 'string' ? author.username : 'Discord user';
  const displayName = memberName ?? globalName ?? username;
  if (displayName.length > 128) throw new TypeError('Discord returned an invalid display name.');
  return {
    id: message.id,
    channelId: expectedChannelId,
    authorId: author.id,
    authorDisplayName: displayName,
    authorIsBot: author.bot === true || typeof message.webhook_id === 'string',
    content: message.content,
    timestamp: new Date(message.timestamp).toISOString(),
    ...(typeof message.nonce === 'string' && message.nonce.length <= 25 ? { nonce: message.nonce } : {}),
  };
}
