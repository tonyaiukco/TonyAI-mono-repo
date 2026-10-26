output "application_contract" {
  description = "Public handoff only; review against ARM, never read foundation state from application."
  value = {
    subscription_id = var.config.subscription_id, tenant_id = var.config.tenant_id
    environment     = "staging", region = local.location, resource_group = "tonyai-staging-apps"
    prefix          = "tonyai", registry_name = var.config.registry_name, vault_name = var.config.vault_name
    default_domain  = azapi_resource.environment.output.properties.defaultDomain
    apps_subnet_id  = local.apps_subnet_id
  }
}
output "oidc_client_id" {
  value = var.config.oidc_enabled ? azapi_resource.deployer["enabled"].output.properties.clientId : null
}
