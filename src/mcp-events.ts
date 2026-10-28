import { publicCallbackUrl } from './callback-policy.js';
import {
  MENTION_EVENT_NAME,
  makeSubscriptionId,
  type EventAuthorizationReference,
  type EventSubscription,
  type EventSubscriptionIdentity,
} from './events.js';
import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';
import { logSubscriptionDiagnostic, type SubscriptionPhase } from './subscription-diagnostics.js';

const PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_SUBSCRIPTION_TTL_MS = 5 * 60 * 1000;
const MAX_EVENT_BYTES = 256 * 1024;

export interface EventSubscriptionInput extends EventSubscriptionIdentity {
  secret: string;
  refreshBefore: string;
  authorization?: EventAuthorizationReference;
}

export interface EventSubscriptionBackend {
  subscribe(subscription: EventSubscriptionInput): Promise<{ id: string; refreshBefore: string }>;
  unsubscribe(identity: EventSubscriptionIdentity): Promise<void>;
  callbackVerified?(principal: string, url: string, now: number): Promise<boolean>;
  recordCallbackVerification?(principal: string, url: string, expiresAt: number): Promise<void>;
}

export interface EventRequestAuth {
  principal: string;
  canRead: boolean;
  canReply: boolean;
  authorizedUntil?: number;
  authorization?: EventAuthorizationReference;
  eventsEnabled?: boolean;
}

export class EventProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function handleEventProtocolRequest(
  request: Request,
  backend: EventSubscriptionBackend,
  auth: EventRequestAuth,
  verify: typeof verifyCallback = verifyCallback,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  let body: unknown;
  try {
    body = await request.clone().json() as unknown;
  } catch {
    return null;
  }
  const batch = Array.isArray(body) ? body : [body];
  if (!batch.some(isEventMethod)) return null;
  const subscription = batch.some((entry) => isRecord(entry) && entry.method === 'events/subscribe');
  if (!batch.every(isEventMethod)) {
    if (subscription) logSubscriptionDiagnostic('validation', 'rejected', { rpcCode: -32600 });
    return jsonError(null, -32600, 'Event methods cannot be mixed with other MCP methods in a batch.');
  }
  if (!auth.canRead) {
    if (subscription) logSubscriptionDiagnostic('authorization', 'scopes_missing', {
      canRead: false, canReply: auth.canReply, rpcCode: -32001,
    });
    return jsonError(null, -32001, 'The discord:read scope is required.');
  }

  const responses = await Promise.all(batch.map(async (entry) => {
    const id = isJsonRpcId(entry.id) ? entry.id : null;
    if (id === null) {
      if (entry.method === 'events/subscribe') logSubscriptionDiagnostic('validation', 'rejected');
      return null;
    }
    try {
      return { jsonrpc: '2.0', id, result: await dispatchEventMethod(entry, backend, auth, verify) };
    } catch (error) {
      const protocolError = error instanceof EventProtocolError
        ? error
        : new EventProtocolError(-32603, 'The event request could not be completed.');
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: protocolError.code,
          message: protocolError.message,
          ...(protocolError.data ? { data: protocolError.data } : {}),
        },
      };
    }
  }));
  const result = Array.isArray(body) ? responses.filter(Boolean) : responses[0];
  if (result === null || Array.isArray(result) && result.length === 0) return new Response(null, { status: 204, headers: noStoreHeaders() });
  return new Response(JSON.stringify(result), { headers: noStoreHeaders() });
}

async function dispatchEventMethod(
  request: Record<string, unknown>,
  backend: EventSubscriptionBackend,
  auth: EventRequestAuth,
  verify: typeof verifyCallback,
): Promise<unknown> {
  const params = isRecord(request.params) ? request.params : {};
  switch (request.method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: auth.eventsEnabled ? { tools: {}, events: {} } : { tools: {} },
      };
    case 'events/list':
      return { events: auth.eventsEnabled ? [mentionEventDefinition] : [] };
    case 'events/subscribe': {
      let phase: SubscriptionPhase = 'authorization';
      try {
        if (!auth.eventsEnabled) throw new EventProtocolError(-32001, 'Discord Gateway event delivery is not configured.');
        if (!auth.canReply) throw new EventProtocolError(-32001, 'The discord:reply scope is required to subscribe.');
        phase = 'validation';
        logSubscriptionDiagnostic(phase, 'started');
        const subscription = await withSubscriptionId(parseSubscription(params, auth.principal, auth.authorizedUntil));
        subscription.authorization = auth.authorization;
        logSubscriptionDiagnostic(phase, 'succeeded');
        const now = Date.now();
        phase = 'storage';
        logSubscriptionDiagnostic(phase, 'callback_cache_read');
        const callbackCached = await backend.callbackVerified?.(subscription.principal, subscription.url, now);
        phase = 'callback';
        if (!callbackCached) {
          logSubscriptionDiagnostic(phase, 'started');
          await verify(subscription, (eventId, timestamp, body) => signWebhook(subscription.secret, eventId, timestamp, body));
          logSubscriptionDiagnostic(phase, 'succeeded');
          phase = 'storage';
          logSubscriptionDiagnostic(phase, 'callback_cache_write');
          await backend.recordCallbackVerification?.(subscription.principal, subscription.url, now + 5 * 60_000);
        } else {
          logSubscriptionDiagnostic(phase, 'cached');
        }
        phase = 'authorization';
        if (auth.authorizedUntil !== undefined) {
          subscription.refreshBefore = new Date(Math.min(Date.parse(subscription.refreshBefore), auth.authorizedUntil)).toISOString();
          if (Date.parse(subscription.refreshBefore) <= Date.now()) {
            throw new EventProtocolError(-32001, 'The authorization expired during callback verification.');
          }
        }
        phase = 'storage';
        logSubscriptionDiagnostic(phase, 'started');
        const stored = await backend.subscribe(subscription);
        logSubscriptionDiagnostic(phase, 'succeeded', { subscriptionStored: true });
        return { ...stored, cursor: null, truncated: false };
      } catch (error) {
        logSubscriptionDiagnostic(phase, 'failed', {
          rpcCode: error instanceof EventProtocolError ? error.code : -32603,
        });
        throw error;
      }
    }
    case 'events/unsubscribe': {
      const identity = await withSubscriptionId(parseUnsubscribe(params, auth.principal));
      await backend.unsubscribe(identity);
      return {};
    }
    default:
      throw new EventProtocolError(-32601, 'Method not found.');
  }
}

