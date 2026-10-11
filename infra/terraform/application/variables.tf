variable "foundation" {
  type = object({
    subscription_id = string, tenant_id = string, environment = string,
    resource_group  = string, prefix = string, registry_name = string,
    vault_name      = string, default_domain = string
  })
  validation {
    condition     = contains(["staging", "production"], var.foundation.environment) && can(regex("^[a-z0-9-]+\\.germanywestcentral\\.azurecontainerapps\\.io$", var.foundation.default_domain)) && can(regex("^[a-z0-9]{3,12}$", var.foundation.prefix)) && can(regex("^[a-z0-9]{5,50}$", var.foundation.registry_name)) && can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.foundation.vault_name))
    error_message = "Application must target the reviewed EU foundation contract."
  }
}
variable "release" {
  description = "Versioned, nonsecret release input; reused unchanged for rollback."
  type = object({
    source_sha              = string, release_id = string, supabase_project_ref = string,
    api_digest              = string, web_digest = string,
    database_secret_version = string, backend_secret_version = string,
    mail = optional(object({
      host = string, port = number, secure = bool, user = string,
      from = string, password_secret_version = string
    }))
    runtime_limits       = optional(map(number), {})
    storage_cleanup_hold = bool, storage_sweep_interval_seconds = number
  })
  validation {
    condition     = alltrue([for digest in [var.release.api_digest, var.release.web_digest] : can(regex("^sha256:[a-f0-9]{64}$", digest))]) && alltrue([for version in [var.release.database_secret_version, var.release.backend_secret_version] : can(regex("^[a-f0-9]{32}$", version))]) && can(regex("^[a-z]{20}$", var.release.supabase_project_ref)) && can(regex("^[a-f0-9]{40}$", var.release.source_sha)) && can(regex("^[a-z][a-z0-9-]{0,29}$", var.release.release_id))
    error_message = "Use immutable digests, exact enabled vault versions, a project ref, full source SHA and unique revision suffix."
  }
  validation {
    condition     = var.release.storage_sweep_interval_seconds >= 1 && var.release.storage_sweep_interval_seconds <= 86400 && floor(var.release.storage_sweep_interval_seconds) == var.release.storage_sweep_interval_seconds
    error_message = "Storage sweep interval must be an integer from 1 to 86400 seconds."
  }
  validation {
    condition = alltrue([for k, v in var.release.runtime_limits :
      contains(keys(jsondecode(file("${path.module}/../../config/runtime-limits.json"))), k)
      && v >= 1 && v <= 2147483647 && floor(v) == v
    ])
    error_message = "Runtime limits accept only registered positive integer budgets."
  }

  validation {
    condition = var.release.mail == null ? true : (
      can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.release.mail.host)) &&
      strcontains(var.release.mail.host, ".") && !endswith(var.release.mail.host, ".localhost") &&
      !can(regex("^[0-9.]+$", var.release.mail.host)) && length(var.release.mail.host) <= 253 &&
      var.release.mail.port >= 1 && var.release.mail.port <= 65535 && floor(var.release.mail.port) == var.release.mail.port &&
      can(regex("^[^\\s<>]{1,256}$", var.release.mail.user)) &&
      can(regex("^[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+$", var.release.mail.from)) &&
      can(regex("^[a-f0-9]{32}$", var.release.mail.password_secret_version))
    )
    error_message = "Mail needs a provider DNS host, valid port, username, sender and exact Key Vault password version."
  }
}
# Operational settings are plain values, never Key Vault secrets.
locals {
  stem            = "${var.foundation.prefix}-${var.foundation.environment}"
  group_id        = "/subscriptions/${var.foundation.subscription_id}/resourceGroups/${var.foundation.resource_group}"
  environment_id  = "${local.group_id}/providers/Microsoft.App/managedEnvironments/${local.stem}-env"
  registry        = "${var.foundation.registry_name}.azurecr.io"
  web_origin      = "https://${local.stem}-web.${var.foundation.default_domain}"
  supabase_url    = "https://${var.release.supabase_project_ref}.supabase.co"
  identity_ids    = { for kind in ["api", "web"] : kind => "${local.group_id}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${local.stem}-${kind}" }
  secret_versions = merge({ database-url = var.release.database_secret_version, supabase-service-role-key = var.release.backend_secret_version }, var.release.mail == null ? {} : { smtp-password = var.release.mail.password_secret_version })
  runtime_limits  = merge(jsondecode(file("${path.module}/../../config/runtime-limits.json")), var.release.runtime_limits)
  mail_env = var.release.mail == null ? [] : [
    { name = "SMTP_HOST", value = var.release.mail.host },
    { name = "SMTP_PORT", value = tostring(var.release.mail.port) },
    { name = "SMTP_SECURE", value = tostring(var.release.mail.secure) },
    { name = "SMTP_USER", value = var.release.mail.user },
    { name = "SMTP_PASSWORD", secretRef = "smtp-password" },
    { name = "MAIL_FROM", value = var.release.mail.from },
    { name = "APP_URL", value = local.web_origin }
  ]
  api_env = concat([
    { name = "NODE_ENV", value = "production" }, { name = "PORT", value = "3001" },
    { name = "NODE_OPTIONS", value = "--max-old-space-size=768" },
    { name = "PROXY_MODE", value = "azure" }, { name = "AZURE_INGRESS_ONLY", value = "true" },
    { name = "STORAGE_CLEANUP_HOLD", value = var.release.storage_cleanup_hold ? "1" : "0" },
    { name = "STORAGE_SWEEP_INTERVAL_SECONDS", value = tostring(var.release.storage_sweep_interval_seconds) },
    { name = "LOG_FORMAT", value = "json" }, { name = "SUPABASE_URL", value = local.supabase_url },
    { name = "SUPABASE_JWT_SCHEME", value = "jwks" }, { name = "WEB_ORIGIN", value = local.web_origin },
    { name = "DATABASE_URL", secretRef = "database-url" },
    { name = "SUPABASE_SERVICE_ROLE_KEY", secretRef = "supabase-service-role-key" }
  ], local.mail_env, [for k, v in local.runtime_limits : { name = k, value = tostring(v) }])
  web_env = [
    { name = "NODE_ENV", value = "production" }, { name = "PORT", value = "3000" },
    { name = "HOSTNAME", value = "0.0.0.0" }, { name = "SUPABASE_URL_INTERNAL", value = local.supabase_url }
  ]
}
