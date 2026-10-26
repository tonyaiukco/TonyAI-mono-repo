# Owner enables only after independently verifying the staging protection and
# ephemeral JIT runner gates. The federated subject alone does not bind main.
resource "azapi_resource" "deployer" {
  for_each               = var.config.oidc_enabled ? toset(["enabled"]) : toset([])
  type                   = "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31"
  name                   = "${local.stem}-release"
  parent_id              = azapi_resource.group.id
  location               = local.location
  body                   = {}
  response_export_values = ["properties.principalId", "properties.clientId"]
}
resource "azapi_resource" "federation" {
  for_each  = var.config.oidc_enabled ? toset(["enabled"]) : toset([])
  type      = "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31"
  name      = "github-staging"
  parent_id = azapi_resource.deployer[each.key].id
  body = { properties = {
    issuer    = "https://token.actions.githubusercontent.com"
    subject   = "repo:${var.config.repository}:environment:staging"
    audiences = ["api://AzureADTokenExchange"]
  } }
  response_export_values = []
}
