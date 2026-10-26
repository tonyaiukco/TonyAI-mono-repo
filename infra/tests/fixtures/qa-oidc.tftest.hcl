# Pure provider mock = establish prior state, then plan the exact Unit 4 transition.
mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, location = "", tags = {} }
  }
}
variables { config = { "environment" = "staging", "resource_group" = "tonyai-staging-apps", "prefix" = "tonyai", "repository" = "tonyaiukco/TonyAI-mono-repo", "subscription_id" = "cb7efc2f-37a7-4672-b62c-93c207bcd33d", "tenant_id" = "00000000-0000-0000-0000-000000000002", "owner_object_id" = "00000000-0000-0000-0000-000000000003", "registry_name" = "tonyaiqatest", "vault_name" = "tonyai-qa-test", "release_sha" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "oidc_enabled" = false, "runtime_secrets_ready" = true, "smtp_secret_ready" = false, "apps_ready" = false } }
override_resource {
  target = azapi_resource.group
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps", "output" = {} }
}
override_resource {
  target = azapi_resource.registry
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ContainerRegistry/registries/tonyaiqatest", "output" = { "properties" = { "loginServer" = "tonyaiqatest.azurecr.io" } } }
}
override_resource {
  target = azapi_resource.logs
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.OperationalInsights/workspaces/tonyai-staging-logs", "output" = {} }
}
override_resource {
  target = azapi_resource.environment
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.App/managedEnvironments/tonyai-staging-env", "output" = { "properties" = { "defaultDomain" = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  target = azapi_resource.diagnostics
  values = { location = "", tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.App/managedEnvironments/tonyai-staging-env/providers/Microsoft.Insights/diagnosticSettings/container-logs", "output" = {} }
}
override_resource {
  target = azapi_resource.vault
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.KeyVault/vaults/tonyai-qa-test", "output" = {} }
}
override_resource {
  target = azapi_resource.identity["api"]
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api", "output" = { "properties" = { "principalId" = "00000000-0000-0000-0000-000000000004" } } }
}
override_resource {
  target = azapi_resource.identity["web"]
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-web", "output" = { "properties" = { "principalId" = "00000000-0000-0000-0000-000000000005" } } }
}
override_resource {
  target = azapi_resource.dns
  values = { tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.Network/privateDnsZones/qa.tonyai.internal", "output" = {} }
}
override_resource {
  target = azapi_resource.dns_link
  values = { tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.Network/privateDnsZones/qa.tonyai.internal/virtualNetworkLinks/qa-data", "output" = {} }
}
override_resource {
  target = azapi_resource.db_address
  values = { location = "", tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.Network/privateDnsZones/qa.tonyai.internal/A/db", "output" = {} }
}
override_resource {
  target = azapi_resource.join_role
  values = { location = "", tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.Authorization/roleDefinitions/dbbd543b-25ce-5f9f-a38b-c01b49ff745a", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["owner_secrets"]
  values = { location = "", tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.KeyVault/vaults/tonyai-qa-test/providers/Microsoft.Authorization/roleAssignments/43cfa98f-a359-57fe-a466-3046405f9c55", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["pull-api"]
  values = { location = "", tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ContainerRegistry/registries/tonyaiqatest/providers/Microsoft.Authorization/roleAssignments/39f09e3d-6aeb-5d8a-83b3-45ec3b312fe6", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["pull-web"]
  values = { location = "", tags = {}, ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ContainerRegistry/registries/tonyaiqatest/providers/Microsoft.Authorization/roleAssignments/9855e900-a7e5-5d16-98d5-7b78ae5b61b9", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["secret-database-url"]
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, location = "", tags = {}, id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.KeyVault/vaults/tonyai-qa-test/secrets/database-url/providers/Microsoft.Authorization/roleAssignments/b16d173e-4fd4-5c8c-aba0-9294a5c0f1ca", output = {} }
}
override_resource {
  target = azapi_resource.grant["secret-supabase-service-role-key"]
  values = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, location = "", tags = {}, id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.KeyVault/vaults/tonyai-qa-test/secrets/supabase-service-role-key/providers/Microsoft.Authorization/roleAssignments/6851475a-8a8f-5941-87f3-a68410095c8f", output = {} }
}
run "oidc_predecessor" { command = apply }
run "oidc_transition" {
  command = plan
  variables { config = merge(var.config, { oidc_enabled = true, release_sha = "cccccccccccccccccccccccccccccccccccccccc" }) }
  assert {
    condition     = length(azapi_resource.grant) == 9 && length(azapi_resource.deployer) == 1 && length(azapi_resource.federation) == 1 && length(azapi_resource.join_grant) == 1
    error_message = "Unit 5 adds only identity, federation and five narrow grants."
  }
}
