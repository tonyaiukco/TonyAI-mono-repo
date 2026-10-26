# No resource overrides: preserve the computed references of a first create plan.
mock_provider "azapi" {}
variables {
  config = {
    subscription_id       = "cb7efc2f-37a7-4672-b62c-93c207bcd33d"
    tenant_id             = "00000000-0000-0000-0000-000000000002"
    owner_object_id       = "00000000-0000-0000-0000-000000000003"
    registry_name         = "tonyaiqatest"
    vault_name            = "tonyai-qa-test"
    release_sha           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    oidc_enabled          = false
    runtime_secrets_ready = false
    smtp_secret_ready     = false
    apps_ready            = false
  }
}
run "initial_computed_references" {
  command = plan
  assert {
    condition     = length(azapi_resource.join_grant) == 0 && length(azapi_resource.deployer) == 0 && length(azapi_resource.federation) == 0 && length(azapi_resource.grant) == 3
    error_message = "Initial foundation has only two pull grants and the owner vault grant."
  }
}
