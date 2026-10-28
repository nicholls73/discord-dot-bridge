import { describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { BridgeStateDO } from '../src/bridge-state.js';
import { DiscordRestMessenger } from '../src/discord.js';
import type { LinkedDiscordAccount } from '../src/discord-account.js';
import { createBridgeMcpHandler, READ_SCOPE, REPLY_SCOPE } from '../src/mcp.js';
import type { EventSubscriptionInput } from '../src/mcp-events.js';
import type { GatewayMentionCandidate } from '../src/policy.js';
import { createSecureWebhookFetch } from '../src/secure-webhook-fetch.js';
import { signWebhook } from '../src/mcp-events.js';

class MemoryStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>({ prefix = '', startAfter = '', limit = Infinity }: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix) && key > startAfter)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit) as [string, T][]);
  }
  private transactionTail: Promise<unknown> = Promise.resolve();
  async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(() => callback(this));
    this.transactionTail = result.catch(() => undefined);
    return result;
  }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(timestamp: number): Promise<void> { this.alarm = timestamp; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}

const candidate: GatewayMentionCandidate = {
  guildId: '11111111111111111',
  channelId: '55555555555555555',
  messageId: '66666666666666666',
  authorId: '33333333333333333',
  authorDisplayName: 'Synthetic user',
  authorIsBot: false,
  mentionedUserIds: ['22222222222222222'],
  content: '<@22222222222222222> please review the synthetic launch checklist',
  timestamp: '2026-10-04T12:00:00.000Z',
};
const ROLE = '44444444444444444';

const testIssuer = 'https://discord-dot.example.test';
const testAuthorization = {
  grantId: 'synthetic-grant',
  tokenId: 'a'.repeat(64),
  clientId: 'synthetic-mcp-client',
  audience: `${testIssuer}/mcp`,
};

function testEnv() {
  const record = {
    id: testAuthorization.tokenId,
    userId: 'owner@example.test',
    grantId: testAuthorization.grantId,
    expiresAt: 4_000_000_000,
    audience: testAuthorization.audience,
    scope: ['discord:read', 'discord:reply'],
    grant: { clientId: testAuthorization.clientId },
  };
  return {
    ACCESS_OWNER_EMAIL: 'owner@example.test',
    MCP_ISSUER_URL: testIssuer,
    DISCORD_BOT_USER_ID: '22222222222222222',
    DISCORD_BOT_TOKEN: 'synthetic-bot-token',
    OAUTH_KV: {
      get: async (key: string) => key === `token:owner@example.test:${testAuthorization.grantId}:${testAuthorization.tokenId}` ? record : null,
    } as never,
  };
}

