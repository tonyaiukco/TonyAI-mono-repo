# Optional same-state generation. Existing addresses and outputs remain intact.
variable "containment" {
  type        = bool
  default     = false
  description = "Separate owner-approved old-host containment; never implies shutdown."
}
variable "replacement" {
  type     = object({ generation = string, recovery_vault_name = string, ssh_public_key = string })
  default  = null
  nullable = true
  validation {
    condition     = var.replacement == null ? true : (var.replacement.generation == "r02" && var.containment && var.config.environment == "staging" && can(regex("^tonyai-qa-r02-[a-z0-9]{8}$", var.replacement.recovery_vault_name)) && can(regex("^ssh-rsa [A-Za-z0-9+/]+=*$", var.replacement.ssh_public_key)))
    error_message = "Only isolated staging r02 with old-host containment and a separate public key is supported."
  }
}
locals {
  r02            = var.replacement == null ? {} : { r02 = var.replacement }
  r02_stem       = "${local.stem}-r02"
  r02_group_id   = "/subscriptions/${var.config.subscription_id}/resourceGroups/${local.stem}"
  r02_network_id = "${local.r02_group_id}/providers/Microsoft.Network/virtualNetworks/${local.stem}-vnet"
  r02_nsg_id     = "${local.r02_group_id}/providers/Microsoft.Network/networkSecurityGroups/${local.r02_stem}-nsg"
  r02_ip_id      = "${local.r02_group_id}/providers/Microsoft.Network/publicIPAddresses/${local.r02_stem}-edge-ip"
  r02_nic_id     = "${local.r02_group_id}/providers/Microsoft.Network/networkInterfaces/${local.r02_stem}-nic"
  r02_tags       = merge(local.tags, { generation = "r02" })
  containment_rules = [
    { name = "owner-ssh", properties = { priority = 100, direction = "Inbound", access = "Allow", protocol = "Tcp", sourcePortRange = "*", destinationPortRange = "22", sourceAddressPrefix = var.config.operator_ipv4, destinationAddressPrefix = local.host_ip } },
    { name = "deny-other-inbound", properties = { priority = 4000, direction = "Inbound", access = "Deny", protocol = "*", sourcePortRange = "*", destinationPortRange = "*", sourceAddressPrefix = "*", destinationAddressPrefix = "*" } },
    { name = "deny-outbound", properties = { priority = 4000, direction = "Outbound", access = "Deny", protocol = "*", sourcePortRange = "*", destinationPortRange = "*", sourceAddressPrefix = "*", destinationAddressPrefix = "*" } }
  ]
}
resource "azapi_resource" "replacement_firewall" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.Network/networkSecurityGroups@2024-05-01"
  name                      = "${local.r02_stem}-nsg"
  parent_id                 = local.r02_group_id
  location                  = local.location
  tags                      = local.r02_tags
  body = { properties = { securityRules = [
    for rule in local.containment_rules : merge(rule, { properties = merge(rule.properties, rule.name == "owner-ssh" ? { destinationAddressPrefix = "10.80.1.4" } : {}) })
  ] } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
