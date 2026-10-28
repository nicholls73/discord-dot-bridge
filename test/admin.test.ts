import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { POLICY_BOUNDARY } from '../src/response-policy.js';
import { policyFixture, seededPolicyFixture } from './policy-fixture.js';
import { handleAdminRequest } from '../src/admin.js';
import { applyAuthorizationMutation, emptyDiscordAuthorization, type AuthorizationMutation } from '../src/policy.js';
import type { DiscordRoleOption, LinkedDiscordAccount } from '../src/discord-account.js';
import type { Env } from '../src/types.js';
import adminCss from '../src/admin.css.txt';

// Match Wrangler's text-module loading; Vite otherwise returns a .txt asset URL.
vi.mock('../src/admin.css.txt', async () => {
  const { readFile } = await import('node:fs/promises');
  return { default: await readFile(new URL('../src/admin.css.txt', import.meta.url), 'utf8') };
});

const owner = 'owner@example.test';
const guildId = '11111111111111111';
const userId = '33333333333333333';
const roleId = '44444444444444444';

afterEach(() => vi.restoreAllMocks());

function localEnv(overrides: Partial<Env> = {}): Env {
  return { ACCESS_OWNER_EMAIL: owner, ALLOW_LOCAL_AUTH: 'true', ...overrides };
}

function controls(seedPolicy = true) {
  let authorization = emptyDiscordAuthorization();
  let link: LinkedDiscordAccount | null = null;
  let state: { ownerEmail: string; stateHash: string; expiresAt: number } | null = null;
  let availableRoles: DiscordRoleOption[] = [
    { roleId: guildId, name: '@everyone' },
    { roleId, name: 'Example reviewers' },
    { roleId: '66666666666666666', name: '<Admin & team>' },
  ];
  const guildNames: Record<string, string> = {};
  const roleNames: Record<string, Record<string, string>> = {};
  const runtimeStatus = { state: 'idle' as const, activeSubscriptions: 0 };
  return {
    ...(seedPolicy ? seededPolicyFixture() : policyFixture()).controls,
    getDiscordAuthorization: async () => authorization,
    mutateDiscordAuthorization: vi.fn(async (mutation: AuthorizationMutation) => {
      authorization = applyAuthorizationMutation(authorization, mutation);
      if (mutation.action === 'revoke-server') delete roleNames[mutation.guildId];
      if (mutation.action === 'revoke-role') delete roleNames[mutation.guildId]?.[mutation.id];
      return authorization;
    }),
    beginDiscordOAuth: vi.fn(async (ownerEmail: string, stateHash: string, expiresAt: number) => {
      state = { ownerEmail, stateHash, expiresAt };
    }),
    consumeDiscordOAuthState: vi.fn(async (ownerEmail: string, stateHash: string, now: number) => {
      const valid = state?.ownerEmail === ownerEmail && state.stateHash === stateHash && state.expiresAt > now;
      if (valid) state = null;
      return Boolean(valid);
    }),
    getLinkedDiscordAccount: async () => link,
    saveLinkedDiscordAccount: vi.fn(async (ownerEmail: string, value: LinkedDiscordAccount) => {
      if (ownerEmail !== owner) throw new TypeError('Owner authentication required.');
      link = value;
    }),
    unlinkDiscordAccount: vi.fn(async (ownerEmail: string) => { if (ownerEmail !== owner) throw new TypeError('Owner authentication required.'); link = null; }),
    approveLinkedServer: vi.fn(async (ownerEmail: string, selectedGuildId: string) => {
      if (!link || ownerEmail !== owner || !link.candidates.some((candidate) => candidate.guildId === selectedGuildId)) {
        throw new TypeError('That server is not in the current linked account list.');
      }
      authorization = applyAuthorizationMutation(authorization, { action: 'approve-server', guildId: selectedGuildId });
      guildNames[selectedGuildId] = link.candidates.find((candidate) => candidate.guildId === selectedGuildId)!.name;
      return authorization;
    }),
    grantLinkedAccountToServer: vi.fn(async (ownerEmail: string, selectedGuildId: string) => {
      if (!link || ownerEmail !== owner || !link.candidates.some((candidate) => candidate.guildId === selectedGuildId)) {
        throw new TypeError('That server is not in the current linked account list.');
      }
      authorization = applyAuthorizationMutation(authorization, { action: 'approve-server', guildId: selectedGuildId });
      authorization = applyAuthorizationMutation(authorization, { action: 'grant-user', guildId: selectedGuildId, id: link.userId });
      guildNames[selectedGuildId] = link.candidates.find((candidate) => candidate.guildId === selectedGuildId)!.name;
      return authorization;
    }),
    grantUserToServer: vi.fn(async (ownerEmail: string, selectedGuildId: string, selectedUserId: string) => {
      if (ownerEmail !== owner || !authorization.guilds[selectedGuildId]) throw new TypeError('Approve the server first.');
      authorization = applyAuthorizationMutation(authorization, { action: 'grant-user', guildId: selectedGuildId, id: selectedUserId });
      return authorization;
    }),
    getLinkedServerRoles: vi.fn(async (ownerEmail: string, selectedGuildId: string) => {
      if (!link || ownerEmail !== owner || !link.candidates.some((candidate) => candidate.guildId === selectedGuildId)) {
        throw new TypeError('That server is not in the current linked account list.');
      }
      return availableRoles;
    }),
    grantLinkedRoleToServer: vi.fn(async (ownerEmail: string, selectedGuildId: string, selectedRoleId: string) => {
      if (!link || ownerEmail !== owner || !link.candidates.some((candidate) => candidate.guildId === selectedGuildId) ||
          !availableRoles.some((role) => role.roleId === selectedRoleId) || selectedRoleId === selectedGuildId) {
        throw new TypeError('That role is not available in the selected server.');
      }
      authorization = applyAuthorizationMutation(authorization, { action: 'approve-server', guildId: selectedGuildId });
      authorization = applyAuthorizationMutation(authorization, { action: 'grant-role', guildId: selectedGuildId, id: selectedRoleId });
      roleNames[selectedGuildId] ??= {};
      roleNames[selectedGuildId]![selectedRoleId] = availableRoles.find((role) => role.roleId === selectedRoleId)!.name;
      guildNames[selectedGuildId] = link.candidates.find((candidate) => candidate.guildId === selectedGuildId)!.name;
      return authorization;
    }),
    getDiscordGuildNames: async () => guildNames,
    getDiscordRoleNames: async () => roleNames,
    getAdminRuntimeStatus: vi.fn(async (ownerEmail: string) => {
      if (ownerEmail !== owner) throw new TypeError('Owner authentication required.');
      return runtimeStatus;
    }),
    setDiscordRoles: (roles: DiscordRoleOption[]) => { availableRoles = roles; },
  };
}

