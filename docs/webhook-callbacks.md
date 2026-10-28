# Hosted Worker webhook callbacks

Verification and signed event delivery use Cloudflare's hosted global HTTPS
`fetch`, including retries from the existing Durable Object outbox. No external
relay, VM, container, public relay endpoint or additional authentication secret
is required. Existing OAuth grants, Discord authorization, signing, subscription
storage, bounded retry/backoff and delivery limits retain their existing owners.

## Platform trust boundary

Cloudflare documents that hosted Worker outbound HTTP requests pass through a
restrictive proxy that prevents access to internal services. Its bindings model
keeps private services outside global `fetch`. The explicit
`global_fetch_strictly_public` flag removes the legacy own-zone privileged-origin
route and makes global requests follow public Internet routing. Both Wrangler
and the Terraform Worker resource already enable this flag; the deployment
artifact test checks it remains enabled and the private-origin flag absent.
[Security model](https://developers.cloudflare.com/workers/reference/security-model/#api-design),
[bindings model](https://blog.cloudflare.com/workers-environment-live-object-bindings/),
[compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public),
[flag implementation comments](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp).

This implementation relies on that hosted platform boundary for destination
resolution, public-network restrictions and normal hostname-based TLS. It does
not perform application DNS preflight, claim that hostname fetch pins a
prevalidated address, or inspect the connected peer. Public docs do not expose
all hosted check/connect internals or exhaustively establish filtering of every
IANA special-purpose range. No independent certification of those internals or
protocol-equivalent pinning is claimed. This trust assumption must be reassessed
before running the callback path on Node, self-hosted Workerd or a different
networking backend. Local mocked tests cannot certify hosted network filtering.

The [MCP Events guide](https://developers.openai.com/plugins/build/mcp-events#verify-the-callback)
requires connection-time destination validation, HTTPS/TLS, non-public-address
blocking and no redirects for both verification and delivery. Platform-managed
enforcement is the deployment assumption here; adding an unpinned DNS lookup
would not establish that guarantee. No guessed OpenAI hostname allowlist is used.

## Application controls

`src/secure-webhook-fetch.ts` is the shared callback boundary. It validates HTTPS
DNS-hostname URLs on port 443, rejects URL credentials/fragments, IP literals and
reserved/local hostname suffixes, and accepts only signed JSON POSTs. It rebuilds
the outbound request from the validated URL, the five allowed webhook headers
and the original body bytes. Input Request metadata and arbitrary init options
are not forwarded: no `cf`/`resolveOverride`, caller-controlled Host, service/VPC
binding, MCP bearer token, cookie or proxy credential reaches global `fetch`.

The operation has a ten-second deadline covering request and response body reads,
honors cancellation, bounds signed bodies to 256 KiB and response bodies to 8 KiB,
and bounds allowed headers. It uses `redirect: 'manual'` and rejects every 3xx
without replaying the POST; `redirect: 'error'` failed in the configured Workerd
runtime. Challenge/HMAC handling stays in `src/mcp-events.ts`. Fixed diagnostic
categories and numeric statuses remain; URLs, headers, bodies, secrets and raw
exceptions are not logged. Global fetch exposes no application DNS/peer proof,
so the transport never emits `dns_resolved` or `peer_verified`.

## Review, rollout and recovery

Run `npm run check` and `npm run verify:production-runtime`. Regression checks
exercise signed verification, delivery/retries, denied input, response limits,
cancellation, real Workerd redirect behavior and the exact Terraform upload
artifact. Outbound destinations in these checks are mocked with synthetic data.

Deployment prerequisites are documented in the [deployment guide](deployment.md).
After deployment, run the [controlled canary](gateway-events.md#canary-sequence)
to verify live callback challenge verification, durable delivery and a reply in
the originating channel. Local checks cannot establish the host's live behaviour.

For rollback, review the previous source version and its compatibility with
saved state before deploying it through the same Terraform workflow. Preserve
OAuth storage, subscriptions, grants and policy history; never recreate them as
part of an ordinary code rollback.
