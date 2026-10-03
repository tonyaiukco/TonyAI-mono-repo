locals {
  roles = {
    pull              = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
    push              = "8311e382-0749-4cb8-b61a-304f252e45ec"
    secrets_user      = "4633458b-17de-408a-b874-0445c86b69e6"
    secrets_officer   = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
    app_contributor   = "358470bc-b998-42bd-ab17-a7e34c199c0f"
    identity_operator = "f1a07417-d97a-45cb-824c-7a7467783830"
    reader            = "acdd72a7-3385-48ef-bd42-f606fba81ae7"
  }
  grants = merge(
    { for kind in keys(local.identities) : "pull-${kind}" => {
      scope = azapi_resource.registry.id, principal = azapi_resource.identity[kind].output.properties.principalId, role = local.roles.pull, kind = "ServicePrincipal"
    } },
    { owner_secrets = { scope = azapi_resource.vault.id, principal = var.config.owner_object_id, role = local.roles.secrets_officer, kind = "User" } },
    var.config.runtime_secrets_ready ? { for name in ["database-url", "supabase-service-role-key"] : "secret-${name}" => {
      scope = "${azapi_resource.vault.id}/secrets/${name}", principal = azapi_resource.identity["api"].output.properties.principalId, role = local.roles.secrets_user, kind = "ServicePrincipal"
    } } : {},
    var.config.deployer_object_id != "" ? merge(
      { registry_push = { scope = azapi_resource.registry.id, principal = var.config.deployer_object_id, role = local.roles.push, kind = "ServicePrincipal" } },
      { for kind in keys(local.identities) : "identity-${kind}" => { scope = azapi_resource.identity[kind].id, principal = var.config.deployer_object_id, role = local.roles.identity_operator, kind = "ServicePrincipal" } },
      { environment_read = { scope = azapi_resource.environment.id, principal = var.config.deployer_object_id, role = local.roles.reader, kind = "ServicePrincipal" } }
    ) : {},
    var.config.apps_ready ? { for kind in keys(local.identities) : "app-${kind}" => {
      scope = "${azapi_resource.group.id}/providers/Microsoft.App/containerApps/${local.stem}-${kind}", principal = var.config.deployer_object_id, role = local.roles.app_contributor, kind = "ServicePrincipal"
    } } : {}
  )
}
resource "azapi_resource" "grant" {
  for_each  = local.grants
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", lower("${each.value.scope}/${each.value.principal}/${each.value.role}"))
  parent_id = each.value.scope
  body = { properties = {
    roleDefinitionId = "/subscriptions/${var.config.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/${each.value.role}"
    principalId      = each.value.principal
    principalType    = each.value.kind
  } }
  response_export_values = []
}
# Environment join is deliberately scoped to this environment, with no ARM deployment rights.
resource "azapi_resource" "join_role" {
  type      = "Microsoft.Authorization/roleDefinitions@2022-04-01"
  name      = uuidv5("url", "${azapi_resource.group.id}/environment-join")
  parent_id = azapi_resource.group.id
  body = { properties = {
    roleName         = "${local.stem}-environment-join-${var.config.registry_name}"
    description      = "Join this existing Container Apps environment only."
    type             = "CustomRole"
    assignableScopes = [azapi_resource.group.id]
    permissions      = [{ actions = ["Microsoft.App/managedEnvironments/join/action"], notActions = [], dataActions = [], notDataActions = [] }]
  } }
  response_export_values = []
}
resource "azapi_resource" "join_grant" {
  count                  = var.config.deployer_object_id == "" ? 0 : 1
  type                   = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name                   = uuidv5("url", "${azapi_resource.environment.id}/${var.config.deployer_object_id}/join")
  parent_id              = azapi_resource.environment.id
  body                   = { properties = { roleDefinitionId = azapi_resource.join_role.id, principalId = var.config.deployer_object_id, principalType = "ServicePrincipal" } }
  response_export_values = []
}
