import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handleAuthenticatedMcp } from '../src/mcp.js';
import { handleEventProtocolRequest, verifyCallback, type EventSubscriptionInput } from '../src/mcp-events.js';
import { createSecureWebhookFetch } from '../src/secure-webhook-fetch.js';
import { logSubscriptionDiagnostic } from '../src/subscription-diagnostics.js';
import { fetchWorker } from '../src/worker.js';
import type { Env } from '../src/types.js';

const issuer = 'https://bridge.example.com';
const privateText = 'PRIVATE_TOKEN_BODY_CODE_STATE_ERROR';
const principal = 'private-user@example.test';
const callback = 'https://private-callback.example.com/private-path?code=private-code&state=private-state';
const secret = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const input = {
  name: 'discord.message.mentioned', arguments: {},
  delivery: { mode: 'webhook', url: callback, secret },
};
const auth = { principal, canRead: true, canReply: true, eventsEnabled: true };

function request(params: unknown = input) {
  return new Request(`${issuer}/mcp?code=private-code&state=private-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-private-header': privateText },
    body: JSON.stringify({ jsonrpc: '2.0', id: privateText, method: 'events/subscribe', params }),
  });
}

function backend() {
  return {
    subscribe: vi.fn(async (value: EventSubscriptionInput) => ({ id: value.id, refreshBefore: value.refreshBefore })),
    unsubscribe: vi.fn(async () => undefined),
  };
}

function configuredEnv(): Env {
  return { MCP_ISSUER_URL: issuer, OAUTH_KV: {} as KVNamespace, ACCESS_OWNER_EMAIL: principal };
}

describe('safe subscription diagnostics', () => {
  let log: MockInstance<typeof console.info>;
  beforeEach(() => { log = vi.spyOn(console, 'info').mockImplementation(() => undefined); });
  afterEach(() => {
    const serialized = JSON.stringify(log.mock.calls);
    for (const sensitive of [privateText, principal, callback, secret, 'private-code', 'private-state', 'private-path']) {
      expect(serialized).not.toContain(sensitive);
    }
    for (const [record] of log.mock.calls) {
      expect(Object.keys(record).every((key) => [
        'event', 'phase', 'reason', 'http_status', 'rpc_code', 'canRead', 'canReply', 'subscriptionStored',
      ].includes(key))).toBe(true);
    }
  });

  it('reconstructs records and rejects arbitrary fields, categories and status strings', () => {
    logSubscriptionDiagnostic(privateText as never, privateText as never, {
      httpStatus: privateText, rpcCode: privateText, canRead: privateText,
      canReply: true, subscriptionStored: false, headers: privateText, body: privateText,
    } as never);
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: 'discord_subscription_diagnostic', phase: 'request', reason: 'failed',
      canReply: true, subscriptionStored: false,
    });
  });

  it('observes OAuth-provider rejection before authenticated dispatch', async () => {
    const clone = vi.spyOn(Request.prototype, 'clone');
    const response = await fetchWorker(request(), configuredEnv(), {} as ExecutionContext);
    expect(response.status).toBe(401);
    expect(clone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'request', reason: 'started' }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'request', reason: 'rejected', http_status: 401 }));
    expect(log.mock.calls.some(([record]) => record.phase === 'callback')).toBe(false);
  });

  it('reports missing configuration without parsing or logging the request body', async () => {
    const clone = vi.spyOn(Request.prototype, 'clone');
    const response = await fetchWorker(new Request(`${issuer}/mcp`, {
      method: 'POST', body: privateText,
    }), {}, {} as ExecutionContext);
    expect(response.status).toBe(503);
    expect(clone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'request', reason: 'started' }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ reason: 'configuration_missing', http_status: 503 }));
  });

  it.each([
    ['owner mismatch', ['discord:read', 'discord:reply'], 'other@example.test', 401, 'rejected'],
    ['reply scope absent', ['discord:read'], principal, 403, 'scopes_missing'],
    ['storage binding absent', ['discord:read', 'discord:reply'], principal, 503, 'binding_missing'],
  ])('reports pre-dispatch %s', async (_case, scope, userId, status, reason) => {
    const clone = vi.spyOn(Request.prototype, 'clone');
    const response = await handleAuthenticatedMcp(request(), configuredEnv(), {
      auth: { token: privateText, userId, scope, clientId: privateText, audience: `${issuer}/mcp` },
      props: { email: userId },
    } as never);
    expect(response.status).toBe(status);
    if (status === 401) expect(clone).not.toHaveBeenCalled();
    else expect(clone).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ reason, http_status: status }));
  });

  it('reports validation failure before any callback or storage write', async () => {
    const events = backend();
    const response = await handleEventProtocolRequest(request({ ...input, name: privateText }), events, auth);
    expect(await response!.json()).toMatchObject({ error: { code: -32602 } });
    expect(events.subscribe).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'validation', reason: 'failed', rpc_code: -32602 }));
  });

  it('classifies a subscription after an earlier reply call in one permission parse', async () => {
    const clone = vi.spyOn(Request.prototype, 'clone');
    const response = await handleAuthenticatedMcp(new Request(`${issuer}/mcp`, {
      method: 'POST', body: JSON.stringify([
        { method: 'tools/call', params: { name: 'discord_reply_to_origin' } },
        { method: 'events/subscribe', params: input },
      ]),
    }), configuredEnv(), {
      auth: { token: privateText, userId: principal, scope: ['discord:read'], clientId: privateText, audience: `${issuer}/mcp` },
      props: { email: principal },
    } as never);
    expect(response.status).toBe(403);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ reason: 'scopes_missing', canReply: false }));
  });

  it.each([
    ['transport failure', async () => { throw new Error(privateText); }, 'transport_failed', 'timeout'],
    ['HTTP failure', async () => new Response(privateText, { status: 503 }), 'http_error', 'http_error'],
    ['redirect', async () => new Response(privateText, { status: 302, headers: { location: callback } }), 'redirect', 'redirect'],
    ['invalid JSON echo', async () => new Response(privateText), 'challenge_failed', 'challenge_failed'],
    ['incorrect challenge', async () => Response.json({ challenge: privateText }), 'challenge_failed', 'challenge_failed'],
  ])('reports callback %s while preserving the protocol error', async (_case, fetcher, reason, protocolReason) => {
    const events = backend();
    const response = await handleEventProtocolRequest(request(), events, auth,
      (subscription, sign) => verifyCallback(subscription, sign, fetcher));
    expect(await response!.json()).toMatchObject({ error: { code: -32015, data: { reason: protocolReason } } });
    expect(events.subscribe).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'callback', reason }));
  });

  it.each(['callback cache', 'verification cache write', 'subscription write'])('reports a failed %s', async (step) => {
    const events = {
      ...backend(),
      callbackVerified: vi.fn(async () => {
        if (step === 'callback cache') throw new Error(privateText);
        return false;
      }),
      recordCallbackVerification: vi.fn(async () => {
        if (step === 'verification cache write') throw new Error(privateText);
      }),
    };
    if (step === 'subscription write') events.subscribe.mockRejectedValue(new Error(privateText));
    const response = await handleEventProtocolRequest(request(), events, auth, async () => undefined);
    expect(await response!.json()).toMatchObject({ error: { code: -32603 } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'storage', reason: 'failed', rpc_code: -32603 }));
  });

  it('reports successful verification and subscription without logging the challenge or identity', async () => {
    const response = await handleEventProtocolRequest(request(), backend(), auth, (subscription, sign) =>
      verifyCallback(subscription, sign, async (_url, init) => Response.json({
        challenge: JSON.parse(String(init?.body)).challenge,
      }), () => privateText));
    expect(await response!.json()).toMatchObject({ result: { cursor: null, truncated: false } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'callback', reason: 'succeeded' }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'storage', reason: 'succeeded', subscriptionStored: true }));
  });

  it('reports a global fetch failure without private data or fabricated DNS/peer checks', async () => {
    const boundary = createSecureWebhookFetch(async () => { throw new Error(privateText); });
    const response = await handleEventProtocolRequest(request(), backend(), auth,
      (subscription, sign) => verifyCallback(subscription, sign, boundary));
    expect(await response!.json()).toMatchObject({ error: { code: -32015 } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ phase: 'callback', reason: 'transport_failed' }));
    expect(log.mock.calls.some(([record]) => ['dns_resolved', 'peer_verified'].includes(record.reason))).toBe(false);
  });
});
