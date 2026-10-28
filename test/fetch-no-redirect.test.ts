import { describe, expect, it, vi } from 'vitest';
import { assertNotRedirectStatus, fetchWithoutRedirect, RedirectResponseError } from '../src/fetch-no-redirect.js';

const TARGET_URL = 'https://discord.com/api/v10/oauth2/token';

describe('fetchWithoutRedirect', () => {
  it('forces manual redirects and preserves ordinary responses', async () => {
    const response = Response.json({ ok: true });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);

    await expect(fetchWithoutRedirect(fetcher, TARGET_URL, { redirect: 'error' })).resolves.toBe(response);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it.each([300, 301, 302, 303, 304, 307, 308, 399])('rejects HTTP %i without following the Location', async (status) => {
    let bodyCanceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { bodyCanceled = true; } });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(status === 304 ? null : body, {
      status,
      headers: { location: 'https://redirect-target.example.test/private' },
    }));

    await expect(fetchWithoutRedirect(fetcher, TARGET_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-test-value' },
    })).rejects.toMatchObject({
      name: 'RedirectResponseError',
      status,
      message: 'Upstream redirect responses are not allowed.',
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(bodyCanceled).toBe(status !== 304);
  });

  it('rejects redirect statuses in raw socket responses', () => {
    expect(() => assertNotRedirectStatus(299)).not.toThrow();
    expect(() => assertNotRedirectStatus(302)).toThrow(RedirectResponseError);
    expect(() => assertNotRedirectStatus(400)).not.toThrow();
  });
});
