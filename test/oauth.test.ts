import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { handleAuthorization } from '../src/oauth.js';
import adminCss from '../src/admin.css.txt';
import type { Env } from '../src/types.js';

// Match Wrangler's text-module loading instead of Vite's asset URL.
vi.mock('../src/admin.css.txt', async () => {
  const { readFile } = await import('node:fs/promises');
  return { default: await readFile(new URL('../src/admin.css.txt', import.meta.url), 'utf8') };
});

const owner = 'owner@example.test';
const oauthRequest = {
  responseType: 'code',
  clientId: 'test-client',
  redirectUri: 'http://127.0.0.1:4567/callback',
  scope: ['discord:read'],
  state: 'state-value',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  resource: 'https://discord-dot.example.test/mcp',
  issuer: 'https://discord-dot.example.test',
};

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async put(key: string, value: string) { values.set(key, value); },
    async get(key: string) { return values.get(key) ?? null; },
    async delete(key: string) { values.delete(key); },
  } as unknown as KVNamespace;
}

function helpers(scopes = oauthRequest.scope) {
  const requested = { ...oauthRequest, scope: scopes };
  const base = {
    parseAuthRequest: vi.fn(async () => requested),
    describeConsent: vi.fn(async (request: typeof oauthRequest) => ({
      clientId: request.clientId,
      clientName: '<untrusted-client>',
      clientDomain: undefined as string | undefined,
      redirectUri: request.redirectUri,
      redirectHost: '127.0.0.1:4567',
      redirectIsLoopback: true,
      scope: request.scope,
    })),
    beginConsent: vi.fn(async () => ({
      handle: 'opaque-consent-handle',
      headers: new Headers({ 'set-cookie': '__Host-oauth-consent=bound; Path=/; Secure; HttpOnly; SameSite=Lax' }),
    })),
    approveConsent: vi.fn(async (_request: Request, _handle: string, options?: { scope?: string[] }) => ({
      request: { ...requested, scope: options?.scope ?? [] },
      headers: new Headers({ 'set-cookie': '__Host-oauth-consent=; Path=/; Max-Age=0' }),
    })),
    denyConsent: vi.fn(async () => ({
      request: oauthRequest,
      redirectTo: 'http://127.0.0.1:4567/callback?error=access_denied&state=state-value',
      headers: new Headers(),
    })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'http://127.0.0.1:4567/callback?code=one-time-code' })),
  };
  return base as unknown as OAuthHelpers & typeof base;
}

function env(oauth: OAuthHelpers): Env {
  return {
    ACCESS_OWNER_EMAIL: owner,
    OAUTH_KV: memoryKv(),
    OAUTH_PROVIDER: oauth,
  };
}

function consentPost(scopes: string[], decision = 'approve') {
  const form = new URLSearchParams();
  form.set('handle', 'opaque-consent-handle');
  form.set('decision', decision);
  for (const scope of scopes) form.append('scope', scope);
  return new Request('https://discord-dot.example.test/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
}

function scopeInput(html: string, scope: string): string {
  return (html.match(/<input\b[^>]*>/g) ?? [])
    .find((input) => input.includes('name="scope"') && input.includes(`value="${scope}"`)) ?? '';
}

describe('OAuth authorization route', () => {
  it('requires owner authentication before starting consent', async () => {
    const provider = helpers();
    const response = await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'),
      env(provider),
      async () => false,
    );
    expect(response.status).toBe(401);
    expect(provider.parseAuthRequest).not.toHaveBeenCalled();
  });

  it('renders escaped client details and the requested scopes with provider-bound consent', async () => {
    const provider = helpers();
    const response = await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'),
      env(provider),
      async () => true,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('&lt;untrusted-client&gt;');
    expect(html).not.toContain('<untrusted-client>');
    expect(html).toContain('discord:read');
    expect(html).not.toContain('discord:reply');
    expect(html).toContain('local process could receive');
    expect(provider.beginConsent).toHaveBeenCalledOnce();
  });

  it('embeds the shared stylesheet with an exact CSP hash and keeps scripts blocked', async () => {
    const response = await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'), env(helpers()), async () => true,
    );
    const html = await response.text();
    expect(html.match(/<style>([\s\S]*?)<\/style>/)?.[1]).toBe(adminCss);
    expect(response.headers.get('content-security-policy')).toBe(
      `default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'sha256-${createHash('sha256').update(adminCss).digest('base64')}'`,
    );
    expect(html).not.toContain('<script');
    expect(html).toMatch(/<fieldset[^>]*>[\s\S]*?<legend/);
    expect(html).toMatch(/<button(?=[^>]*value="deny")(?=[^>]*formnovalidate)[^>]*>/i);
    expect(response.headers.get('set-cookie')).toContain('__Host-oauth-consent=bound');
  });

  it('escapes every client-provided display field and the consent handle', async () => {
    const provider = helpers();
    const untrusted = '<img src=x onerror="alert(1)">';
    provider.describeConsent.mockResolvedValue({
      clientId: oauthRequest.clientId, clientName: untrusted, clientDomain: untrusted,
      redirectUri: oauthRequest.redirectUri, redirectHost: untrusted,
      redirectIsLoopback: false, scope: oauthRequest.scope,
    });
    provider.beginConsent.mockResolvedValue({ handle: untrusted, headers: new Headers() });
    const response = await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'), env(provider), async () => true,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain(untrusted);
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/g)).toHaveLength(4);
    expect(html).not.toContain('local process could receive');
  });

  it.each([
    ['both permissions approved', ['discord:read', 'discord:reply']],
    ['reply permission unchecked', ['discord:read']],
  ])('grants only the selected scopes when both are requested: %s', async (_case, selectedScopes) => {
    const provider = helpers(['discord:read', 'discord:reply']);
    const currentEnv = env(provider);
    const consent = await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'),
      currentEnv,
      async () => true,
    );
    const html = await consent.text();
    expect(consent.status).toBe(200);
    expect(scopeInput(html, 'discord:read')).toContain('checked=""');
    expect(scopeInput(html, 'discord:read')).toContain('required=""');
    expect(scopeInput(html, 'discord:reply')).toContain('checked=""');

    const response = await handleAuthorization(consentPost(selectedScopes), currentEnv, async () => true);
    expect(response.status).toBe(302);
    expect(provider.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      scope: selectedScopes,
    }));
  });

  it('grants only scopes shown in the original consent, even if the posted form adds one', async () => {
    const provider = helpers();
    const currentEnv = env(provider);
    await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'),
      currentEnv,
      async () => true,
    );
    const response = await handleAuthorization(
      consentPost(['discord:read', 'discord:reply']),
      currentEnv,
      async () => true,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('code=one-time-code');
    expect(provider.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId: owner,
      scope: ['discord:read'],
      props: { email: owner },
    }));
  });

  it('uses the OAuth provider deny path without issuing a grant', async () => {
    const provider = helpers();
    const currentEnv = env(provider);
    await handleAuthorization(
      new Request('https://discord-dot.example.test/authorize'),
      currentEnv,
      async () => true,
    );
    const response = await handleAuthorization(
      consentPost([], 'deny'),
      currentEnv,
      async () => true,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=access_denied');
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });
});