function memberFetch(roleIds: () => string[] = () => []) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const userId = url.pathname.split('/').at(-1)!;
    return new Response(JSON.stringify({ user: { id: userId }, roles: roleIds() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

class QuietGatewaySocket {
  readyState = 3;
  addEventListener(): void {}
  close(): void {}
}

function testRuntime(discordFetch = memberFetch(), now = () => Date.parse('2026-10-04T12:00:00.000Z')) {
  return {
    discordFetch,
    gatewayUrl: async () => 'wss://gateway.discord.gg',
    webSocket: () => new QuietGatewaySocket() as unknown as WebSocket,
    now,
  };
}

async function grantUser(bridge: BridgeStateDO, userId = candidate.authorId) {
  await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId: candidate.guildId });
  await bridge.mutateDiscordAuthorization({ action: 'grant-user', guildId: candidate.guildId, id: userId });
}

function testSubscription(now: number): EventSubscriptionInput {
  return {
    id: 'sub_synthetic',
    principal: 'owner@example.test',
    name: 'discord.message.mentioned',
    arguments: {} as Record<string, never>,
    url: 'https://receiver.example.com/callback',
    secret: `whsec_${Buffer.from(new Uint8Array(32).fill(4)).toString('base64')}`,
    refreshBefore: new Date(now + 60 * 60_000).toISOString(),
    authorization: testAuthorization,
  };
}

describe('BridgeState Durable Object outbox', () => {
  it('reports a caught Gateway socket failure while preserving persistence and retry behavior', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const now = Date.now();
    const storage = new MemoryStorage();
    const privateText = 'PRIVATE_SOCKET_TOKEN_CODE_STATE_ERROR';
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, testEnv(), {
      ...testRuntime(memberFetch(), () => now),
      webSocket: () => { throw new Error(privateText); },
    });
    const subscription = testSubscription(now);
    await expect(bridge.subscribe(subscription)).resolves.toMatchObject({ id: subscription.id });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'gateway', reason: 'socket_failed' }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'gateway', reason: 'returned' }));
    expect(log.mock.calls.some(([record]) => record.phase === 'gateway' && record.reason === 'succeeded')).toBe(false);
    expect((await storage.list({ prefix: 'subscription:' })).size).toBe(1);
    expect(storage.alarm).not.toBeNull();
    const serialized = JSON.stringify(log.mock.calls);
    for (const sensitive of [privateText, subscription.url, subscription.secret, subscription.principal,
      subscription.id, testAuthorization.tokenId, testAuthorization.grantId, testAuthorization.clientId]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it.each(['authorization', 'storage', 'gateway'] as const)('reports a subscription failure at the %s boundary without leaking inputs', async (phase) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const now = Date.now();
    const storage = new MemoryStorage();
    const env = phase === 'authorization'
      ? { ...testEnv(), OAUTH_KV: { get: async () => null } as never }
      : testEnv();
    const privateText = 'PRIVATE_TOKEN_CODE_STATE_BODY_ERROR';
    if (phase === 'storage') vi.spyOn(storage, 'transaction').mockRejectedValue(new Error(privateText));
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, env, {
      ...testRuntime(memberFetch(), () => now),
      gatewayUrl: async () => { throw new Error(privateText); },
    });
    const subscription = testSubscription(now);
    subscription.url += '?code=private-code&state=private-state';
    await expect(bridge.subscribe(subscription)).rejects.toThrow();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      phase, reason: 'failed', subscriptionStored: phase === 'gateway',
    }));
    expect((await storage.list({ prefix: 'subscription:' })).size).toBe(phase === 'gateway' ? 1 : 0);
    const serialized = JSON.stringify(log.mock.calls);
    for (const sensitive of [privateText, subscription.url, subscription.secret, subscription.principal, subscription.id,
      testAuthorization.tokenId, testAuthorization.grantId, testAuthorization.clientId, 'private-code', 'private-state']) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it.each(['', '   '])('reports an unavailable Gateway when the bot token is absent (%j)', async (token) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    const gatewayUrl = vi.fn(async () => 'wss://gateway.discord.gg');
    const webSocket = vi.fn(() => new QuietGatewaySocket() as unknown as WebSocket);
    const bridge = new BridgeStateDO(context as never, { ...testEnv(), DISCORD_BOT_TOKEN: token }, {
      ...testRuntime(memberFetch(), () => now), gatewayUrl, webSocket,
    });

    await bridge.subscribe(testSubscription(now));
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now))
      .resolves.toEqual({ state: 'unavailable', activeSubscriptions: 1 });
    expect(gatewayUrl).not.toHaveBeenCalled();
    expect(webSocket).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'gateway', reason: 'configuration_missing' }));
    expect(log.mock.calls.some(([record]) => record.phase === 'gateway' && record.reason === 'succeeded')).toBe(false);
  });

  it('reports an existing Gateway socket without creating another one', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const now = Date.now();
    const storage = new MemoryStorage();
    const socket = new QuietGatewaySocket();
    socket.readyState = 0;
    const webSocket = vi.fn(() => socket as unknown as WebSocket);
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, testEnv(), {
      ...testRuntime(memberFetch(), () => now), webSocket,
    });
    await bridge.subscribe(testSubscription(now));
    await bridge.subscribe(testSubscription(now));
    expect(webSocket).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'gateway', reason: 'cached' }));
  });

  it.each([4004, 4014])('reports a persisted terminal Gateway stop (%s) until the same subscription is refreshed', async (closeCode) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    const webSocket = vi.fn(() => new QuietGatewaySocket() as unknown as WebSocket);
    const runtime = { ...testRuntime(memberFetch(), () => now), webSocket };
    const bridge = new BridgeStateDO(context as never, testEnv(), runtime);
    const subscription = testSubscription(now);
    await bridge.subscribe(subscription);
    await storage.put('gateway:terminal-close-code', closeCode);
    webSocket.mockClear();

    const restarted = new BridgeStateDO(context as never, testEnv(), runtime);
    await restarted.alarm();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'gateway', reason: 'terminal_stopped' }));
    await expect(restarted.getAdminRuntimeStatus('owner@example.test', now))
      .resolves.toEqual({ state: 'unavailable', activeSubscriptions: 1 });
    expect(webSocket).not.toHaveBeenCalled();

    await restarted.subscribe(subscription);
    expect(await storage.get('gateway:terminal-close-code')).toBeUndefined();
    expect(webSocket).toHaveBeenCalledOnce();
    await expect(restarted.getAdminRuntimeStatus('owner@example.test', now))
      .resolves.toEqual({ state: 'connecting', activeSubscriptions: 1 });
  });

  it('reports Gateway readiness only with an authorized subscription and a READY socket', async () => {
    class StatusSocket {
      readyState = 1;
      listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        this.listeners.set(type, listener as (event: { data?: string; code?: number }) => void);
      }
      send(): void {}
      close(code = 1000): void {
        this.readyState = 3;
        this.listeners.get('close')?.({ code });
      }
      emitMessage(data: unknown): void { this.listeners.get('message')?.({ data: JSON.stringify(data) }); }
    }

    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const pending: Promise<unknown>[] = [];
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    let socket: StatusSocket | undefined;
    const bridge = new BridgeStateDO(context as never, testEnv() as never, {
      ...testRuntime(memberFetch(), () => now),
      webSocket: () => (socket = new StatusSocket()) as unknown as WebSocket,
    });
    const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

    await expect(bridge.getAdminRuntimeStatus('other@example.test', now)).rejects.toThrow('Owner authentication required');
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now)).resolves.toEqual({ state: 'idle', activeSubscriptions: 0 });
    const subscription = testSubscription(now);
    await bridge.subscribe(subscription);
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now)).resolves.toEqual({ state: 'connecting', activeSubscriptions: 1 });

    socket!.emitMessage({ op: 10, d: { heartbeat_interval: 30_000 } });
    await drain();
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now)).resolves.toMatchObject({ state: 'connecting' });
    socket!.emitMessage({ op: 0, s: 1, t: 'READY', d: {
      session_id: 'synthetic-status-session', resume_gateway_url: 'wss://gateway.discord.gg',
    } });
    await drain();
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now)).resolves.toEqual({ state: 'connected', activeSubscriptions: 1 });

    socket!.close(1006);
    await drain();
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now)).resolves.toMatchObject({ state: 'connecting' });
    await bridge.unsubscribe(subscription);
    await expect(bridge.getAdminRuntimeStatus('owner@example.test', now)).resolves.toEqual({ state: 'idle', activeSubscriptions: 0 });
  });

  it('stores one authorized origin and durably retries a signed event until acknowledged', async () => {
    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const responses = [500, 204];
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: responses.shift() ?? 500 }));
    const discordFetch = memberFetch();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const env = testEnv();
    const bridge = new BridgeStateDO(context as never, env, { ...testRuntime(discordFetch, () => now), fetch: createSecureWebhookFetch(fetch) });
    const subscription = testSubscription(now);
    await bridge.subscribe(subscription);
    await grantUser(bridge);

    await expect(bridge.recordMention(candidate)).resolves.toEqual({ status: 'accepted', eventId: candidate.messageId });
    await expect(bridge.recordMention(candidate)).resolves.toEqual({ status: 'duplicate', eventId: candidate.messageId });
    const pending = await storage.list({ prefix: 'delivery:' });
    expect(pending.size).toBe(1);
    expect(storage.alarm).toBe(now + 1_000);

    now += 1_000;
    await bridge.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    let retry = (await storage.list<{ attempts: number; nextAttemptAt: number }>({ prefix: 'delivery:' })).values().next().value;
    expect(retry).toMatchObject({ attempts: 1, nextAttemptAt: now + 5_000 });
    const firstInit = fetch.mock.calls[0]?.[1] as RequestInit;
    const firstHeaders = new Headers(firstInit.headers);
    const firstBody = new TextDecoder().decode(firstInit.body as ArrayBuffer);
    expect(firstHeaders.get('webhook-id')).toBe(candidate.messageId);
    expect(firstHeaders.has('authorization')).toBe(false);
    expect(firstInit.redirect).toBe('manual');
    expect(firstInit).not.toHaveProperty('cf');

    now += 5_000;
    await bridge.alarm();
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondInit = fetch.mock.calls[1]?.[1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers);
    expect(secondHeaders.get('webhook-id')).toBe(candidate.messageId);
    expect(new TextDecoder().decode(secondInit.body as ArrayBuffer)).toBe(firstBody);
    expect(secondInit.redirect).toBe('manual');
    expect(secondHeaders.get('webhook-signature')).toBe(await signWebhook(subscription.secret, candidate.messageId, secondHeaders.get('webhook-timestamp')!, firstBody));
    expect(secondHeaders.get('webhook-timestamp')).not.toBe(firstHeaders.get('webhook-timestamp'));
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
  });

  it('denies by default, persists runtime grants across restarts, and trusts only Discord current roles', async () => {
    let roles: string[] = [];
    const discordFetch = memberFetch(() => roles);
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    const env = testEnv();
    let bridge = new BridgeStateDO(context as never, env, testRuntime(discordFetch));

    await expect(bridge.recordMention(candidate)).resolves.toMatchObject({ status: 'rejected' });
    expect((await storage.list({ prefix: 'origin:' })).size).toBe(0);
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId: candidate.guildId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId: candidate.guildId, id: ROLE });

    // Extra role-like fields on an event are ignored; the Guild Member API is authoritative.
    await expect(bridge.recordMention({ ...candidate, memberRoles: [ROLE] } as GatewayMentionCandidate))
      .resolves.toMatchObject({ status: 'rejected' });
    roles = [ROLE];
    bridge = new BridgeStateDO(context as never, env, testRuntime(discordFetch));
    expect(await bridge.getDiscordAuthorization()).toEqual({
      guilds: { [candidate.guildId]: { userIds: [], roleIds: [ROLE] } },
    });
    await expect(bridge.recordMention(candidate)).resolves.toEqual({ status: 'accepted', eventId: candidate.messageId });
    expect(discordFetch).toHaveBeenCalledWith(
      `https://discord.com/api/v10/guilds/${candidate.guildId}/members/${candidate.authorId}`,
      expect.objectContaining({ headers: { authorization: 'Bot synthetic-bot-token', accept: 'application/json' } }),
    );
  });

  it('revoking a configured role invalidates a previously stored origin immediately', async () => {
    const discordFetch = memberFetch(() => [ROLE]);
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const callbackFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const bridge = new BridgeStateDO(context as never, testEnv(), {
      ...testRuntime(discordFetch, () => now),
      fetch: callbackFetch,
    });
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId: candidate.guildId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId: candidate.guildId, id: ROLE });
    await bridge.subscribe(testSubscription(now));
    await expect(bridge.recordMention(candidate)).resolves.toMatchObject({ status: 'accepted' });
    expect(await bridge.getOrigin(candidate.messageId)).not.toBeNull();

    await bridge.mutateDiscordAuthorization({ action: 'revoke-role', guildId: candidate.guildId, id: ROLE });
    now += 1_000;
    await bridge.alarm();
    expect(callbackFetch).not.toHaveBeenCalled();
    await expect(bridge.getOrigin(candidate.messageId)).resolves.toBeNull();
    expect((await storage.list({ prefix: 'origin:' })).size).toBe(0);
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
  });

  it('rechecks role membership before reads, queued event delivery, and replies', async () => {
    let roles = [ROLE];
    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    const callbackFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const discordFetch = memberFetch(() => roles);
    const env = testEnv();
    const bridge = new BridgeStateDO(context as never, env, {
      ...testRuntime(discordFetch, () => now),
      fetch: callbackFetch,
    });
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId: candidate.guildId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId: candidate.guildId, id: ROLE });
    await bridge.subscribe(testSubscription(now));
    await expect(bridge.recordMention(candidate)).resolves.toMatchObject({ status: 'accepted' });
    const origin = await bridge.getOrigin(candidate.messageId);
    expect(origin).not.toBeNull();
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(1);

    roles = [];
    await expect(bridge.getOrigin(candidate.messageId)).resolves.toBeNull();
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
    const messengerFetch = vi.fn(async () => new Response(JSON.stringify({ id: '77777777777777777' }), { status: 200 }));
    const messenger = new DiscordRestMessenger('synthetic-bot-token', messengerFetch as typeof fetch);
    await expect(messenger.replyToOrigin(origin!, 'Reply', () => bridge.isOriginAuthorized(origin!)))
      .rejects.toThrow('no longer authorized');
    expect(messengerFetch).not.toHaveBeenCalled();
    now += 1_000;
    await bridge.alarm();
    expect(callbackFetch).not.toHaveBeenCalled();
    expect(await bridge.getOrigin(candidate.messageId)).toBeNull();
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
  });

  it('removes queued deliveries when an authorized owner unsubscribes', async () => {
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    const env = testEnv();
    const bridge = new BridgeStateDO(context as never, env, testRuntime(memberFetch(), () => now));
    const subscription = testSubscription(now);
    await bridge.subscribe(subscription);
    await grantUser(bridge);
    await bridge.recordMention(candidate);
    await bridge.unsubscribe(subscription);
    expect((await storage.list({ prefix: 'subscription:' })).size).toBe(0);
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
  });

  it('stops an event subscription as soon as its OAuth access-token record is revoked', async () => {
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    let tokenActive = true;
    const baseEnv = testEnv();
    const env = {
      ...baseEnv,
      OAUTH_KV: {
        get: async (key: string) => tokenActive && key === `token:owner@example.test:${testAuthorization.grantId}:${testAuthorization.tokenId}`
          ? {
            id: testAuthorization.tokenId,
            userId: 'owner@example.test',
            grantId: testAuthorization.grantId,
            expiresAt: 4_000_000_000,
            audience: testAuthorization.audience,
            scope: ['discord:read', 'discord:reply'],
            grant: { clientId: testAuthorization.clientId },
          }
          : null,
      } as never,
    };
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const discordFetch = memberFetch();
    const context = { storage, waitUntil: () => undefined };
    const bridge = new BridgeStateDO(context as never, env, { ...testRuntime(discordFetch, () => now), fetch });
    await bridge.subscribe(testSubscription(now));
    await grantUser(bridge);
    await bridge.recordMention(candidate);
    tokenActive = false;

    await bridge.alarm();
    expect((await storage.list({ prefix: 'subscription:' })).size).toBe(0);
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('expires stored origin messages after seven days', async () => {
    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: () => undefined };
    const bridge = new BridgeStateDO(context as never, testEnv(), testRuntime(memberFetch(), () => now));
    await grantUser(bridge);
    await expect(bridge.recordMention(candidate)).resolves.toEqual({ status: 'accepted', eventId: candidate.messageId });
    expect(storage.alarm).toBe(now + 7 * 24 * 60 * 60_000);
    now += 7 * 24 * 60 * 60_000;

    await expect(bridge.getOrigin(candidate.messageId)).resolves.toBeNull();
    expect((await storage.list({ prefix: 'origin:' })).size).toBe(0);
    await bridge.alarm();
    expect(storage.alarm).toBeNull();
  });

  it('carries an authorized Gateway mention through durable MCP Events delivery and a reply to the same origin', async () => {
    class MockGatewaySocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, (event: { data?: string; code?: number }) => void>();
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        this.listeners.set(type, listener as (event: { data?: string; code?: number }) => void);
      }
      send(value: string): void { this.sent.push(value); }
      close(): void { this.readyState = 3; }
      emitMessage(data: unknown): void { this.listeners.get('message')?.({ data: JSON.stringify(data) }); }
    }

    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const storage = new MemoryStorage();
    const pending: Promise<unknown>[] = [];
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    const sockets: MockGatewaySocket[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const env = {
      ...testEnv(),
    };
    const typing = vi.fn(async () => new Response(null, { status: 204 }));
    const runtime = {
      fetch,
      discordFetch: async (input: RequestInfo | URL) => String(input).endsWith('/typing') ? typing() : memberFetch()(input),
      gatewayUrl: async () => 'wss://gateway.discord.gg',
      now: () => now,
      webSocket: () => {
        const socket = new MockGatewaySocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    };
    let bridge = new BridgeStateDO(context as never, env, runtime);
    await grantUser(bridge);
    const subscription = testSubscription(now);
    await bridge.subscribe(subscription);
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    const drain = async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    };

    socket.emitMessage({ op: 10, d: { heartbeat_interval: 30_000 } });
    await drain();
    expect(JSON.parse(socket.sent[0] ?? 'null')).toMatchObject({ op: 2, d: { token: 'synthetic-bot-token', intents: 512 } });
    socket.emitMessage({ op: 0, s: 2, t: 'READY', d: {
      session_id: 'synthetic-session', resume_gateway_url: 'wss://gateway-us-east1-a.discord.gg',
    } });
    await drain();

    // Recreate the Durable Object instance to model activation after a restart.
    socket.readyState = 3;
    bridge = new BridgeStateDO(context as never, env, runtime);
    await bridge.alarm();
    const resumedSocket = sockets[1]!;
    expect(resumedSocket).not.toBe(socket);
    resumedSocket.emitMessage({ op: 10, d: { heartbeat_interval: 30_000 } });
    await drain();
    expect(JSON.parse(resumedSocket.sent[0] ?? 'null')).toMatchObject({
      op: 6,
      d: { session_id: 'synthetic-session', seq: 2 },
    });
    resumedSocket.emitMessage({ op: 0, s: 3, t: 'RESUMED', d: {} });
    await drain();

    now += 30_000;
    await bridge.alarm();
    expect(JSON.parse(resumedSocket.sent[1] ?? 'null')).toEqual({ op: 1, d: 3 });
    resumedSocket.emitMessage({ op: 11, d: null });
    await drain();

    resumedSocket.emitMessage({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: {
      id: '66666666666666666',
      guild_id: '11111111111111111',
      channel_id: '55555555555555555',
      timestamp: '2026-10-04T12:00:00.000Z',
      content: '<@22222222222222222> please review the synthetic example checklist',
      author: { id: '33333333333333333', username: 'Synthetic user', bot: false },
      member: { nick: 'Synthetic user' },
      mentions: [{ id: '22222222222222222' }],
    } });
    await drain();
    now += 1_000;
    await bridge.alarm();

    expect(await bridge.getOrigin('66666666666666666')).toMatchObject({
      eventId: '66666666666666666', channelId: '55555555555555555', authorDisplayName: 'Synthetic user',
    });
    expect(fetch).toHaveBeenCalledOnce();
    await drain();
    expect(typing).toHaveBeenCalledOnce();
    const heartbeatDue = await storage.get('gateway:next-alarm-at');
    now += 6_000;
    await bridge.alarm();
    await drain();
    expect(typing).toHaveBeenCalledTimes(2);
    expect(resumedSocket.sent.map((value) => JSON.parse(value).op)).toEqual([6, 1]);
    expect(await storage.get('gateway:next-alarm-at')).toBe(heartbeatDue);
    const deliveryInit = fetch.mock.calls[0]?.[1] as RequestInit;
    const deliveryHeaders = new Headers(deliveryInit.headers);
    const event = JSON.parse(String(deliveryInit.body));
    expect(event).toMatchObject({
      eventId: '66666666666666666',
      name: 'discord.message.mentioned',
      data: { channel_id: '55555555555555555', author_display_name: 'Synthetic user', text: '<@22222222222222222> please review the synthetic example checklist' },
    });
    expect(deliveryHeaders.get('X-MCP-Subscription-Id')).toBe(subscription.id);

    const replyToOrigin = vi.fn(async (message: { channelId: string; messageId: string }, _text: string) => ({ messageId: '77777777777777777' }));
    const handler = createBridgeMcpHandler({
      policy: bridge,
      origins: bridge,
      recovery: bridge,
      channelAccess: bridge,
      outbound: bridge,
      eventsAuthorization: testAuthorization,
      discord: { replyToOrigin } as never,
      listChannels: async () => [],
      events: bridge,
      eventsEnabled: true,
      env,
    });
    const authInfo: AuthInfo = {
      token: 'synthetic-access-token',
      clientId: 'synthetic-client',
      scopes: [READ_SCOPE, REPLY_SCOPE],
      resource: new URL('https://discord-dot.test/mcp'),
      extra: { userId: 'owner@example.test' },
    };
    const transport = new StreamableHTTPClientTransport(new URL('https://discord-dot.test/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init), { authInfo }),
    });
    const client = new Client(
      { name: 'bridge-e2e-test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    try {
      const pending = await client.callTool({ name: 'discord_list_pending_mentions', arguments: {} });
      expect(JSON.parse((pending.content[0] as { text: string }).text).events).toEqual([
        { eventId: '66666666666666666', messageId: '66666666666666666', timestamp: candidate.timestamp, status: 'pending' },
      ]);
      const read = await client.callTool({ name: 'discord_get_origin_message', arguments: { eventId: '66666666666666666' } });
      expect(JSON.parse((read.content[0] as { text: string }).text).messageId).toBe('66666666666666666');
      const result = await client.callTool({
        name: 'discord_reply_to_origin',
        arguments: { eventId: '66666666666666666', text: 'Reviewed the checklist.' },
      });
      expect(result.isError).not.toBe(true);
      expect(replyToOrigin).toHaveBeenCalledWith(expect.objectContaining({
        channelId: '55555555555555555', messageId: '66666666666666666',
      }), 'Reviewed the checklist.', expect.any(Function));
      const repeated = await client.callTool({ name: 'discord_reply_to_origin', arguments: { eventId: '66666666666666666', text: 'Late wake.' } });
      expect(JSON.parse((repeated.content[0] as { text: string }).text).replyMessageId).toBe('77777777777777777');
      expect(replyToOrigin).toHaveBeenCalledTimes(1);
      now += 23_000;
      await bridge.alarm();
      await drain();
      expect(typing).toHaveBeenCalledTimes(2);
      expect(resumedSocket.sent.map((value) => JSON.parse(value).op)).toEqual([6, 1, 1]);
      const remaining = await client.callTool({ name: 'discord_list_pending_mentions', arguments: {} });
      expect(JSON.parse((remaining.content[0] as { text: string }).text).events).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('BridgeState Discord account linking', () => {
  const ownerEmail = 'owner@example.test';
  const linkedUserId = '33333333333333333';
  const guildId = '11111111111111111';
  const candidateExpiresAt = Date.parse('2026-10-04T12:05:00.000Z');

  function linkedAccount(): LinkedDiscordAccount {
    return {
      userId: linkedUserId,
      displayName: 'Synthetic owner account',
      linkedAt: Date.parse('2026-10-04T12:00:00.000Z'),
      candidates: [{ guildId, name: 'Synthetic guild' }],
      candidatesExpireAt: candidateExpiresAt,
    };
  }

  it('binds OAuth state to the configured owner, expires it, and consumes it once', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(memberFetch(), () => now));
    const hash = 'a'.repeat(64);

    await expect(bridge.beginDiscordOAuth('other@example.test', hash, now + 10 * 60_000)).rejects.toThrow('Owner authentication required');
    await bridge.beginDiscordOAuth(ownerEmail, hash, now + 10 * 60_000);
    await expect(bridge.consumeDiscordOAuthState('other@example.test', hash, now)).rejects.toThrow('Owner authentication required');
    expect(await bridge.consumeDiscordOAuthState(ownerEmail, 'b'.repeat(64), now)).toBe(false);
    expect(await bridge.consumeDiscordOAuthState(ownerEmail, hash, now)).toBe(true);
    expect(await bridge.consumeDiscordOAuthState(ownerEmail, hash, now)).toBe(false);

    await bridge.beginDiscordOAuth(ownerEmail, hash, now + 1_000);
    expect(await bridge.consumeDiscordOAuthState(ownerEmail, hash, now + 1_000)).toBe(false);
  });

  it('approves a linked server without granting users or roles and persists it', async () => {
    const storage = new MemoryStorage();
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(memberFetch());
    const env = testEnv();
    const bridge = new BridgeStateDO(context as never, env as never, testRuntime(discordFetch, () => now));

    await expect(bridge.approveLinkedServer('other@example.test', guildId, now)).rejects.toThrow('Owner authentication required');
    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());
    await expect(bridge.approveLinkedServer(ownerEmail, '99999999999999999', now)).rejects.toThrow('not in the current linked account list');
    expect(discordFetch).not.toHaveBeenCalled();

    discordFetch.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(bridge.approveLinkedServer(ownerEmail, guildId, now)).rejects.toThrow('bot must be in this server');
    expect((await bridge.getDiscordAuthorization()).guilds).toEqual({});

    await bridge.approveLinkedServer(ownerEmail, guildId, now);
    const expected = { guilds: { [guildId]: { userIds: [], roleIds: [] } } };
    expect(await bridge.getDiscordAuthorization()).toEqual(expected);
    expect(await bridge.getDiscordGuildNames()).toEqual({ [guildId]: 'Synthetic guild' });

    const restarted = new BridgeStateDO(context as never, env as never, testRuntime(memberFetch(), () => now));
    expect(await restarted.getDiscordAuthorization()).toEqual(expected);
    expect(await restarted.getDiscordGuildNames()).toEqual({ [guildId]: 'Synthetic guild' });
  });

  it('grants only the linked user after candidate, bot membership, and live state checks; storage survives restart', async () => {
    const storage = new MemoryStorage();
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const env = testEnv();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bot synthetic-bot-token');
      return Response.json({ user: { id: '22222222222222222' } });
    });
    const bridge = new BridgeStateDO(context as never, env as never, testRuntime(discordFetch, () => now));

    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());
    await expect(bridge.grantLinkedAccountToServer(ownerEmail, '99999999999999999', now)).rejects.toThrow('not in the current linked account list');
    expect(discordFetch).not.toHaveBeenCalled();

    discordFetch.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(bridge.grantLinkedAccountToServer(ownerEmail, guildId, now)).rejects.toThrow('bot must be in this server');
    expect((await bridge.getDiscordAuthorization()).guilds).toEqual({});

    discordFetch.mockImplementationOnce(async () => Response.json({ user: { id: '99999999999999999' } }));
    await expect(bridge.grantLinkedAccountToServer(ownerEmail, guildId, now)).rejects.toThrow('membership could not be verified');
    expect((await bridge.getDiscordAuthorization()).guilds).toEqual({});

    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId, id: ROLE });
    const updated = await bridge.grantLinkedAccountToServer(ownerEmail, guildId, now);
    expect(updated.guilds[guildId]).toEqual({ userIds: [linkedUserId], roleIds: [ROLE] });
    expect(await bridge.getDiscordGuildNames()).toEqual({ [guildId]: 'Synthetic guild' });

    const restarted = new BridgeStateDO(context as never, env as never, testRuntime(memberFetch(), () => now));
    expect(await restarted.getLinkedDiscordAccount(ownerEmail)).toEqual(linkedAccount());
    expect(await restarted.getDiscordAuthorization()).toEqual(updated);
    await restarted.unlinkDiscordAccount(ownerEmail);
    expect(await restarted.getLinkedDiscordAccount(ownerEmail)).toBeNull();
    expect(await restarted.getDiscordAuthorization()).toEqual(updated);
    expect(await restarted.getDiscordGuildNames()).toEqual({ [guildId]: 'Synthetic guild' });
  });

  it('denies a selected server after the linked candidate list expires', async () => {
    const storage = new MemoryStorage();
    let now = Date.parse('2026-10-04T12:00:00.000Z');
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(memberFetch());
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch, () => now));
    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());
    now = candidateExpiresAt;
    await bridge.alarm();
    expect(await bridge.getLinkedDiscordAccount(ownerEmail)).toMatchObject({ userId: linkedUserId, candidates: [] });
    await expect(bridge.grantLinkedAccountToServer(ownerEmail, guildId, candidateExpiresAt)).rejects.toThrow('not in the current linked account list');
    expect(discordFetch).not.toHaveBeenCalled();
    expect((await bridge.getDiscordAuthorization()).guilds).toEqual({});
  });

  it('requires a current linked owner membership and existing user or role grant for channel access', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    let roles: string[] = [];
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(memberFetch(() => roles)));
    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    expect(await bridge.isChannelAuthorized(ownerEmail, guildId)).toBe(false);
    await bridge.mutateDiscordAuthorization({ action: 'grant-user', guildId, id: linkedUserId });
    expect(await bridge.isChannelAuthorized(ownerEmail, guildId)).toBe(true);
    expect(await bridge.isAuthorizedMember(guildId, linkedUserId)).toEqual({ status: 'authorized' });
    expect(await bridge.isAuthorizedMember(guildId, '44444444444444444')).toEqual({ status: 'denied' });
    await bridge.mutateDiscordAuthorization({ action: 'revoke-user', guildId, id: linkedUserId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId, id: ROLE });
    roles = [ROLE];
    expect(await bridge.isChannelAuthorized(ownerEmail, guildId)).toBe(true);
    expect(await bridge.isAuthorizedMember(guildId, linkedUserId)).toEqual({ status: 'authorized' });
    await bridge.unlinkDiscordAccount(ownerEmail);
    expect(await bridge.isChannelAuthorized(ownerEmail, guildId)).toBe(false);
  });

  it('propagates unavailable membership checks instead of treating them as revoked access', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(async () => new Response(null, { status: 429 }));
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch));
    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId });

    await expect(bridge.isAuthorizedMember(guildId, linkedUserId)).resolves.toEqual({
      status: 'unavailable',
      reason: 'member_access_http_error',
      httpStatus: 429,
    });
    expect(discordFetch).toHaveBeenCalledOnce();
    await expect(bridge.isChannelAuthorized(ownerEmail, guildId))
      .rejects.toThrow('Current Discord membership could not be verified');
  });

  it('retries one rate-limited member lookup after the longest Discord retry hint', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const memberBody = JSON.stringify({ user: { id: candidate.authorId }, roles: [] });
    const discordFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 0.025 }), {
        status: 429,
        headers: { 'retry-after': '0.02', 'x-ratelimit-reset-after': '0.015' },
      }))
      .mockResolvedValueOnce(new Response(memberBody, { status: 200 }));
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch));
    await grantUser(bridge);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(bridge.isAuthorizedMember(guildId, candidate.authorId)).resolves.toEqual({ status: 'authorized' });
      expect(discordFetch).toHaveBeenCalledTimes(2);
      expect(timer.mock.calls.some(([, milliseconds]) => milliseconds === 25)).toBe(true);
    } finally { timer.mockRestore(); }
  });

  it('does not exceed one retry or wait longer than the member lookup retry cap', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 0.001 }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 2 }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: candidate.authorId }, roles: [] }), { status: 200 }));
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch));
    await grantUser(bridge);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      await expect(bridge.isAuthorizedMember(guildId, candidate.authorId)).resolves.toEqual({
        status: 'unavailable',
        reason: 'member_access_http_error',
        httpStatus: 429,
      });
      expect(discordFetch).toHaveBeenCalledTimes(2);
      expect(timer.mock.calls.some(([, milliseconds]) => milliseconds === 1)).toBe(true);
      expect(timer.mock.calls.some(([, milliseconds]) => milliseconds === 2_000)).toBe(false);
    } finally { timer.mockRestore(); }
  });

  it('fails closed without retrying when Discord requests a delay over the member lookup cap', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retry_after: 2 }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: candidate.authorId }, roles: [] }), { status: 200 }));
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch));
    await grantUser(bridge);

    await expect(bridge.isAuthorizedMember(guildId, candidate.authorId)).resolves.toEqual({
      status: 'unavailable',
      reason: 'member_access_http_error',
      httpStatus: 429,
    });
    expect(discordFetch).toHaveBeenCalledOnce();
  });

  it('returns cloneable, categorized member lookup outcomes without treating uncertainty as denial', async () => {
    const memberBody = JSON.stringify({ user: { id: candidate.authorId }, roles: [] });
    const cases = [
      {
        name: 'not granted', grant: false,
        response: () => new Response(memberBody, { status: 200 }),
        expected: { status: 'denied' },
      },
      {
        name: 'departed member', grant: true,
        response: () => new Response(null, { status: 404 }),
        expected: { status: 'denied' },
      },
      {
        name: 'rate limited', grant: true,
        response: () => new Response('null', { status: 429 }),
        expected: { status: 'unavailable', reason: 'member_access_http_error', httpStatus: 429 },
      },
      {
        name: 'Discord API failure', grant: true,
        response: () => new Response(null, { status: 503 }),
        expected: { status: 'unavailable', reason: 'member_access_http_error', httpStatus: 503 },
      },
      {
        name: 'invalid JSON', grant: true,
        response: () => new Response('{', { status: 200 }),
        expected: { status: 'unavailable', reason: 'member_access_invalid_response' },
      },
      {
        name: 'invalid roles', grant: true,
        response: () => new Response(JSON.stringify({ user: { id: candidate.authorId }, roles: [7] }), { status: 200 }),
        expected: { status: 'unavailable', reason: 'member_access_invalid_response' },
      },
    ];

    for (const testCase of cases) {
      const storage = new MemoryStorage();
      const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
      const discordFetch = vi.fn(async () => testCase.response());
      const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch));
      await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId });
      if (testCase.grant) {
        await bridge.mutateDiscordAuthorization({ action: 'grant-user', guildId, id: candidate.authorId });
      }

      const result = await bridge.isAuthorizedMember(guildId, candidate.authorId);
      expect(result, testCase.name).toEqual(testCase.expected);
      expect(structuredClone(result), testCase.name).toEqual(testCase.expected);
      expect(discordFetch).toHaveBeenCalledOnce();
    }
  });

  it('returns only a fixed request failure category when member lookup throws', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(async () => { throw new Error('PRIVATE_MEMBER_ID Bot synthetic-secret'); });
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch));
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-user', guildId, id: candidate.authorId });

    const result = await bridge.isAuthorizedMember(guildId, candidate.authorId);
    expect(result).toEqual({ status: 'unavailable', reason: 'member_access_request_failed' });
    expect(JSON.stringify(structuredClone(result))).not.toMatch(/PRIVATE_MEMBER_ID|synthetic-secret/);
  });

  it('reserves standalone sends transactionally and returns the receipt without storing message content or raw keys', async () => {
    const storage = new MemoryStorage();
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime());
    const rawKey = 'sensitive-idempotency-key';
    const requestHash = 'a'.repeat(64);
    const nonce = 'syntheticnonce1234567890';
    await expect(bridge.beginStandaloneMessage('other@example.test', rawKey, candidate.channelId, requestHash, nonce))
      .rejects.toThrow('Owner authentication required');
    await expect(bridge.beginStandaloneMessage('owner@example.test', rawKey, candidate.channelId, requestHash, nonce))
      .resolves.toEqual({ status: 'new' });
    await expect(bridge.beginStandaloneMessage('owner@example.test', rawKey, candidate.channelId, requestHash, nonce))
      .resolves.toEqual({ status: 'message_started' });
    await expect(bridge.beginStandaloneMessage('owner@example.test', rawKey, candidate.channelId, 'b'.repeat(64), nonce))
      .rejects.toThrow('different message');
    await bridge.completeStandaloneMessage('owner@example.test', rawKey, candidate.channelId, requestHash, '77777777777777777');
    await expect(bridge.beginStandaloneMessage('owner@example.test', rawKey, candidate.channelId, requestHash, nonce))
      .resolves.toEqual({ status: 'sent', messageId: '77777777777777777' });
    const records = await storage.list({ prefix: 'outbound-message:' });
    expect(records.size).toBe(1);
    expect([...records.keys()][0]).not.toContain(rawKey);
    expect(JSON.stringify([...records.values()])).not.toContain(rawKey);
    expect(JSON.stringify([...records.values()])).not.toContain('message content');
  });

  it('grants an individual user only after current membership is verified', async () => {
    const storage = new MemoryStorage();
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(memberFetch());
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch, () => now));

    await expect(bridge.grantUserToServer(ownerEmail, guildId, candidate.authorId, now)).rejects.toThrow('Approve the server');
    expect(discordFetch).not.toHaveBeenCalled();
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    const updated = await bridge.grantUserToServer(ownerEmail, guildId, candidate.authorId, now);
    expect(updated.guilds[guildId]).toEqual({ userIds: [candidate.authorId], roleIds: [] });
    expect(discordFetch.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname)).toEqual([
      `/api/v10/guilds/${guildId}/members/22222222222222222`,
      `/api/v10/guilds/${guildId}/members/${candidate.authorId}`,
    ]);

    discordFetch.mockImplementationOnce(async () => Response.json({ user: { id: '22222222222222222' } }))
      .mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(bridge.grantUserToServer(ownerEmail, guildId, '99999999999999999', now))
      .rejects.toThrow('not a current human member');
    expect((await bridge.getDiscordAuthorization()).guilds[guildId]?.userIds).toEqual([candidate.authorId]);
  });

  it('lists current bot-visible roles and explicitly grants only a selected non-everyone role', async () => {
    const storage = new MemoryStorage();
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const roles = [
      { id: guildId, name: '@everyone', position: 0 },
      { id: ROLE, name: 'Example reviewers', position: 2 },
      { id: '88888888888888888', name: '<Example> members', position: 3 },
    ];
    const discordFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bot synthetic-bot-token');
      if (url.pathname.endsWith('/members/22222222222222222')) {
        return Response.json({ user: { id: '22222222222222222' } });
      }
      if (url.pathname.endsWith('/roles')) return Response.json(roles);
      throw new Error(`Unexpected Discord request: ${url.pathname}`);
    });
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch, () => now));
    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());

    expect(await bridge.getLinkedServerRoles(ownerEmail, guildId, now)).toEqual(expect.arrayContaining([
      { roleId: ROLE, name: 'Example reviewers' },
      { roleId: '88888888888888888', name: '<Example> members' },
    ]));
    await expect(bridge.grantLinkedRoleToServer(ownerEmail, guildId, guildId, now)).rejects.toThrow('non-@everyone role');
    await expect(bridge.grantLinkedRoleToServer(ownerEmail, guildId, '99999999999999999', now)).rejects.toThrow('not available in the selected server');
    expect((await bridge.getDiscordAuthorization()).guilds).toEqual({});

    const updated = await bridge.grantLinkedRoleToServer(ownerEmail, guildId, ROLE, now);
    expect(updated.guilds[guildId]).toEqual({ userIds: [], roleIds: [ROLE] });
    expect(discordFetch).toHaveBeenCalledTimes(6);
    expect(discordFetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(await bridge.getDiscordGuildNames()).toEqual({ [guildId]: 'Synthetic guild' });
    expect(await bridge.getDiscordRoleNames(ownerEmail)).toEqual({ [guildId]: { [ROLE]: 'Example reviewers' } });

    await bridge.mutateDiscordAuthorization({ action: 'revoke-role', guildId, id: ROLE });
    expect(await bridge.getDiscordRoleNames(ownerEmail)).toEqual({});
  });

  it('does not list or grant roles when the bot is no longer in the selected server', async () => {
    const storage = new MemoryStorage();
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    const context = { storage, waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const discordFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const bridge = new BridgeStateDO(context as never, testEnv() as never, testRuntime(discordFetch, () => now));
    await bridge.saveLinkedDiscordAccount(ownerEmail, linkedAccount());

    await expect(bridge.getLinkedServerRoles(ownerEmail, guildId, now)).rejects.toThrow('bot must be in this server');
    await expect(bridge.grantLinkedRoleToServer(ownerEmail, guildId, ROLE, now)).rejects.toThrow('bot must be in this server');
    expect(discordFetch).toHaveBeenCalledTimes(2);
    expect((await bridge.getDiscordAuthorization()).guilds).toEqual({});
  });
});

