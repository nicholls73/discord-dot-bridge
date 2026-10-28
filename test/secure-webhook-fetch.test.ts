import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecureWebhookFetch } from '../src/secure-webhook-fetch.js';
import { postSignedEvent, signWebhook, verifyCallback } from '../src/mcp-events.js';

const callback = 'https://receiver.example.com/callback?opaque=synthetic';
const headers = { 'content-type': 'application/json', 'webhook-id': 'evt_synthetic', 'webhook-timestamp': '123', 'webhook-signature': 'v1,synthetic', 'x-mcp-subscription-id': 'sub_synthetic' };
const body = '{"text":"é 🦊"}';
beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => undefined));

describe('hosted Worker HTTPS callback boundary', () => {
  it('uses genuine global fetch by default and preserves signed UTF-8 bytes and headers', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const result = await createSecureWebhookFetch()(callback, { method: 'POST', headers, body });
    const [url, init] = outbound.mock.calls[0];
    expect(url).toBe(callback);
    expect(new Uint8Array(init!.body as ArrayBuffer)).toEqual(new TextEncoder().encode(body));
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual(headers);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store', credentials: 'omit' });
    expect(Object.keys(init!).sort()).toEqual(['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'signal']);
    expect(result.status).toBe(202);
  });

  it('rebuilds Request input without private routing, credentials or caller-controlled transport options', async () => {
    const outbound = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const request = Object.assign(new Request(callback, { method: 'POST', headers, body }), { cf: { resolveOverride: 'private.internal' } });
    await createSecureWebhookFetch(outbound)(request, { cf: { resolveOverride: 'private.internal' }, redirect: 'follow', credentials: 'include', keepalive: true, dispatcher: { private: true } } as RequestInit);
    const [url, init] = outbound.mock.calls[0];
    expect(url).toBe(callback);
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
    expect(Object.keys(init!).sort()).toEqual(['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'signal']);
    expect(init).not.toHaveProperty('cf');
    expect(init).not.toHaveProperty('dispatcher');
    expect(outbound).toHaveBeenCalledOnce();
  });

  it.each(['http://receiver.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://0x7f000001', 'https://service.local', 'https://localhost.', 'https://receiver.example.com:444', 'https://user:password@receiver.example.com', 'https://receiver.example.com/#fragment'])('rejects invalid callback %s before dispatch', async (url) => {
    const outbound = vi.fn();
    await expect(createSecureWebhookFetch(outbound)(url, { method: 'POST', headers, body })).rejects.toThrow('Webhook callback request failed.');
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(['authorization', 'proxy-authorization', 'cookie', 'host', 'cf-access-client-secret', 'x-mcp-token'])('rejects forbidden header %s without forwarding MCP credentials', async (name) => {
    const outbound = vi.fn();
    await expect(createSecureWebhookFetch(outbound)(callback, { method: 'POST', headers: { ...headers, [name]: 'PRIVATE_VALUE' }, body })).rejects.toThrow();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('requires POST, signed JSON headers and bounded headers/body before dispatch', async () => {
    for (const init of [{ method: 'GET', headers }, { method: 'POST', body }, { method: 'POST', headers: { ...headers, 'webhook-id': 'x'.repeat(16 * 1024) }, body }, { method: 'POST', headers, body: 'x'.repeat(256 * 1024 + 1) }]) {
      const outbound = vi.fn();
      await expect(createSecureWebhookFetch(outbound)(callback, init)).rejects.toThrow();
      expect(outbound).not.toHaveBeenCalled();
    }
  });

  it.each([300, 301, 302, 303, 304, 307, 308, 399])('rejects HTTP %s without a redirect follow-up', async (status) => {
    const outbound = vi.fn(async () => new Response(null, { status, headers: { location: 'https://private.internal/' } }));
    await expect(createSecureWebhookFetch(outbound)(callback, { method: 'POST', headers, body })).rejects.toMatchObject({ name: 'RedirectResponseError', status });
    expect(outbound).toHaveBeenCalledOnce();
  });

  it('bounds responses, cancels excess bytes and returns numeric callback status', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 + 1)); }, cancel });
    await expect(createSecureWebhookFetch(async () => new Response(stream))(callback, { method: 'POST', headers, body })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    const response = await createSecureWebhookFetch(async () => new Response('bounded', { status: 503, headers: { 'set-cookie': 'PRIVATE_COOKIE' } }))(callback, { method: 'POST', headers, body });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('bounded');
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('does not dispatch pre-aborted requests', async () => {
    const controller = new AbortController(); controller.abort();
    const outbound = vi.fn();
    await expect(createSecureWebhookFetch(outbound)(callback, { method: 'POST', headers, body, signal: controller.signal })).rejects.toThrow();
    expect(outbound).not.toHaveBeenCalled();
  });

  it('cancels a stalled response body on caller abort and on the ten-second deadline', async () => {
    for (const deadline of [false, true]) {
      const controller = new AbortController();
      const timeout = new AbortController();
      const clock = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => { expect(milliseconds).toBe(10_000); return timeout.signal; });
      const cancel = vi.fn();
      const pending = createSecureWebhookFetch(async () => {
        queueMicrotask(() => (deadline ? timeout : controller).abort());
        return new Response(new ReadableStream({ cancel }));
      })(callback, { method: 'POST', headers, body, signal: controller.signal });
      await expect(pending).rejects.toThrow('Webhook callback request failed.');
      expect(cancel).toHaveBeenCalledOnce();
      clock.mockRestore();
    }
  });

  it('reports only fixed failures and never claims application DNS/peer verification', async () => {
    const log = vi.mocked(console.info);
    await expect(createSecureWebhookFetch(async () => { throw new Error('PRIVATE_URL_TOKEN_BODY'); })(callback, { method: 'POST', headers, body })).rejects.toThrow('Webhook callback request failed.');
    expect(log).toHaveBeenCalledExactlyOnceWith({ event: 'discord_subscription_diagnostic', phase: 'callback', reason: 'transport_failed' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_URL_TOKEN_BODY');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/dns_resolved|peer_verified/);
  });

  it('uses the same boundary for signed challenge verification and event delivery', async () => {
    const subscription = { id: 'sub_synthetic', principal: 'owner@example.test', name: 'discord.message.mentioned' as const, arguments: {}, url: callback, secret: `whsec_${Buffer.alloc(32, 4).toString('base64')}`, refreshBefore: '2026-10-11T00:00:00Z' };
    const sent: Array<{ bytes: string; headers: Headers }> = [];
    const boundary = createSecureWebhookFetch(async (_url, init) => {
      const bytes = new TextDecoder().decode(init!.body as ArrayBuffer);
      sent.push({ bytes, headers: new Headers(init!.headers) });
      const payload = JSON.parse(bytes);
      return payload.type === 'verification' ? Response.json({ challenge: payload.challenge }) : new Response(null, { status: 204 });
    });
    await verifyCallback(subscription, (id, timestamp, bytes) => signWebhook(subscription.secret, id, timestamp, bytes), boundary);
    const event = { eventId: 'evt_synthetic', data: { text: 'é 🦊' } };
    await expect(postSignedEvent(subscription, event, boundary)).resolves.toEqual({ status: 204, accepted: true });
    expect(sent[1].bytes).toBe(JSON.stringify(event));
    for (const request of sent) {
      expect(request.headers.get('webhook-signature')).toBe(await signWebhook(subscription.secret, request.headers.get('webhook-id')!, request.headers.get('webhook-timestamp')!, request.bytes));
      expect(request.headers.has('authorization')).toBe(false);
    }
  });
});
