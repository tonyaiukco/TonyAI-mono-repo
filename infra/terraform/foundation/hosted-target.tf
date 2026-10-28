locals {
  hosted_exception = try(jsondecode(file("${path.module}/../../config/hosted-qa-exception.json")), {})
  hosted_exception_valid = try(
    toset(keys(local.hosted_exception)) == toset(["subscription", "resource_group", "prefix", "backend_resource_group", "backend_storage_account"]) &&
    can(regex("^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$", local.hosted_exception.subscription)) &&
    local.hosted_exception.subscription != "00000000-0000-0000-0000-000000000000" &&
    local.hosted_exception.resource_group == "tonyai-qatmp-apps" &&
    local.hosted_exception.prefix == "tonyaiqt" &&
    local.hosted_exception.backend_resource_group == "tonyai-qatmp-tfstate" &&
    can(regex("^tonyaiqt[a-z0-9]{1,16}$", local.hosted_exception.backend_storage_account)), false
  )
}
