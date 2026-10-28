import {
  AuthorizationError,
  OAuthProvider,
} from '@cloudflare/workers-oauth-provider';
import { POLICY_MANAGE_SCOPE } from './response-policy.js';
import { accessAuthorized } from './access.js';
import { canonicalIssuer } from './issuer.js';
import {
  handleAuthenticatedMcp,
  READ_SCOPE,
  REPLY_SCOPE,
  CHANNEL_READ_SCOPE,
  MESSAGE_SEND_SCOPE,
  MESSAGE_EDIT_SCOPE,
} from './mcp.js';
import type { Env } from './types.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { CircleAlert, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardFooter, CardHeader } from './components/ui/card.js';
import adminCss from './admin.css.txt';

const SUPPORTED_SCOPES = [READ_SCOPE, REPLY_SCOPE, CHANNEL_READ_SCOPE, MESSAGE_SEND_SCOPE, MESSAGE_EDIT_SCOPE, POLICY_MANAGE_SCOPE];
const SUPPORTED_SCOPE_SET = new Set(SUPPORTED_SCOPES);
const OPTIONAL_CHANNEL_SCOPES = [CHANNEL_READ_SCOPE, MESSAGE_SEND_SCOPE, MESSAGE_EDIT_SCOPE];
const HTML_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'content-type': 'text/html; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

type ConsentVerifier = (request: Request, env: Env) => Promise<boolean>;

export function createOAuthProvider(env: Env, verifyAccess: ConsentVerifier = accessAuthorized) {
  const issuer = canonicalIssuer(env.MCP_ISSUER_URL);
  if (!issuer) throw new Error('MCP_ISSUER_URL must be a canonical HTTPS origin (or localhost for development)');
  const resource = `${issuer}/mcp`;

  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: {
      fetch: (request, apiEnv, context) => handleAuthenticatedMcp(request, apiEnv, context),
    },
    defaultHandler: {
      fetch: (request, defaultEnv) => new URL(request.url).pathname === '/authorize'
        ? handleAuthorization(request, defaultEnv, verifyAccess)
        : new Response('Not found', { status: 404 }),
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: SUPPORTED_SCOPES,
    requiredScopes: [READ_SCOPE, REPLY_SCOPE],
    resourceMetadata: {
      resource,
      authorization_servers: [issuer],
      resource_name: 'Discord dot bridge',
    },
    clientIdMetadataDocumentEnabled: true,
  });
}

