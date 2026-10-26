variable "config" {
  description = "QA-only public parameters. No R3 credentials or state are consumed."
  type = object({
    subscription_id       = string, tenant_id = string, owner_object_id = string
    registry_name         = string, vault_name = string, release_sha = string
    environment           = optional(string, "staging")
    resource_group        = optional(string, "tonyai-staging-apps")
    prefix                = optional(string, "tonyai")
    repository            = optional(string, "tonyaiukco/TonyAI-mono-repo")
    runtime_secrets_ready = optional(bool, false)
    smtp_secret_ready     = optional(bool, false)
    apps_ready            = optional(bool, false)
    oidc_enabled          = optional(bool, false)
  })
  validation {
    condition     = contains(jsondecode(file("${path.module}/../../../config/deployment-policy.json")).selfhost_sweden_subscriptions, var.config.subscription_id) && var.config.environment == "staging" && var.config.resource_group == "tonyai-staging-apps" && var.config.prefix == "tonyai" && var.config.repository == "tonyaiukco/TonyAI-mono-repo"
    error_message = "Only the reserved Sweden QA subscription, group, names and repository are allowed."
  }
  validation {
    condition     = alltrue([for id in [var.config.tenant_id, var.config.owner_object_id] : can(regex("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", id))]) && can(regex("^[a-z0-9]{5,50}$", var.config.registry_name)) && can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.config.vault_name)) && can(regex("^[a-f0-9]{40}$", var.config.release_sha)) && (!var.config.apps_ready || var.config.oidc_enabled)
    error_message = "Require public UUIDs, safe resource names, full source SHA and OIDC before app grants."
  }
}
locals {
  location           = "swedencentral"
  stem               = "tonyai-staging"
  tags               = { application = "TonyAI", environment = "staging", task = "LP2-01" }
  group_id           = "/subscriptions/${var.config.subscription_id}/resourceGroups/tonyai-staging-apps"
  data_vnet_id       = "/subscriptions/${var.config.subscription_id}/resourceGroups/tonyai-staging-data/providers/Microsoft.Network/virtualNetworks/tonyai-staging-data-vnet"
  apps_subnet_id     = "${local.data_vnet_id}/subnets/container-apps"
  deployer_object_id = var.config.oidc_enabled ? azapi_resource.deployer["enabled"].output.properties.principalId : ""
}
