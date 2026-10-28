import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';

const TARGET_URL = 'https://discord.com/api/v10/oauth2/token';

describe('Workerd fetch redirect compatibility', () => {
  it('runs the fixed request and redirect refusal in the configured Workerd runtime', async () => {
    const helperPath = fileURLToPath(new URL('../src/fetch-no-redirect.ts', import.meta.url));
    const helperSource = await readFile(helperPath, 'utf8');
    const { code: helperModule } = await transform(helperSource, { loader: 'ts', format: 'esm', target: 'es2022' });
    const workerModule = `
      import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';
      const tokenUrl = ${JSON.stringify(TARGET_URL)};
      export default {
        async fetch(request) {
          const mode = new URL(request.url).searchParams.get('mode');
          if (mode === 'legacy') {
            try {
              const response = await fetch(tokenUrl, {
                method: 'POST',
                redirect: 'error',
                cache: 'no-store',
                signal: AbortSignal.timeout(10_000),
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: 'synthetic-client', client_secret: '', grant_type: 'authorization_code', code: '', redirect_uri: 'https://discord-dot.example.invalid/admin?discord_oauth=callback' }),
              });
              return Response.json({ outcome: 'unexpected-response', status: response.status });
            } catch (error) {
              return Response.json({ outcome: 'legacy-rejected', errorType: error instanceof Error ? error.name : 'unknown' });
            }
          }
          try {
            const response = await fetchWithoutRedirect(fetch, tokenUrl, {
              method: 'POST',
              cache: 'no-store',
              signal: AbortSignal.timeout(10_000),
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                authorization: 'Bearer synthetic-runtime-test-value',
                accept: 'application/json',
              },
              body: new URLSearchParams({ client_id: 'synthetic-client', client_secret: '', grant_type: 'authorization_code', code: '', redirect_uri: 'https://discord-dot.example.invalid/admin?discord_oauth=callback' }),
            });
            await response.body?.cancel();
            return Response.json({ outcome: 'unexpected-response', status: response.status });
          } catch (error) {
            return Response.json({
              outcome: error instanceof RedirectResponseError ? 'redirect-rejected' : 'request-failed',
              status: error instanceof RedirectResponseError ? error.status : null,
            });
          }
        },
      };
    `;
    const outboundRequests: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    const miniflare = new Miniflare({
      workers: [{
        config: {
          name: 'discord-dot-redirect-regression',
          compatibilityDate: '2026-10-04',
          compatibilityFlags: ['global_fetch_strictly_public'],
          manifest: {
            mainModule: 'worker.mjs',
            modules: {
              'worker.mjs': { type: 'esm', contents: workerModule },
              'fetch-no-redirect.js': { type: 'esm', contents: helperModule },
            },
          },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              outboundRequests.push({
                url: request.url,
                method: request.method,
                authorization: request.headers.get('authorization'),
                body: await request.clone().text(),
              });
              return new MiniflareResponse('synthetic redirect body', {
                status: 302,
                headers: { location: 'https://redirect-target.example.test/private' },
              });
            },
          },
        },
      }],
    });

    try {
      const legacyResponse = await miniflare.dispatchFetch('http://localhost/?mode=legacy');
      await expect(legacyResponse.json()).resolves.toEqual({ outcome: 'legacy-rejected', errorType: 'TypeError' });
      expect(outboundRequests).toHaveLength(0);

      const fixedResponse = await miniflare.dispatchFetch('http://localhost/?mode=fixed');
      await expect(fixedResponse.json()).resolves.toEqual({ outcome: 'redirect-rejected', status: 302 });
      expect(outboundRequests).toHaveLength(1);
      expect(outboundRequests[0]).toMatchObject({
        url: TARGET_URL,
        method: 'POST',
        authorization: 'Bearer synthetic-runtime-test-value',
      });
      const form = new URLSearchParams(outboundRequests[0]!.body);
      expect(form.get('client_id')).toBe('synthetic-client');
      expect(form.get('client_secret')).toBe('');
      expect(form.get('code')).toBe('');
      expect(outboundRequests.some((outbound) => outbound.url.includes('redirect-target'))).toBe(false);
    } finally {
      await miniflare.dispose();
    }
  });
});
