resource "azapi_resource" "replacement_recovery_vault" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.KeyVault/vaults@2023-07-01"
  name                      = each.value.recovery_vault_name
  parent_id                 = local.r02_group_id
  location                  = local.location
  tags                      = local.r02_tags
  body = { properties = {
    tenantId                  = var.config.tenant_id
    sku                       = { family = "A", name = "standard" }
    enableRbacAuthorization   = true
    enableSoftDelete          = true
    softDeleteRetentionInDays = 90
    enablePurgeProtection     = true
    publicNetworkAccess       = "Enabled"
    networkAcls               = { bypass = "None", defaultAction = "Deny", ipRules = [{ value = var.config.operator_ipv4 }], virtualNetworkRules = [] }
    accessPolicies            = []
  } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "replacement_recovery_owner" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name                      = uuidv5("url", "${local.r02_group_id}/providers/Microsoft.KeyVault/vaults/${each.value.recovery_vault_name}/${var.config.recovery_owner_object_id}/secrets-officer")
  parent_id                 = "${local.r02_group_id}/providers/Microsoft.KeyVault/vaults/${each.value.recovery_vault_name}"
  body = { properties = {
    principalId      = var.config.recovery_owner_object_id
    principalType    = "User"
    roleDefinitionId = "/subscriptions/${var.config.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
  } }
  depends_on             = [azapi_resource.replacement_recovery_vault]
  response_export_values = []
}

resource "azapi_resource" "replacement_ip_lock" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.Authorization/locks@2020-05-01"
  name                      = "tonyai-retain-r02-public-ip"
  parent_id                 = local.r02_ip_id
  body                      = { properties = { level = "CanNotDelete", notes = "Retain r02 hostname. Removal requires a separate reviewed decommission plan." } }
  depends_on                = [azapi_resource.replacement_public_ip]
  response_export_values    = []
  lifecycle { prevent_destroy = true }
}
output "replacement_contract" {
  value = var.replacement == null ? null : {
    generation         = "r02"
    vm_id              = "${local.r02_group_id}/providers/Microsoft.Compute/virtualMachines/${local.r02_stem}"
    private_ip         = "10.80.1.4"
    public_ip          = azapi_resource.replacement_public_ip["r02"].output.properties.ipAddress
    public_hostname    = azapi_resource.replacement_public_ip["r02"].output.properties.dnsSettings.fqdn
    recovery_vault_url = "https://${var.replacement.recovery_vault_name}.vault.azure.net"
    apps_subnet_id     = "${local.r02_network_id}/subnets/container-apps"
  }
}
