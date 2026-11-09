# LP2-04 design D4: Application Insights only as the home of two standard availability tests.
# Owner-approved exception (2026-11-09) to "no Application Insights": no SDK, no app telemetry.
locals {
  availability_locations = ["emea-nl-ams-azr", "emea-gb-db3-azr", "emea-fr-pra-edge"] # West Europe, North Europe, France Central
  # Public hosts only once they serve SNI: before that ACA presents its default certificate.
  monitored = try(var.config.public_hosts.certificates && var.config.public_hosts.monitored, false) ? local.public_hosts : {}
  availability_targets = { for kind, path in { api = "/api/v1/health/ready", web = "/login" } : kind => (
    contains(keys(local.monitored), kind)
    ? "https://${local.monitored[kind]}${path}"
    : "https://${local.stem}-${kind}.${azapi_resource.environment.output.properties.defaultDomain}${path}"
  ) }
  availability = length(local.monitoring) == 0 || !var.config.availability_tests ? {} : local.availability_targets
}
resource "azapi_resource" "insights" {
  for_each  = length(local.availability) == 0 ? {} : local.monitoring
  type      = "Microsoft.Insights/components@2020-02-02"
  name      = "${local.stem}-availability"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = {
    kind = "web"
    properties = {
      Application_Type    = "web"
      WorkspaceResourceId = azapi_resource.logs.id
      IngestionMode       = "LogAnalytics"
      DisableLocalAuth    = true
    }
  }
  response_export_values = []
  ignore_casing          = true # ARM echoes resource IDs in its own casing.
}
resource "azapi_resource" "availability_test" {
  for_each  = local.availability
  type      = "Microsoft.Insights/webtests@2022-06-15"
  name      = "${local.stem}-${each.key}-availability"
  parent_id = azapi_resource.group.id
  location  = local.location
  # Azure requires the hidden-link tag to attach a test to its component.
  tags = merge(local.tags, { "hidden-link:${azapi_resource.insights["enabled"].id}" = "Resource" })
  body = {
    kind = "standard"
    properties = {
      SyntheticMonitorId = "${local.stem}-${each.key}-availability"
      Name               = "${local.stem}-${each.key}-availability"
      Kind               = "standard"
      Enabled            = true
      Frequency          = 900
      Timeout            = 30
      RetryEnabled       = true
      Locations          = [for id in local.availability_locations : { Id = id }]
      Request            = { RequestUrl = each.value, HttpVerb = "GET", ParseDependentRequests = false }
      ValidationRules    = { ExpectedHttpStatusCode = 200, SSLCheck = true, SSLCertRemainingLifetimeCheck = 7 }
    }
  }
  response_export_values = []
  ignore_casing          = true # ARM echoes resource IDs in its own casing.
}
resource "azapi_resource" "availability_alert" {
  for_each  = local.availability
  type      = "Microsoft.Insights/metricAlerts@2018-03-01"
  name      = "${local.stem}-${each.key}-availability"
  parent_id = azapi_resource.group.id
  location  = "global"
  tags      = local.tags
  body = { properties = {
    description         = "The ${each.key} availability test fails from all three locations. Follow runbook 06."
    enabled             = true
    severity            = 1
    evaluationFrequency = "PT5M"
    windowSize          = "PT15M"
    autoMitigate        = true
    scopes              = [azapi_resource.availability_test[each.key].id, azapi_resource.insights["enabled"].id]
    criteria = {
      "odata.type"        = "Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria"
      webTestId           = azapi_resource.availability_test[each.key].id
      componentId         = azapi_resource.insights["enabled"].id
      failedLocationCount = 3
    }
    actions = [{ actionGroupId = azapi_resource.operator["enabled"].id }]
  } }
  response_export_values = []
  ignore_casing          = true # ARM echoes resource IDs in its own casing.
}