describe('retained mention recovery', () => {
  async function setup() {
    let now = Date.parse(candidate.timestamp);
    let roles = [ROLE];
    const storage = new MemoryStorage();
    const env = testEnv();
    const runtime = { ...testRuntime(memberFetch(() => roles), () => now), fetch: vi.fn(async () => new Response('', { status: 200 })) };
    const bridge = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, env, runtime);
    await bridge.mutateDiscordAuthorization({ action: 'approve-server', guildId: candidate.guildId });
    await bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId: candidate.guildId, id: ROLE });
    const subscription = testSubscription(now);
    await bridge.subscribe(subscription);
    const list = (limit = 10, after?: string) => bridge.listPendingMentions(subscription.principal, testAuthorization, limit, after);
    return { bridge, storage, env, runtime, subscription, list, advance: (ms: number) => { now += ms; }, revokeRole: () => { roles = []; } };
  }

  it('recovers a delivered event after a missing-payload wake, survives restart, and never consumes on read', async () => {
    const { bridge, storage, env, runtime, list, advance } = await setup();
    await bridge.recordMention(candidate);
    advance(1_000);
    await bridge.alarm();
    expect((await storage.list({ prefix: 'delivery:' })).size).toBe(0);
    const expected = { events: [{ eventId: candidate.messageId, messageId: candidate.messageId, timestamp: candidate.timestamp, status: 'pending' }], nextCursor: null };
    await expect(list()).resolves.toEqual(expected);
    await expect(list()).resolves.toEqual(expected);
    const restarted = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, env, runtime);
    await expect(restarted.listPendingMentions('owner@example.test', testAuthorization, 10)).resolves.toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain(candidate.content);
  });

  it('records ownership for existing subscriptions without backfilling earlier mentions', async () => {
    const { bridge, storage, subscription, list } = await setup();
    const stored = await storage.get<Record<string, unknown>>(`subscription:${subscription.id}`);
    delete stored!.recoveryId;
    await bridge.recordMention(candidate);
    expect((await list()).events).toHaveLength(1);
    expect(await storage.get(`subscription:${subscription.id}`)).toHaveProperty('recoveryId');
  });

  it('preserves an ownership ID created by intake while a legacy subscription refresh awaits OAuth', async () => {
    const { bridge, storage, subscription, env, list } = await setup();
    const stored = await storage.get<Record<string, unknown>>(`subscription:${subscription.id}`);
    delete stored!.recoveryId;
    const kv = env.OAUTH_KV as { get: (key: string) => Promise<unknown> };
    const originalGet = kv.get;
    let release!: () => void;
    let signalCheck!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const checking = new Promise<void>((resolve) => { signalCheck = resolve; });
    // pruneExpiredSubscriptions checks first; block the refresh's subsequent OAuth check.
    vi.spyOn(kv, 'get').mockImplementationOnce(originalGet).mockImplementationOnce(async (key) => {
      signalCheck();
      await blocked;
      return originalGet(key);
    });
    const refresh = bridge.subscribe(subscription);
    await checking;
    await bridge.recordMention(candidate);
    const acceptedOwnership = (await storage.get<{ recoveryId: string }>(`subscription:${subscription.id}`))!.recoveryId;
    release();
    await refresh;
    expect((await storage.get<{ recoveryId: string }>(`subscription:${subscription.id}`))!.recoveryId).toBe(acceptedOwnership);
    expect((await list()).events).toHaveLength(1);
  });

  it('rechecks subscription access after the live Discord membership lookup', async () => {
    const { bridge, storage, subscription, runtime, list } = await setup();
    await bridge.recordMention(candidate);
    runtime.discordFetch.mockImplementation(async () => {
      await storage.delete(`subscription:${subscription.id}`);
      return Response.json({ user: { id: candidate.authorId }, roles: [ROLE] });
    });
    expect((await list()).events).toEqual([]);
  });

  it('isolates principals, grants, clients and audiences and excludes mentions before subscription', async () => {
    const { bridge, storage, subscription, list } = await setup();
    await bridge.recordMention(candidate);
    for (const patch of [{ grantId: 'another-grant' }, { clientId: 'another-client' }, { audience: 'https://another.test/mcp' }]) {
      expect((await bridge.listPendingMentions(subscription.principal, { ...testAuthorization, ...patch }, 10)).events).toEqual([]);
    }
    expect((await bridge.listPendingMentions('another@example.test', testAuthorization, 10)).events).toEqual([]);
    await bridge.unsubscribe(subscription);
    await bridge.recordMention({ ...candidate, messageId: '77777777777777777' });
    await bridge.subscribe(subscription);
    expect((await list()).events).toEqual([]);
    // Legacy accepted origins lack subscription ownership and are never backfilled/reoffered.
    const stored = await storage.get<Record<string, unknown>>(`origin:${candidate.messageId}`);
    delete stored!.recipients;
    expect((await list()).events).toEqual([]);
  });

  it.each(['subscription', 'token', 'origin', 'server', 'user', 'role', 'member'] as const)('excludes expired or revoked %s access', async (kind) => {
    const { bridge, storage, env, list, advance, revokeRole, runtime } = await setup();
    await bridge.recordMention(candidate);
    if (kind === 'subscription') advance(60 * 60_000);
    if (kind === 'origin') {
      const origin = await storage.get<Record<string, unknown>>(`origin:${candidate.messageId}`);
      origin!.expiresAt = 0;
    }
    if (kind === 'token') vi.spyOn(env.OAUTH_KV as { get: () => Promise<unknown> }, 'get').mockResolvedValue(null);
    if (kind === 'server') await bridge.mutateDiscordAuthorization({ action: 'revoke-server', guildId: candidate.guildId });
    if (kind === 'role') revokeRole();
    if (kind === 'member') runtime.discordFetch.mockImplementation(async () => new Response('', { status: 404 }));
    if (kind === 'user') {
      await bridge.mutateDiscordAuthorization({ action: 'revoke-role', guildId: candidate.guildId, id: ROLE });
      await bridge.mutateDiscordAuthorization({ action: 'grant-user', guildId: candidate.guildId, id: candidate.authorId });
      await bridge.mutateDiscordAuthorization({ action: 'revoke-user', guildId: candidate.guildId, id: candidate.authorId });
    }
    expect((await list()).events).toEqual([]);
  });

  it('fails closed on unavailable membership and does not store rejected mentions', async () => {
    const { bridge, list, runtime } = await setup();
    expect((await bridge.recordMention({ ...candidate, authorIsBot: true })).status).toBe('rejected');
    expect((await list()).events).toEqual([]);
    await bridge.recordMention(candidate);
    runtime.discordFetch.mockImplementation(async () => new Response('', { status: 503 }));
    expect((await list()).events).toEqual([]);
    runtime.discordFetch.mockImplementation(memberFetch(() => [ROLE]));
    expect((await list()).events).toHaveLength(1);
  });

  it('bounds scans and paginates deterministically through empty pages; late arrivals appear on the next wake', async () => {
    const { bridge, storage, list } = await setup();
    const ids = ['88888888888888888', '66666666666666666', '77777777777777777'];
    for (const messageId of ids) await bridge.recordMention({ ...candidate, messageId });
    const first = await storage.get<Record<string, unknown>>('origin:66666666666666666');
    delete first!.recipients;
    const page1 = await list(1);
    expect(page1.events).toEqual([]);
    expect(page1.nextCursor).toBeTypeOf('string');
    expect(page1.nextCursor).not.toContain('66666666666666666');
    const page2 = await list(1, page1.nextCursor!);
    expect(page2.events[0].eventId).toBe('77777777777777777');
    const page3 = await list(1, page2.nextCursor!);
    expect(page3.events[0].eventId).toBe('88888888888888888');
    expect(await list(1, page3.nextCursor!)).toEqual({ events: [], nextCursor: null });
    await bridge.recordMention({ ...candidate, messageId: '55555555555555555' });
    expect((await list()).events.map((e) => e.eventId)).toEqual(['55555555555555555', '77777777777777777', '88888888888888888']);
    await expect(list(21)).rejects.toThrow();
  });

  it.each([false, true])('paginates slow serial checks without skipping records (unavailable first: %s)', async (unavailableFirst) => {
    const { bridge, runtime, advance, list } = await setup();
    const ids = ['66666666666666666', '77777777777777777', '88888888888888888'];
    for (const messageId of ids) await bridge.recordMention({ ...candidate, messageId });
    runtime.discordFetch.mockClear();
    let active = 0;
    let peak = 0;
    runtime.discordFetch.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      advance(6_000);
      active -= 1;
      return unavailableFirst ? new Response('', { status: 503 })
        : Response.json({ user: { id: candidate.authorId }, roles: [ROLE] });
    });
    const first = await list(20);
    expect(runtime.discordFetch).toHaveBeenCalledTimes(1);
    expect(first.events.map((entry) => entry.eventId)).toEqual(unavailableFirst ? [] : [ids[0]]);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await list(20, first.nextCursor!);
    expect(runtime.discordFetch).toHaveBeenCalledTimes(2);
    expect(second.events.map((entry) => entry.eventId)).toEqual(unavailableFirst ? [] : [ids[1]]);
    const third = await list(20, second.nextCursor!);
    expect(runtime.discordFetch).toHaveBeenCalledTimes(3);
    expect(third.events.map((entry) => entry.eventId)).toEqual(unavailableFirst ? [] : [ids[2]]);
    expect(third.nextCursor).toBeNull();
    expect(peak).toBe(1);
    // A transient failure did not consume the accepted events.
    runtime.discordFetch.mockImplementation(memberFetch(() => [ROLE]));
    expect((await list()).events.map((entry) => entry.eventId)).toEqual(ids);
  });

  it.each(['missing', 'changed', 'unreserved', 'expired', 'conflicting receipt'] as const)('rejects reply completion for a %s origin', async (failure) => {
    const { bridge, storage } = await setup();
    await bridge.recordMention(candidate);
    const origin = (await bridge.getOrigin(candidate.messageId))!;
    await bridge.beginReply(origin);
    const key = `origin:${origin.eventId}`;
    const stored = await storage.get<Record<string, unknown>>(key);
    if (failure === 'missing') await storage.delete(key);
    if (failure === 'changed') stored!.content = 'Different origin';
    if (failure === 'unreserved') delete stored!.reply;
    if (failure === 'expired') stored!.expiresAt = 0;
    if (failure === 'conflicting receipt') stored!.reply = { status: 'replied', replyMessageId: '77777777777777777' };
    const before = structuredClone(await storage.get(key));
    await expect(bridge.completeReply(origin, '99999999999999999')).rejects.toThrow();
    expect(await storage.get(key)).toEqual(before);
  });

  it('leaves the reply reservation intact when the receipt write fails', async () => {
    const { bridge, storage } = await setup();
    await bridge.recordMention(candidate);
    const origin = (await bridge.getOrigin(candidate.messageId))!;
    await bridge.beginReply(origin);
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(bridge.completeReply(origin, '99999999999999999')).rejects.toThrow('Storage unavailable');
    await expect(bridge.beginReply(origin)).resolves.toEqual({ status: 'reply_started' });
  });

  it('binds opaque cursors to caller access and rejects tampering or token renewal', async () => {
    const { bridge, list } = await setup();
    await bridge.recordMention(candidate);
    const { nextCursor } = await list(1);
    expect(nextCursor).not.toContain(candidate.messageId);
    await expect(list(1, 'tampered')).rejects.toThrow();
    await expect(bridge.listPendingMentions('another@example.test', testAuthorization, 1, nextCursor!)).rejects.toThrow();
    for (const patch of [{ grantId: 'another-grant' }, { clientId: 'another-client' }, { audience: 'https://another.test/mcp' }, { tokenId: 'b'.repeat(64) }]) {
      await expect(bridge.listPendingMentions('owner@example.test', { ...testAuthorization, ...patch }, 1, nextCursor!)).rejects.toThrow();
    }
    expect(await list(1, nextCursor!)).toEqual({ events: [], nextCursor: null });
  });

  it('preserves ownership on refresh but never grants old mentions to a replacement subscription', async () => {
    const { bridge, subscription, list, advance } = await setup();
    await bridge.recordMention(candidate);
    await bridge.subscribe({ ...subscription, refreshBefore: new Date(Date.parse(subscription.refreshBefore) + 1000).toISOString() });
    expect((await list()).events).toHaveLength(1);
    advance(60 * 60_000 + 1000);
    await bridge.subscribe({ ...subscription, refreshBefore: new Date(Date.parse(subscription.refreshBefore) + 60 * 60_000).toISOString() });
    expect((await list()).events).toEqual([]);
  });

  it('serializes competing replies, reports an uncertain send, and excludes completed replies after restart', async () => {
    const { bridge, storage, env, runtime, list } = await setup();
    await bridge.recordMention(candidate);
    const origin = (await bridge.getOrigin(candidate.messageId))!;
    const claims = await Promise.all([bridge.beginReply(origin), bridge.beginReply(origin)]);
    expect(claims).toEqual([null, { status: 'reply_started' }]);
    expect((await list()).events[0].status).toBe('reply_started');
    await bridge.completeReply(origin, '99999999999999999');
    await expect(bridge.completeReply(origin, '99999999999999999')).resolves.toBeUndefined();
    expect((await list()).events).toEqual([]);
    const restarted = new BridgeStateDO({ storage, waitUntil: () => undefined } as never, env, runtime);
    await expect(restarted.beginReply(origin)).resolves.toEqual({ status: 'replied', replyMessageId: '99999999999999999' });
    // Internal recipients and reply state never leak through the existing origin read.
    expect(origin).not.toHaveProperty('recipients');
    expect(origin).not.toHaveProperty('reply');
  });
});

