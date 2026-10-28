import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';

export const TYPING_REFRESH_MS = 7_000;
export const TYPING_TIMEOUT_MS = 5 * 60_000;
// Reserve before network I/O so eviction cannot cause an immediate duplicate attempt.
export const TYPING_LEASE_MS = 30_000;
export const TYPING_PREFIX = 'typing:channel:';
export const TYPING_GLOBAL_KEY = 'typing:global-backoff';

export interface TypingChannel {
  events: Record<string, number>;
  nextAttemptAt: number;
  failures: number;
}

export interface TypingResult {
  terminal: boolean;
  delayMs: number;
  global: boolean;
  failed: boolean;
}

/** Best-effort native indicator; never creates a Discord message or follows redirects. */
export async function triggerTyping(
  fetchImpl: typeof fetch, token: string, channelId: string, failures: number,
): Promise<TypingResult> {
  const fallback = Math.min(60_000, TYPING_REFRESH_MS * 2 ** Math.min(failures + 1, 4));
  try {
    const response = await fetchWithoutRedirect(fetchImpl,
      `https://discord.com/api/v10/channels/${channelId}/typing`, {
        method: 'POST', headers: { authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(3_000),
      });
    let body: { retry_after?: unknown; global?: unknown } = {};
    if (response.status === 429) {
      try { body = await response.json() as typeof body; } catch { /* Use headers or backoff. */ }
    }
    const seconds = [body?.retry_after, response.headers.get('retry-after'),
      response.headers.get('x-ratelimit-reset-after')]
      .filter((value) => typeof value === 'number' || typeof value === 'string')
      .map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const limited = response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0';
    const failed = response.status !== 204;
    return {
      terminal: failed && response.status !== 429 && response.status < 500,
      delayMs: limited ? Math.max(TYPING_REFRESH_MS, ...seconds.map((value) => value * 1_000),
        seconds.length ? 0 : fallback) : failed ? fallback : TYPING_REFRESH_MS,
      global: body?.global === true || response.headers.get('x-ratelimit-global') === 'true',
      failed,
    };
  } catch (error) {
    return { terminal: error instanceof RedirectResponseError, delayMs: fallback, global: false, failed: true };
  }
}
