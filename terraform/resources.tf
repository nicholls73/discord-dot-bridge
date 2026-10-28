locals {
  worker_script_name = "discord-dot"
  worker_hostname    = "${local.worker_script_name}.${var.workers_dev_subdomain}.workers.dev"
  discord_oauth_bindings = trimspace(var.discord_oauth_client_secret) != "" ? [
    {
      name = "DISCORD_OAUTH_CLIENT_SECRET"
      type = "secret_text"
      text = var.discord_oauth_client_secret
    },
  ] : []
}

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = "discord-dot-oauth"
}

resource "cloudflare_zero_trust_access_application" "owner_consent" {
  account_id           = var.account_id
  name                 = "discord-dot-owner-consent"
  domain               = "${local.worker_hostname}/authorize"
  type                 = "self_hosted"
  allowed_idps         = [var.access_identity_provider_id]
  app_launcher_visible = false
  session_duration     = "8h"

  policies = [{
    name       = "discord-dot-owner-only"
    precedence = 1
    decision   = "allow"
    include = [{
      email = { email = var.owner_email }
    }]
  }]
}

resource "cloudflare_zero_trust_access_application" "owner_controls" {
  account_id           = var.account_id
  name                 = "discord-dot-owner-controls"
  domain               = "${local.worker_hostname}/admin"
  type                 = "self_hosted"
  allowed_idps         = [var.access_identity_provider_id]
  app_launcher_visible = false
  session_duration     = "8h"

  policies = [{
    name       = "discord-dot-owner-only"
    precedence = 1
    decision   = "allow"
    include = [{
      email = { email = var.owner_email }
    }]
  }]
}

resource "cloudflare_workers_script" "discord_dot" {
  # First installs use the temporary bootstrap_override.tf template; updates omit migrations.
  account_id          = var.account_id
  script_name         = local.worker_script_name
  main_module         = "index.js"
  content_file        = "${path.module}/../dist/index.js"
  content_sha256      = filesha256("${path.module}/../dist/index.js")
  compatibility_date  = "2026-10-04"
  compatibility_flags = ["global_fetch_strictly_public"]

  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      invocation_logs    = false
      persist            = true
      head_sampling_rate = 1
    }
  }

  bindings = concat([
    {
      name         = "OAUTH_KV"
      type         = "kv_namespace"
      namespace_id = cloudflare_workers_kv_namespace.oauth.id
    },
    {
      name       = "BRIDGE_STATE"
      type       = "durable_object_namespace"
      class_name = "BridgeStateDO"
    },
    {
      name = "ENVIRONMENT"
      type = "plain_text"
      text = "production"
    },
    {
      name = "MCP_ISSUER_URL"
      type = "plain_text"
      text = "https://${local.worker_hostname}"
    },
    {
      name = "ACCESS_TEAM_DOMAIN"
      type = "plain_text"
      text = var.access_team_domain
    },
    {
      name = "ACCESS_AUD"
      type = "plain_text"
      text = cloudflare_zero_trust_access_application.owner_consent.aud
    },
    {
      name = "ACCESS_ADMIN_AUD"
      type = "plain_text"
      text = cloudflare_zero_trust_access_application.owner_controls.aud
    },
    {
      name = "ACCESS_OWNER_EMAIL"
      type = "plain_text"
      text = var.owner_email
    },
    {
      name = "DISCORD_BOT_USER_ID"
      type = "plain_text"
      text = var.discord_bot_user_id
    },
    {
      name = "DISCORD_BOT_TOKEN"
      type = "secret_text"
      text = var.discord_bot_token
    },
  ], local.discord_oauth_bindings)
}

resource "cloudflare_workers_script_subdomain" "discord_dot" {
  account_id       = var.account_id
  script_name      = cloudflare_workers_script.discord_dot.script_name
  enabled          = true
  previews_enabled = false
}
