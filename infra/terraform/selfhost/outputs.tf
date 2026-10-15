output "selfhost_contract" {
  description = "Host foundation only; no running Supabase, backups or QA acceptance is implied."
  value = {
    subscription_id    = var.config.subscription_id
    tenant_id          = var.config.tenant_id
    environment        = var.config.environment
    resource_group     = azapi_resource.group.name
    vm_name            = azapi_resource.host.name
    private_ip         = local.host_ip
    public_ip          = azapi_resource.scoped_public_ip.output.properties.ipAddress
    public_hostname    = azapi_resource.scoped_public_ip.output.properties.dnsSettings.fqdn
    apps_subnet_id     = "${azapi_resource.network.id}/subnets/container-apps"
    principal_id       = azapi_resource.host.output.identity.principalId
    recovery_vault_url = "https://${azapi_resource.recovery_vault.name}.vault.azure.net"
  }
}
