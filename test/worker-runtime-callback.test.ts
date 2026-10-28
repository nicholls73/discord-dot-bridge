import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { describe, expect, it } from 'vitest';
import { signWebhook } from '../src/mcp-events.js';

const secret = `whsec_${Buffer.alloc(32, 4).toString('base64')}`;

describe('actual callback transport in Workerd', () => {
  it('uses global HTTPS fetch for verification/delivery and rejects redirects without follow-up', async () => {
    const bundle = await build({
      stdin: {
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        contents: `
          import { secureWebhookFetch } from './src/secure-webhook-fetch.ts';
          import { verifyCallback, postSignedEvent, signWebhook } from './src/mcp-events.ts';
          const secret = ${JSON.stringify(secret)};
          const headers = { 'content-type': 'application/json', 'webhook-id': 'evt_runtime', 'webhook-timestamp': '123', 'webhook-signature': 'v1,synthetic', 'x-mcp-subscription-id': 'sub_runtime' };
          export default {
            async fetch(request) {
              const mode = new URL(request.url).pathname.slice(1);
              const subscription = { id: 'sub_runtime', url: 'https://receiver.example.com/' + mode, secret };
              try {
                if (mode === 'invalid') {
                  await secureWebhookFetch(subscription.url, { method: 'POST', headers: { ...headers, authorization: 'PRIVATE_MCP_TOKEN' }, body: '{}' });
                } else if (mode === 'routing') {
                  const original = new Request(subscription.url, { method: 'POST', headers, body: '{}' });
                  await secureWebhookFetch(original, { cf: { resolveOverride: 'private.internal' }, redirect: 'follow', credentials: 'include' });
                } else if (mode.includes('verify')) {
                  await verifyCallback(subscription, (id, timestamp, body) => signWebhook(secret, id, timestamp, body), secureWebhookFetch, () => 'synthetic-challenge');
                } else {
                  await postSignedEvent(subscription, { eventId: 'evt_runtime', data: { text: 'é 🦊' } }, secureWebhookFetch, 1800000000000);
                }
                return Response.json({ ok: true });
              } catch (error) {
                return Response.json({ ok: false, reason: error.data?.reason ?? error.name });
              }
            }
          };
        `,
      }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    });
    const outbound: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    const runtime = new Miniflare({
      workers: [{
        config: {
          name: 'discord-dot-callback-regression', compatibilityDate: '2026-10-04',
          compatibilityFlags: ['global_fetch_strictly_public'],
          manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
        },
        dev: { outboundService: { type: 'fetcher', handler: async (request) => {
          const body = await request.text();
          outbound.push({ url: request.url, method: request.method, headers: new Headers(Object.fromEntries(request.headers)), body });
          if (request.url.includes('redirect')) return new MiniflareResponse('synthetic', { status: 302, headers: { location: 'https://127.0.0.1/private' } });
          const payload = JSON.parse(body);
          return payload.type === 'verification'
            ? new MiniflareResponse(JSON.stringify({ challenge: payload.challenge }), { headers: { 'content-type': 'application/json' } })
            : new MiniflareResponse(null, { status: 204 });
        } } },
      }],
    });
    try {
      for (const mode of ['verify', 'delivery', 'verify-redirect', 'delivery-redirect', 'routing', 'invalid']) {
        const response = await runtime.dispatchFetch(`http://localhost/${mode}`);
        expect(await response.json()).toEqual(mode.includes('redirect')
          ? { ok: false, reason: mode.includes('verify') ? 'redirect' : 'RedirectResponseError' }
          : mode === 'invalid' ? { ok: false, reason: 'TypeError' } : { ok: true });
      }
      expect(outbound.map((request) => request.url)).toEqual(['verify', 'delivery', 'verify-redirect', 'delivery-redirect', 'routing'].map((mode) => `https://receiver.example.com/${mode}`));
      for (const request of outbound) {
        expect(request.method).toBe('POST');
        expect(request.headers.has('authorization')).toBe(false);
        expect(request.headers.has('cookie')).toBe(false);
        expect(request.headers.get('x-mcp-subscription-id')).toBe('sub_runtime');
      }
      for (const request of outbound.slice(0, 4)) expect(request.headers.get('webhook-signature')).toBe(await signWebhook(secret, request.headers.get('webhook-id')!, request.headers.get('webhook-timestamp')!, request.body));
      expect(outbound[1].body).toBe(JSON.stringify({ eventId: 'evt_runtime', data: { text: 'é 🦊' } }));
      expect(JSON.stringify(outbound.map((request) => request.url))).not.toMatch(/private|127\.0\.0\.1/);
    } finally { await runtime.dispose(); }
  }, 20_000);
});
