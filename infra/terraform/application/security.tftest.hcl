mock_provider "azapi" {}
variables {
  foundation = {
    subscription_id = "00000000-0000-0000-0000-000000000001"
    tenant_id       = "00000000-0000-0000-0000-000000000002"
    environment     = "staging"
    resource_group  = "tonyai-staging"
    prefix          = "tonyai"
    registry_name   = "tonyaistaging"
    vault_name      = "tonyai-staging-kv"
    default_domain  = "example.germanywestcentral.azurecontainerapps.io"
  }
  release = {
    source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    release_id                     = "r001"
    supabase_project_ref           = "abcdefghijklmnopqrst"
    api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    storage_cleanup_hold           = false
    storage_sweep_interval_seconds = 300
  }
}
run "application_security_contract" {
  command = plan
  assert {
    condition     = azapi_resource.app["api"].body.properties.configuration.ingress.allowInsecure == false && length(azapi_resource.app["web"].body.properties.configuration.secrets) == 0
    error_message = "HTTPS and secret-free web must remain enforced."
  }
  assert {
    condition     = alltrue([for s in azapi_resource.app["api"].body.properties.configuration.secrets : can(regex("/secrets/[a-z-]+/[a-f0-9]{32}$", s.keyVaultUrl)) && !can(s.value)])
    error_message = "Only exact Key Vault version references may enter state."
  }
  assert {
    condition     = endswith(azapi_resource.app["api"].body.properties.template.containers[0].image, var.release.api_digest) && azapi_resource.app["api"].body.properties.template.revisionSuffix == var.release.release_id
    error_message = "Release digest and revision must be immutable inputs."
  }
  assert {
    condition     = azapi_resource.app["api"].body.properties.template.scale.minReplicas == 1 && azapi_resource.app["api"].body.properties.template.scale.maxReplicas == 1 && azapi_resource.app["web"].body.properties.template.scale.maxReplicas == 2 && alltrue([for app in azapi_resource.app : length(app.body.properties.template.containers[0].probes) == 3])
    error_message = "Consumption scaling and process probes are required."
  }
}
run "runtime_auth_and_origin_pins" {
  command = plan
  assert {
    condition     = { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["SUPABASE_JWT_SCHEME"] == "jwks" && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["WEB_ORIGIN"] == "https://tonyai-staging-web.example.germanywestcentral.azurecontainerapps.io"
    error_message = "Cloud JWKS scheme and exact CORS origin must be pinned."
  }
  assert {
    condition     = alltrue([for item in azapi_resource.app["api"].body.properties.template.containers[0].env : !contains(["ALLOW_INSECURE_LOCAL_AUTH", "SUPABASE_JWT_SECRET"], item.name)]) && !contains([for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name], "DIRECT_URL") && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.secretRef, "") }["DATABASE_URL"] == "database-url"
    error_message = "No local auth bypass or migration credential may reach runtime."
  }
  assert {
    condition     = endswith(azapi_resource.app["web"].body.properties.template.containers[0].image, var.release.web_digest)
    error_message = "The selected web digest must be deployed exactly."
  }
}
run "mutable_image_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "latest"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
    }
  }
  expect_failures = [var.release]
}

run "readiness_and_storage_settings" {
  command = plan
  assert {
    condition     = { for probe in azapi_resource.app["api"].body.properties.template.containers[0].probes : probe.type => probe.httpGet.path } == { Startup = "/api/v1/health", Liveness = "/api/v1/health", Readiness = "/api/v1/health/ready" }
    error_message = "Only readiness may depend on DB and Storage."
  }
  assert {
    condition     = { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["STORAGE_CLEANUP_HOLD"] == "0" && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["STORAGE_SWEEP_INTERVAL_SECONDS"] == "300"
    error_message = "Storage settings must remain plain release inputs."
  }
}

run "runtime_override_boundary" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { RATE_READ_PER_MINUTE = 1 }
    }
  }
  assert {
    condition     = lookup({ for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }, "RATE_READ_PER_MINUTE", "missing") == "1"
    error_message = "Reviewed override must reach the runtime contract."
  }
}

run "zero_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { RATE_READ_PER_MINUTE = 0 }
    }
  }
  expect_failures = [var.release]
}

run "unknown_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { TYPO = 1 }
    }
  }
  expect_failures = [var.release]
}

run "incompatible_runtime_budgets_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { DB_CONNECTION_LIMIT = 2 }
    }
  }
  expect_failures = [azapi_resource.app]
}

run "runtime_resource_contract" {
  command = plan
  assert {
    condition     = alltrue([for k, v in local.runtime_limits : lookup({ for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }, k, "missing") == tostring(v)])
    error_message = "Every runtime budget must reach the API container."
  }
  assert {
    condition     = alltrue([for k, v in { NODE_OPTIONS = "--max-old-space-size=768", PROXY_MODE = "azure", AZURE_INGRESS_ONLY = "true" } : lookup({ for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }, k, "missing") == v])
    error_message = "Heap and ingress trust must reach the container."
  }
  assert {
    condition     = azapi_resource.app["api"].body.properties.template.containers[0].resources.cpu == 1 && azapi_resource.app["api"].body.properties.template.containers[0].resources.memory == "2Gi" && azapi_resource.app["api"].body.properties.configuration.activeRevisionsMode == "Single" && azapi_resource.app["api"].body.properties.template.terminationGracePeriodSeconds == 120
    error_message = "Resource, revision and grace bounds are part of the release."
  }
}
run "fractional_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { RATE_READ_PER_MINUTE = 1.5 }
    }
  }
  expect_failures = [var.release]
}

run "grace_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { SHUTDOWN_GRACE_MS = 109999 }
    }
  }
  expect_failures = [azapi_resource.app]
}

run "upload_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { UPLOAD_USER_CONCURRENCY = 3 }
    }
  }
  expect_failures = [azapi_resource.app]
}

run "headers_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { HTTP_HEADERS_TIMEOUT_MS = 30001 }
    }
  }
  expect_failures = [azapi_resource.app]
}

run "mutation_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { MUTATION_USER_CONCURRENCY = 3 }
    }
  }
  expect_failures = [azapi_resource.app]
}

run "import_runtime_limit_rejected" {
  command = plan
  variables {
    release = {
      source_sha                     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id                     = "r001"
      supabase_project_ref           = "abcdefghijklmnopqrst"
      api_digest                     = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      web_digest                     = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version         = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      storage_cleanup_hold           = false
      storage_sweep_interval_seconds = 300
      runtime_limits                 = { IMPORT_CONCURRENCY = 4 }
    }
  }
  expect_failures = [azapi_resource.app]
}
