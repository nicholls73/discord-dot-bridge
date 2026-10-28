import { accessAuthorized } from './access.js';
import { fetchWithoutRedirect, RedirectResponseError } from './fetch-no-redirect.js';
import { isDiscordSnowflake, type AuthorizationMutation, type DiscordAuthorization } from './policy.js';
import { managedGuildCandidates, type DiscordRoleOption, type LinkedDiscordAccount } from './discord-account.js';
import type { AdminRuntimeStatus } from './bridge-state.js';
import type { Env } from './types.js';
import { canonicalIssuer } from './issuer.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Activity, ArrowUpRight, CircleAlert, CircleCheck, Copy, Link2, Server, ShieldCheck, UserRound, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader } from './components/ui/card.js';
import { MAX_POLICY_BYTES, POLICY_BOUNDARY, validateRevision, type PolicyControls, type PolicyState, type PolicyHistory } from './response-policy.js';
import adminCss from './admin.css.txt';
import adminCopyScript from './admin-copy.js.txt';

interface AuthorizationControls extends PolicyControls {
  getDiscordAuthorization(): Promise<DiscordAuthorization>;
  mutateDiscordAuthorization(mutation: AuthorizationMutation): Promise<DiscordAuthorization>;
  beginDiscordOAuth(ownerEmail: string, stateHash: string, expiresAt: number): Promise<void>;
  consumeDiscordOAuthState(ownerEmail: string, stateHash: string, now: number): Promise<boolean>;
  getLinkedDiscordAccount(ownerEmail: string): Promise<LinkedDiscordAccount | null>;
  saveLinkedDiscordAccount(ownerEmail: string, link: LinkedDiscordAccount): Promise<void>;
  unlinkDiscordAccount(ownerEmail: string): Promise<void>;
  approveLinkedServer(ownerEmail: string, guildId: string, now: number): Promise<DiscordAuthorization>;
  grantLinkedAccountToServer(ownerEmail: string, guildId: string, now: number): Promise<DiscordAuthorization>;
  grantUserToServer(ownerEmail: string, guildId: string, userId: string, now: number): Promise<DiscordAuthorization>;
  getLinkedServerRoles(ownerEmail: string, guildId: string, now: number): Promise<DiscordRoleOption[]>;
  grantLinkedRoleToServer(ownerEmail: string, guildId: string, roleId: string, now: number): Promise<DiscordAuthorization>;
  getDiscordGuildNames(): Promise<Record<string, string>>;
  getDiscordRoleNames(ownerEmail: string): Promise<Record<string, Record<string, string>>>;
  getAdminRuntimeStatus(ownerEmail: string, now: number): Promise<AdminRuntimeStatus>;
}

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  'content-type': 'text/html; charset=utf-8',
  // Suppress referrer paths and queries without nulling Origin on same-origin form POSTs.
  'referrer-policy': 'strict-origin',
  'x-content-type-options': 'nosniff',
};
const MAX_FORM_BYTES = MAX_POLICY_BYTES * 3 + 8192;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const GUILD_CANDIDATE_TTL_MS = 5 * 60_000;
const OAUTH_STATE_COOKIE = '__Secure-discord-link-state';
const DISCORD_REDIRECT_URI = '/admin?discord_oauth=callback';
const BOT_PERMISSIONS = '274877975552';

type OAuthCallbackFailureStage =
  | 'configuration'
  | 'token_exchange'
  | 'token_response'
  | 'discord_account_lookup'
  | 'discord_account_payload'
  | 'discord_profile_validation'
  | 'discord_guild_list_validation'
  | 'save_link';