describe('explicit policy-management consent', () => {
  const manage = 'discord:policy:manage';
  it('shows an unchecked optional management scope only when requested', async () => {
    const provider = helpers(['discord:read', manage]);
    const currentEnv = env(provider);
    const response = await handleAuthorization(new Request('https://discord-dot.example.test/authorize'), currentEnv, async () => true);
    const html = await response.text();
    expect(scopeInput(html, manage)).toContain(`value="${manage}"`);
    expect(scopeInput(html, manage)).not.toContain('checked');
    expect(html).toContain('cannot prove the originating conversation');
    await handleAuthorization(consentPost(['discord:read']), currentEnv, async () => true);
    expect(provider.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ scope: ['discord:read'] }));
  });
  it('grants management only when both requested and explicitly selected', async () => {
    for (const requested of [['discord:read'], ['discord:read', manage]]) {
      const provider = helpers(requested);
      const currentEnv = env(provider);
      await handleAuthorization(new Request('https://discord-dot.example.test/authorize'), currentEnv, async () => true);
      await handleAuthorization(consentPost(['discord:read', manage]), currentEnv, async () => true);
      expect(provider.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ scope: requested }));
    }
  });
});

describe('explicit optional channel permissions', () => {
  const channelRead = 'discord:channel:read';
  const messageSend = 'discord:message:send';
  const messageEdit = 'discord:message:edit';

  it('shows new channel capabilities unchecked with specific read and write consent copy', async () => {
    const provider = helpers(['discord:read', 'discord:reply', channelRead, messageSend, messageEdit]);
    const response = await handleAuthorization(new Request('https://discord-dot.example.test/authorize'), env(provider), async () => true);
    const html = await response.text();
    expect(response.status).toBe(200);
    for (const scope of [channelRead, messageSend, messageEdit]) {
      expect(scopeInput(html, scope)).toContain(`value="${scope}"`);
      expect(scopeInput(html, scope)).not.toContain('checked');
    }
    expect(html).toContain('current grants');
    expect(html).toContain('edit only messages authored by this bot');
    expect(html).toContain('everyone and role mentions are disabled');
  });

  it('offers channel scopes when a client requests only the core scopes and grants only explicit choices', async () => {
    const provider = helpers(['discord:read', 'discord:reply']);
    const currentEnv = env(provider);
    const consent = await handleAuthorization(new Request('https://discord-dot.example.test/authorize'), currentEnv, async () => true);
    const html = await consent.text();
    for (const scope of [channelRead, messageSend, messageEdit]) {
      expect(scopeInput(html, scope)).toContain(`value="${scope}"`);
      expect(scopeInput(html, scope)).not.toContain('checked');
    }

    const response = await handleAuthorization(
      consentPost(['discord:read', 'discord:reply', messageSend]),
      currentEnv,
      async () => true,
    );
    expect(response.status).toBe(302);
    expect(provider.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      scope: ['discord:read', 'discord:reply', messageSend],
    }));
  });

  it('grants only the new scopes explicitly checked on the consent page', async () => {
    const provider = helpers(['discord:read', 'discord:reply', channelRead, messageSend, messageEdit]);
    const currentEnv = env(provider);
    await handleAuthorization(new Request('https://discord-dot.example.test/authorize'), currentEnv, async () => true);
    const response = await handleAuthorization(consentPost(['discord:read', 'discord:reply', messageSend]), currentEnv, async () => true);
    expect(response.status).toBe(302);
    expect(provider.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      scope: ['discord:read', 'discord:reply', messageSend],
    }));
  });
});