function parseSubscription(params: Record<string, unknown>, principal: string, authorizedUntil?: number): EventSubscriptionInput {
  if (params.name !== MENTION_EVENT_NAME || !isEmptyObject(params.arguments)) {
    throw new EventProtocolError(-32602, 'The event name or subscription arguments are not supported.');
  }
  const delivery = params.delivery;
  if (!isRecord(delivery) || delivery.mode !== 'webhook' || typeof delivery.url !== 'string' || typeof delivery.secret !== 'string') {
    throw new EventProtocolError(-32602, 'Webhook delivery requires a callback URL and signing secret.');
  }
  const url = validateCallbackUrl(delivery.url);
  if (!isValidSigningSecret(delivery.secret)) throw new EventProtocolError(-32602, 'The signing secret must contain 24 to 64 decoded bytes.');

  const ttl = params.ttlMs;
  if (ttl !== undefined && ttl !== null && (!Number.isSafeInteger(ttl) || (ttl as number) < MIN_SUBSCRIPTION_TTL_MS)) {
    throw new EventProtocolError(-32602, 'ttlMs must be null or an integer of at least five minutes.');
  }
  let ttlMs = ttl === null ? DEFAULT_SUBSCRIPTION_TTL_MS
    : ttl === undefined ? DEFAULT_SUBSCRIPTION_TTL_MS
      : Math.min(ttl as number, DEFAULT_SUBSCRIPTION_TTL_MS);
  if (authorizedUntil !== undefined) ttlMs = Math.min(ttlMs, authorizedUntil - Date.now());
  if (ttlMs < MIN_SUBSCRIPTION_TTL_MS) {
    throw new EventProtocolError(-32001, 'The authorization expires too soon to create or refresh this subscription.');
  }
  const refreshBefore = new Date(Date.now() + ttlMs).toISOString();
  const name = MENTION_EVENT_NAME;
  const arguments_ = {} as Record<string, never>;
  return {
    id: '', // Replaced after canonical identity calculation below.
    principal,
    name,
    arguments: arguments_,
    url,
    secret: delivery.secret,
    refreshBefore,
  };
}

function parseUnsubscribe(params: Record<string, unknown>, principal: string): EventSubscriptionIdentity {
  if (params.name !== MENTION_EVENT_NAME || !isEmptyObject(params.arguments)) {
    throw new EventProtocolError(-32602, 'The event name or subscription arguments are not supported.');
  }
  const delivery = params.delivery;
  if (!isRecord(delivery) || delivery.mode !== 'webhook' || typeof delivery.url !== 'string') {
    throw new EventProtocolError(-32602, 'Webhook delivery requires its callback URL.');
  }
  const url = validateCallbackUrl(delivery.url);
  const name = MENTION_EVENT_NAME;
  return {
    id: '', // Replaced after canonical identity calculation below.
    principal,
    name,
    arguments: {} as Record<string, never>,
    url,
  };
}

export async function withSubscriptionId<T extends EventSubscriptionIdentity>(identity: T): Promise<T> {
  return { ...identity, id: await makeSubscriptionId(identity.principal, identity.url, identity.name, identity.arguments) };
}

export function validateCallbackUrl(value: string): string {
  try { return publicCallbackUrl(value); }
  catch { throw new EventProtocolError(-32015, 'Callback endpoint validation failed.', { reason: 'invalid_url' }); }
}

