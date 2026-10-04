mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = {
      output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }
    }
  }
}
variables {
  config = {
    subscription_id       = "00000000-0000-0000-0000-000000000001"
    tenant_id             = "00000000-0000-0000-0000-000000000002"
    environment           = "staging"
    resource_group        = "tonyai-staging"
    prefix                = "tonyai"
    registry_name         = "tonyaistaging"
    vault_name            = "tonyai-staging-kv"
    repository            = "owner/repo"
    release_sha           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    owner_object_id       = "00000000-0000-0000-0000-000000000003"
    deployer_object_id    = "00000000-0000-0000-0000-000000000005"
    runtime_secrets_ready = true
    apps_ready            = true
  }
}
run "foundation_security_contract" {
  command = plan
  assert {
    condition     = azapi_resource.registry.body.properties.adminUserEnabled == false && azapi_resource.registry.body.sku.name == "Basic"
    error_message = "ACR must use Basic with no admin keys."
  }
  assert {
    condition     = azapi_resource.environment.body.properties.appLogsConfiguration.destination == "azure-monitor" && !can(azapi_resource.environment.body.properties.appLogsConfiguration.logAnalyticsConfiguration) && azapi_resource.diagnostics.body.properties.workspaceId == azapi_resource.logs.id
    error_message = "Logging must route by resource ID without any workspace keys."
  }
  assert {
    condition     = azapi_resource.vault.body.properties.enableRbacAuthorization && azapi_resource.vault.body.properties.enablePurgeProtection && azapi_resource.vault.body.properties.softDeleteRetentionInDays == 90
    error_message = "Vault RBAC and recovery controls are required."
  }
  assert {
    condition     = alltrue([for key, grant in azapi_resource.grant : !startswith(key, "app-") || can(regex("/Microsoft.App/containerApps/tonyai-staging-(api|web)$", grant.parent_id))]) && !contains(keys(azapi_resource.grant), "secret-direct-url")
    error_message = "App deployer scopes must stay on the two apps; direct-url must have no runtime grant; the owner credential never reaches workloads."
  }
  assert {
    condition = toset([for name, grant in azapi_resource.grant : "${name}|${grant.body.properties.principalId}|${grant.parent_id}|${grant.body.properties.roleDefinitionId}"]) == toset([
      "pull-api|00000000-0000-0000-0000-000000000004|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ContainerRegistry/registries/tonyaistaging|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d",
      "pull-web|00000000-0000-0000-0000-000000000006|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ContainerRegistry/registries/tonyaistaging|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d",
      "owner_secrets|00000000-0000-0000-0000-000000000003|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.KeyVault/vaults/tonyai-staging-kv|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7",
      "registry_push|00000000-0000-0000-0000-000000000005|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ContainerRegistry/registries/tonyaistaging|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/8311e382-0749-4cb8-b61a-304f252e45ec",
      "environment_read|00000000-0000-0000-0000-000000000005|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/managedEnvironments/tonyai-staging-env|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7",
      "secret-database-url|00000000-0000-0000-0000-000000000004|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.KeyVault/vaults/tonyai-staging-kv/secrets/database-url|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
      "secret-supabase-service-role-key|00000000-0000-0000-0000-000000000004|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.KeyVault/vaults/tonyai-staging-kv/secrets/supabase-service-role-key|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6",
      "identity-api|00000000-0000-0000-0000-000000000005|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/f1a07417-d97a-45cb-824c-7a7467783830",
      "app-api|00000000-0000-0000-0000-000000000005|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/containerApps/tonyai-staging-api|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/358470bc-b998-42bd-ab17-a7e34c199c0f",
      "identity-web|00000000-0000-0000-0000-000000000005|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-web|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/f1a07417-d97a-45cb-824c-7a7467783830",
      "app-web|00000000-0000-0000-0000-000000000005|/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/containerApps/tonyai-staging-web|/subscriptions/00000000-0000-0000-0000-000000000001/providers/Microsoft.Authorization/roleDefinitions/358470bc-b998-42bd-ab17-a7e34c199c0f",
    ])
    error_message = "The complete grant set must preserve separate identities, API-only named secrets and exact deployer scopes."
  }
  assert {
    condition = alltrue([for grant in azapi_resource.grant : grant.body.properties.principalId == var.config.owner_object_id || !contains([
      "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "b24988ac-6180-42a0-ab88-20f7382dd24c",
      "18d7d88d-d35e-4fb1-a5c3-7773c20a72d9", "00482a5a-887f-4fb3-b363-3b7fe8e74483",
      "b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
    ], basename(grant.body.properties.roleDefinitionId))])
    error_message = "Non-owner principals must never receive Owner, Contributor, UAA, Vault Administrator or Secrets Officer."
  }
  assert {
    condition     = length(azapi_resource.join_grant) == 1 && azapi_resource.join_grant[0].parent_id == azapi_resource.environment.id && azapi_resource.join_grant[0].body.properties.principalId == "00000000-0000-0000-0000-000000000005" && azapi_resource.join_grant[0].body.properties.roleDefinitionId == azapi_resource.join_role.id && jsonencode(azapi_resource.join_role.body.properties.permissions) == jsonencode([{ actions = ["Microsoft.App/managedEnvironments/join/action"], notActions = [], dataActions = [], notDataActions = [] }])
    error_message = "The additional custom grant permits only environment join for the deployer."
  }
}

