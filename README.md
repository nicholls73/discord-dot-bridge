# Discord Dot Bridge

A self-hosted bridge between Discord and your ChatGPT dot, deployed to your own
Cloudflare account. Approved members mention your bot; MCP Events wakes the
connected dot, which reads the mention and replies in its original channel.

You supply the Discord application, Cloudflare infrastructure and a dot host
with OAuth MCP connections and MCP Events support. This project provides no
hosted service, AI runtime or model API key. Verify host support with an
end-to-end mention test after installation.

## Features

- Owner-only administration through Cloudflare Access. Approve servers and grant
  members or roles access; new installations allow nobody.
- Direct-mention delivery, native typing feedback and replies tied to the saved
  origin. Uncertain sends are not automatically repeated.
- Optional, separately consented channel reads, standalone sends and edits to
  the bot's own messages. General channel traffic does not trigger replies.
- An owner-supplied response policy with revision checks and history. No policy
  content is bundled or reset during upgrades.

## Get started

Follow the [deployment guide](docs/deployment.md), then
[connect your dot and test a mention](docs/gateway-events.md#connect-the-dot).
Each installation uses one Worker, one SQLite-backed Durable Object, OAuth KV,
two Access applications and an R2 bucket for Terraform state. Create the state
bucket and select an Access identity provider before applying the project.
Cloudflare usage is billed to your account.

## Local development

Use Node.js 24 and the Terraform version in [`versions.tf`](terraform/versions.tf).

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Development uses loopback-only consent bypass and a placeholder KV ID. Keep real
configuration in ignored local files or deployment secret stores.
`wrangler.jsonc` is for local development; Terraform owns production deployment.

## Local checks

```sh
npm run check
npm run verify:production-runtime
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=terraform validate -no-color
```

Tests use synthetic identities and mocked external services. The build embeds
assets into the exact single module Terraform uploads and starts it in Workerd
to test the protected admin UI. These checks do not deploy resources or prove a
live Discord-to-dot connection. CI runs them without cloud secrets.

## Operation and security

- [Gateway, permissions, subscriptions and troubleshooting](docs/gateway-events.md)
- [Response policy and listener privacy boundaries](docs/response-policy.md)
- [Webhook transport and Cloudflare trust assumptions](docs/webhook-callbacks.md)

The bridge enforces access to Discord messages. It cannot isolate your dot's
broader personal context or prove which conversation caused an MCP call. Review
the listener guidance and grant only the scopes you need.

## Licence

[MIT](LICENSE). The package remains `private` to prevent accidental npm publication;
that setting does not restrict use of the source under the licence.