describe('native typing lifecycle', () => {
  async function setup(subscribe = true) {
    let now = Date.parse(candidate.timestamp);
    let roles: string[] = [];
    const storage = new MemoryStorage();
    const pending: Promise<unknown>[] = [];
    const context = { storage, waitUntil: (work: Promise<unknown>) => { pending.push(work); } };
    const env = testEnv();
    const typing = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const membership = memberFetch(() => roles);
    const discordFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/typing') ? typing(input, init) : membership(input));
    const runtime = { ...testRuntime(discordFetch, () => now), fetch: vi.fn(async () => new Response(null, { status: 204 })) };
    let bridge = new BridgeStateDO(context as never, env, runtime);
    await grantUser(bridge);
    const subscription = testSubscription(now);
    if (subscribe) await bridge.subscribe(subscription);
    const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    return {
      get bridge() { return bridge; }, storage, env, typing, membership, subscription, runtime, drain,
      get now() { return now; }, advance: (ms: number) => { now += ms; },
      roles: (value: string[]) => { roles = value; },
      restart: () => { bridge = new BridgeStateDO(context as never, env, runtime); },
      tick: async () => { await bridge.alarm(); await drain(); },
      accept: async (value = candidate) => { const result = await bridge.recordMention(value); await drain(); return result; },
    };
  }

  it('starts promptly only for accepted mentions with a live authorized recipient', async () => {
    const t = await setup();
    for (const invalid of [
      { ...candidate, mentionedUserIds: [] }, { ...candidate, authorIsBot: true },
      { ...candidate, authorId: '99999999999999999' }, { ...candidate, guildId: '99999999999999999' },
      { ...candidate, guildId: '' },
    ]) expect((await t.accept(invalid)).status).toBe('rejected');
    expect(t.typing).not.toHaveBeenCalled();
    expect((await t.accept()).status).toBe('accepted');
    expect(t.typing).toHaveBeenCalledOnce();
    expect(t.typing).toHaveBeenCalledWith(`https://discord.com/api/v10/channels/${candidate.channelId}/typing`,
      expect.objectContaining({ method: 'POST', redirect: 'manual', headers: { authorization: 'Bot synthetic-bot-token' } }));
    expect((await t.accept()).status).toBe('duplicate');
    expect(t.typing).toHaveBeenCalledOnce();
    const noSubscriber = await setup(false);
    await noSubscriber.accept();
    expect(noSubscriber.typing).not.toHaveBeenCalled();
    const revoked = await setup();
    revoked.env.OAUTH_KV = { get: async () => null } as never;
    await revoked.accept();
    expect(revoked.typing).not.toHaveBeenCalled();
  });

  it('refreshes at seven seconds across restart and retains Gateway and delivery deadlines', async () => {
    const t = await setup();
    await t.accept();
    expect(t.storage.alarm).toBe(t.now + 1_000); // callback before typing
    const heartbeat = await t.storage.get('gateway:next-alarm-at');
    t.advance(1_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
    expect(t.storage.alarm).toBe(t.now + 6_000);
    expect(await t.storage.get('gateway:next-alarm-at')).toBeTypeOf('number');
    t.advance(5_999);
    t.restart();
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
    t.advance(1);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
    expect(heartbeat).toBeTypeOf('number');
  });

  it('coalesces concurrent mentions and duplicate alarms, stopping only the replied event', async () => {
    const t = await setup();
    const second = { ...candidate, messageId: '66666666666666667' };
    await Promise.all([t.bridge.recordMention(candidate), t.bridge.recordMention(second), t.bridge.recordMention(candidate)]);
    await t.drain();
    expect(t.typing).toHaveBeenCalledOnce();
    const origin = (await t.bridge.getOrigin(candidate.messageId))!;
    await t.bridge.beginReply(origin);
    await t.bridge.completeReply(origin, '77777777777777777');
    await t.bridge.stopTyping(origin);
    t.advance(7_000);
    await Promise.all([t.bridge.alarm(), t.bridge.alarm()]);
    await t.drain();
    expect(t.typing).toHaveBeenCalledTimes(2);
    const other = (await t.bridge.getOrigin(second.messageId))!;
    await t.bridge.stopTyping(other);
    t.advance(7_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
    expect((await t.storage.list({ prefix: 'typing:channel:' })).size).toBe(0);
  });

  it('keeps typing during a reply send, then stops on confirmed completion', async () => {
    const t = await setup();
    await t.accept();
    const origin = (await t.bridge.getOrigin(candidate.messageId))!;
    await t.bridge.beginReply(origin);
    t.advance(7_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
    await t.bridge.completeReply(origin, '77777777777777777');
    t.advance(7_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
  });

  it('expires each event five minutes after acceptance without extending it on duplicate delivery or restart', async () => {
    const t = await setup();
    await t.accept();
    const key = `typing:channel:${candidate.channelId}`;
    const original = await t.storage.get<{ events: Record<string, number> }>(key);
    t.advance(299_000);
    await t.accept();
    t.restart();
    await t.tick();
    expect((await t.storage.get<{ events: Record<string, number> }>(key))?.events).toEqual(original?.events);
    expect(t.typing).toHaveBeenCalledTimes(2);
    expect(t.storage.alarm).toBe(t.now + 1_000);
    t.advance(1_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
    t.advance(60_000);
    await t.tick();
    expect((await t.storage.list({ prefix: 'typing:channel:' })).size).toBe(0);
  });

  it.each(['unsubscribe', 'replace-subscription', 'expiry', 'oauth', 'server', 'user', 'role', 'member', 'origin', 'terminal'])(
    'stops refreshes after %s revocation or expiry', async (reason) => {
      const t = await setup();
      if (reason === 'role') {
        await t.bridge.mutateDiscordAuthorization({ action: 'revoke-user', guildId: candidate.guildId, id: candidate.authorId });
        await t.bridge.mutateDiscordAuthorization({ action: 'grant-role', guildId: candidate.guildId, id: ROLE });
        t.roles([ROLE]);
      }
      await t.accept();
      expect(t.typing).toHaveBeenCalledOnce();
      if (reason === 'unsubscribe' || reason === 'replace-subscription') await t.bridge.unsubscribe(t.subscription);
      if (reason === 'replace-subscription') await t.bridge.subscribe(t.subscription);
      if (reason === 'expiry') t.advance(60 * 60_000);
      if (reason === 'oauth') t.env.OAUTH_KV = { get: async () => null } as never;
      if (reason === 'server') await t.bridge.mutateDiscordAuthorization({ action: 'revoke-server', guildId: candidate.guildId });
      if (reason === 'user') await t.bridge.mutateDiscordAuthorization({ action: 'revoke-user', guildId: candidate.guildId, id: candidate.authorId });
      if (reason === 'role') t.roles([]);
      if (reason === 'member') t.membership.mockImplementation(async () => new Response(null, { status: 404 }));
      if (reason === 'origin') await t.storage.delete(`origin:${candidate.messageId}`);
      if (reason === 'terminal') await t.storage.put('gateway:terminal-close-code', 4004);
      t.advance(7_000);
      await t.tick();
      expect(t.typing).toHaveBeenCalledOnce();
    },
  );

  it('honors a persisted global rate limit across channels and a new instance', async () => {
    const t = await setup();
    t.typing.mockImplementationOnce(async () => Response.json({ retry_after: 20, global: true }, { status: 429 }));
    await t.accept();
    t.advance(1_000);
    await t.accept({ ...candidate, messageId: '66666666666666667', channelId: '55555555555555556' });
    t.restart();
    t.advance(18_999);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
    t.advance(1);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
    t.advance(250);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404])('stops the pending batch on terminal typing status %s without removing origins', async (status) => {
    const t = await setup();
    t.typing.mockImplementation(async () => new Response(null, { status }));
    await t.accept();
    t.advance(60_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
    expect(await t.bridge.getOrigin(candidate.messageId)).not.toBeNull();
  });

  it('backs off on transport errors without blocking intake, callbacks or replies', async () => {
    const t = await setup();
    t.typing.mockRejectedValueOnce(new Error('synthetic network failure'));
    expect((await t.accept()).status).toBe('accepted');
    t.advance(7_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
    expect(t.runtime.fetch).toHaveBeenCalledOnce();
    t.advance(7_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
    const origin = (await t.bridge.getOrigin(candidate.messageId))!;
    await expect(t.bridge.beginReply(origin)).resolves.toBeNull();
    await expect(t.bridge.completeReply(origin, '77777777777777777')).resolves.toBeUndefined();
  });

  it('cannot revive typing when reply cleanup occurs during a pending typing request', async () => {
    const t = await setup();
    let finish!: (response: Response) => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    t.typing.mockImplementationOnce(async () => {
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    await t.bridge.recordMention(candidate);
    await start;
    const origin = (await t.bridge.getOrigin(candidate.messageId))!;
    await t.bridge.stopTyping(origin);
    finish(new Response(null, { status: 204 }));
    await t.drain();
    t.advance(7_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
  });

  it('waits out the persisted request lease after a restart during uncertain work', async () => {
    const t = await setup();
    await t.accept();
    const key = `typing:channel:${candidate.channelId}`;
    const channel = await t.storage.get<Record<string, unknown>>(key);
    await t.storage.put(key, { ...channel, nextAttemptAt: t.now + 30_000 });
    t.restart();
    t.advance(29_999);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
    t.advance(1);
    await t.tick();
    expect(t.typing).toHaveBeenCalledTimes(2);
  });

  it.each(['reply', 'unsubscribe', 'revoke'])('rechecks durable state when %s occurs during authorization', async (action) => {
    const t = await setup();
    await t.accept();
    t.advance(1_000);
    await t.tick(); // Finish delivery so only typing is due next.
    const origin = (await t.bridge.getOrigin(candidate.messageId))!;
    t.membership.mockImplementationOnce(async (input) => {
      if (action === 'reply') await t.bridge.stopTyping(origin);
      if (action === 'unsubscribe') await t.bridge.unsubscribe(t.subscription);
      if (action === 'revoke') await t.bridge.mutateDiscordAuthorization({ action: 'revoke-server', guildId: candidate.guildId });
      return memberFetch()(input);
    });
    t.advance(6_000);
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
  });

  it('checks expiry again after a slow authorization request and preserves the recovery lease', async () => {
    const t = await setup();
    await t.accept();
    t.advance(7_000);
    t.membership.mockImplementationOnce(async (input) => {
      t.advance(5 * 60_000);
      return memberFetch()(input);
    });
    await t.tick();
    expect(t.typing).toHaveBeenCalledOnce();
  });
});
