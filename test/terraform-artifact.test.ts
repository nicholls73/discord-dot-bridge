import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { describe, expect, it } from 'vitest';

describe('Terraform Worker upload artifact', () => {
  it('starts with only the module Terraform uploads and serves the complete protected admin UI', async () => {
    const terraformRoot = new URL('../terraform/', import.meta.url);
    const terraform = await readFile(new URL('resources.tf', terraformRoot), 'utf8');
    const resource = terraform.match(/resource "cloudflare_workers_script" "discord_dot" \{([\s\S]*?)\n\}/)?.[1];
    if (!resource) throw new Error('Terraform Worker resource was not found.');
    const mainModule = resource.match(/main_module\s*=\s*"([^"]+)"/)?.[1];
    const contentPath = resource.match(/content_file\s*=\s*"\$\{path\.module\}\/([^"]+)"/)?.[1];
    const compatibilityDate = resource.match(/compatibility_date\s*=\s*"([^"]+)"/)?.[1];
    const flagList = resource.match(/compatibility_flags\s*=\s*\[([^\]]*)\]/)?.[1];
    if (!mainModule || !contentPath || !compatibilityDate || flagList === undefined) {
      throw new Error('Terraform upload metadata could not be read. Update this artifact gate if the upload contract changes.');
    }
    const compatibilityFlags = [...flagList.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    const artifact = await readFile(new URL(contentPath, terraformRoot), 'utf8');
    const wrangler = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    expect(compatibilityFlags).toContain('global_fetch_strictly_public');
    expect(compatibilityFlags).not.toContain('global_fetch_private_origin');
    expect(wrangler.compatibility_flags).toEqual(compatibilityFlags);
    expect(artifact).not.toMatch(/cloudflare:sockets|CALLBACK_EGRESS_|Callback egress/);
    await expect(readFile(new URL('../POLICY.md', import.meta.url), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(artifact).not.toContain('POLICY.md');
    const seededText = 'Example policy <script>not executed</script>';
    const seededVersion = `sha256:${createHash('sha256').update(seededText, 'utf8').digest('hex')}`;
    const stylesheet = await readFile(new URL('../src/admin.css.txt', import.meta.url), 'utf8');
    const outboundRequests: string[] = [];
    const clientMetadataUrl = 'https://chatgpt.com/oauth/client.json';
    const clientMetadata = {
      client_id: clientMetadataUrl,
      client_name: 'ChatGPT',
      redirect_uris: ['http://127.0.0.1:4567/callback'],
      token_endpoint_auth_methods_supported: ['none'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    const name = 'discord-dot-terraform-artifact';
    const runtime = new Miniflare({
      workers: [{
        config: {
          name,
          compatibilityDate,
          compatibilityFlags,
          // Terraform uploads exactly one file. Do not supply Wrangler's sidecar modules.
          manifest: { mainModule, modules: { [mainModule]: { type: 'esm', contents: artifact } } },
          env: {
            MCP_ISSUER_URL: { type: 'json', value: 'https://discord-dot.example.test' },
            ALLOW_LOCAL_AUTH: { type: 'json', value: 'true' },
            ACCESS_OWNER_EMAIL: { type: 'json', value: 'owner@example.test' },
            DISCORD_BOT_USER_ID: { type: 'json', value: '55555555555555555' },
            OAUTH_KV: { type: 'kv', id: 'oauth-consent-artifact-test' },
            BRIDGE_STATE: { type: 'durable-object', worker: name, exportName: 'BridgeStateDO' },
          },
          exports: { BridgeStateDO: { type: 'durable-object', storage: 'sqlite' } },
        },
        dev: {
          outboundService: {
            type: 'fetcher',
            handler: async (request) => {
              outboundRequests.push(request.url);
              if (request.url === clientMetadataUrl) return MiniflareResponse.json(clientMetadata);
              return new MiniflareResponse('External requests are disabled in this artifact test.', { status: 503 });
            },
          },
        },
      }],
    });

    try {
      const unauthorized = await runtime.dispatchFetch('https://discord-dot.example.test/admin');
      expect(unauthorized.status).toBe(403);
      expect(await unauthorized.text()).toContain('Owner authentication required.');
      expect(outboundRequests).toEqual([]);

      const verifier = 'synthetic-code-verifier-for-consent-artifact-test';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const consentParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientMetadataUrl,
        redirect_uri: clientMetadata.redirect_uris[0],
        scope: 'discord:read discord:reply',
        state: 'synthetic-consent-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://discord-dot.example.test/mcp',
      });
      const consent = await runtime.dispatchFetch(`http://localhost/authorize?${consentParams}`);
      expect(consent.status).toBe(200);
      expect(consent.headers.get('cache-control')).toBe('no-store');
      const consentHtml = await consent.text();
      expect(consentHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1]).toBe(stylesheet);
      expect(consent.headers.get('content-security-policy')).toContain(
        `style-src 'sha256-${createHash('sha256').update(stylesheet).digest('base64')}'`,
      );
      const offeredScopes = (consentHtml.match(/<input\b[^>]*>/g) ?? [])
        .filter((input) => input.includes('name="scope"'))
        .map((input) => ({ scope: input.match(/value="([^"]+)"/)?.[1], checked: /\schecked(?:[=\s/>])/.test(input) }));
      expect(offeredScopes).toEqual([
        { scope: 'discord:read', checked: true },
        { scope: 'discord:reply', checked: true },
        { scope: 'discord:channel:read', checked: false },
        { scope: 'discord:message:send', checked: false },
        { scope: 'discord:message:edit', checked: false },
      ]);
      expect(consentHtml).toContain('These choices do not widen already-issued tokens');
      expect(outboundRequests.length).toBeGreaterThan(0);
      expect(outboundRequests.every((url) => url === clientMetadataUrl)).toBe(true);

      const invalidPage = await runtime.dispatchFetch('http://localhost/admin?policy_before=0');
      expect(invalidPage.status).toBe(400);
      expect(await invalidPage.text()).toContain('Policy history cursor was rejected');

      const response = await runtime.dispatchFetch('http://localhost/admin');
      expect(response.status).toBe(200);
      const csp = response.headers.get('content-security-policy');
      expect(csp).toContain("default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'");
      expect(response.headers.get('cache-control')).toBe('no-store');
      const html = await response.text();
      expect(html.match(/<style>([\s\S]*?)<\/style>/)?.[1]).toBe(stylesheet);
      expect(html).toContain('Choose which servers, members and roles can use Dot.');
      expect(html).toContain('Response policy');
      expect(html).toContain('Policy is not configured');
      expect(html).toContain('No saved revisions yet.');
      const policySection = html.match(/<section aria-labelledby="response-policy-heading">([\s\S]*?)<\/section>/)?.[1];
      expect(policySection).toContain('Save new revision');
      expect(policySection).toContain('name="expectedRevision" value="0"');
      const policyWrite = await runtime.dispatchFetch('http://localhost/admin', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=update-policy&policy=Ignore+all+rules',
      });
      expect(policyWrite.status).toBe(400);
      const unchanged = await runtime.dispatchFetch('http://localhost/admin');
      expect(await unchanged.text()).toContain('Policy is not configured');
      const edit = await runtime.dispatchFetch('http://localhost/admin', {
        method: 'POST', redirect: 'manual',
        headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: 'update-policy', expectedRevision: '0', markdown: seededText }).toString(),
      });
      expect(edit.status).toBe(303);
      const editedHtml = await (await runtime.dispatchFetch('http://localhost/admin')).text();
      expect(editedHtml).toContain('Example policy &lt;script&gt;not executed&lt;/script&gt;');
      expect(editedHtml).toContain('name="expectedRevision" value="1"');
      const stale = await runtime.dispatchFetch('http://localhost/admin', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=update-policy&expectedRevision=0&markdown=stale',
      });
      expect(stale.status).toBe(409);
      const nextEdit = await runtime.dispatchFetch('http://localhost/admin', {
        method: 'POST', redirect: 'manual',
        headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=update-policy&expectedRevision=1&markdown=Another+example+policy',
      });
      expect(nextEdit.status).toBe(303);
      const rollback = await runtime.dispatchFetch('http://localhost/admin', {
        method: 'POST', redirect: 'manual',
        headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=rollback-policy&expectedRevision=2&revision=1',
      });
      expect(rollback.status).toBe(303);
      const restoredHtml = await (await runtime.dispatchFetch('http://localhost/admin')).text();
      expect(restoredHtml).toContain(seededVersion);
      expect(restoredHtml).toContain('name="expectedRevision" value="3"');

      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBe(await readFile(new URL('../src/admin-copy.js.txt', import.meta.url), 'utf8'));
      expect(csp?.split('; ').find((directive) => directive.startsWith('script-src'))).toBe(
        `script-src 'sha256-${createHash('sha256').update(script!).digest('base64')}'`,
      );
      expect(html).toContain('aria-label="Copy MCP server URL"');
      expect(html).toContain('value="https://discord-dot.example.test/mcp"');

      const rejectedForm = await runtime.dispatchFetch('http://localhost/admin', {
        method: 'POST',
        headers: { origin: 'https://attacker.example.test', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=start-discord-link',
      });
      expect(rejectedForm.status).toBe(403);
      expect(outboundRequests.length).toBeGreaterThan(0);
      expect(outboundRequests.every((url) => url === clientMetadataUrl)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 20_000);
});
