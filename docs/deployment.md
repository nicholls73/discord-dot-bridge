# Deploy to your own Cloudflare account

Each installation has its own Discord application, Cloudflare resources, owner
identity and Terraform state. The configuration supports one `discord-dot`
installation per Cloudflare account. Do not reuse another installation's state
or OAuth storage.

## Prepare the accounts

1. Enable your Cloudflare account's [Workers.dev subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
   Set up a Zero Trust team and select an Access identity provider. Record the
   account ID, subdomain label, team domain, provider ID and exact owner email
   asserted by that provider. Terraform creates the two Access applications;
   it does not create or change the identity provider.
2. Create a private R2 state bucket and bucket-scoped read/write
   [R2 credentials](https://developers.cloudflare.com/r2/api/tokens/). Use a
   separate account-scoped Cloudflare API token for Workers scripts, KV and
   Access applications/policies. Consult the pinned
   [provider documentation](https://registry.terraform.io/providers/cloudflare/cloudflare/5.24.0/docs)
   for the resource permissions.
3. Create your application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
   Save its bot token, bot/application ID and OAuth client secret privately.
   The bridge uses the bot ID as its OAuth client ID. Add this redirect URI,
   replacing the subdomain with yours:

   ```text
   https://discord-dot.<workers_dev_subdomain>.workers.dev/admin?discord_oauth=callback
   ```

See [Discord permissions](gateway-events.md#discord-permissions) for channel and
Message Content settings. Account linking requires the OAuth client secret;
without it, existing grants remain viewable/revocable, but linking is disabled.

## Private local configuration

Install dependencies and run the [local checks](../README.md#local-checks), which
build `dist/index.js`. Copy these templates and replace their placeholders:

```sh
cp terraform/production.auto.tfvars.example terraform/production.auto.tfvars
cp terraform/production.backend.hcl.example terraform/production.backend.hcl
```

The populated files are ignored by Git. Variable meanings and validation live
in [`variables.tf`](../terraform/variables.tf). Load credentials into your shell
through a secret manager, without committing them:

| Environment variable | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account-scoped deployment token |
| `TF_VAR_discord_bot_token` | Discord bot token |
| `TF_VAR_discord_oauth_client_secret` | Discord OAuth client secret |
| `AWS_ACCESS_KEY_ID` | R2 state-bucket access key ID |
| `AWS_SECRET_ACCESS_KEY` | R2 state-bucket secret access key |

Terraform state contains Worker secrets. Keep the bucket, local state, backups
and saved plans private. Do not publish state or plans as CI artifacts.

## First installation only

Confirm `discord-dot` is a genuinely new Worker in your account, with no Durable
Object migration history. Existing installations skip this bootstrap procedure
and retain their state.

1. Activate the [bootstrap template](../terraform/bootstrap_override.tf.example):

   ```sh
   cp terraform/bootstrap_override.tf.example terraform/bootstrap_override.tf
   ```

   Terraform merges this [override](https://developer.hashicorp.com/terraform/language/files/override)
   with the Worker resource to register its SQLite class once. It creates no
   response policy or access grants. The active file is ignored by Git.
2. Initialise the real private backend, review the plan and approve the apply:

   ```sh
   terraform -chdir=terraform init -input=false -backend-config=production.backend.hcl -lockfile=readonly
   terraform -chdir=terraform plan
   terraform -chdir=terraform apply
   ```

   Use this same bucket, endpoint and the state key in
   [`versions.tf`](../terraform/versions.tf) for later local and GitHub deployments.
   Backend-disabled validation is not a deployment backend. After an interrupted
   apply or migration-tag conflict, inspect the Worker and state before retrying;
   never reset migration history or recreate existing resources to bypass it.
3. After registration succeeds, remove the active override:

   ```sh
   rm terraform/bootstrap_override.tf
   terraform -chdir=terraform plan
   ```

   Confirm the next plan does not request another class migration or replace
   existing resources. Routine uploads omit migration metadata. Keep the
   `.example` template; do not activate it for upgrades.

## GitHub deployment

After the first local installation, configure a GitHub environment named
`production`, restricted to `main`. Use the same installation's settings;
local `.tfvars` files are not available in Actions.

| Kind | GitHub environment name | Value |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Worker/Access account ID |
| Variable | `ACCESS_OWNER_EMAIL` | Exact owner login email |
| Variable | `WORKERS_DEV_SUBDOMAIN` | Account subdomain label only |
| Variable | `ACCESS_TEAM_DOMAIN` | Team host ending in `.cloudflareaccess.com` |
| Variable | `ACCESS_IDENTITY_PROVIDER_ID` | Selected existing provider ID |
| Variable | `DISCORD_BOT_USER_ID` | Bot/application ID |
| Variable | `TF_STATE_R2_ACCOUNT_ID` | State bucket's account ID |
| Variable | `TF_STATE_R2_BUCKET` | State bucket name |
| Variable | `TF_STATE_R2_ACCESS_KEY_ID` | State access key ID |
| Secret | `CLOUDFLARE_API_TOKEN` | Deployment token |
| Secret | `DISCORD_BOT_TOKEN` | Bot token |
| Secret | `DISCORD_OAUTH_CLIENT_SECRET` | OAuth client secret for account linking |
| Secret | `TF_STATE_R2_SECRET_ACCESS_KEY` | State secret access key |

The [Deploy workflow](../.github/workflows/deploy.yml) runs on pushes to `main`
and manual dispatches on `main`. It checks the runtime/build, rejects missing
settings, then applies Terraform. Configure the environment before using it.
Protect `main` and require deployment approval as appropriate for your account.
Contributor CI requires no production credentials.

## Finish setup and update

Open `https://discord-dot.<workers_dev_subdomain>.workers.dev/admin`. Sign in as
the owner, install your bot, link your Discord account and explicitly approve
a server and grant a member or role. Supply your own
[response policy](response-policy.md), then [connect the dot and run the canary](gateway-events.md#connect-the-dot).
Installing the bot or subscribing grants nobody access by itself.

For updates, retain the backend and bindings, leave the bootstrap override
absent, and review the plan. Grants, policy and revision history must survive
redeployment. Future class migrations need separate review with the current tag
as their precondition; never reuse the initial template or use `terraform destroy`
as an update procedure.