export async function handleAdminRequest(
  request: Request,
  env: Env,
  controls?: AuthorizationControls,
  discordFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!await accessAuthorized(request, {
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: env.ACCESS_ADMIN_AUD,
    ACCESS_OWNER_EMAIL: env.ACCESS_OWNER_EMAIL,
    ALLOW_LOCAL_AUTH: env.ALLOW_LOCAL_AUTH,
  })) return page('Owner authentication required.', 403);
  if (!controls) return page('Runtime authorization storage is not configured.', 503);
  const ownerEmail = env.ACCESS_OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail || !ownerEmail.includes('@')) return page('Owner authentication is not configured.', 503);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    let policyBeforeRevision: number | undefined;
    try {
      if (url.searchParams.has('policy_before')) {
        policyBeforeRevision = parsePolicyRevision(oneField(url.searchParams, 'policy_before'));
      }
    } catch {
      return page('Policy history cursor was rejected. Use a single positive revision number.', 400);
    }
    try {
      if (url.searchParams.getAll('discord_oauth').length) {
        if (url.searchParams.getAll('discord_oauth').length !== 1 || url.searchParams.get('discord_oauth') !== 'callback') {
          return oauthCallbackRedirect('invalid', clearOAuthStateCookie());
        }
        return await handleDiscordOAuthCallback(request, url, env, controls, ownerEmail, discordFetch);
      }
      const status = url.searchParams.getAll('discord_link');
      if (status.length > 1) return page('Discord account linking status was rejected.', 400);
      const statusMessage = status.length ? oauthStatusMessage(status[0] ?? '') : undefined;
      if (status.length && !statusMessage) return page('Discord account linking status was rejected.', 400);
      return await renderAdminPage(controls, ownerEmail, env, statusMessage, 200, undefined,
        status[0] === 'linked' ? 'success' : 'info',
        policyBeforeRevision);
    } catch {
      return page('Runtime authorization storage is unavailable.', 503);
    }
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...PAGE_HEADERS, allow: 'GET, POST' },
    });
  }
  if (request.headers.get('origin') !== new URL(request.url).origin ||
      !request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return page('This form request was rejected.', 403);
  }

  const body = await readSmallBody(request);
  if (body === null) return page('Form is too large.', 413);
  const form = new URLSearchParams(body);
  try {
    const action = oneField(form, 'action');
    if (action === 'update-policy' || action === 'rollback-policy') {
      const expectedRevision = parsePolicyRevision(oneField(form, 'expectedRevision'), 0);
      const result = action === 'update-policy'
        ? await controls.updateResponsePolicy(ownerEmail, expectedRevision, onePolicyText(form), 'admin')
        : await controls.rollbackResponsePolicy(ownerEmail, expectedRevision, parsePolicyRevision(oneField(form, 'revision')), 'admin');
      if (!result.ok) {
        return page(result.reason === 'conflict'
          ? 'Policy changed since this form was loaded. Your edit was not saved. Return to admin and compare the current revision before submitting again.'
          : 'The requested policy revision does not exist.', result.reason === 'conflict' ? 409 : 404);
      }
      return redirectToAdmin();
    }
    if (action === 'start-discord-link') return await startDiscordOAuth(request, env, controls, ownerEmail);
    if (action === 'unlink-discord-account') {
      await controls.unlinkDiscordAccount(ownerEmail);
      return redirectToAdmin();
    }
    if (action === 'approve-linked-server') {
      const guildId = oneField(form, 'guildId');
      if (!isDiscordSnowflake(guildId)) throw new TypeError('Choose a valid server from the linked account list.');
      await controls.approveLinkedServer(ownerEmail, guildId, Date.now());
      return redirectToAdmin();
    }
    if (action === 'grant-linked-account') {
      const guildId = oneField(form, 'guildId');
      if (!isDiscordSnowflake(guildId)) throw new TypeError('Choose a valid server from the linked account list.');
      await controls.grantLinkedAccountToServer(ownerEmail, guildId, Date.now());
      return redirectToAdmin();
    }
    if (action === 'load-role-options') {
      const guildId = oneField(form, 'guildId');
      if (!isDiscordSnowflake(guildId)) throw new TypeError('Choose a valid server from the linked account list.');
      const roles = await controls.getLinkedServerRoles(ownerEmail, guildId, Date.now());
      return await renderAdminPage(controls, ownerEmail, env, undefined, 200, { guildId, roles });
    }
    if (action === 'grant-linked-role') {
      const guildId = oneField(form, 'guildId');
      const roleId = oneField(form, 'roleId');
      if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(roleId) || roleId === guildId) {
        throw new TypeError('Choose a valid server and a non-@everyone role.');
      }
      await controls.grantLinkedRoleToServer(ownerEmail, guildId, roleId, Date.now());
      return redirectToAdmin();
    }
    if (action === 'grant-user') {
      const guildId = oneField(form, 'guildId');
      const userId = oneField(form, 'id');
      if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(userId) || userId === guildId) {
        throw new TypeError('Enter a valid server and Discord user ID.');
      }
      await controls.grantUserToServer(ownerEmail, guildId, userId, Date.now());
      return redirectToAdmin();
    }
    await controls.mutateDiscordAuthorization(parseRevocation(form));
    return redirectToAdmin();
  } catch (error) {
    const message = error instanceof TypeError ? error.message : 'The authorization change could not be saved.';
    try {
      return await renderAdminPage(controls, ownerEmail, env, message, 400, undefined, 'error');
    } catch {
      return page(message, 400);
    }
  }
}

function parseRevocation(form: URLSearchParams): AuthorizationMutation {
  const action = oneField(form, 'action');
  const guildId = oneField(form, 'guildId');
  if (!isDiscordSnowflake(guildId)) throw new TypeError('Enter a valid server ID.');
  if (action === 'revoke-server') return { action, guildId };
  const id = oneField(form, 'id');
  if (action === 'revoke-user' || action === 'revoke-role') {
    if (!isDiscordSnowflake(id)) throw new TypeError('Enter a valid Discord user or role ID.');
    return { action, guildId, id };
  }
  throw new TypeError('Choose a supported access change.');
}

