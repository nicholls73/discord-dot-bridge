import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { accessAuthorized } from '../src/access.js';
import type { Env } from '../src/types.js';

const owner = 'owner@example.test';
const teamDomain = 'example.cloudflareaccess.com';
const audience = 'test-access-audience';

function accessEnv(overrides: Partial<Env> = {}): Env {
  return {
    ACCESS_OWNER_EMAIL: ` ${owner.toUpperCase()} `,
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: audience,
    ...overrides,
  };
}

describe('Cloudflare Access owner gate', () => {
  it('requires explicit local auth and loopback when no Access assertion is supplied', async () => {
    expect(await accessAuthorized(new Request('http://localhost/authorize'), accessEnv())).toBe(false);
    expect(await accessAuthorized(new Request('http://localhost/authorize'), accessEnv({ ALLOW_LOCAL_AUTH: 'true' }))).toBe(true);
    expect(await accessAuthorized(new Request('https://bridge.example/authorize'), accessEnv({ ALLOW_LOCAL_AUTH: 'true' }))).toBe(false);
  });

  it('verifies Access JWT signature, issuer, audience and exact owner email', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key';
    const token = await new SignJWT({ email: owner })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(`https://${teamDomain}`)
      .setAudience(audience)
      .setExpirationTime('5m')
      .sign(privateKey);
    const keySet = createLocalJWKSet({ keys: [publicJwk] });
    const request = new Request('https://bridge.example/authorize', {
      headers: { 'cf-access-jwt-assertion': token },
    });

    expect(await accessAuthorized(request, accessEnv(), keySet)).toBe(true);
    expect(await accessAuthorized(request, accessEnv({ ACCESS_AUD: 'wrong-audience' }), keySet)).toBe(false);
    expect(await accessAuthorized(request, accessEnv({ ACCESS_OWNER_EMAIL: 'other@example.test' }), keySet)).toBe(false);
    expect(await accessAuthorized(request, accessEnv({ ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com' }), keySet)).toBe(false);
  });
});
