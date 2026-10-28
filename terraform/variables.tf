variable "account_id" {
  description = "Cloudflare account that owns discord-dot resources."
  type        = string
  nullable    = false
}

variable "workers_dev_subdomain" {
  description = "Existing account-level workers.dev subdomain label, without the Worker name or .workers.dev suffix."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.workers_dev_subdomain))
    error_message = "workers_dev_subdomain must be the existing account-level workers.dev label, such as example-team."
  }
}

variable "access_team_domain" {
  description = "Cloudflare Access team domain, without a scheme or path."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9-]+\\.cloudflareaccess\\.com$", lower(var.access_team_domain)))
    error_message = "access_team_domain must be a Cloudflare Access team hostname."
  }
}

variable "access_identity_provider_id" {
  description = "ID of the existing Cloudflare Access identity provider selected for the owner-only applications."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.access_identity_provider_id)) || can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.access_identity_provider_id))
    error_message = "access_identity_provider_id must be the ID of an existing Access identity provider, as 32 hex digits or a UUID."
  }
}

variable "owner_email" {
  description = "Exact owner email allowed by Cloudflare Access and the MCP OAuth gate. Supply through private deployment configuration."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = can(regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", var.owner_email))
    error_message = "owner_email must be a valid email address."
  }
}

variable "discord_bot_user_id" {
  description = "Verified Discord bot user snowflake."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{17,20}$", var.discord_bot_user_id))
    error_message = "discord_bot_user_id must be a verified Discord snowflake."
  }
}

variable "discord_bot_token" {
  description = "Discord bot token. Terraform stores this sensitive Worker secret binding in state."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = length(trimspace(var.discord_bot_token)) > 0
    error_message = "discord_bot_token must be provided through the production secret store."
  }
}

variable "discord_oauth_client_secret" {
  description = "Discord application OAuth client secret for owner-only account linking; Terraform stores this sensitive Worker binding in state."
  type        = string
  sensitive   = true
  nullable    = false
  default     = ""
}