export async function handleAuthorization(
  request: Request,
  env: Env,
  verifyAccess: ConsentVerifier = accessAuthorized,
): Promise<Response> {
  const owner = normalizeEmail(env.ACCESS_OWNER_EMAIL);
  if (!owner) return plain('Owner identity is not configured', 503);

  const oauth = env.OAUTH_PROVIDER;
  const kv = env.OAUTH_KV;
  if (!oauth || !kv) return plain('OAuth storage is not configured', 503);
  if (!(await verifyAccess(request, env))) {
    return plain('Owner authentication required', 401, { 'www-authenticate': 'Bearer' });
  }

  if (request.method === 'GET') {
    try {
      const oauthRequest = await oauth.parseAuthRequest(request);
      const description = await oauth.describeConsent(oauthRequest);
      const requestedScopes = description.scope.filter((scope) => SUPPORTED_SCOPE_SET.has(scope));
      if (!requestedScopes.includes(READ_SCOPE)) return plain('The discord:read scope is required', 400);
      // Clients request the minimal resource scopes; the owner can opt into these on reconnect.
      const consentScopes = SUPPORTED_SCOPES.filter((scope) =>
        requestedScopes.includes(scope) || OPTIONAL_CHANNEL_SCOPES.includes(scope));
      const consent = await oauth.beginConsent(oauthRequest);
      const scopeKey = await consentScopeKey(consent.handle);
      await kv.put(scopeKey, JSON.stringify(consentScopes), { expirationTtl: 600 });
      const scopeDescriptions: Record<string, { title: string; description: string }> = {
        [READ_SCOPE]: { title: 'Read mentions', description: 'Read accepted mentions and the current response policy.' },
        [REPLY_SCOPE]: { title: 'Reply to mentions', description: 'Reply once to an accepted mention.' },
        [CHANNEL_READ_SCOPE]: { title: 'Read channel history', description: 'Read message pages from approved channels, limited to the bot and members with current grants.' },
        [MESSAGE_SEND_SCOPE]: { title: 'Send messages', description: 'Send standalone bot messages in approved channels with safe mentions.' },
        [MESSAGE_EDIT_SCOPE]: { title: 'Edit own messages', description: 'Edit only messages authored by this bot in approved channels.' },
        [POLICY_MANAGE_SCOPE]: { title: 'Manage response policy', description: 'Edit and roll back the live response policy.' },
      };
      const page = `<!doctype html>${renderToStaticMarkup(
        <html lang="en">
          <head>
            <meta charSet="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="color-scheme" content="light" />
            <title>Connect to Discord dot bridge</title>
            <style>{adminCss}</style>
          </head>
          <body>
            <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
              <div className="mb-6 flex items-center gap-3">
                <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">d.</span>
                <span className="font-semibold tracking-tight">Dot <span className="font-normal text-muted-foreground">/ Discord bridge</span></span>
              </div>
              <Card className="gap-0 overflow-hidden py-0">
                <CardHeader className="gap-5 border-b p-6 sm:p-8">
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Connect to Discord</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">Review the connection and choose what this client can do.</p>
                  </div>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Client</dt>
                    <dd className="text-right font-medium wrap-anywhere">{description.clientName}</dd>
                    {description.clientDomain ? <>
                      <dt className="text-muted-foreground">Verified client domain</dt>
                      <dd className="flex min-w-0 items-center justify-end gap-1.5 font-medium">
                        <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0 text-right wrap-anywhere">{description.clientDomain}</span>
                      </dd>
                    </> : null}
                    <dt className="text-muted-foreground">Redirect host</dt>
                    <dd className="text-right wrap-anywhere"><code className="text-xs">{description.redirectHost}</code></dd>
                  </dl>
                  {description.redirectIsLoopback ? <Alert className="border-amber-200 bg-amber-50 text-amber-950">
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle>Local callback address</AlertTitle>
                    <AlertDescription className="text-amber-950">The callback uses a local address. Any local process could receive the authorization code.</AlertDescription>
                  </Alert> : null}
                </CardHeader>
                <form method="post">
                  <input type="hidden" name="handle" value={consent.handle} />
                  <CardContent className="space-y-5 p-6 sm:p-8">
                    <fieldset aria-describedby="permissions-help">
                      <legend className="text-base font-semibold">Permissions</legend>
                      <p id="permissions-help" className="mt-1 text-sm leading-6 text-muted-foreground">Select only the access you want to grant. Extra channel permissions are off by default.</p>
                      <div className="mt-4 grid gap-2">
                        {consentScopes.map((scope) => <label key={scope} className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 hover:bg-muted/50 has-checked:border-primary/30 has-checked:bg-accent/30 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring">
                          <input type="checkbox" name="scope" value={scope} defaultChecked={scope === READ_SCOPE || scope === REPLY_SCOPE} required={scope === READ_SCOPE}
                            aria-labelledby={`${scope}-title`} aria-describedby={`${scope}-description ${scope}-code`} className="mt-0.5 size-4 shrink-0 accent-primary" />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                              <span id={`${scope}-title`} className="text-sm font-medium">{scopeDescriptions[scope]?.title}</span>
                              {scope === READ_SCOPE ? <Badge variant="secondary">Required</Badge> : <span className="text-xs text-muted-foreground">Optional</span>}
                            </span>
                            <span id={`${scope}-description`} className="mt-1 block text-sm leading-5 text-muted-foreground">{scopeDescriptions[scope]?.description}</span>
                            <code id={`${scope}-code`} className="mt-1.5 block text-xs text-muted-foreground wrap-anywhere">{scope}</code>
                          </span>
                        </label>)}
                      </div>
                    </fieldset>
                    {requestedScopes.includes(POLICY_MANAGE_SCOPE) ? <Alert className="border-amber-200 bg-amber-50 text-amber-950">
                      <CircleAlert aria-hidden="true" />
                      <AlertTitle>Policy management</AlertTitle>
                      <AlertDescription className="text-amber-950">Checking discord:policy:manage allows this client to edit and roll back the live policy. Use only for the configured owner’s private dot chat instructions, never Discord requests. This permission cannot prove the originating conversation.</AlertDescription>
                    </Alert> : null}
                    <details className="disclosure text-sm">
                      <summary className="w-fit font-medium">How access works</summary>
                      <div className="mt-3 space-y-3 leading-6 text-muted-foreground">
                        <p><strong>Channel history:</strong> channel reads are limited to approved servers, current owner access, and messages by the bot or currently granted human members. Discord’s privileged Message Content intent must also be enabled in the Developer Portal for message bodies.</p>
                        <p><strong>Standalone sending:</strong> the bot can send a separate message in approved channels. Retries use a stable message nonce; everyone and role mentions are disabled, and user mentions require explicit recipient IDs.</p>
                        <p><strong>Own-message editing:</strong> the bot can edit only messages authored by this bot in approved channels.</p>
                        <p>The channel permissions above are available even when a client requests only the basic scopes; they remain off until selected. These choices do not widen already-issued tokens; selected scopes apply only to this authorization.</p>
                      </div>
                    </details>
                    <p className="text-xs leading-5 text-muted-foreground">These tools run only when explicitly called and do not enable automatic responses to channel traffic.</p>
                  </CardContent>
                  <CardFooter className="flex-col gap-3 border-t bg-muted/30 p-6 sm:flex-row sm:justify-end sm:px-8">
                    <Button type="submit" name="decision" value="deny" formNoValidate variant="outline" className="h-11 w-full sm:w-auto">Cancel</Button>
                    <Button type="submit" name="decision" value="approve" className="h-11 w-full sm:w-auto">Allow access</Button>
                  </CardFooter>
                </form>
              </Card>
            </main>
          </body>
        </html>,
      )}`;
      const headers = new Headers(consent.headers);
      for (const [name, value] of Object.entries(HTML_HEADERS)) headers.set(name, value);
      const styleDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(adminCss)));
      headers.set('content-security-policy', `${HTML_HEADERS['content-security-policy']}; style-src 'sha256-${btoa(String.fromCharCode(...styleDigest))}'`);
      return new Response(page, { headers });
    } catch (error) {
      return authorizationErrorResponse(error);
    }
  }

  if (request.method !== 'POST') return plain('Method not allowed', 405, { allow: 'GET, POST' });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return plain('Invalid consent form', 400);
  }
  const handle = form.get('handle');
  if (typeof handle !== 'string' || !handle) return plain('Invalid consent request', 400);
  const decision = form.get('decision');

  try {
    if (decision === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      await kv.delete(await consentScopeKey(handle));
      const headers = new Headers(denied.headers);
      headers.set('cache-control', 'no-store');
      headers.set('location', denied.redirectTo);
      return new Response(null, { status: 302, headers });
    }
    if (decision !== 'approve') return plain('Invalid consent decision', 400);

    const submittedScopes = new Set(form.getAll('scope')
      .filter((scope): scope is string => typeof scope === 'string' && SUPPORTED_SCOPE_SET.has(scope)));
    if (!submittedScopes.has(READ_SCOPE)) return plain('The discord:read scope is required', 400);
    const approved = await oauth.approveConsent(request, handle, { scope: [...submittedScopes] });
    const scopeKey = await consentScopeKey(handle);
    const storedScopes = await kv.get(scopeKey);
    await kv.delete(scopeKey);
    if (!storedScopes) return plain('Consent request expired; connect again', 400);

    let offeredScopes: unknown;
    try {
      offeredScopes = JSON.parse(storedScopes);
    } catch {
      return plain('Consent request is invalid; connect again', 400);
    }
    if (!Array.isArray(offeredScopes) || offeredScopes.some((scope) => typeof scope !== 'string' || !SUPPORTED_SCOPE_SET.has(scope))) {
      return plain('Consent request is invalid; connect again', 400);
    }
    const offeredScopeSet = new Set(offeredScopes as string[]);
    const approvedScopes = SUPPORTED_SCOPES.filter((scope) =>
      offeredScopeSet.has(scope) && submittedScopes.has(scope) && approved.request.scope.includes(scope));
    if (!approvedScopes.includes(READ_SCOPE)) return plain('The discord:read scope is required', 400);

    const completed = await oauth.completeAuthorization({
      request: approved.request,
      userId: owner,
      metadata: {},
      scope: approvedScopes,
      props: { email: owner },
    });
    const headers = new Headers(approved.headers);
    headers.set('cache-control', 'no-store');
    headers.set('location', completed.redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

async function consentScopeKey(handle: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handle));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `consent-scopes:${hex}`;
}

function authorizationErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) {
      return new Response(null, {
        status: 302,
        headers: { location: error.redirectTo, 'cache-control': 'no-store' },
      });
    }
    return plain(error.description, 400);
  }
  return plain('Authorization could not be completed', 500);
}

function plain(message: string, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function normalizeEmail(value: string | undefined): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}
