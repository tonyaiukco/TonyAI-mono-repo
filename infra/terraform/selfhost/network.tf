resource "azapi_resource" "group" {
  type                   = "Microsoft.Resources/resourceGroups@2024-03-01"
  name                   = local.stem
  parent_id              = "/subscriptions/${var.config.subscription_id}"
  location               = local.location
  tags                   = local.tags
  body                   = { properties = {} }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "network" {
  type      = "Microsoft.Network/virtualNetworks@2024-05-01"
  name      = "${local.stem}-vnet"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = { properties = {
    addressSpace = { addressPrefixes = ["10.${local.octet}.0.0/16"] }
    # VNet PUT must include both subnets; separate child writers can lose them.
    subnets = concat([
      { name = "supabase", properties = {
        addressPrefix         = local.host_net
        networkSecurityGroup  = { id = azapi_resource.firewall.id }
        defaultOutboundAccess = false
      } },
      { name = "container-apps", properties = {
        addressPrefix = local.apps_net
        delegations   = [{ name = "container-apps", properties = { serviceName = "Microsoft.App/environments" } }]
      } }
    ], var.replacement == null ? [] : [{ name = "supabase-r02", properties = { addressPrefix = "10.80.1.0/24", networkSecurityGroup = { id = local.r02_nsg_id }, defaultOutboundAccess = false } }])
  } }
  depends_on             = [azapi_resource.replacement_firewall]
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "firewall" {
  type      = "Microsoft.Network/networkSecurityGroups@2024-05-01"
  name      = "${local.stem}-nsg"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = { properties = { securityRules = var.containment ? local.containment_rules : concat([
    { name = "owner-ssh", properties = { priority = 100, direction = "Inbound", access = "Allow", protocol = "Tcp", sourcePortRange = "*", destinationPortRange = "22", sourceAddressPrefix = var.config.operator_ipv4, destinationAddressPrefix = local.host_ip } },
    { name = "apps-postgres", properties = { priority = 110, direction = "Inbound", access = "Allow", protocol = "Tcp", sourcePortRange = "*", destinationPortRange = "5432", sourceAddressPrefix = local.apps_net, destinationAddressPrefix = local.host_ip } }
    ], var.config.https_enabled ? [
    { name = "public-https", properties = { priority = 120, direction = "Inbound", access = "Allow", protocol = "Tcp", sourcePortRange = "*", destinationPortRange = "443", sourceAddressPrefix = "Internet", destinationAddressPrefix = local.host_ip } }
    ] : [], [
    { name = "deny-other-inbound", properties = { priority = 4000, direction = "Inbound", access = "Deny", protocol = "*", sourcePortRange = "*", destinationPortRange = "*", sourceAddressPrefix = "*", destinationAddressPrefix = "*" } }
  ]) } }
  response_export_values = []
}
resource "azapi_resource" "public_ip" {
  type      = "Microsoft.Network/publicIPAddresses@2024-05-01"
  name      = "${local.stem}-ip"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = {
    sku = { name = "Standard", tier = "Regional" }
    properties = {
      publicIPAllocationMethod = "Static"
      publicIPAddressVersion   = "IPv4"
      dnsSettings = {
        domainNameLabel = "tonyai-${var.config.environment}-${substr(var.config.subscription_id, 0, 8)}"
      }
    }
  }
  response_export_values = ["properties.ipAddress", "properties.dnsSettings.fqdn"]
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "nic" {
  type      = "Microsoft.Network/networkInterfaces@2024-05-01"
  name      = "${local.stem}-nic"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = { properties = {
    enableIPForwarding = false
    ipConfigurations = [{ name = "primary", properties = {
      primary                   = true
      privateIPAllocationMethod = "Static"
      privateIPAddress          = local.host_ip
      subnet                    = { id = "${azapi_resource.network.id}/subnets/supabase" }
      publicIPAddress           = { id = azapi_resource.scoped_public_ip.id }
    } }]
  } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}

# Retain the original IP above for rollback; DNS scope cannot be changed in place.
# Scoped Azure DNS is a QA-only bridge. Production requires an owned custom domain.
resource "azapi_resource" "scoped_public_ip" {
  type      = "Microsoft.Network/publicIPAddresses@2024-05-01"
  name      = "${local.stem}-edge-ip"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = {
    sku = { name = "Standard", tier = "Regional" }
    properties = {
      publicIPAllocationMethod = "Static"
      publicIPAddressVersion   = "IPv4"
      dnsSettings = {
        domainNameLabel      = "tonyai-${var.config.environment}-${substr(var.config.subscription_id, 0, 8)}-edge"
        domainNameLabelScope = "NoReuse"
      }
    }
  }
  response_export_values = ["properties.ipAddress", "properties.dnsSettings.fqdn"]
  lifecycle { prevent_destroy = true }
}