function post(body: string, origin = 'http://localhost') {
  return new Request('http://localhost/admin', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

describe('owner Discord access controls', () => {
  it('shows the live policy and version with owner edit and history controls', async () => {
    const store = controls();
    const policy = await store.getResponsePolicy(owner);
    const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    const section = html.match(/<section aria-labelledby="response-policy-heading">([\s\S]*?)<\/section>/)?.[1];
    expect(section).toContain('Response policy');
    expect(section).toContain('Save new revision');
    expect(section).toContain('name="expectedRevision" value="1"');
    expect(section).toContain(policy.version);
    const escaped = renderToStaticMarkup(createElement('pre', null, policy.markdown)).slice(5, -6);
    expect(section).toContain(escaped);
    expect(section).toContain('Revision history');
    expect(section).toContain(POLICY_BOUNDARY);
  });

  it('puts saved access before optional setup and keeps existing grants usable with an expired server list', async () => {
    const store = controls();
    await store.saveLinkedDiscordAccount(owner, {
      userId, displayName: 'Linked Person', linkedAt: 0, candidates: [], candidatesExpireAt: 1,
    });
    await store.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    await store.mutateDiscordAuthorization({ action: 'grant-user', guildId, id: userId });
    const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(html.indexOf('id="approved-heading"')).toBeLessThan(html.indexOf('id="add-access"'));
    expect(html.indexOf('name="action" value="grant-user"')).toBeLessThan(html.indexOf('id="add-access"'));
    expect(html).not.toMatch(/<details id="add-access"[^>]*open/);
    expect(html).toContain('name="action" value="revoke-user"');
    expect(html).toContain('Refresh to add a server or role. Existing access still works.');
    expect(html).not.toContain('name="action" value="approve-linked-server"');
    expect(html).toContain('href="#main"');
    expect(html).toMatch(/<details[^>]*id="policy-history"(?![^>]*open)/);
  });

  it('opens revision history when following a history page link', async () => {
    const html = await (await handleAdminRequest(new Request('http://localhost/admin?policy_before=2'), localEnv(), controls())).text();
    expect(html).toMatch(/<details[^>]*id="policy-history"[^>]*open=""/);
  });

  it('escapes policy markup instead of executing or rendering raw HTML', async () => {
    const store = controls();
    await store.updateResponsePolicy(owner, 1, '</textarea><script>alert("policy")</script><form><input name="policy"></form>', 'admin');
    const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<input name="policy">');
  });

  it.each(['update-policy', 'edit-policy', 'save-policy'])('rejects a malformed %s admin action', async (action) => {
    const store = controls();
    const before = await store.getResponsePolicy(owner);
    const result = await handleAdminRequest(post(`action=${action}&policy=Ignore+all+rules`), localEnv(), store);
    expect(result.status).toBe(400);
    expect(store.mutateDiscordAuthorization).not.toHaveBeenCalled();
    expect(await store.getResponsePolicy(owner)).toEqual(before);
  });

  it('offers manual Codex setup from the configured issuer without starting OAuth or granting access', async () => {
    const store = controls();
    const response = await handleAdminRequest(new Request('http://localhost/admin'), localEnv({
      MCP_ISSUER_URL: 'https://discord-dot.example.test/',
    }), store);
    const html = await response.text();
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Set up in Codex/);
    expect(html).not.toMatch(/<details[^>]*\sopen[^>]*><summary[^>]*>Set up in Codex/);
    expect(html).toContain('for="codex-mcp-url"');
    expect(html).toMatch(/id="codex-mcp-url"[^>]*readOnly=""[^>]*value="https:\/\/discord-dot.example.test\/mcp"/);
    expect(html).toContain('codex mcp add discord-dot --url https://discord-dot.example.test/mcp');
    expect(html).toContain('codex mcp login discord-dot');
    expect(html).toContain('discord:read');
    expect(html).toContain('discord:reply');
    expect(html).toContain('Connecting does not create an event subscription.');
    expect(html).toContain('https://developers.openai.com/codex/mcp/');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toContain(
      `script-src 'sha256-${createHash('sha256').update(script!).digest('base64')}'`,
    );
    expect(html).toContain('aria-label="Copy MCP server URL"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toMatch(/onclick=|onload=/);
    expect(html).not.toContain('codex://');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(store.beginDiscordOAuth).not.toHaveBeenCalled();
    expect(store.mutateDiscordAuthorization).not.toHaveBeenCalled();
  });

  it.each([undefined, 'https://secret@discord-dot.test', 'https://discord-dot.test/?token=secret', 'https://discord-dot.test/admin', 'javascript:alert(1)'])(
    'withholds Codex connection instructions for an invalid issuer (%s)', async (issuer) => {
      const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv({ MCP_ISSUER_URL: issuer }), controls())).text();
      expect(html).toContain('Set up in Codex');
      expect(html).toContain('The MCP server URL is unavailable.');
      expect(html).not.toContain('id="codex-mcp-url"');
      expect(html).not.toContain('codex mcp add');
      expect(html).not.toContain('secret');
    },
  );

  it('preserves compiled CSS selectors verbatim in the served style element', async () => {
    const response = await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), controls());
    const html = await response.text();
    const stylesheet = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    expect(response.status).toBe(200);
    expect(adminCss).toContain('\\&');
    expect(stylesheet).toBe(adminCss);
    expect(stylesheet).not.toContain('&amp;');
  });

  it('requires owner authentication for reads and management changes', async () => {
    const store = controls();
    const env = localEnv();
    const get = await handleAdminRequest(new Request('https://discord-dot.test/admin'), env, store);
    expect(get.status).toBe(403);

    const remotePost = await handleAdminRequest(new Request('https://discord-dot.test/admin', {
      method: 'POST',
      headers: { origin: 'https://discord-dot.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: `action=grant-user&guildId=${guildId}&id=${userId}`,
    }), env, store);
    expect(remotePost.status).toBe(403);
    expect(store.mutateDiscordAuthorization).not.toHaveBeenCalled();
  });

  it('shows the empty default, links an account, and grants only its stored identity', async () => {
    const store = controls();
    const env = localEnv();
    const empty = await handleAdminRequest(new Request('http://localhost/admin'), env, store);
    const emptyHtml = await empty.text();
    expect(empty.status).toBe(200);
    expect(empty.headers.get('referrer-policy')).toBe('strict-origin');
    expect(emptyHtml).toContain('No servers approved');
    expect(emptyHtml).toMatch(/<details id="add-access"[^>]*open=""/);
    expect(emptyHtml).toContain('Link Discord account');
    expect(emptyHtml).toContain('Servers and members start with no access');
    expect(emptyHtml).toContain('Gateway connection');
    expect(emptyHtml).toContain('There is no active authorized event subscription');
    expect(empty.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(emptyHtml).not.toContain('<script');
    expect(emptyHtml).not.toContain('name="id"');

    const applicationId = '55555555555555555';
    const start = await handleAdminRequest(post('action=start-discord-link'), localEnv({ DISCORD_BOT_USER_ID: applicationId }), store);
    expect(start.status).toBe(503);

    const envWithOAuth = localEnv({
      DISCORD_BOT_USER_ID: applicationId,
      DISCORD_OAUTH_CLIENT_SECRET: 'synthetic-client-secret',
      DISCORD_BOT_TOKEN: 'synthetic-bot-token',
    });
    const linkResponse = await handleAdminRequest(post('action=start-discord-link'), envWithOAuth, store);
    expect(linkResponse.status).toBe(303);
    expect(linkResponse.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    const authorize = new URL(linkResponse.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe(applicationId);
    expect(authorize.searchParams.get('scope')).toBe('identify guilds');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost/admin?discord_oauth=callback');
    expect(store.beginDiscordOAuth).toHaveBeenCalledWith(owner, expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Number));

    const cookie = linkResponse.headers.get('set-cookie')!.split(';', 1)[0]!;
    const state = authorize.searchParams.get('state')!;
    const discordFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v10/oauth2/token') {
        return Response.json({ access_token: 'ephemeral-access-token', token_type: 'Bearer', scope: 'identify guilds' });
      }
      if (url.pathname === '/api/v10/users/@me') {
        return Response.json({ id: userId, username: 'linked-user', global_name: 'Linked Person' });
      }
      if (url.pathname === '/api/v10/users/@me/guilds') {
        return Response.json([
          { id: guildId, name: 'Owned & <Safe>', owner: true, permissions: '0' },
          { id: '22222222222222222', name: 'Can Manage', owner: false, permissions: '32' },
          { id: '66666666666666666', name: 'Admin bit', owner: false, permissions: '8' },
          { id: '77777777777777777', name: 'No management', owner: false, permissions: '4' },
          { id: '88888888888888888', name: 'Bad permissions', owner: false, permissions: 'not-a-bitfield' },
        ]);
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const callback = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&code=synthetic-code`,
      { headers: { cookie } },
    ), envWithOAuth, store, discordFetch as typeof fetch);
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/admin?discord_link=linked');
    expect(callback.headers.get('set-cookie')).toContain('Max-Age=0');
    const html = await (await handleAdminRequest(new Request('http://localhost/admin?discord_link=linked'), envWithOAuth, store)).text();
    expect(html).toContain('Linked Person');
    expect(html).toContain('Owned &amp; &lt;Safe&gt;');
    expect(html).toMatch(/<details id="add-access"[^>]*open=""/);
    expect(html).toContain('Can Manage');
    expect(html).toContain('Admin bit');
    expect(html).toContain(`value="${guildId}"`);
    expect(html).toContain('Owned &amp; &lt;Safe&gt;');
    expect(html).toContain('Approve server only');
    expect(html).toContain('Approves the server without granting anyone access.');
    expect(html).toContain('Grant my account');
    expect(html).toContain('Gateway connection');
    expect(html).toContain('Add Dot to a server');
    expect(html).toContain(`client_id=${applicationId}&amp;scope=bot&amp;permissions=274877975552`);
    expect(html).not.toContain('No management');
    expect(html).not.toContain('Bad permissions');
    expect(html).not.toContain('ephemeral-access-token');
    expect(store.saveLinkedDiscordAccount).toHaveBeenCalledWith(owner, expect.objectContaining({ userId, displayName: 'Linked Person' }));
    expect(discordFetch).toHaveBeenCalledTimes(3);
    expect(discordFetch.mock.calls.map(([, init]) => init?.redirect)).toEqual(['manual', 'manual', 'manual']);
    const tokenRequest = discordFetch.mock.calls[0]![1] as RequestInit;
    expect(String(tokenRequest.body)).toContain(`client_id=${applicationId}`);
    expect(String(tokenRequest.body)).toContain('client_secret=synthetic-client-secret');

    const serverApproval = await handleAdminRequest(post(`action=approve-linked-server&guildId=${guildId}`), envWithOAuth, store);
    expect(serverApproval.status).toBe(303);
    expect(store.approveLinkedServer).toHaveBeenCalledWith(owner, guildId, expect.any(Number));
    expect(await store.getDiscordAuthorization()).toEqual({ guilds: { [guildId]: { userIds: [], roleIds: [] } } });

    const grant = await handleAdminRequest(post(`action=grant-linked-account&guildId=${guildId}&id=99999999999999999`), envWithOAuth, store);
    expect(grant.status).toBe(303);
    expect(store.grantLinkedAccountToServer).toHaveBeenCalledWith(owner, guildId, expect.any(Number));
    const grantedHtml = await (await handleAdminRequest(new Request('http://localhost/admin'), envWithOAuth, store)).text();
    expect(grantedHtml).toContain(userId);
    expect(grantedHtml).not.toContain('99999999999999999');

    const rolesPage = await handleAdminRequest(post(`action=load-role-options&guildId=${guildId}`), envWithOAuth, store);
    expect(rolesPage.status).toBe(200);
    const rolesHtml = await rolesPage.text();
    expect(rolesHtml).toContain(`value="${roleId}"`);
    expect(rolesHtml).toContain('Example reviewers');
    expect(rolesHtml).toMatch(/<details id="add-access"[^>]*open=""/);
    expect(rolesHtml).toContain('&lt;Admin &amp; team&gt;');
    expect(rolesHtml).not.toMatch(new RegExp(`<option value="${guildId}"[^>]*>@everyone</option>`));
    expect(rolesHtml).toContain('Approve server and grant role');
    expect(rolesHtml).toContain('Role grants do not assign Discord roles');
    expect(store.grantLinkedRoleToServer).not.toHaveBeenCalled();

    const roleGrant = await handleAdminRequest(post(`action=grant-linked-role&guildId=${guildId}&roleId=${roleId}`), envWithOAuth, store);
    expect(roleGrant.status).toBe(303);
    expect(store.grantLinkedRoleToServer).toHaveBeenCalledWith(owner, guildId, roleId, expect.any(Number));
    const roleGrantedHtml = await (await handleAdminRequest(new Request('http://localhost/admin'), envWithOAuth, store)).text();
    expect(roleGrantedHtml).toContain(roleId);
    expect(roleGrantedHtml).toContain('Example reviewers');
  });

  it('rejects arbitrary grant IDs and cross-origin, malformed, and oversized posts', async () => {
    const store = controls();
    const env = localEnv();
    const request = (headers: Record<string, string>, body = `action=grant-user&guildId=${guildId}&id=bad`) =>
      handleAdminRequest(new Request('http://localhost/admin', { method: 'POST', headers, body }), env, store);

    expect((await request({ origin: 'https://attacker.test', 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(403);
    // Referrer-Policy: no-referrer makes browser form POSTs send Origin: null; keep that fail-closed.
    const nullOrigin = await request({ origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }, 'action=start-discord-link');
    expect(nullOrigin.status).toBe(403);
    expect(await nullOrigin.text()).toContain('This form request was rejected.');
    expect(store.beginDiscordOAuth).not.toHaveBeenCalled();
    expect((await request({ origin: 'http://localhost', 'content-type': 'application/json' })).status).toBe(403);
    expect((await request({ origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(400);
    expect(store.mutateDiscordAuthorization).not.toHaveBeenCalled();
    expect(store.approveLinkedServer).not.toHaveBeenCalled();
    expect(store.grantLinkedAccountToServer).not.toHaveBeenCalled();
    expect(store.grantUserToServer).not.toHaveBeenCalled();
  });

  it('offers direct user grants only inside an approved server and routes them through membership verification', async () => {
    const store = controls();
    await store.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    const pageHtml = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(pageHtml).toContain('name="action" value="grant-user"');
    expect(pageHtml).toContain('Discord user ID');
    expect(pageHtml).toContain('current human member');

    const grant = await handleAdminRequest(post(`action=grant-user&guildId=${guildId}&id=${userId}`), localEnv(), store);
    expect(grant.status).toBe(303);
    expect(store.grantUserToServer).toHaveBeenCalledWith(owner, guildId, userId, expect.any(Number));
    const grantedHtml = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(grantedHtml).toContain(userId);
    expect(grantedHtml).toContain('Revoke user access');

    const invalid = await handleAdminRequest(post(`action=grant-user&guildId=${guildId}&id=not-a-snowflake`), localEnv(), store);
    expect(invalid.status).toBe(400);
    expect(store.grantUserToServer).toHaveBeenCalledTimes(1);
  });

  it('requires the matching owner-bound one-time state and cookie, and handles cancellation safely', async () => {
    const store = controls();
    const env = localEnv({ DISCORD_BOT_USER_ID: '55555555555555555', DISCORD_OAUTH_CLIENT_SECRET: 'synthetic-secret' });
    const start = await handleAdminRequest(post('action=start-discord-link'), env, store);
    const authorize = new URL(start.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const noCookie = await handleAdminRequest(new Request(`http://localhost/admin?discord_oauth=callback&state=${state}&error=access_denied`), env, store);
    expect(noCookie.status).toBe(303);
    expect(store.consumeDiscordOAuthState).not.toHaveBeenCalled();

    const wrongState = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${'a'.repeat(64)}&error=access_denied`, { headers: { cookie } },
    ), env, store);
    expect(wrongState.status).toBe(303);
    expect(store.consumeDiscordOAuthState).not.toHaveBeenCalled();

    const cancelled = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&error=access_denied`, { headers: { cookie } },
    ), env, store);
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get('location')).toBe('/admin?discord_link=cancelled');
    const cancelledPage = await handleAdminRequest(new Request(`http://localhost${cancelled.headers.get('location')!}`), env, store);
    expect(await cancelledPage.text()).toContain('Discord account linking was cancelled');
    expect(store.consumeDiscordOAuthState).toHaveBeenCalledTimes(1);
    expect(store.saveLinkedDiscordAccount).not.toHaveBeenCalled();
  });

  it('does not reflect OAuth provider errors, codes, or secrets into the admin page', async () => {
    const store = controls();
    const secret = 'synthetic-client-secret-do-not-render';
    const code = 'synthetic-authorization-code-do-not-render';
    const accessToken = 'synthetic-access-token-do-not-log';
    const env = localEnv({ DISCORD_BOT_USER_ID: '55555555555555555', DISCORD_OAUTH_CLIENT_SECRET: secret });
    const start = await handleAdminRequest(post('action=start-discord-link'), env, store);
    const authorize = new URL(start.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const diagnosticLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const discordFetch = vi.fn(async () => new Response(`invalid ${secret} ${code} ${accessToken} ${state} ${cookie}`, { status: 401 }));

    const callback = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&code=${code}`,
      { headers: { cookie } },
    ), env, store, discordFetch as typeof fetch);
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/admin?discord_link=failed');
    const html = await (await handleAdminRequest(new Request('http://localhost/admin?discord_link=failed'), env, store)).text();
    expect(html).toContain('Discord account linking failed');
    expect(html).not.toContain(secret);
    expect(html).not.toContain(code);
    expect(html).not.toContain('access_denied');
    expect(store.saveLinkedDiscordAccount).not.toHaveBeenCalled();
    expect(diagnosticLog).toHaveBeenCalledOnce();
    expect(diagnosticLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'discord_oauth_callback_failure',
      stage: 'token_exchange',
      token_status: 401,
    }));
    const loggedDiagnostics = JSON.stringify(diagnosticLog.mock.calls);
    for (const sensitiveValue of [secret, code, accessToken, state, cookie]) {
      expect(loggedDiagnostics).not.toContain(sensitiveValue);
    }
  });

  it('refuses token-endpoint redirects and logs only their status', async () => {
    const store = controls();
    const env = localEnv({
      DISCORD_BOT_USER_ID: '55555555555555555',
      DISCORD_OAUTH_CLIENT_SECRET: 'synthetic-secret',
    });
    const start = await handleAdminRequest(post('action=start-discord-link'), env, store);
    const authorize = new URL(start.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const redirectLocation = 'https://redirect-target.example.test/private';
    const diagnosticLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const discordFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { location: redirectLocation },
    }));

    const callback = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&code=synthetic-code`,
      { headers: { cookie } },
    ), env, store, discordFetch as typeof fetch);

    expect(callback.headers.get('location')).toBe('/admin?discord_link=failed');
    expect(discordFetch).toHaveBeenCalledOnce();
    expect(discordFetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(diagnosticLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'discord_oauth_callback_failure',
      stage: 'token_exchange',
      token_status: 302,
    }));
    expect(JSON.stringify(diagnosticLog.mock.calls)).not.toContain(redirectLocation);
    expect(store.saveLinkedDiscordAccount).not.toHaveBeenCalled();
  });

  it('records only safe statuses when Discord account lookups fail', async () => {
    const store = controls();
    const accessToken = 'synthetic-access-token-do-not-log';
    const env = localEnv({ DISCORD_BOT_USER_ID: '55555555555555555', DISCORD_OAUTH_CLIENT_SECRET: 'synthetic-secret' });
    const start = await handleAdminRequest(post('action=start-discord-link'), env, store);
    const authorize = new URL(start.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const diagnosticLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const discordFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v10/oauth2/token') {
        return Response.json({ access_token: accessToken, token_type: 'Bearer', scope: 'identify guilds' });
      }
      if (url.pathname === '/api/v10/users/@me') return new Response('private profile response', { status: 503 });
      if (url.pathname === '/api/v10/users/@me/guilds') return new Response('private guild response', { status: 429 });
      throw new Error('Unexpected URL');
    });

    const callback = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&code=synthetic-code-do-not-log`,
      { headers: { cookie } },
    ), env, store, discordFetch as typeof fetch);

    expect(callback.headers.get('location')).toBe('/admin?discord_link=failed');
    expect(diagnosticLog).toHaveBeenCalledWith({
      event: 'discord_oauth_callback_failure',
      stage: 'discord_account_lookup',
      token_status: 200,
      profile_status: 503,
      guilds_status: 429,
    });
    const loggedDiagnostics = JSON.stringify(diagnosticLog.mock.calls);
    for (const sensitiveValue of [accessToken, state, cookie, 'synthetic-code-do-not-log', 'private profile response', 'private guild response']) {
      expect(loggedDiagnostics).not.toContain(sensitiveValue);
    }
    expect(store.saveLinkedDiscordAccount).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: 'profile fetch rejection',
      failure: 'profile_fetch',
      diagnostic: { stage: 'discord_account_lookup', profile_fetch_failed: true, guilds_status: 200 },
    },
    {
      description: 'guild-list fetch rejection',
      failure: 'guilds_fetch',
      diagnostic: { stage: 'discord_account_lookup', profile_status: 200, guilds_fetch_failed: true },
    },
    {
      description: 'profile payload JSON rejection',
      failure: 'profile_payload',
      diagnostic: { stage: 'discord_account_payload', profile_status: 200, guilds_status: 200, profile_payload_failed: true },
    },
    {
      description: 'guild-list payload JSON rejection',
      failure: 'guilds_payload',
      diagnostic: { stage: 'discord_account_payload', profile_status: 200, guilds_status: 200, guilds_payload_failed: true },
    },
  ] as const)('logs safe markers for $description', async ({ failure, diagnostic }) => {
    const store = controls();
    const secret = 'synthetic-client-secret-do-not-log';
    const code = 'synthetic-code-do-not-log';
    const accessToken = 'synthetic-access-token-do-not-log';
    const env = localEnv({ DISCORD_BOT_USER_ID: '55555555555555555', DISCORD_OAUTH_CLIENT_SECRET: secret });
    const start = await handleAdminRequest(post('action=start-discord-link'), env, store);
    const authorize = new URL(start.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const diagnosticLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sensitiveError = `provider detail ${secret} ${code} ${accessToken} ${state} ${cookie}`;
    const discordFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v10/oauth2/token') {
        return Response.json({ access_token: accessToken, token_type: 'Bearer', scope: 'identify guilds' });
      }
      if (url.pathname === '/api/v10/users/@me') {
        if (failure === 'profile_fetch') throw new Error(sensitiveError);
        if (failure === 'profile_payload') return new Response(`invalid JSON ${sensitiveError}`, { status: 200 });
        return Response.json({ id: userId, username: 'linked-user' });
      }
      if (url.pathname === '/api/v10/users/@me/guilds') {
        if (failure === 'guilds_fetch') throw new Error(sensitiveError);
        if (failure === 'guilds_payload') return new Response(`invalid JSON ${sensitiveError}`, { status: 200 });
        return Response.json([{ id: guildId, name: 'Synthetic server', owner: true }]);
      }
      throw new Error('Unexpected URL');
    });

    const callback = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&code=${code}`,
      { headers: { cookie } },
    ), env, store, discordFetch as typeof fetch);

    expect(callback.headers.get('location')).toBe('/admin?discord_link=failed');
    expect(diagnosticLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'discord_oauth_callback_failure',
      token_status: 200,
      ...diagnostic,
    }));
    const loggedDiagnostics = JSON.stringify(diagnosticLog.mock.calls);
    for (const sensitiveValue of [secret, code, accessToken, state, cookie, sensitiveError]) {
      expect(loggedDiagnostics).not.toContain(sensitiveValue);
    }
    expect(store.saveLinkedDiscordAccount).not.toHaveBeenCalled();
  });

  it('identifies linked-account persistence failures without exposing provider values', async () => {
    const store = controls();
    store.saveLinkedDiscordAccount.mockRejectedValue(new Error('private storage detail'));
    const accessToken = 'synthetic-access-token-do-not-log';
    const env = localEnv({ DISCORD_BOT_USER_ID: '55555555555555555', DISCORD_OAUTH_CLIENT_SECRET: 'synthetic-secret' });
    const start = await handleAdminRequest(post('action=start-discord-link'), env, store);
    const authorize = new URL(start.headers.get('location')!);
    const state = authorize.searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';', 1)[0]!;
    const diagnosticLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const discordFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/api/v10/oauth2/token') {
        return Response.json({ access_token: accessToken, token_type: 'Bearer', scope: 'identify guilds' });
      }
      if (url.pathname === '/api/v10/users/@me') return Response.json({ id: userId, username: 'linked-user' });
      if (url.pathname === '/api/v10/users/@me/guilds') return Response.json([{ id: guildId, name: 'Synthetic server', owner: true }]);
      throw new Error('Unexpected URL');
    });

    const callback = await handleAdminRequest(new Request(
      `http://localhost/admin?discord_oauth=callback&state=${state}&code=synthetic-code-do-not-log`,
      { headers: { cookie } },
    ), env, store, discordFetch as typeof fetch);

    expect(callback.headers.get('location')).toBe('/admin?discord_link=failed');
    expect(diagnosticLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'discord_oauth_callback_failure',
      stage: 'save_link',
      token_status: 200,
      profile_status: 200,
      guilds_status: 200,
    }));
    const loggedDiagnostics = JSON.stringify(diagnosticLog.mock.calls);
    for (const sensitiveValue of [accessToken, state, cookie, 'synthetic-code-do-not-log', 'private storage detail']) {
      expect(loggedDiagnostics).not.toContain(sensitiveValue);
    }
  });

  it('shows an empty role state and rejects malformed or @everyone role submissions', async () => {
    const store = controls();
    await store.saveLinkedDiscordAccount(owner, {
      userId,
      displayName: 'Linked account',
      linkedAt: Date.now(),
      candidates: [{ guildId, name: 'Synthetic server' }],
      candidatesExpireAt: Date.now() + 60_000,
    });
    store.setDiscordRoles([]);

    const loaded = await handleAdminRequest(post(`action=load-role-options&guildId=${guildId}`), localEnv(), store);
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toContain('No grantable roles were returned');

    const badGuild = await handleAdminRequest(post('action=load-role-options&guildId=bad'), localEnv(), store);
    expect(badGuild.status).toBe(400);
    expect(store.getLinkedServerRoles).toHaveBeenCalledTimes(1);
    const everyone = await handleAdminRequest(post(`action=grant-linked-role&guildId=${guildId}&roleId=${guildId}`), localEnv(), store);
    expect(everyone.status).toBe(400);
    expect(await everyone.text()).toContain('non-@everyone role');
    expect(store.grantLinkedRoleToServer).not.toHaveBeenCalled();
  });

  it('renders prior grants for revocation after unlinking and does not add role grants', async () => {
    const store = controls();
    await store.saveLinkedDiscordAccount(owner, {
      userId,
      displayName: 'Linked account',
      linkedAt: Date.now(),
      candidates: [{ guildId, name: 'Synthetic server' }],
      candidatesExpireAt: Date.now() + 60_000,
    });
    await store.mutateDiscordAuthorization({ action: 'approve-server', guildId });
    await store.mutateDiscordAuthorization({ action: 'grant-user', guildId, id: userId });
    await store.mutateDiscordAuthorization({ action: 'grant-role', guildId, id: roleId });
    await store.unlinkDiscordAccount(owner);
    const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(html).toContain(userId);
    expect(html).toContain(roleId);
    expect(html).toContain('Revoke role');
    expect(html).not.toContain('Grant a role');
    expect(html).not.toContain('name="action" value="grant-role"');

    const response = await handleAdminRequest(post(`action=revoke-role&guildId=${guildId}&id=${roleId}`), localEnv(), store);
    expect(response.status).toBe(303);
    expect(store.mutateDiscordAuthorization).toHaveBeenLastCalledWith({ action: 'revoke-role', guildId, id: roleId });
  });
});