async function startDiscordOAuth(
  request: Request,
  env: Env,
  controls: AuthorizationControls,
  ownerEmail: string,
): Promise<Response> {
  const clientId = env.DISCORD_BOT_USER_ID?.trim();
  const clientSecret = env.DISCORD_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return page('Discord account linking is not configured yet.', 503);
  const state = randomHex(32);
  const stateHash = await hashState(state);
  await controls.beginDiscordOAuth(ownerEmail, stateHash, Date.now() + OAUTH_STATE_TTL_MS);

  const redirectUri = new URL(DISCORD_REDIRECT_URI, new URL(request.url).origin).toString();
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('scope', 'identify guilds');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('prompt', 'consent');
  return new Response(null, {
    status: 303,
    headers: {
      ...PAGE_HEADERS,
      location: authorize.toString(),
      'set-cookie': `${OAUTH_STATE_COOKIE}=${state}; Path=/admin; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

async function handleDiscordOAuthCallback(
  request: Request,
  url: URL,
  env: Env,
  controls: AuthorizationControls,
  ownerEmail: string,
  discordFetch: typeof fetch,
): Promise<Response> {
  const clearCookie = clearOAuthStateCookie();
  const stateValues = url.searchParams.getAll('state');
  const cookieState = readCookie(request.headers.get('cookie'), OAUTH_STATE_COOKIE);
  if (stateValues.length !== 1 || !/^[a-f0-9]{64}$/.test(stateValues[0] ?? '') ||
      !cookieState || cookieState !== stateValues[0]) {
    return oauthCallbackRedirect('invalid', clearCookie);
  }
  const stateHash = await hashState(stateValues[0]);
  const stateIsValid = await controls.consumeDiscordOAuthState(ownerEmail, stateHash, Date.now());
  if (!stateIsValid) {
    return oauthCallbackRedirect('expired', clearCookie);
  }

  const providerError = url.searchParams.getAll('error');
  if (providerError.length) {
    return oauthCallbackRedirect(providerError.length === 1 ? 'cancelled' : 'invalid', clearCookie);
  }
  const codeValues = url.searchParams.getAll('code');
  if (codeValues.length !== 1 || !codeValues[0] || codeValues[0].length > 2048) {
    return oauthCallbackRedirect('invalid', clearCookie);
  }

  let failureStage: OAuthCallbackFailureStage = 'configuration';
  let tokenStatus: number | undefined;
  let profileStatus: number | undefined;
  let guildsStatus: number | undefined;
  let profileFetchFailed = false;
  let guildsFetchFailed = false;
  let profilePayloadFailed = false;
  let guildsPayloadFailed = false;
  try {
    const clientId = env.DISCORD_BOT_USER_ID?.trim();
    const clientSecret = env.DISCORD_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('Discord OAuth is not configured.');
    const redirectUri = new URL(DISCORD_REDIRECT_URI, url.origin).toString();
    failureStage = 'token_exchange';
    const tokenResponse = await fetchWithoutRedirect(discordFetch, 'https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: codeValues[0],
        redirect_uri: redirectUri,
      }),
    });
    tokenStatus = tokenResponse.status;
    if (!tokenResponse.ok) throw new Error('Discord token exchange failed.');
    failureStage = 'token_response';
    const token = await tokenResponse.json() as unknown;
    if (!isRecord(token) || typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 8192 ||
        typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' ||
        typeof token.scope !== 'string' || !hasRequiredScopes(token.scope)) throw new Error('Discord token response was invalid.');

    const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/json' };
    failureStage = 'discord_account_lookup';
    const [profileResult, guildsResult] = await Promise.allSettled([
      fetchWithoutRedirect(discordFetch, 'https://discord.com/api/v10/users/@me', {
        method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(10_000), headers,
      }),
      fetchWithoutRedirect(discordFetch, 'https://discord.com/api/v10/users/@me/guilds', {
        method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(10_000), headers,
      }),
    ]);
    const profileResponse = profileResult.status === 'fulfilled' ? profileResult.value : undefined;
    const guildsResponse = guildsResult.status === 'fulfilled' ? guildsResult.value : undefined;
    profileFetchFailed = profileResult.status === 'rejected';
    guildsFetchFailed = guildsResult.status === 'rejected';
    if (profileResponse) profileStatus = profileResponse.status;
    if (guildsResponse) guildsStatus = guildsResponse.status;
    if (!profileResponse?.ok || !guildsResponse?.ok) throw new Error('Discord account lookup failed.');

    failureStage = 'discord_account_payload';
    const [profilePayload, guildsPayload] = await Promise.allSettled([
      profileResponse.json(),
      guildsResponse.json(),
    ]);
    profilePayloadFailed = profilePayload.status === 'rejected';
    guildsPayloadFailed = guildsPayload.status === 'rejected';
    if (profilePayload.status === 'rejected' || guildsPayload.status === 'rejected') {
      throw new Error('Discord account response was invalid.');
    }
    const profile = profilePayload.value as unknown;
    const guilds = guildsPayload.value as unknown;

    failureStage = 'discord_profile_validation';
    if (!isRecord(profile) || !isDiscordSnowflake(profile.id) || profile.bot === true || typeof profile.username !== 'string' ||
        !profile.username || profile.username.length > 128) throw new Error('Discord profile was invalid.');
    const displayName = typeof profile.global_name === 'string' && profile.global_name.trim()
      ? profile.global_name.trim().slice(0, 128)
      : profile.username;
    failureStage = 'discord_guild_list_validation';
    const link: LinkedDiscordAccount = {
      userId: profile.id,
      displayName,
      linkedAt: Date.now(),
      candidates: managedGuildCandidates(guilds),
      candidatesExpireAt: Date.now() + GUILD_CANDIDATE_TTL_MS,
    };
    failureStage = 'save_link';
    await controls.saveLinkedDiscordAccount(ownerEmail, link);
    return oauthCallbackRedirect('linked', clearCookie);
  } catch (error) {
    if (failureStage === 'token_exchange' && error instanceof RedirectResponseError) tokenStatus = error.status;
    console.error({
      event: 'discord_oauth_callback_failure',
      stage: failureStage,
      ...(tokenStatus === undefined ? {} : { token_status: tokenStatus }),
      ...(profileStatus === undefined ? {} : { profile_status: profileStatus }),
      ...(guildsStatus === undefined ? {} : { guilds_status: guildsStatus }),
      ...(profileFetchFailed ? { profile_fetch_failed: true } : {}),
      ...(guildsFetchFailed ? { guilds_fetch_failed: true } : {}),
      ...(profilePayloadFailed ? { profile_payload_failed: true } : {}),
      ...(guildsPayloadFailed ? { guilds_payload_failed: true } : {}),
    });
    return oauthCallbackRedirect('failed', clearCookie);
  }
}

function hasRequiredScopes(scope: string): boolean {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  return scopes.size === 2 && scopes.has('identify') && scopes.has('guilds');
}

function oauthStatusMessage(status: string): string | undefined {
  return ({
    linked: 'Discord account linked. Choose a server to grant your account access.',
    cancelled: 'Discord account linking was cancelled.',
    expired: 'Discord account linking expired. Start again to refresh the server list.',
    failed: 'Discord account linking failed. Start again to retry.',
    invalid: 'Discord account linking state was missing or invalid.',
  } as Record<string, string>)[status];
}

async function renderAdminPage(
  controls: AuthorizationControls,
  ownerEmail: string,
  env: Env,
  notice?: string,
  status = 200,
  roleSelection?: { guildId: string; roles: DiscordRoleOption[] },
  noticeKind: 'success' | 'info' | 'error' = 'info',
  policyBeforeRevision?: number,
): Promise<Response> {
  const [authorization, link, guildNames, roleNames] = await Promise.all([
    controls.getDiscordAuthorization(),
    controls.getLinkedDiscordAccount(ownerEmail),
    controls.getDiscordGuildNames(),
    controls.getDiscordRoleNames(ownerEmail),
  ]);
  const runtimeStatus = await controls.getAdminRuntimeStatus(ownerEmail, Date.now()).catch(() => ({
    state: 'unavailable' as const,
    activeSubscriptions: null,
  }));
  const [responsePolicy, policyHistory] = await Promise.all([
    controls.getResponsePolicy(ownerEmail),
    controls.listResponsePolicyRevisions(ownerEmail, policyBeforeRevision),
  ]);
  return page(renderControls(authorization, link, guildNames, roleNames, runtimeStatus, env, responsePolicy, policyHistory, notice, roleSelection, noticeKind, Boolean(policyBeforeRevision)), status, Boolean(canonicalIssuer(env.MCP_ISSUER_URL)));
}

function renderControls(
  authorization: DiscordAuthorization,
  link: LinkedDiscordAccount | null,
  guildNames: Record<string, string>,
  roleNames: Record<string, Record<string, string>>,
  runtimeStatus: AdminRuntimeStatus,
  env: Env,
  responsePolicy: PolicyState,
  policyHistory: PolicyHistory,
  notice?: string,
  roleSelection?: { guildId: string; roles: DiscordRoleOption[] },
  noticeKind: 'success' | 'info' | 'error' = 'info',
  showPolicyHistory = false,
): ReactNode {
  const servers = Object.entries(authorization.guilds).sort(([left], [right]) => left.localeCompare(right));
  const candidates = link?.candidatesExpireAt && link.candidatesExpireAt > Date.now() ? link.candidates : [];
  const hasCandidateAccess = link && candidates.length > 0;
  const selectedCandidateAvailable = roleSelection && candidates.some((candidate) => candidate.guildId === roleSelection.guildId);
  const inviteUrl = botInviteUrl(env.DISCORD_BOT_USER_ID);

  return (
    <>
      <a href="#main" className="skip-link">Skip to access controls</a>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="/admin" className="flex items-center gap-3 text-foreground no-underline">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">d.</span>
            <span className="font-semibold tracking-tight">Dot <span className="font-normal text-muted-foreground">/ Access</span></span>
          </a>
          <Badge variant="outline" className="gap-1.5"><ShieldCheck aria-hidden="true" />Owner controls</Badge>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-7 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Discord access</h1>
            <p className="mt-2 text-sm text-muted-foreground">Choose which servers, members and roles can use Dot.</p>
          </div>
          <RuntimeStatusView status={runtimeStatus} />
        </div>

        {notice ? <Notice message={notice} kind={noticeKind} /> : null}

        <section aria-labelledby="approved-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="approved-heading" className="text-lg font-semibold tracking-tight">Approved servers</h2>
              <p className="mt-1 text-sm text-muted-foreground">Members need a direct grant or an approved role.</p>
            </div>
            <Badge variant="outline">{servers.length} {servers.length === 1 ? 'server' : 'servers'}</Badge>
          </div>
          {servers.length ? servers.map(([guildId, grants]) => {
            const serverName = guildNames[guildId] ?? 'Approved server';
            return (
              <Card key={guildId} className="gap-5 shadow-none">
                <CardHeader>
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                    <div className="min-w-0">
                      <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
                        <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all">{serverName}</span>
                        <Badge variant="secondary">Approved</Badge>
                      </h3>
                      <CardDescription className="mt-2 break-all font-mono text-xs">Server ID · {guildId}</CardDescription>
                    </div>
                    <AdminForm action="revoke-server" guildId={guildId}>
                      <Button type="submit" variant="outline" size="sm" aria-label={`Remove ${serverName} and all its grants`}>
                        Remove server
                      </Button>
                    </AdminForm>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-6 lg:grid-cols-2">
                  <GrantList
                    title="Individual members"
                    empty="No individual members are approved."
                    count={grants.userIds.length}
                  >
                    {grants.userIds.map((id) => {
                      const name = link?.userId === id ? link.displayName : 'Discord user';
                      return <GrantRow key={id} label={name} id={id} kind="user" guildId={guildId} serverName={serverName} />;
                    })}
                  </GrantList>
                  <GrantList title="Roles" empty="No roles are approved." count={grants.roleIds.length}>
                    {grants.roleIds.map((id) => <GrantRow key={id} label={roleNames[guildId]?.[id] ?? 'Discord role'} id={id} kind="role" guildId={guildId} serverName={serverName} />)}
                  </GrantList>
                  <div className="border-t pt-4 lg:col-span-2">
                    <h3 className="text-sm font-medium">Add a member</h3>
                    <AdminForm action="grant-user" guildId={guildId} className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                      <div className="grid w-full max-w-sm gap-2">
                        <label htmlFor={`user-id-${guildId}`} className="text-sm font-medium">Discord user ID</label>
                        <input id={`user-id-${guildId}`} name="id" required inputMode="numeric" pattern="[0-9]{17,20}" autoComplete="off" placeholder="17–20 digit ID" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
                      </div>
                      <Button type="submit"><UserRound aria-hidden="true" />Grant user access</Button>
                    </AdminForm>
                    <p className="mt-2 text-xs text-muted-foreground">Must be a current human member of this server.</p>
                  </div>
                </CardContent>
              </Card>
            );
          }) : (
            <Card className="shadow-none">
              <CardContent className="flex items-start gap-4">
                <Server aria-hidden="true" className="mt-1 size-5 shrink-0 text-muted-foreground" />
                <div>
                  <h3 className="font-semibold">No servers approved</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">Servers and members start with no access. Use the setup below to approve your first server.</p>
                </div>
              </CardContent>
            </Card>
          )}
          <details className="disclosure text-sm">
            <summary className="w-fit text-muted-foreground">How access works</summary>
            <p className="mt-2 max-w-2xl leading-6 text-muted-foreground">Each grant applies to one approved server. Dot checks current roles on every operation. Removing access applies to subsequent operations. Role grants do not assign Discord roles.</p>
          </details>
        </section>
        <details id="add-access" className="disclosure rounded-xl border bg-card" open={servers.length === 0 || Boolean(roleSelection) || Boolean(notice)}>
          <summary className="px-5 py-4 font-semibold">Add a server or role</summary>
          <div className="grid gap-5 border-t px-5 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
              <p className="text-sm text-muted-foreground">Install Dot first. Installing or linking grants no access.</p>
              {inviteUrl ? <Button asChild variant="outline"><a href={inviteUrl} rel="noreferrer" target="_blank">Add Dot to a server <ArrowUpRight aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span></a></Button>
                : <p className="text-sm text-muted-foreground">Bot identity is not configured. Set DISCORD_BOT_USER_ID to enable invites.</p>}
            </div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Discord account</h2>
                <p className="mt-1 break-all text-sm text-muted-foreground">{link ? link.displayName : 'Link your account to choose a server you manage.'}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <AdminForm action="start-discord-link"><Button type="submit" variant={link ? 'outline' : 'default'}><Link2 aria-hidden="true" />{link ? 'Refresh server list' : 'Link Discord account'}</Button></AdminForm>
                {link ? <AdminForm action="unlink-discord-account"><Button type="submit" variant="ghost">Unlink account</Button></AdminForm> : null}
              </div>
            </div>
            {hasCandidateAccess ? (
              <>
                <div className="border-t pt-4">
                  <h3 className="font-medium">Approve a server</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Approves the server without granting anyone access.</p>
                </div>
                <AdminForm action="approve-linked-server" className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                  <SelectField id="approve-server" label="Server">
                    {candidates.map((candidate) => <option key={candidate.guildId} value={candidate.guildId}>{candidate.name}</option>)}
                  </SelectField>
                  <Button type="submit" variant="outline"><Server aria-hidden="true" />Approve server only</Button>
                </AdminForm>
                <div className="border-t pt-4">
                  <h3 className="font-medium">Grant yourself access</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Approves the selected server and your linked account together.</p>
                </div>
                <AdminForm action="grant-linked-account" className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                  <SelectField id="self-server" label="Server">
                    {candidates.map((candidate) => <option key={candidate.guildId} value={candidate.guildId}>{candidate.name}</option>)}
                  </SelectField>
                  <Button type="submit" variant="secondary"><UserRound aria-hidden="true" />Grant my account</Button>
                </AdminForm>
                <div className="border-t pt-4">
                  <h3 className="font-medium">Grant a role</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Approves the server and gives access to members who currently hold the selected role.</p>
                </div>
                <AdminForm action="load-role-options" className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                  <SelectField id="role-server" label="Server" defaultValue={roleSelection?.guildId}>
                    {candidates.map((candidate) => <option key={candidate.guildId} value={candidate.guildId}>{candidate.name}</option>)}
                  </SelectField>
                  <Button type="submit" variant="outline"><Users aria-hidden="true" />Load roles</Button>
                </AdminForm>
                {selectedCandidateAvailable && roleSelection ? (
                  roleSelection.roles.length ? (
                    <AdminForm action="grant-linked-role" guildId={roleSelection.guildId} className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                      <SelectField id="role-id" label="Role" name="roleId">
                        {roleSelection.roles.filter((role) => role.roleId !== roleSelection.guildId).map((role) =>
                          <option key={role.roleId} value={role.roleId}>{role.name}</option>)}
                      </SelectField>
                      <Button type="submit" variant="secondary"><ShieldCheck aria-hidden="true" />Approve server and grant role</Button>
                    </AdminForm>
                  ) : (
                    <p className="text-sm text-muted-foreground">No grantable roles were returned. The @everyone role is excluded because it would include every server member.</p>
                  )
                ) : null}
              </>
            ) : link ? (
              <Alert>
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{link.candidatesExpireAt > Date.now() ? 'No managed servers found' : 'Refresh the server list'}</AlertTitle>
                <AlertDescription>{link.candidatesExpireAt > Date.now()
                  ? 'Discord returned no servers that this account owns or can manage.'
                  : 'Refresh to add a server or role. Existing access still works.'}</AlertDescription>
              </Alert>
            ) : null}

          </div>
        </details>

        <section aria-labelledby="response-policy-heading">
          <Card className="shadow-none">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="response-policy-heading" className="text-lg font-semibold tracking-tight">Response policy</h2>
                <Badge variant="outline">{responsePolicy.configured ? `Revision ${responsePolicy.revision}` : 'Not configured'}</Badge>
              </div>
              <CardDescription>Guidance for Dot’s replies. Changes are saved as new revisions.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">Policy cannot grant access or permit disclosure of private information.</p>
              {!responsePolicy.configured ? <Alert><AlertTitle>Policy is not configured</AlertTitle><AlertDescription>No response policy has been supplied. Save the initial policy before the listener relies on it. Server authorization and privacy safeguards still apply.</AlertDescription></Alert> : null}
              <details className="disclosure">
                <summary className="text-sm font-medium">Read current policy</summary>
                <p className="mt-3 text-xs text-muted-foreground">Version <code className="break-all">{responsePolicy.version ?? 'None'}</code></p>
                <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg border bg-muted p-4 font-sans text-sm leading-6">{responsePolicy.markdown}</pre>
              </details>
              <details className="disclosure">
                <summary className="text-sm font-medium">Edit policy</summary>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{POLICY_BOUNDARY}</p>
                <AdminForm action="update-policy" className="mt-4 flex flex-col gap-3">
                  <input type="hidden" name="expectedRevision" value={responsePolicy.revision} />
                  <label htmlFor="policy-markdown" className="text-sm font-medium">Policy Markdown (maximum 16 KiB)</label>
                  <textarea id="policy-markdown" name="markdown" rows={18} required maxLength={MAX_POLICY_BYTES} defaultValue={responsePolicy.markdown} className="w-full rounded-lg border bg-background p-4 font-mono text-sm" />
                  <p className="text-xs text-muted-foreground">Save creates a new revision. If someone has edited it meanwhile, reload and compare before saving again.</p>
                  <Button type="submit" className="w-fit">Save new revision</Button>
                </AdminForm>
              </details>
              <details className="disclosure" id="policy-history" open={showPolicyHistory}>
                <summary className="text-sm font-medium">Revision history</summary>
                {!policyHistory.revisions.length ? <p className="text-sm text-muted-foreground">No saved revisions yet.</p> : null}
                {policyHistory.revisions.map((entry) => <div key={entry.revision} className="mt-4 border-t pt-3">
                  <h3 className="text-sm font-medium">Revision {entry.revision} · {entry.updatedAt} · {entry.via}{entry.restoredFrom ? ` · restored from ${entry.restoredFrom}` : ''}</h3>
                  <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg border bg-muted p-4 font-sans text-sm leading-6">{entry.markdown}</pre>
                  {entry.revision !== responsePolicy.revision ? <AdminForm action="rollback-policy" className="mt-3">
                    <input type="hidden" name="expectedRevision" value={responsePolicy.revision} />
                    <input type="hidden" name="revision" value={entry.revision} />
                    <Button type="submit" variant="outline">Restore revision {entry.revision} as a new revision</Button>
                  </AdminForm> : null}
                </div>)}
                {policyHistory.nextBeforeRevision ? <a className="text-sm underline" href={`/admin?policy_before=${policyHistory.nextBeforeRevision}#policy-history`}>Older revisions</a> : null}
              </details>
            </CardContent>
          </Card>
        </section>
        <section aria-label="Connection setup" className="border-t pt-4">
          <CodexSetup issuerUrl={env.MCP_ISSUER_URL} />
        </section>
      </main>
    </>
  );
}

function PageDocument({ children }: { children: ReactNode }) {
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="light" /><title>Dot · Discord access</title><style>{adminCss}</style></head><body>{children}</body></html>;
}

function Notice({ message, kind }: { message: string; kind: 'success' | 'info' | 'error' }) {
  const Icon = kind === 'success' ? CircleCheck : CircleAlert;
  return <Alert variant={kind === 'error' ? 'destructive' : 'default'} className={kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : ''}>
    <Icon aria-hidden="true" />
    <AlertTitle>{kind === 'success' ? 'Done' : kind === 'error' ? 'Could not save that change' : 'Account linking'}</AlertTitle>
    <AlertDescription>{message}</AlertDescription>
  </Alert>;
}

function RuntimeStatusView({ status }: { status: AdminRuntimeStatus }) {
  const description = status.state === 'connected'
    ? 'The Gateway socket is open and Discord has sent READY or RESUMED.'
    : status.state === 'connecting'
      ? 'A valid subscription is active. The Gateway has not confirmed READY or RESUMED yet.'
      : status.state === 'idle'
        ? 'There is no active authorized event subscription, so the Gateway stays idle.'
        : 'The Worker could not verify subscription or Gateway state right now.';
  const title = status.state === 'connected' ? 'Ready'
    : status.state === 'connecting' ? 'Starting or reconnecting'
      : status.state === 'idle' ? 'Idle' : 'Status unavailable';
  return <div aria-label="Gateway connection" className="max-w-sm text-sm">
    <p className="mb-2 text-xs font-medium text-muted-foreground">Gateway connection</p>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary" className={status.state === 'connected' ? 'gap-1.5 bg-emerald-100 text-emerald-800' : 'gap-1.5'}><Activity aria-hidden="true" />{title}</Badge>
      {status.activeSubscriptions !== null ? <span className="text-sm text-muted-foreground">{status.activeSubscriptions} active {status.activeSubscriptions === 1 ? 'subscription' : 'subscriptions'}</span> : null}
    </div>
    {status.state !== 'connected' ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{description}</p> : null}
  </div>;
}

function CodexSetup({ issuerUrl }: { issuerUrl: string | undefined }) {
  const issuer = canonicalIssuer(issuerUrl);
  const mcpUrl = issuer ? `${issuer}/mcp` : null;
  return <details className="disclosure">
    <summary className="w-fit text-sm font-medium">Set up in Codex</summary>
    <div className="mt-4 flex min-w-0 flex-col gap-4 text-sm leading-6">
      {mcpUrl ? <>
        <div className="grid gap-2">
          <label htmlFor="codex-mcp-url" className="font-medium">MCP server URL</label>
          <div className="relative">
            <input id="codex-mcp-url" type="text" readOnly value={mcpUrl} aria-describedby="codex-mcp-copy" className="h-10 w-full min-w-0 rounded-md border border-input bg-background py-2 pl-3 pr-12 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
            <Button id="codex-mcp-copy-button" type="button" variant="ghost" size="icon-sm" aria-label="Copy MCP server URL" title="Copy MCP server URL" className="absolute right-1 top-1 text-muted-foreground"><Copy aria-hidden="true" /></Button>
          </div>
          <p id="codex-mcp-copy" role="status" aria-live="polite" aria-atomic="true" className="text-xs text-muted-foreground">Select and copy this URL. It contains no credentials.</p>
        </div>
        <ol className="list-decimal space-y-3 pl-5 text-muted-foreground">
          <li>With Codex CLI installed, run these commands in a terminal on your Codex host:
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border bg-muted p-3 text-xs text-foreground"><code>{`codex mcp add discord-dot --url ${mcpUrl}\ncodex mcp login discord-dot`}</code></pre>
          </li>
          <li>In the browser OAuth flow, sign in through Cloudflare Access as the configured owner. Review and approve <code>discord:read</code> and <code>discord:reply</code> for mention replies.</li>
          <li>Start a new Codex session. In the CLI, use <code>/mcp</code> to check the connection. Local Codex clients on the same host share MCP configuration.</li>
        </ol>
        <p className="text-xs text-muted-foreground">Connecting does not create an event subscription. A compatible MCP Events client must subscribe before the Gateway starts.</p>
      </> : <p className="text-muted-foreground">The MCP server URL is unavailable. Configure a valid MCP_ISSUER_URL before connecting Codex.</p>}
      <a href="https://developers.openai.com/codex/mcp/" target="_blank" rel="noreferrer" className="w-fit text-primary underline underline-offset-4">Codex MCP setup guide <span className="sr-only">(opens in a new tab)</span></a>
    </div>
  </details>;
}

function SelectField({ id, label, name = 'guildId', defaultValue, children }: { id: string; label: string; name?: string; defaultValue?: string; children: ReactNode }) {
  return <div className="grid w-full max-w-sm gap-2">
    <label htmlFor={id} className="text-sm font-medium">{label}</label>
    <select id={id} name={name} required defaultValue={defaultValue} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {children}
    </select>
  </div>;
}

function AdminForm({ action, guildId, className, children }: { action: string; guildId?: string; className?: string; children: ReactNode }) {
  return <form method="post" action="/admin" className={className}>
    <input type="hidden" name="action" value={action} />
    {guildId ? <input type="hidden" name="guildId" value={guildId} /> : null}
    {children}
  </form>;
}

function GrantList({ title, empty, count, children }: { title: string; empty: string; count: number; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="font-medium">{title}</h3>
      <Badge variant="outline">{count}</Badge>
    </div>
    {count ? <ul className="grid gap-2">{children}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}
  </section>;
}

function GrantRow({ label, id, kind, guildId, serverName }: { label: string; id: string; kind: 'user' | 'role'; guildId: string; serverName: string }) {
  const action = kind === 'user' ? 'revoke-user' : 'revoke-role';
  return <li className="flex min-w-0 items-center justify-between gap-3 border-b py-3 last:border-0">
    <span className="flex min-w-0 flex-col">
      <span className="break-words text-sm font-medium">{label}</span>
      <code className="break-all text-xs text-muted-foreground">{id}</code>
    </span>
    <AdminForm action={action} guildId={guildId} className="shrink-0">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" size="sm" aria-label={`Revoke ${kind} access for ${label} from ${serverName}`}>Revoke</Button>
    </AdminForm>
  </li>;
}

function botInviteUrl(botUserId: string | undefined): string | null {
  const clientId = botUserId?.trim();
  if (!clientId || !isDiscordSnowflake(clientId)) return null;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'bot');
  url.searchParams.set('permissions', BOT_PERMISSIONS);
  return url.toString();
}

function parsePolicyRevision(value: string, minimum = 1): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new TypeError('Enter a valid policy revision.');
  const revision = Number(value);
  validateRevision(revision, minimum);
  return revision;
}

function onePolicyText(form: URLSearchParams): string {
  const values = form.getAll('markdown');
  if (values.length !== 1) throw new TypeError('Enter one policy Markdown value.');
  return values[0]!;
}

function oneField(formData: URLSearchParams, name: string): string {
  const values = formData.getAll(name);
  if (values.length !== 1 || !values[0]?.trim()) throw new TypeError(`Enter one ${name} value.`);
  return values[0].trim();
}

async function readSmallBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  return matches[0]!.slice(name.length + 1);
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashState(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function redirectToAdmin(): Response {
  return new Response(null, { status: 303, headers: { 'cache-control': 'no-store', location: '/admin' } });
}

function oauthCallbackRedirect(status: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: { 'cache-control': 'no-store', location: `/admin?discord_link=${status}`, 'set-cookie': cookie },
  });
}

function clearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/admin; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

async function page(content: ReactNode, status = 200, copyScript = false): Promise<Response> {
  const body = typeof content === 'string' ? (
    <main className="mx-auto max-w-2xl px-5 py-16 sm:px-8">
      <Card><CardHeader><h1 className="text-xl font-semibold">Discord access</h1></CardHeader><CardContent><Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>Request could not be completed</AlertTitle><AlertDescription>{content}</AlertDescription></Alert></CardContent></Card>
    </main>
  ) : content;
  const headers = { ...PAGE_HEADERS };
  if (copyScript) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(adminCopyScript)));
    headers['content-security-policy'] += `; script-src 'sha256-${btoa(String.fromCharCode(...digest))}'`;
  }
  return new Response(`<!doctype html>${renderToStaticMarkup(<PageDocument>{body}{copyScript ? <script dangerouslySetInnerHTML={{ __html: adminCopyScript }} /> : null}</PageDocument>)}`, { status, headers });
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
