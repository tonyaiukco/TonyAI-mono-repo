output "application_contract" {
  description = "Public handoff; application never reads foundation state. Owner reviews this against ARM."
  value = {
    subscription_id = var.config.subscription_id
    tenant_id       = var.config.tenant_id
    environment     = var.config.environment
    resource_group  = var.config.resource_group
    prefix          = var.config.prefix
    registry_name   = var.config.registry_name
    vault_name      = var.config.vault_name
    default_domain  = azapi_resource.environment.output.properties.defaultDomain
  }
}
