# Owner-managed operations. The app-scoped deployer gains no job/alert permissions.
locals {
  monitoring = var.config.monitoring == null ? {} : { enabled = var.config.monitoring }
}
resource "azapi_resource" "storage_verify" {
  for_each  = local.monitoring
  type      = "Microsoft.App/jobs@2025-01-01"
  name      = "${local.stem}-storage-verify"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  identity {
    type         = "UserAssigned"
    identity_ids = [azapi_resource.identity["api"].id]
  }
  body = { properties = {
    environmentId       = azapi_resource.environment.id
    workloadProfileName = "Consumption"
    configuration = {
      triggerType           = "Schedule"
      replicaTimeout        = 960
      replicaRetryLimit     = 0
      scheduleTriggerConfig = { cronExpression = "0 2 * * *", parallelism = 1, replicaCompletionCount = 1 }
      registries            = [{ server = "${var.config.registry_name}.azurecr.io", identity = azapi_resource.identity["api"].id }]
      secrets = [for name, version in { database-url = each.value.database_secret_version, supabase-service-role-key = each.value.backend_secret_version } : {
        name = name, keyVaultUrl = "https://${var.config.vault_name}.vault.azure.net/secrets/${name}/${version}", identity = azapi_resource.identity["api"].id
      }]
    }
    template = { containers = [{
      name      = "verify", image = "${var.config.registry_name}.azurecr.io/tonyai/api@${each.value.api_digest}"
      command   = ["node", "dist/health-storage-verify.cli.js"]
      resources = { cpu = 0.5, memory = "1Gi" }
      env = [
        { name = "DATABASE_URL", secretRef = "database-url" },
        { name = "SUPABASE_SERVICE_ROLE_KEY", secretRef = "supabase-service-role-key" },
        { name = "SUPABASE_URL", value = "https://${each.value.supabase_project_ref}.supabase.co" },
        { name = "STORAGE_CLEANUP_HOLD", value = "1" },
        { name = "NODE_ENV", value = "production" }
      ]
    }] }
  } }
  response_export_values = []
}
resource "azapi_resource" "operator" {
  for_each  = local.monitoring
  type      = "Microsoft.Insights/actionGroups@2023-01-01"
  name      = "${local.stem}-operator"
  parent_id = azapi_resource.group.id
  location  = "global"
  body = { properties = {
    groupShortName = "TonyAIOps", enabled = true
    emailReceivers = [{ name = each.value.operator_name, emailAddress = each.value.operator_email, useCommonAlertSchema = true }]
  } }
  response_export_values = []
}
resource "azapi_resource" "storage_verify_alert" {
  for_each  = local.monitoring
  type      = "Microsoft.Insights/scheduledQueryRules@2023-12-01"
  name      = "${local.stem}-storage-verify"
  parent_id = azapi_resource.group.id
  location  = local.location
  body = { kind = "LogAlert", properties = {
    displayName  = "Storage verification needs ${each.value.operator_name}"
    description  = "Exit 1/2 or no completed verification in 26 hours. Follow runbook 06."
    enabled      = true, severity = 1, evaluationFrequency = "PT5M", windowSize = "P2D"
    scopes       = [azapi_resource.logs.id]
    autoMitigate = true
    criteria = { allOf = [{
      query           = <<-KQL
        ContainerAppConsoleLogs
        | where TimeGenerated > ago(26h)
        | where JobName startswith "${local.stem}-storage-verify"
        | extend result = parse_json(Log)
        | where tostring(result.event) == "storage_verify"
        | summarize completed=count(), failures=countif(toint(result.exitCode) != 0)
        | where completed == 0 or failures > 0
      KQL
      timeAggregation = "Count", operator = "GreaterThan", threshold = 0
      failingPeriods  = { numberOfEvaluationPeriods = 1, minFailingPeriodsToAlert = 1 }
    }] }
    actions = { actionGroups = [azapi_resource.operator[each.key].id] }
  } }
  response_export_values = []
}