describe('owner policy editing', () => {
  const edit = (expectedRevision: string, markdown: string) => new URLSearchParams({ action: 'update-policy', expectedRevision, markdown }).toString();
  it('saves live edits and restores history as a new revision, with stale-write rejection', async () => {
    const store = controls();
    const initial = await store.getResponsePolicy(owner);
    expect((await handleAdminRequest(post(edit('1', 'Owner edit')), localEnv(), store)).status).toBe(303);
    expect((await store.getResponsePolicy(owner)).markdown).toBe('Owner edit');
    const stale = await handleAdminRequest(post(edit('1', 'Old form')), localEnv(), store);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('Your edit was not saved');
    const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(html).toContain('Restore revision 1 as a new revision');
    expect(html).toContain('name="expectedRevision" value="2"');
    const rollback = await handleAdminRequest(post('action=rollback-policy&expectedRevision=2&revision=1'), localEnv(), store);
    expect(rollback.status).toBe(303);
    expect(await store.getResponsePolicy(owner)).toMatchObject({ revision: 3, markdown: initial.markdown, restoredFrom: 1 });
    expect((await handleAdminRequest(post('action=rollback-policy&expectedRevision=2&revision=1'), localEnv(), store)).status).toBe(409);
    expect((await handleAdminRequest(post('action=rollback-policy&expectedRevision=3&revision=999'), localEnv(), store)).status).toBe(404);
  });

  it('requires owner authentication and same-origin form submission for edits and rollback', async () => {
    const store = controls();
    for (const body of [edit('1', 'Denied'), 'action=rollback-policy&expectedRevision=1&revision=1']) {
      expect((await handleAdminRequest(post(body, 'https://attacker.test'), localEnv(), store)).status).toBe(403);
      const remote = new Request('https://discord-dot.test/admin', { method: 'POST', headers: { origin: 'https://discord-dot.test', 'content-type': 'application/x-www-form-urlencoded' }, body });
      expect((await handleAdminRequest(remote, localEnv(), store)).status).toBe(403);
      const noOrigin = new Request('http://localhost/admin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      expect((await handleAdminRequest(noOrigin, localEnv(), store)).status).toBe(403);
      const json = new Request('http://localhost/admin', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{}' });
      expect((await handleAdminRequest(json, localEnv(), store)).status).toBe(403);
    }
    expect((await store.getResponsePolicy(owner)).revision).toBe(1);
  });

  it('rejects duplicate fields, invalid revisions and oversized Markdown without saving', async () => {
    const store = controls();
    for (const body of [edit('-1', 'text'), edit('1.5', 'text'), edit('1', ''), edit('1', 'é'.repeat(8193)), edit('1', 'text') + '&expectedRevision=1', edit('1', 'text') + '&markdown=duplicate']) {
      expect((await handleAdminRequest(post(body), localEnv(), store)).status).toBe(400);
    }
    expect((await handleAdminRequest(post(edit('1', 'x'.repeat(60000))), localEnv(), store)).status).toBe(413);
    expect((await store.getResponsePolicy(owner)).revision).toBe(1);
  });
});

describe('unconfigured admin policy', () => {
  it('shows an empty editor and revision zero until a separate owner seed is saved', async () => {
    const store = controls(false);
    const html = await (await handleAdminRequest(new Request('http://localhost/admin'), localEnv(), store)).text();
    expect(html).toContain('Policy is not configured');
    expect(html).toContain('No saved revisions yet.');
    expect(html).toContain('name="expectedRevision" value="0"');
    expect(html).toMatch(/<textarea[^>]*name="markdown"[^>]*><\/textarea>/);
    expect(html).toContain(POLICY_BOUNDARY);
    const body = new URLSearchParams({ action: 'update-policy', expectedRevision: '0', markdown: 'Separately supplied example text' }).toString();
    expect((await handleAdminRequest(post(body), localEnv(), store)).status).toBe(303);
    expect(await store.getResponsePolicy(owner)).toMatchObject({ configured: true, revision: 1, markdown: 'Separately supplied example text' });
    expect((await handleAdminRequest(post(body), localEnv(), store)).status).toBe(409);
  });
});

describe('policy history query validation', () => {
  it.each(['0', '-1', '1.5', '', 'invalid', '9007199254740991', '1&policy_before=2'])(
    'rejects policy_before=%s as a bad request before loading storage', async (query) => {
      const store = controls();
      const load = vi.spyOn(store, 'getDiscordAuthorization');
      const history = vi.spyOn(store, 'listResponsePolicyRevisions');
      const response = await handleAdminRequest(new Request(`http://localhost/admin?policy_before=${query}`), localEnv(), store);
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('Policy history cursor was rejected');
      expect(html).not.toContain('storage is unavailable');
      expect(load).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
    },
  );

  it('passes valid pagination through and still reports real storage failures as 503', async () => {
    const store = controls();
    const history = vi.spyOn(store, 'listResponsePolicyRevisions');
    const request = () => new Request('http://localhost/admin?policy_before=1');
    expect((await handleAdminRequest(request(), localEnv(), store)).status).toBe(200);
    expect(history).toHaveBeenCalledWith(owner, 1);
    history.mockRejectedValue(new Error('synthetic storage failure'));
    const failure = await handleAdminRequest(request(), localEnv(), store);
    expect(failure.status).toBe(503);
    expect(await failure.text()).toContain('Runtime authorization storage is unavailable');
  });
});
