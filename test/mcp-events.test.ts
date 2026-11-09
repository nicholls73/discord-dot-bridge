import { describe, expect, it, vi } from 'vitest';
import {
  EventProtocolError,
  handleEventProtocolRequest,
  isValidSigningSecret,
  postSignedEvent,
  retryDelayMs,
  signWebhook,
  validateCallbackUrl,
  verifyCallback,
  type EventSubscriptionInput,
} from '../src/mcp-events.js';
import { TASK_CAPTURED_EVENT_NAME, TASK_REMINDER_EVENT_NAME } from '../src/task-reminders.js';

const secret = `whsec_${Buffer.from(new Uint8Array(32).fill(7)).toString('base64')}`;
const subscription: EventSubscriptionInput = {
  id: 'sub_test',
  principal: 'owner@example.test',
  name: 'discord.message.mentioned',
  arguments: {} as Record<string, never>,
  url: 'https://receiver.example.com/mcp-events/callback',
  secret,
  refreshBefore: '2026-10-05T12:00:00.000Z',
};

describe('MCP webhook event security', () => {
  it('lists task events only when configured and requires both separately consented scopes to subscribe', async () => {
    const backend = {
      subscribe: vi.fn(async (value: EventSubscriptionInput) => ({ id: value.id, refreshBefore: value.refreshBefore })),
      unsubscribe: vi.fn(async () => undefined),
      callbackVerified: vi.fn(async () => true),
    };
    const list = await handleEventProtocolRequest(new Request('https://bridge.example.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list' }),
    }), backend, { principal: subscription.principal, canRead: true, canReply: true, eventsEnabled: true, taskEventsEnabled: true });
    const listed = await list!.json() as { result: { events: Array<{ name: string }> } };
    expect(listed.result.events.map((event) => event.name)).toContain(TASK_CAPTURED_EVENT_NAME);
    expect(listed.result.events.map((event) => event.name)).toContain(TASK_REMINDER_EVENT_NAME);

    const request = (name: string) => new Request('https://bridge.example.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'events/subscribe', params: {
        name, arguments: {}, delivery: { mode: 'webhook', url: subscription.url, secret },
      } }),
    });
    const missingScopes = await handleEventProtocolRequest(request(TASK_CAPTURED_EVENT_NAME), backend, {
      principal: subscription.principal, canRead: true, canReply: true, eventsEnabled: true, taskEventsEnabled: true,
    });
    expect((await missingScopes!.json() as { error?: { code: number } }).error).toMatchObject({ code: -32001 });
    expect(backend.subscribe).not.toHaveBeenCalled();

    const approved = await handleEventProtocolRequest(request(TASK_CAPTURED_EVENT_NAME), backend, {
      principal: subscription.principal, canRead: true, canReply: true, eventsEnabled: true, taskEventsEnabled: true,
      canManageTasks: true, canReadChannelHistory: true,
    });
    expect((await approved!.json() as { result?: { id: string } }).result).toMatchObject({ id: expect.any(String) });
    expect(backend.subscribe).toHaveBeenCalledOnce();
    expect(backend.subscribe.mock.calls[0]![0].name).toBe(TASK_CAPTURED_EVENT_NAME);
  });

  it('validates HTTPS callback addresses and rejects local, reserved, and IP-literal targets', () => {
    expect(validateCallbackUrl(subscription.url)).toBe(subscription.url);
    for (const url of [
      'http://receiver.example.com/callback',
      'https://localhost./callback',
      'https://service.local/callback',
      'https://127.0.0.1/callback',
      'https://[::1]/callback',
      'https://receiver.example.test/callback',
      'https://user@receiver.example.com/callback',
      'https://receiver.example.com:8443/callback',
    ]) {
      expect(() => validateCallbackUrl(url)).toThrow(EventProtocolError);
    }
  });

  it('requires standard webhook secrets with 24 to 64 decoded bytes', () => {
    expect(isValidSigningSecret(secret)).toBe(true);
    expect(isValidSigningSecret(`whsec_${Buffer.from(new Uint8Array(23)).toString('base64')}`)).toBe(false);
    expect(isValidSigningSecret('whsec_not-base64')).toBe(false);
    expect(isValidSigningSecret('secret')).toBe(false);
  });

  it('verifies a fresh signed callback challenge and blocks redirects', async () => {
    const ids = ['verification-id', 'single-use-challenge'];
    let sent: { request: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      sent = { request, init };
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ challenge: body.challenge }), { status: 202 });
    });
    await verifyCallback(
      subscription,
      (eventId, timestamp, body) => signWebhook(subscription.secret, eventId, timestamp, body),
      fetcher,
      () => ids.shift() ?? 'fallback',
    );

    expect(sent?.request).toBe(subscription.url);
    expect(sent?.init?.redirect).toBe('manual');
    const headers = new Headers(sent?.init?.headers);
    expect(headers.get('webhook-id')).toBe('msg_verification_verification-id');
    expect(headers.get('X-MCP-Subscription-Id')).toBe(subscription.id);
    const body = String(sent?.init?.body);
    const timestamp = headers.get('webhook-timestamp') ?? '';
    expect(headers.get('webhook-signature')).toBe(await signWebhook(secret, 'msg_verification_verification-id', timestamp, body));
    expect(JSON.parse(body)).toMatchObject({ type: 'verification', challenge: 'single-use-challenge' });
  });

  it('rejects callback verification redirects without following the Location', async () => {
    const fetcher = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => new Response('redirect response', {
      status: 302,
      headers: { location: 'https://redirect-target.example.test/callback' },
    }));
    const ids = ['verification-redirect-id', 'single-use-challenge'];

    await expect(verifyCallback(
      subscription,
      (eventId, timestamp, body) => signWebhook(subscription.secret, eventId, timestamp, body),
      fetcher,
      () => ids.shift() ?? 'fallback',
    )).rejects.toMatchObject({ data: { reason: 'redirect' } });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('signs the exact event body with fresh timestamp and both rotation keys', async () => {
    const previousSecret = `whsec_${Buffer.from(new Uint8Array(24).fill(2)).toString('base64')}`;
    const event = { eventId: '66666666666666666', name: 'discord.message.mentioned', timestamp: '2026-10-04T12:00:00.000Z', data: { text: 'hello' }, cursor: null };
    let sent: { request: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      sent = { request, init };
      return new Response(null, { status: 204 });
    });
    const result = await postSignedEvent({
      ...subscription,
      previousSecret,
      previousSecretUntil: 1_800_000_100_000,
    }, event, fetcher, 1_800_000_000_000);
    const headers = new Headers(sent?.init?.headers);
    const body = String(sent?.init?.body);
    const timestamp = headers.get('webhook-timestamp') ?? '';
    const signature = headers.get('webhook-signature') ?? '';
    expect(result).toEqual({ status: 204, accepted: true });
    expect(sent?.request).toBe(subscription.url);
    expect(sent?.init?.redirect).toBe('manual');
    expect(body).toBe(JSON.stringify(event));
    expect(headers.get('webhook-id')).toBe(event.eventId);
    expect(timestamp).toBe('1800000000');
    expect(signature).toBe(`${await signWebhook(secret, event.eventId, timestamp, body)} ${await signWebhook(previousSecret, event.eventId, timestamp, body)}`);
  });

  it('uses bounded exponential retry intervals', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([5_000, 30_000, 300_000, 1_800_000, 7_200_000, 7_200_000]);
  });
});