override_resource {
  override_during = plan
  target          = azapi_resource.group
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.registry
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ContainerRegistry/registries/tonyaistaging" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.logs
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.OperationalInsights/workspaces/tonyai-staging-logs" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.environment
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/managedEnvironments/tonyai-staging-env" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.vault
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.KeyVault/vaults/tonyai-staging-kv" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.identity["api"]
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.identity["web"]
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000006", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-web" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.join_role
  values          = { output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.germanywestcentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io" } }, id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.Authorization/roleDefinitions/00000000-0000-0000-0000-000000000099" }
}

run "scheduled_verification_operator_contract" {
  command = plan
  variables {
    config = {
      subscription_id       = "00000000-0000-0000-0000-000000000001"
      tenant_id             = "00000000-0000-0000-0000-000000000002"
      environment           = "staging"
      resource_group        = "tonyai-staging"
      prefix                = "tonyai"
      registry_name         = "tonyaistaging"
      vault_name            = "tonyai-staging-kv"
      repository            = "owner/repo"
      release_sha           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      owner_object_id       = "00000000-0000-0000-0000-000000000003"
      deployer_object_id    = "00000000-0000-0000-0000-000000000005"
      runtime_secrets_ready = true
      apps_ready            = true
      monitoring = {
        operator_name           = "Test Operator", operator_email = "operator@example.invalid"
        api_digest              = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        supabase_project_ref    = "abcdefghijklmnopqrst"
        database_secret_version = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        backend_secret_version  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    }
  }
  assert {
    condition     = azapi_resource.storage_verify["enabled"].body.properties.configuration.scheduleTriggerConfig.cronExpression == "0 2 * * *" && azapi_resource.storage_verify["enabled"].body.properties.configuration.replicaRetryLimit == 0 && azapi_resource.storage_verify["enabled"].body.properties.template.containers[0].command[1] == "dist/health-storage-verify.cli.js"
    error_message = "Daily read-only verification must use the bounded private-output wrapper."
  }
  assert {
    condition     = azapi_resource.operator["enabled"].body.properties.emailReceivers[0].emailAddress == "operator@example.invalid" && azapi_resource.storage_verify_alert["enabled"].body.properties.enabled && strcontains(azapi_resource.storage_verify_alert["enabled"].body.properties.criteria.allOf[0].query, "completed == 0 or failures > 0")
    error_message = "Verification failures and missing results must alert the named operator."
  }
  assert {
    condition     = toset([for secret in azapi_resource.storage_verify["enabled"].body.properties.configuration.secrets : secret.name]) == toset(["database-url", "supabase-service-role-key"]) && !contains([for item in azapi_resource.storage_verify["enabled"].body.properties.template.containers[0].env : item.name], "DIRECT_URL") && { for item in azapi_resource.storage_verify["enabled"].body.properties.template.containers[0].env : item.name => try(item.secretRef, "") }["DATABASE_URL"] == "database-url"
    error_message = "Storage verification must receive only the runtime database credential, never the owner."
  }
  assert {
    condition     = alltrue([for secret in azapi_resource.storage_verify["enabled"].body.properties.configuration.secrets : !can(secret.value) && strcontains(secret.keyVaultUrl, "/secrets/")])
    error_message = "Job secrets must be exact Key Vault references, never values."
  }
}
