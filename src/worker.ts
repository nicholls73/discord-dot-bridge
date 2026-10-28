import { canonicalIssuer } from './issuer.js';
import { handleAdminRequest } from './admin.js';
import { createOAuthProvider } from './oauth.js';
import type { Env } from './types.js';
import { logSubscriptionDiagnostic } from './subscription-diagnostics.js';

export async function fetchWorker(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/admin') {
    const controls = env.BRIDGE_STATE?.get(env.BRIDGE_STATE.idFromName('bridge-state'));
    return handleAdminRequest(request, env, controls);
  }
  const oauthPath = path === '/mcp' || path.startsWith('/oauth/') || path.startsWith('/.well-known/') || path === '/authorize';
  if (!oauthPath) return new Response('Not found', { status: 404 });

  const mcpRequest = path === '/mcp' && request.method === 'POST';
  if (mcpRequest) logSubscriptionDiagnostic('request', 'started');
  if (!env.OAUTH_KV || !canonicalIssuer(env.MCP_ISSUER_URL)) {
    if (mcpRequest) logSubscriptionDiagnostic('request', 'configuration_missing', { httpStatus: 503 });
    return unavailable(!env.OAUTH_KV ? 'OAuth storage binding OAUTH_KV is missing' : 'MCP_ISSUER_URL is missing or invalid');
  }

  let provider;
  try {
    provider = createOAuthProvider(env);
  } catch {
    if (mcpRequest) logSubscriptionDiagnostic('request', 'configuration_missing', { httpStatus: 503 });
    return unavailable('MCP OAuth is not configured');
  }
  try {
    const response = await provider.fetch(request, env, context);
    if (mcpRequest) {
      logSubscriptionDiagnostic('request', response.ok ? 'response_received' : 'rejected', { httpStatus: response.status });
    }
    return response;
  } catch (error) {
    if (mcpRequest) logSubscriptionDiagnostic('request', 'failed');
    throw error;
  }
}

function unavailable(message: string): Response {
  return new Response(message, {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}
