resource "azapi_resource" "replacement_public_ip" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.Network/publicIPAddresses@2024-05-01"
  name                      = "${local.r02_stem}-edge-ip"
  parent_id                 = local.r02_group_id
  location                  = local.location
  tags                      = local.r02_tags
  body = {
    sku = { name = "Standard", tier = "Regional" }
    properties = {
      publicIPAllocationMethod = "Static"
      publicIPAddressVersion   = "IPv4"
      dnsSettings = {
        domainNameLabel      = "tonyai-${var.config.environment}-${substr(var.config.subscription_id, 0, 8)}-r02"
        domainNameLabelScope = "NoReuse"
      }
    }
  }
  response_export_values = ["properties.ipAddress", "properties.dnsSettings.fqdn"]
  lifecycle { prevent_destroy = true }
}

resource "azapi_resource" "replacement_nic" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.Network/networkInterfaces@2024-05-01"
  name                      = "${local.r02_stem}-nic"
  parent_id                 = local.r02_group_id
  location                  = local.location
  tags                      = local.r02_tags
  body = { properties = {
    enableIPForwarding = false
    ipConfigurations = [{ name = "primary", properties = {
      primary         = true, privateIPAllocationMethod = "Static", privateIPAddress = "10.80.1.4",
      subnet          = { id = "${local.r02_network_id}/subnets/supabase-r02" },
      publicIPAddress = { id = local.r02_ip_id }
    } }]
  } }
  depends_on             = [azapi_resource.network, azapi_resource.replacement_public_ip]
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
