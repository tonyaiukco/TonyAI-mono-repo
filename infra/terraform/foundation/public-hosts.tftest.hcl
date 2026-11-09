# LP2-04: managed certificates, the custom sender and availability tests stay inert until set.
mock_provider "azapi" {
  mock_resource "azapi_resource" {
    defaults = {
      output = { properties = { principalId = "00000000-0000-0000-0000-000000000004", defaultDomain = "example.swedencentral.azurecontainerapps.io", loginServer = "tonyaistaging.azurecr.io", mailFromSenderDomain = "tonyai.io", verificationRecords = {}, provisioningState = "Succeeded" } }
    }
  }
}
# Plan-time values the checks read: the environment's domain and the workspace ID.
override_resource {
  target          = azapi_resource.environment
  override_during = plan
  values = {
    id     = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.App/managedEnvironments/tonyai-staging-env"
    output = { properties = { defaultDomain = "example.swedencentral.azurecontainerapps.io" } }
  }
}
override_resource {
  target          = azapi_resource.logs
  override_during = plan
  values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.OperationalInsights/workspaces/tonyai-staging-logs" }
}
override_resource {
  target          = azapi_resource.email_domain
  override_during = plan
  values          = { output = { properties = { mailFromSenderDomain = "managed.azurecomm.net" } } }
}
override_resource {
  target          = azapi_resource.email_custom_domain
  override_during = plan
  values = {
    id     = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.Communication/emailServices/tonyai-staging-email/domains/tonyai.io"
    output = { properties = { mailFromSenderDomain = "tonyai.io", verificationRecords = {} } }
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
    monitoring = {
      operator_name           = "Test Operator", operator_email = "operator@example.invalid"
      api_digest              = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      supabase_project_ref    = "abcdefghijklmnopqrst"
      database_secret_version = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      backend_secret_version  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
    email = {
      client_id     = "00000000-0000-0000-0000-000000000010"
      principal_id  = "00000000-0000-0000-0000-000000000011"
      tenant_id     = "00000000-0000-0000-0000-000000000002"
      custom_domain = "tonyai.io"
    }
  }
}
run "unset_hosts_create_no_certificate_and_test_generated_origins" {
  command = plan
  override_resource {
    target          = azapi_resource.operator["enabled"]
    override_during = plan
    values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.Insights/actionGroups/tonyai-staging-operator" }
  }
  override_resource {
    target          = azapi_resource.insights["enabled"]
    override_during = plan
    values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.Insights/components/tonyai-staging-availability" }
  }
  override_resource {
    target          = azapi_resource.availability_test
    override_during = plan
    values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging/providers/Microsoft.Insights/webtests/test" }
  }
  assert {
    condition     = length(azapi_resource.certificate) == 0 && length(output.dns_contract.hosts) == 0
    error_message = "No public hosts, no certificates or DNS rows."
  }
  assert {
    condition     = azapi_resource.availability_test["api"].body.properties.Request.RequestUrl == "https://tonyai-staging-api.example.swedencentral.azurecontainerapps.io/api/v1/health/ready" && azapi_resource.availability_test["web"].body.properties.Request.RequestUrl == "https://tonyai-staging-web.example.swedencentral.azurecontainerapps.io/login"
    error_message = "Until certificates exist the tests target the generated hosts."
  }
  assert {
    condition     = alltrue([for test in azapi_resource.availability_test : test.body.kind == "standard" && test.body.properties.Enabled && test.body.properties.Frequency == 900 && length(test.body.properties.Locations) == 3 && test.body.properties.ValidationRules.ExpectedHttpStatusCode == 200 && test.body.properties.ValidationRules.SSLCheck && test.body.properties.Request.HttpVerb == "GET"])
    error_message = "Basic standard tests: enabled, 15 minutes, 3 locations, 200 over checked TLS."
  }
  assert {
    condition     = azapi_resource.insights["enabled"].body.properties.WorkspaceResourceId == azapi_resource.logs.id && azapi_resource.insights["enabled"].body.properties.IngestionMode == "LogAnalytics" && azapi_resource.insights["enabled"].body.properties.DisableLocalAuth
    error_message = "Workspace-based component with local auth disabled; no separate ingestion."
  }
  assert {
    condition     = alltrue([for kind, alert in azapi_resource.availability_alert : alert.body.properties.enabled && alert.body.properties.criteria.failedLocationCount == 2 && alert.body.properties.actions[0].actionGroupId == azapi_resource.operator["enabled"].id && alert.body.properties.criteria.webTestId == azapi_resource.availability_test[kind].id])
    error_message = "Each test alerts the operator when two locations fail."
  }
  assert {
    condition     = length(azapi_resource.sender) == 0 && startswith(output.email_contract.enabled.sender, "DoNotReply@")
    error_message = "An unverified custom domain keeps ACS's managed sender."
  }
}
run "hosts_without_certificates_list_dns_only" {
  command = plan
  variables {
    config = merge(var.config, { public_hosts = { web = "qa.tonyai.io", api = "api.qa.tonyai.io" } })
  }
  assert {
    condition     = length(azapi_resource.certificate) == 0 && output.dns_contract.hosts.web.cname.host == "qa" && output.dns_contract.hosts.api.cname.host == "api.qa" && output.dns_contract.hosts.web.asuid.host == "asuid.qa" && output.dns_contract.hosts.api.cname.value == "tonyai-staging-api.example.swedencentral.azurecontainerapps.io"
    error_message = "DNS rows are relative to the parent domain and point straight at the app hosts."
  }
  assert {
    condition     = endswith(azapi_resource.availability_test["web"].body.properties.Request.RequestUrl, ".azurecontainerapps.io/login")
    error_message = "Tests move to public hosts only with their certificates."
  }
}
run "certificates_for_each_host_and_tests_follow" {
  command = plan
  variables {
    config = merge(var.config, { public_hosts = { web = "qa.tonyai.io", api = "api.qa.tonyai.io", certificates = true } })
  }
  assert {
    condition     = azapi_resource.certificate["web"].name == "tonyai-staging-web-cert" && azapi_resource.certificate["web"].body.properties.subjectName == "qa.tonyai.io" && azapi_resource.certificate["api"].body.properties.subjectName == "api.qa.tonyai.io" && alltrue([for cert in azapi_resource.certificate : cert.body.properties.domainControlValidation == "CNAME" && cert.parent_id == azapi_resource.environment.id])
    error_message = "One CNAME-validated certificate per host, named as the application root expects."
  }
  assert {
    condition     = azapi_resource.availability_test["api"].body.properties.Request.RequestUrl == "https://api.qa.tonyai.io/api/v1/health/ready" && azapi_resource.availability_test["web"].body.properties.Request.RequestUrl == "https://qa.tonyai.io/login"
    error_message = "With certificates the tests target the public hosts."
  }
}
run "verified_domain_uses_the_configured_sender" {
  command = plan
  variables {
    config = merge(var.config, { email = merge(var.config.email, { custom_domain_verified = true, sender_username = "no-reply" }) })
  }
  assert {
    condition     = azapi_resource.sender["enabled"].name == "no-reply" && azapi_resource.sender["enabled"].body.properties.username == "no-reply" && output.email_contract.enabled.sender == "no-reply@tonyai.io"
    error_message = "A verified domain gets the configured sender username."
  }
}
run "host_outside_parent_domain_rejected" {
  command = plan
  variables {
    config = merge(var.config, { public_hosts = { web = "qa.example.com", api = "api.qa.tonyai.io" } })
  }
  expect_failures = [var.config]
}
run "malformed_sender_rejected" {
  command = plan
  variables {
    config = merge(var.config, { email = merge(var.config.email, { sender_username = "no reply@" }) })
  }
  expect_failures = [var.config]
}
run "no_availability_without_monitoring" {
  command = plan
  variables {
    config = merge(var.config, { monitoring = null })
  }
  assert {
    condition     = length(azapi_resource.insights) == 0 && length(azapi_resource.availability_test) == 0 && length(azapi_resource.availability_alert) == 0
    error_message = "Availability needs the named operator."
  }
}