export function isValidSigningSecret(secret: string): boolean {
  if (!secret.startsWith('whsec_')) return false;
  try {
    return decodeBase64(secret.slice(6)).byteLength >= 24 && decodeBase64(secret.slice(6)).byteLength <= 64;
  } catch {
    return false;
  }
}

export async function verifyCallback(
  subscription: EventSubscriptionInput,
  sign: (eventId: string, timestamp: string, body: string) => Promise<string>,
  fetcher: typeof fetch = fetch,
  randomId: () => string = () => crypto.randomUUID(),
): Promise<void> {
  const eventId = `msg_verification_${randomId()}`;
  const challenge = randomId();
  const body = JSON.stringify({ type: 'verification', challenge });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(eventId, timestamp, body);
  let response: Response;
  try {
    response = await fetchWithoutRedirect(fetcher, subscription.url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: signedHeaders(eventId, timestamp, signature, subscription.id),
      body,
    });
  } catch (error) {
    const reason = error instanceof RedirectResponseError ? 'redirect' : 'timeout';
    logSubscriptionDiagnostic('callback', reason === 'redirect' ? 'redirect' : 'transport_failed', { rpcCode: -32015 });
    throw new EventProtocolError(-32015, 'Callback endpoint verification failed.', { reason });
  }
  logSubscriptionDiagnostic('callback', 'response_received', { httpStatus: response.status });
  if (!response.ok) {
    logSubscriptionDiagnostic('callback', 'http_error', { httpStatus: response.status, rpcCode: -32015 });
    throw new EventProtocolError(-32015, 'Callback endpoint verification failed.', { reason: 'http_error' });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedBody(response, 8 * 1024)) as unknown;
  } catch {
    logSubscriptionDiagnostic('callback', 'challenge_failed', { rpcCode: -32015 });
    throw new EventProtocolError(-32015, 'Callback endpoint verification failed.', { reason: 'challenge_failed' });
  }
  if (!isRecord(payload) || typeof payload.challenge !== 'string' || !constantTimeEqual(payload.challenge, challenge)) {
    logSubscriptionDiagnostic('callback', 'challenge_failed', { rpcCode: -32015 });
    throw new EventProtocolError(-32015, 'Callback endpoint verification failed.', { reason: 'challenge_failed' });
  }
}

export async function signWebhook(secret: string, eventId: string, timestamp: string, body: string): Promise<string> {
  const rawSecret = decodeBase64(secret.slice(6));
  const rawBuffer = Uint8Array.from(rawSecret).buffer as ArrayBuffer;
  const key = await crypto.subtle.importKey('raw', rawBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const payload = new TextEncoder().encode(`${eventId}.${timestamp}.${body}`);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return `v1,${encodeBase64(signature)}`;
}

export async function postSignedEvent(
  subscription: Pick<EventSubscription, 'id' | 'url' | 'secret' | 'previousSecret' | 'previousSecretUntil'>,
  event: unknown,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ status: number; accepted: boolean }> {
  const body = JSON.stringify(event);
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES) return { status: 413, accepted: false };
  const eventId = (event as { eventId?: unknown }).eventId;
  if (typeof eventId !== 'string') throw new TypeError('Event ID is required for webhook signing.');
  const timestamp = String(Math.floor(now / 1000));
  const signatures = [await signWebhook(subscription.secret, eventId, timestamp, body)];
  if (subscription.previousSecret && (subscription.previousSecretUntil ?? 0) > now) {
    signatures.push(await signWebhook(subscription.previousSecret, eventId, timestamp, body));
  }
  const response = await fetchWithoutRedirect(fetcher, subscription.url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: signedHeaders(eventId, timestamp, signatures.join(' '), subscription.id),
    body,
  });
  return { status: response.status, accepted: response.ok };
}

export function retryDelayMs(attempt: number): number {
  const delays = [5_000, 30_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  return delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)];
}

export const mentionEventDefinition = {
  name: MENTION_EVENT_NAME,
  description: 'An authorized member mentioned the Discord dot in an approved server channel.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  payloadSchema: {
    type: 'object',
    properties: {
      event_id: { type: 'string' },
      message_id: { type: 'string' },
      message_url: { type: 'string' },
      guild_id: { type: 'string' },
      channel_id: { type: 'string' },
      author_id: { type: 'string' },
      author_display_name: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['event_id', 'message_id', 'message_url', 'guild_id', 'channel_id', 'author_id', 'author_display_name', 'text'],
    additionalProperties: false,
  },
};

function isEventMethod(value: unknown): value is Record<string, unknown> & { method: string; id: unknown } {
  return isRecord(value) && typeof value.method === 'string' &&
    ['server/discover', 'events/list', 'events/subscribe', 'events/unsubscribe'].includes(value.method);
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function jsonError(id: string | number | null, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
}

function signedHeaders(eventId: string, timestamp: string, signature: string, subscriptionId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'webhook-id': eventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
    'X-MCP-Subscription-Id': subscriptionId,
  };
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value) {
    throw new TypeError('Invalid base64 secret.');
  }
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) throw new RangeError('Response too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RangeError('Response too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
