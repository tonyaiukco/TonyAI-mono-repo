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
    source_sha              = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    release_id              = "r001"
    supabase_project_ref    = "abcdefghijklmnopqrst"
    api_digest              = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    web_digest              = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    database_secret_version = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    backend_secret_version  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
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
    condition     = alltrue([for app in azapi_resource.app : app.body.properties.template.scale.minReplicas == 0 && app.body.properties.template.scale.maxReplicas == 2 && length(app.body.properties.template.containers[0].probes) == 3])
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
    condition     = alltrue([for item in azapi_resource.app["api"].body.properties.template.containers[0].env : !contains(["ALLOW_INSECURE_LOCAL_AUTH", "SUPABASE_JWT_SECRET"], item.name)]) && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.secretRef, "") }["DIRECT_URL"] == "database-url"
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
      source_sha              = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      release_id              = "r001"
      supabase_project_ref    = "abcdefghijklmnopqrst"
      api_digest              = "latest"
      web_digest              = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      database_secret_version = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }
  expect_failures = [var.release]
}
