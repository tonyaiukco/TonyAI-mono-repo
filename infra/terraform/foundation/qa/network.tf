# The selfhost root remains the sole writer of the VNet, subnets, NSG and r02.
resource "azapi_resource" "dns" {
  type                   = "Microsoft.Network/privateDnsZones@2024-06-01"
  name                   = "qa.tonyai.internal"
  parent_id              = azapi_resource.group.id
  location               = "global"
  body                   = { properties = {} }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "dns_link" {
  type                   = "Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01"
  name                   = "qa-data"
  parent_id              = azapi_resource.dns.id
  location               = "global"
  body                   = { properties = { registrationEnabled = false, virtualNetwork = { id = local.data_vnet_id } } }
  response_export_values = []
}
resource "azapi_resource" "db_address" {
  type                   = "Microsoft.Network/privateDnsZones/A@2024-06-01"
  name                   = "db"
  parent_id              = azapi_resource.dns.id
  body                   = { properties = { ttl = 300, aRecords = [{ ipv4Address = "10.80.1.4" }] } }
  response_export_values = []
}
