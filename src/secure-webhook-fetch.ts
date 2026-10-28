import { publicCallbackUrl } from './callback-policy.js';
import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';
import { logSubscriptionDiagnostic } from './subscription-diagnostics.js';

const callbackHeaders = ['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id'];
const MAX_CALLBACK_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;

class CallbackBoundaryError extends TypeError {
  constructor(readonly reason: 'request_failed' | 'response_failed') { super('Webhook callback boundary rejected the request or response.'); }
}

async function readBoundedBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) { signal.throwIfAborted(); return new Uint8Array(); }
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new CallbackBoundaryError(maximum === MAX_CALLBACK_BYTES ? 'request_failed' : 'response_failed');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Hosted global fetch + global_fetch_strictly_public owns the public-network boundary. */
export function createSecureWebhookFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    let signal: AbortSignal | undefined;
    let dispatched = false;
    try {
      const request = new Request(input, { ...init, redirect: 'manual' });
      const url = publicCallbackUrl(request.url);
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
      signal.throwIfAborted();
      if (request.method !== 'POST') throw new CallbackBoundaryError('request_failed');
      const headers: Record<string, string> = {};
      let headerBytes = 0;
      for (const [name, value] of request.headers) {
        if (!callbackHeaders.includes(name)) throw new CallbackBoundaryError('request_failed');
        headerBytes += new TextEncoder().encode(name + value).byteLength;
        if (headerBytes > 16 * 1024) throw new CallbackBoundaryError('request_failed');
        headers[name] = value;
      }
      if (callbackHeaders.some((name) => !headers[name]) || headers['content-type'] !== 'application/json') throw new CallbackBoundaryError('request_failed');
      const body = await readBoundedBytes(new Response(request.body), MAX_CALLBACK_BYTES, signal);
      dispatched = true;
      // Rebuild from values only: never forward a Request's cf data, routing overrides or MCP credentials.
      const response = await fetchWithoutRedirect(fetcher, url, {
        method: 'POST', headers, body: Uint8Array.from(body).buffer,
        signal, redirect: 'manual', cache: 'no-store', credentials: 'omit',
      });
      const bytes = await readBoundedBytes(response, MAX_RESPONSE_BYTES, signal);
      return new Response(bytes.length ? Uint8Array.from(bytes).buffer : null, { status: response.status });
    } catch (error) {
      const reason = signal?.aborted ? 'timeout' : error instanceof RedirectResponseError ? 'redirect' : error instanceof CallbackBoundaryError ? error.reason : dispatched ? 'transport_failed' : 'request_failed';
      logSubscriptionDiagnostic('callback', reason);
      if (error instanceof RedirectResponseError) throw error;
      throw new TypeError('Webhook callback request failed.');
    }
  };
}

export const secureWebhookFetch = createSecureWebhookFetch();
