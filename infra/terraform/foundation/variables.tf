variable "config" {
  description = "Nonsecret owner configuration. Use a distinct group and backend account per environment."
  type = object({
    subscription_id       = string
    tenant_id             = string
    environment           = string
    prefix                = string
    resource_group        = string
    registry_name         = string
    vault_name            = string
    repository            = string
    release_sha           = string
    owner_object_id       = string
    deployer_object_id    = optional(string, "")
    runtime_secrets_ready = optional(bool, false)
    apps_ready            = optional(bool, false)
    monitoring = optional(object({
      operator_name           = string, operator_email = string,
      api_digest              = string, supabase_project_ref = string,
      database_secret_version = string, backend_secret_version = string
    }))
  })
  validation {
    condition     = contains(["staging", "production"], var.config.environment) && can(regex("^[a-z0-9]{3,12}$", var.config.prefix)) && can(regex("^[a-z0-9]{5,50}$", var.config.registry_name)) && can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.config.vault_name)) && can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.config.repository)) && can(regex("^[a-f0-9]{40}$", var.config.release_sha))
    error_message = "Use explicit environment, safe names, repository and a full reviewed SHA."
  }
  validation {
    condition     = alltrue([for id in [var.config.subscription_id, var.config.tenant_id, var.config.owner_object_id] : can(regex("^[a-f0-9-]{36}$", id))]) && (var.config.deployer_object_id == "" || can(regex("^[a-f0-9-]{36}$", var.config.deployer_object_id))) && (!var.config.apps_ready || var.config.deployer_object_id != "")
    error_message = "Supply nonsecret UUIDs; app grants require a verified OIDC principal."
  }
  validation {
    condition = var.config.monitoring == null ? true : (
      var.config.runtime_secrets_ready &&
      can(regex("^[A-Za-z][A-Za-z0-9 ._-]{1,79}$", var.config.monitoring.operator_name)) &&
      can(regex("^[^@ <>]+@[^@ <>]+\\.[^@ <>]+$", var.config.monitoring.operator_email)) &&
      can(regex("^sha256:[a-f0-9]{64}$", var.config.monitoring.api_digest)) &&
      can(regex("^[a-z]{20}$", var.config.monitoring.supabase_project_ref)) &&
      alltrue([for version in [var.config.monitoring.database_secret_version, var.config.monitoring.backend_secret_version] : can(regex("^[a-f0-9]{32}$", version))])
    )
    error_message = "Monitoring needs runtime secret grants, a named operator/email, exact image and secret versions."
  }

}
locals {
  location   = "germanywestcentral"
  stem       = "${var.config.prefix}-${var.config.environment}"
  group_id   = "/subscriptions/${var.config.subscription_id}/resourceGroups/${var.config.resource_group}"
  tags       = { application = "TonyAI", environment = var.config.environment, task = "LP2-01" }
  identities = { api = "api", web = "web" }

}
