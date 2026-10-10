resource "azapi_resource" "app" {
  for_each = {
    api = { port = 3001, cpu = 1, memory = "2Gi", path = "/api/v1/health", digest = var.release.api_digest }
    web = { port = 3000, cpu = 0.5, memory = "1Gi", path = "/login", digest = var.release.web_digest }
  }
  type      = "Microsoft.App/containerApps@2025-01-01"
  name      = "${local.stem}-${each.key}"
  parent_id = local.group_id
  location  = "germanywestcentral"
  tags      = { application = "TonyAI", environment = var.foundation.environment, task = "LP2-01", release = var.release.release_id, source = var.release.source_sha }
  identity {
    type         = "UserAssigned"
    identity_ids = [local.identity_ids[each.key]]
  }
  body = { properties = {
    environmentId       = local.environment_id
    workloadProfileName = "Consumption"
    configuration = {
      activeRevisionsMode = "Single"
      ingress             = { external = true, allowInsecure = false, targetPort = each.value.port, transport = "auto" }
      registries          = [{ server = local.registry, identity = local.identity_ids[each.key] }]
      secrets = each.key == "api" ? [for name, version in local.secret_versions : {
        name = name, keyVaultUrl = "https://${var.foundation.vault_name}.vault.azure.net/secrets/${name}/${version}", identity = local.identity_ids["api"]
      }] : []
    }
    template = {
      # Secret-version changes always create a revision through a new release_id.
      terminationGracePeriodSeconds = each.key == "api" ? ceil(local.runtime_limits.SHUTDOWN_GRACE_MS / 1000) : 30
      revisionSuffix                = var.release.release_id
      containers = [{
        name      = each.key
        image     = "${local.registry}/tonyai/${each.key}@${each.value.digest}"
        env       = each.key == "api" ? local.api_env : local.web_env
        resources = { cpu = each.value.cpu, memory = each.value.memory }
        probes = [for kind in ["Startup", "Liveness", "Readiness"] : {
          type             = kind
          httpGet          = { path = each.key == "api" && kind == "Readiness" ? "/api/v1/health/ready" : each.value.path, port = each.value.port, scheme = "HTTP" }
          periodSeconds    = kind == "Startup" ? 5 : 10
          timeoutSeconds   = 5
          failureThreshold = kind == "Startup" ? 60 : 3
        }]
      }]
      scale = {
        minReplicas = each.key == "api" ? 1 : 0
        maxReplicas = each.key == "api" ? 1 : 2
        rules       = each.key == "api" ? [] : [{ name = "http", http = { metadata = { concurrentRequests = "10" } } }]
      }
    }
  } }
  response_export_values = ["properties.configuration.ingress.fqdn", "properties.latestReadyRevisionName"]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = local.runtime_limits.UPLOAD_USER_CONCURRENCY <= local.runtime_limits.UPLOAD_CONCURRENCY && local.runtime_limits.SHUTDOWN_GRACE_MS >= max(local.runtime_limits.BULK_DEADLINE_MS, local.runtime_limits.PDF_TIMEOUT_MS) + 50000 && local.runtime_limits.SHUTDOWN_GRACE_MS <= 3600000 && local.runtime_limits.HTTP_HEADERS_TIMEOUT_MS <= local.runtime_limits.HTTP_BODY_TIMEOUT_MS && local.runtime_limits.MUTATION_USER_CONCURRENCY <= local.runtime_limits.MUTATION_CONCURRENCY && local.runtime_limits.MUTATION_CONCURRENCY < local.runtime_limits.DB_CONNECTION_LIMIT && local.runtime_limits.IMPORT_CONCURRENCY + local.runtime_limits.REPORT_CONCURRENCY < local.runtime_limits.DB_CONNECTION_LIMIT
      error_message = "Incompatible runtime budgets."
    }
  }
}
