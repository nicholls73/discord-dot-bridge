import { describe, expect, it, vi } from 'vitest';
import { triggerTyping } from '../src/typing.js';

describe('typing REST transport', () => {
  it.each([
    [204, {}, undefined, 7_000, false],
    [204, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '12.5' }, undefined, 12_500, false],
    [429, { 'retry-after': '31' }, { retry_after: 30 }, 31_000, false],
    [429, {}, { retry_after: 25, global: true }, 25_000, false],
    [429, {}, null, 14_000, false],
    [500, {}, undefined, 14_000, false],
    [400, {}, undefined, 14_000, true],
    [302, { location: 'https://example.test' }, undefined, 14_000, true],
  ])('handles status %s with server timing and terminal errors', async (status, headers, body, delayMs, terminal) => {
    const fetcher = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body),
      { status: status as number, headers: headers as HeadersInit }));
    expect(await triggerTyping(fetcher, 'synthetic', '55555555555555555', 0)).toMatchObject({ delayMs, terminal });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('bounds exponential transport backoff at one minute', async () => {
    const fetcher = vi.fn(async () => { throw new Error('synthetic'); });
    expect(await triggerTyping(fetcher, 'synthetic', '55555555555555555', 9)).toMatchObject({ delayMs: 60_000 });
  });
});
