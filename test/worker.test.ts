import { describe, expect, it } from 'vitest';
import { fetchWorker } from '../src/worker.js';
import type { Env } from '../src/types.js';

const context = {} as ExecutionContext;
const issuer = 'https://discord-dot.example.test';

function kv(): KVNamespace {
  return {} as KVNamespace;
}

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: kv(),
    MCP_ISSUER_URL: issuer,
    ACCESS_OWNER_EMAIL: 'owner@example.test',
    ...overrides,
  };
}

describe('Worker routing and OAuth discovery', () => {
  it.each(['/policy', '/POLICY.md', '/admin/policy', '/api/policy'])('exposes no policy HTTP route at %s', async (path) => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetchWorker(new Request(`${issuer}${path}`, { method }), configuredEnv(), context);
      expect(response.status).toBe(404);
    }
  });

  it('returns 404 for non-MCP paths', async () => {
    const response = await fetchWorker(new Request(`${issuer}/health`), {}, context);
    expect(response.status).toBe(404);
  });

  it('routes management through the owner authentication gate', async () => {
    const response = await fetchWorker(
      new Request(`${issuer}/admin`),
      configuredEnv(),
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Owner authentication required');
  });

  it('routes management through the owner authentication gate', async () => {
    const response = await fetchWorker(
      new Request(`${issuer}/admin`),
      configuredEnv(),
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Owner authentication required');
  });

  it('fails closed when OAuth storage is missing', async () => {
    const response = await fetchWorker(new Request(`${issuer}/mcp`), {
      MCP_ISSUER_URL: issuer,
    }, context);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('OAUTH_KV');
  });

  it('fails closed when the configured issuer is not a canonical secure origin', async () => {
    const response = await fetchWorker(new Request(`${issuer}/authorize`), configuredEnv({
      MCP_ISSUER_URL: 'http://not-local.example.test',
    }), context);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('MCP_ISSUER_URL');
  });

  it('serves protected-resource metadata with both scopes needed for mention replies', async () => {
    const response = await fetchWorker(
      new Request(`${issuer}/.well-known/oauth-protected-resource/mcp`),
      configuredEnv(),
      context,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ['discord:read', 'discord:reply'],
    });
  });

  it('serves authorization-server discovery with the configured OAuth endpoints', async () => {
    const response = await fetchWorker(
      new Request(`${issuer}/.well-known/oauth-authorization-server`),
      configuredEnv(),
      context,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      scopes_supported: ['discord:read', 'discord:reply', 'discord:channel:read', 'discord:message:send', 'discord:message:edit', 'discord:policy:manage'],
    });
  });

  it('challenges unauthenticated MCP requests with both scopes and the resource metadata URL', async () => {
    const response = await fetchWorker(new Request(`${issuer}/mcp`, { method: 'POST' }), configuredEnv(), context);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata');
    expect(response.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    expect(response.headers.get('www-authenticate')).toContain('scope="discord:read discord:reply"');
  });
});
