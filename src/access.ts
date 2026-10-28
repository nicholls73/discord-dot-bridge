import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './types.js';

const keySets = new Map<string, JWTVerifyGetKey>();
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function accessAuthorized(
  request: Request,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ACCESS_OWNER_EMAIL' | 'ALLOW_LOCAL_AUTH'>,
  keySet?: JWTVerifyGetKey,
): Promise<boolean> {
  const owner = normalizeEmail(env.ACCESS_OWNER_EMAIL);
  if (!owner) return false;

  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (!assertion) {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return env.ALLOW_LOCAL_AUTH === 'true' && LOOPBACK_HOSTS.has(hostname);
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.ACCESS_AUD?.trim();
  if (!teamDomain || !audience || /[/:?#@]/.test(teamDomain)) return false;

  const issuer = `https://${teamDomain}`;
  if (!keySet) {
    keySet = keySets.get(issuer);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keySets.set(issuer, keySet);
    }
  }

  try {
    const { payload } = await jwtVerify(assertion, keySet, { issuer, audience });
    return normalizeEmail(payload.email) === owner;
  } catch {
    return false;
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}
