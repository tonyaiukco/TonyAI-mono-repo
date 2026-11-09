# LP2-04: public hosts bind in stages and change nothing while unset.
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
    default_domain  = "example.swedencentral.azurecontainerapps.io"
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
    mail = {
      host = "smtp.azurecomm.net", port = 587, secure = false, user = "tonyai-staging-smtp",
      from = "no-reply@tonyai.io", password_secret_version = "cccccccccccccccccccccccccccccccc"
    }
  }
}
run "unset_hosts_change_nothing" {
  command = plan
  assert {
    condition     = alltrue([for app in azapi_resource.app : !contains(keys(app.body.properties.configuration.ingress), "customDomains")])
    error_message = "Without public hosts the ingress body must not gain customDomains."
  }
  assert {
    condition     = { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["WEB_ORIGIN"] == "https://tonyai-staging-web.example.swedencentral.azurecontainerapps.io" && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["APP_URL"] == "https://tonyai-staging-web.example.swedencentral.azurecontainerapps.io"
    error_message = "Unset hosts keep the generated origin."
  }
}
run "unbound_hosts_are_added_disabled" {
  command = plan
  variables {
    foundation = merge(var.foundation, { public_hosts = { web = "qa.tonyai.io", api = "api.qa.tonyai.io", bound = false } })
  }
  assert {
    condition     = azapi_resource.app["web"].body.properties.configuration.ingress.customDomains == [{ name = "qa.tonyai.io", bindingType = "Disabled" }] && azapi_resource.app["api"].body.properties.configuration.ingress.customDomains == [{ name = "api.qa.tonyai.io", bindingType = "Disabled" }]
    error_message = "Unbound hosts are added with binding Disabled and no certificate."
  }
  assert {
    condition     = { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["WEB_ORIGIN"] == "https://tonyai-staging-web.example.swedencentral.azurecontainerapps.io" && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["APP_URL"] == "https://tonyai-staging-web.example.swedencentral.azurecontainerapps.io"
    error_message = "Origins stay generated until the binding is live."
  }
}
run "bound_hosts_use_sni_and_custom_origins" {
  command = plan
  variables {
    foundation = merge(var.foundation, { public_hosts = { web = "qa.tonyai.io", api = "api.qa.tonyai.io", bound = true } })
  }
  assert {
    condition     = azapi_resource.app["web"].body.properties.configuration.ingress.customDomains == [{ name = "qa.tonyai.io", bindingType = "SniEnabled", certificateId = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/managedEnvironments/tonyai-staging-env/managedCertificates/tonyai-staging-web-cert" }]
    error_message = "Bound web host uses SNI with the foundation's deterministic certificate."
  }
  assert {
    condition     = azapi_resource.app["api"].body.properties.configuration.ingress.customDomains[0].certificateId == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/managedEnvironments/tonyai-staging-env/managedCertificates/tonyai-staging-api-cert"
    error_message = "Bound API host uses its own certificate."
  }
  assert {
    condition     = { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["WEB_ORIGIN"] == "https://qa.tonyai.io,https://tonyai-staging-web.example.swedencentral.azurecontainerapps.io" && { for item in azapi_resource.app["api"].body.properties.template.containers[0].env : item.name => try(item.value, "") }["APP_URL"] == "https://qa.tonyai.io"
    error_message = "Mail links use the public host; CORS keeps the generated origin second."
  }
  assert {
    condition     = azapi_resource.app["api"].body.properties.configuration.ingress.allowInsecure == false && azapi_resource.app["web"].body.properties.configuration.ingress.external == true
    error_message = "Binding must not weaken ingress."
  }
}
run "host_outside_parent_domain_rejected" {
  command = plan
  variables {
    foundation = merge(var.foundation, { public_hosts = { web = "qa.tonyai.io.evil.com", api = "api.qa.tonyai.io", bound = true } })
  }
  expect_failures = [var.foundation]
}
run "parent_domain_itself_rejected" {
  command = plan
  variables {
    foundation = merge(var.foundation, { public_hosts = { web = "tonyai.io", api = "api.qa.tonyai.io", bound = false } })
  }
  expect_failures = [var.foundation]
}
run "same_host_twice_rejected" {
  command = plan
  variables {
    foundation = merge(var.foundation, { public_hosts = { web = "qa.tonyai.io", api = "qa.tonyai.io", bound = false } })
  }
  expect_failures = [var.foundation]
}
