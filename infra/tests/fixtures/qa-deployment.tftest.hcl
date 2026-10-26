# Pure provider mock = establish prior state, then plan the exact Unit 8 transition.
mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = { ignore_casing = false, ignore_missing_property = true, ignore_null_property = false, schema_validation_enabled = true, location = "", tags = {} }
  }
}
variables { config = { "environment" = "staging", "resource_group" = "tonyai-staging-apps", "prefix" = "tonyai", "repository" = "tonyaiukco/TonyAI-mono-repo", "subscription_id" = "cb7efc2f-37a7-4672-b62c-93c207bcd33d", "tenant_id" = "00000000-0000-0000-0000-000000000002", "owner_object_id" = "00000000-0000-0000-0000-000000000003", "registry_name" = "tonyaiqatest", "vault_name" = "tonyai-qa-test", "release_sha" = "cccccccccccccccccccccccccccccccccccccccc", "oidc_enabled" = true, "runtime_secrets_ready" = true, "smtp_secret_ready" = false, "apps_ready" = false } }
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
override_resource {
  target = azapi_resource.deployer["enabled"]
  values = { "location" = "swedencentral", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-release", "output" = { "properties" = { "principalId" = "00000000-0000-0000-0000-000000000006", "clientId" = "00000000-0000-0000-0000-000000000007" } } }
}
override_resource {
  target = azapi_resource.federation["enabled"]
  values = { "location" = "", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-release/federatedIdentityCredentials/github-staging", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["registry_push"]
  values = { "location" = "", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ContainerRegistry/registries/tonyaiqatest/providers/Microsoft.Authorization/roleAssignments/41c396b0-98d6-5485-a337-d2ad27e3bcbb", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["identity-api"]
  values = { "location" = "", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api/providers/Microsoft.Authorization/roleAssignments/ebdddd21-61a4-55ae-8d2b-bbfb3c9043fd", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["identity-web"]
  values = { "location" = "", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-web/providers/Microsoft.Authorization/roleAssignments/b77a6c3b-cafa-5171-a736-cc57386a182d", "output" = {} }
}
override_resource {
  target = azapi_resource.grant["environment_read"]
  values = { "location" = "", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.App/managedEnvironments/tonyai-staging-env/providers/Microsoft.Authorization/roleAssignments/517d8903-d4ce-5e72-b557-cc4074e8278d", "output" = {} }
}
override_resource {
  target = azapi_resource.join_grant[0]
  values = { "location" = "", "tags" = {}, "ignore_casing" = false, "ignore_missing_property" = true, "ignore_null_property" = false, "schema_validation_enabled" = true, "id" = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.App/managedEnvironments/tonyai-staging-env/providers/Microsoft.Authorization/roleAssignments/14c8df66-a7fa-58fe-b690-a6b7f9f925fb", "output" = {} }
}
run "deployment_predecessor" { command = apply }
run "deployment_transition" {
  command = plan
  variables { config = merge(var.config, { apps_ready = true, release_sha = "dddddddddddddddddddddddddddddddddddddddd" }) }
  assert {
    condition     = length(azapi_resource.grant) == 11 && length(azapi_resource.deployer) == 1 && length(azapi_resource.federation) == 1 && length(azapi_resource.join_grant) == 1
    error_message = "Unit 8 adds only two existing-app deployment grants."
  }
}
