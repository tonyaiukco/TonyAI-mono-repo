resource "azapi_resource" "recovery_vault" {
  type      = "Microsoft.KeyVault/vaults@2023-07-01"
  name      = "tonyai-${var.config.environment == "staging" ? "qa" : "prod"}-rec-${substr(var.config.subscription_id, 0, 8)}"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
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
resource "azapi_resource" "recovery_owner" {
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "${azapi_resource.recovery_vault.id}/${var.config.recovery_owner_object_id}/secrets-officer")
  parent_id = azapi_resource.recovery_vault.id
  body = { properties = {
    principalId      = var.config.recovery_owner_object_id
    principalType    = "User"
    roleDefinitionId = "/subscriptions/${var.config.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
  } }
  response_export_values = []
}
resource "azapi_resource" "delete_lock" {
  for_each               = { group = azapi_resource.group.id, public_ip = azapi_resource.public_ip.id, scoped_public_ip = azapi_resource.scoped_public_ip.id }
  type                   = "Microsoft.Authorization/locks@2020-05-01"
  name                   = "tonyai-retain-${each.key}"
  parent_id              = each.value
  body                   = { properties = { level = "CanNotDelete", notes = "Retain QA data and its authentication hostname. Removal requires an explicit reviewed recovery/decommission plan." } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
