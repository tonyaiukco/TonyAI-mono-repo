mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", clientId = "00000000-0000-0000-0000-000000000005", defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
  }
}
variables {
  config = {
    subscription_id       = "cb7efc2f-37a7-4672-b62c-93c207bcd33d", tenant_id = "00000000-0000-0000-0000-000000000002"
    owner_object_id       = "00000000-0000-0000-0000-000000000003"
    registry_name         = "tonyaiqatest", vault_name = "tonyai-qa-test", release_sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    runtime_secrets_ready = true, smtp_secret_ready = true, apps_ready = true, oidc_enabled = true
  }
}
override_resource {
  override_during = plan
  target          = azapi_resource.group
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.registry
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ContainerRegistry/registries/tonyaiqatest", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.logs
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.OperationalInsights/workspaces/tonyai-staging-logs", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.environment
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.App/managedEnvironments/tonyai-staging-env", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.vault
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.KeyVault/vaults/tonyai-qa-test", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.dns
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.Network/privateDnsZones/qa.tonyai.internal", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.join_role
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000099", output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.identity["api"]
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api", output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", clientId = "00000000-0000-0000-0000-000000000004" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.identity["web"]
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-web", output = { properties = { principalId = "00000000-0000-0000-0000-000000000006", clientId = "00000000-0000-0000-0000-000000000006" } } }
}
override_resource {
  override_during = plan
  target          = azapi_resource.deployer["enabled"]
  values          = { id = "/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d/resourceGroups/tonyai-staging-apps/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-release", output = { properties = { principalId = "00000000-0000-0000-0000-000000000005", clientId = "00000000-0000-0000-0000-000000000005" } } }
}
run "qa_foundation_boundaries" {
  command = plan
  assert {
    condition     = azapi_resource.environment.location == "swedencentral" && azapi_resource.environment.body.properties.vnetConfiguration.infrastructureSubnetId == local.apps_subnet_id && azapi_resource.environment.body.properties.vnetConfiguration.internal == false && azapi_resource.environment.body.properties.workloadProfiles == [{ name = "Consumption", workloadProfileType = "Consumption" }]
    error_message = "The first environment PUT must bind the existing QA subnet and Consumption profile."
  }
  assert {
    condition     = azapi_resource.db_address.body.properties.aRecords[0].ipv4Address == "10.80.1.4" && azapi_resource.dns_link.body.properties.registrationEnabled == false && azapi_resource.dns_link.body.properties.virtualNetwork.id == local.data_vnet_id
    error_message = "Private DNS must target r02 and link only the existing data VNet."
  }
  assert {
    condition     = !azapi_resource.registry.body.properties.adminUserEnabled && azapi_resource.vault.body.properties.enablePurgeProtection && azapi_resource.vault.body.properties.enableRbacAuthorization && azapi_resource.environment.body.properties.appLogsConfiguration.destination == "azure-monitor"
    error_message = "Registry, vault and keyless diagnostics controls are required."
  }
  assert {
    condition     = toset(keys(local.grants)) == toset(["pull-api", "pull-web", "owner_secrets", "secret-database-url", "secret-supabase-service-role-key", "secret-smtp-password", "registry_push", "identity-api", "identity-web", "environment_read", "app-api", "app-web"]) && alltrue([for name, grant in local.grants : !startswith(name, "secret-") || (grant.principal == "00000000-0000-0000-0000-000000000004" && grant.role == local.roles.secrets_user && startswith(grant.scope, "${azapi_resource.vault.id}/secrets/"))])
    error_message = "Only API named runtime secrets may be granted; no migration or recovery access."
  }
  assert {
    condition     = alltrue([for name, grant in local.grants : !startswith(name, "app-") || (grant.role == local.roles.app_contributor && contains(["${local.group_id}/providers/Microsoft.App/containerApps/tonyai-staging-api", "${local.group_id}/providers/Microsoft.App/containerApps/tonyai-staging-web"], grant.scope))]) && local.grants["registry_push"].scope == azapi_resource.registry.id && local.grants["pull-web"].principal == "00000000-0000-0000-0000-000000000006"
    error_message = "Deployment is scoped to the two apps and one ACR; workload identities differ."
  }
  assert {
    condition     = azapi_resource.federation["enabled"].body.properties.subject == "repo:tonyaiukco/TonyAI-mono-repo:environment:staging" && azapi_resource.federation["enabled"].body.properties.issuer == "https://token.actions.githubusercontent.com" && azapi_resource.federation["enabled"].body.properties.audiences == ["api://AzureADTokenExchange"] && azapi_resource.join_grant[0].parent_id == azapi_resource.environment.id
    error_message = "OIDC and join grants must have exact reviewed scope."
  }
}
run "no_federation_or_runtime_grants_by_default" {
  command = plan
  variables { config = merge(var.config, { oidc_enabled = false, apps_ready = false, runtime_secrets_ready = false, smtp_secret_ready = false }) }
  assert {
    condition     = length(azapi_resource.federation) == 0 && length(azapi_resource.deployer) == 0 && toset(keys(local.grants)) == toset(["pull-api", "pull-web", "owner_secrets"])
    error_message = "The first foundation stage must not enable deployment or secret access."
  }
}
run "reject_production" {
  command = plan
  variables { config = merge(var.config, { environment = "production" }) }
  expect_failures = [var.config]
}
run "reject_foreign_subscription" {
  command = plan
  variables { config = merge(var.config, { subscription_id = "00000000-0000-0000-0000-000000000001" }) }
  expect_failures = [var.config]
}
