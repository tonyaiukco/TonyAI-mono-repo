# LP2-04: free ACA managed certificates for the public hosts (design D2). The application root
# adds each host with binding Disabled first; ACA issues only for a host an app already carries.
locals {
  public_hosts = var.config.public_hosts == null ? {} : { api = var.config.public_hosts.api, web = var.config.public_hosts.web }
  certificates = try(var.config.public_hosts.certificates, false) ? local.public_hosts : {}
  parent       = jsondecode(file("${path.module}/../../config/public-hosts.json")).parent_domain
}
resource "azapi_resource" "certificate" {
  for_each  = local.certificates
  type      = "Microsoft.App/managedEnvironments/managedCertificates@2025-01-01"
  name      = "${local.stem}-${each.key}-cert"
  parent_id = azapi_resource.environment.id
  location  = local.location
  tags      = local.tags
  body = { properties = {
    subjectName             = each.value
    domainControlValidation = "CNAME"
  } }
  response_export_values = []
  ignore_casing          = true
}
output "dns_contract" {
  # Certificate state is read live with az (runbook 11): output never refreshes state.
  description = "Nonsecret records the owner enters at the DNS host. The asuid value is read with az (runbook 11)."
  value = {
    hosts = { for kind, host in local.public_hosts : kind => {
      cname = { host = trimsuffix(host, ".${local.parent}"), value = "${local.stem}-${kind}.${azapi_resource.environment.output.properties.defaultDomain}" }
      asuid = { host = "asuid.${trimsuffix(host, ".${local.parent}")}" }
    } }
    # ACS's raw records (Domain, SPF, DKIM, DKIM2); runbook 11 maps them to Namecheap and merges SPF.
    email = { for key, email in local.email : key => try(azapi_resource.email_custom_domain[key].output.properties.verificationRecords, null) }
  }
}
