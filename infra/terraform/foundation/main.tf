resource "azapi_resource" "group" {
  type                   = "Microsoft.Resources/resourceGroups@2024-03-01"
  name                   = var.config.resource_group
  parent_id              = "/subscriptions/${var.config.subscription_id}"
  location               = local.location
  tags                   = merge(local.tags, { tonyaiPrefix = var.config.prefix, githubRepository = var.config.repository, releaseSha = var.config.release_sha })
  body                   = { properties = {} }
  response_export_values = []
  lifecycle {
    prevent_destroy = true
    # Graph helper is sole writer of these two nonsecret identity recovery markers.
    ignore_changes = [tags["githubClientId"], tags["githubPrincipalId"]]
  }
}
resource "azapi_resource" "registry" {
  type                   = "Microsoft.ContainerRegistry/registries@2023-07-01"
  name                   = var.config.registry_name
  parent_id              = azapi_resource.group.id
  location               = local.location
  tags                   = local.tags
  body                   = { sku = { name = "Basic" }, properties = { adminUserEnabled = false, publicNetworkAccess = "Enabled" } }
  response_export_values = ["properties.loginServer"]
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "logs" {
  type                   = "Microsoft.OperationalInsights/workspaces@2023-09-01"
  name                   = "${local.stem}-logs"
  parent_id              = azapi_resource.group.id
  location               = local.location
  tags                   = local.tags
  body                   = { properties = { sku = { name = "PerGB2018" }, retentionInDays = 30, features = { enableLogAccessUsingOnlyResourcePermissions = true } } }
  response_export_values = []
}
resource "azapi_resource" "environment" {
  type      = "Microsoft.App/managedEnvironments@2025-01-01"
  name      = "${local.stem}-env"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  # No workspace key: Azure Monitor routes by ARM workspace ID below.
  body = { properties = {
    workloadProfiles     = [{ name = "Consumption", workloadProfileType = "Consumption" }]
    appLogsConfiguration = { destination = "azure-monitor" }
  } }
  response_export_values = ["properties.defaultDomain"]
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "diagnostics" {
  type      = "Microsoft.Insights/diagnosticSettings@2021-05-01-preview"
  name      = "container-logs"
  parent_id = azapi_resource.environment.id
  body = { properties = {
    workspaceId                 = azapi_resource.logs.id
    logAnalyticsDestinationType = "Dedicated"
    logs                        = [for category in ["ContainerAppConsoleLogs", "ContainerAppSystemLogs"] : { category = category, enabled = true }]
  } }
  response_export_values = []
}
resource "azapi_resource" "vault" {
  type      = "Microsoft.KeyVault/vaults@2023-07-01"
  name      = var.config.vault_name
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
    networkAcls               = { bypass = "AzureServices", defaultAction = "Allow" }
    accessPolicies            = []
  } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "identity" {
  for_each               = local.identities
  type                   = "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31"
  name                   = "${local.stem}-${each.key}"
  parent_id              = azapi_resource.group.id
  location               = local.location
  tags                   = local.tags
  body                   = {}
  response_export_values = ["properties.principalId"]
}
