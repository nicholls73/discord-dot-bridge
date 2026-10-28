import type { OAuthResourceAuth, OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { describe, expect, it, vi } from 'vitest';
import {
  handleAuthenticatedMcp,
  READ_SCOPE,
  REPLY_SCOPE,
  CHANNEL_READ_SCOPE,
  MESSAGE_SEND_SCOPE,
  MESSAGE_EDIT_SCOPE,
} from '../src/mcp.js';
import type { BridgeAuthProps, Env } from '../src/types.js';

const owner = 'owner@example.test';
const issuer = 'https://discord-dot.example.test';
const replyBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'discord_reply_to_origin', arguments: { eventId: '66666666666666666', text: 'Reviewed.' } },
});

function context(authOverrides: Partial<OAuthResourceAuth> = {}, props: Partial<BridgeAuthProps> = {}) {
  return {
    auth: {
      token: 'unit-test-token',
      audience: `${issuer}/mcp`,
      scope: [READ_SCOPE],
      userId: owner,
      clientId: 'test-client',
      ...authOverrides,
    },
    props: { email: owner, ...props },
  } as unknown as OAuthResourceContext<BridgeAuthProps>;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ACCESS_OWNER_EMAIL: owner,
    MCP_ISSUER_URL: issuer,
    BRIDGE_STATE: {
      idFromName: vi.fn(() => 'state'),
      get: vi.fn(() => ({ getOrigin: vi.fn(async () => null), recordOriginOnce: vi.fn(async () => true) })),
    } as unknown as Env['BRIDGE_STATE'],
    ...overrides,
  };
}


function post(body: string) {
  return new Request(`${issuer}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('MCP OAuth boundary', () => {
  it('rejects a token with the wrong resource audience', async () => {
    const response = await handleAuthenticatedMcp(
      post(replyBody),
      env(),
      context({ audience: 'https://another.example/mcp', scope: [READ_SCOPE, REPLY_SCOPE] }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a token issued to a different owner', async () => {
    const response = await handleAuthenticatedMcp(
      post(replyBody),
      env(),
      context({ userId: 'someone-else@example.test', scope: [READ_SCOPE, REPLY_SCOPE] }),
    );
    expect(response.status).toBe(401);
  });

  it('returns a step-up scope challenge before reaching Discord', async () => {
    const response = await handleAuthenticatedMcp(post(replyBody), env(), context());
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain(`${READ_SCOPE} ${REPLY_SCOPE}`);
  });

  it('keeps an existing read-only grant unable to subscribe without new consent', async () => {
    const currentEnv = env();
    const currentContext = context();
    const response = await handleAuthenticatedMcp(
      post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: {} })),
      currentEnv,
      currentContext,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="discord:read discord:reply"');
    expect(currentContext.auth.scope).toEqual([READ_SCOPE]);
    expect(currentEnv.BRIDGE_STATE!.get).not.toHaveBeenCalled();
  });

  it('requires the consent-bound owner property as well as the subject claim', async () => {
    const response = await handleAuthenticatedMcp(
      post(replyBody),
      env(),
      context({ scope: [READ_SCOPE, REPLY_SCOPE] }, { email: 'someone-else@example.test' }),
    );
    expect(response.status).toBe(401);
  });
});

describe('policy management OAuth boundary', () => {
  const managementBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discord_update_policy', arguments: { expectedRevision: 1, markdown: 'text' } } });
  it('requires explicit management scope before storage access', async () => {
    const currentEnv = env();
    const response = await handleAuthenticatedMcp(post(managementBody), currentEnv, context({ scope: [READ_SCOPE, REPLY_SCOPE] }));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('discord:policy:manage');
    expect(currentEnv.BRIDGE_STATE!.get).not.toHaveBeenCalled();
  });
  it.each([
    { userId: 'another@example.test' },
    { audience: 'https://another.example/mcp' },
  ])('retains owner and audience gates even with management scope', async (overrides) => {
    const response = await handleAuthenticatedMcp(post(managementBody), env(), context({ scope: [READ_SCOPE, 'discord:policy:manage'], ...overrides }));
    expect(response.status).toBe(401);
  });
});

describe('optional channel OAuth boundaries', () => {
  it.each([
    ['channel listing', CHANNEL_READ_SCOPE, 'discord_list_channels'],
    ['channel reads', CHANNEL_READ_SCOPE, 'discord_list_channel_messages'],
    ['standalone sends', MESSAGE_SEND_SCOPE, 'discord_send_message'],
    ['own-message edits', MESSAGE_EDIT_SCOPE, 'discord_edit_own_message'],
  ])('requires explicit consent for %s before reaching Durable Object storage', async (_name, scope, toolName) => {
    const currentEnv = env();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: {} } });
    const response = await handleAuthenticatedMcp(post(body), currentEnv, context({ scope: [READ_SCOPE, REPLY_SCOPE] }));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain(`scope="${READ_SCOPE} ${scope}"`);
    expect(currentEnv.BRIDGE_STATE!.get).not.toHaveBeenCalled();
  });
});
