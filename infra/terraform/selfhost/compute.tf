resource "azapi_resource" "disk" {
  for_each  = { database = 64, objects = 32 }
  type      = "Microsoft.Compute/disks@2024-03-02"
  name      = "${local.stem}-${each.key}"
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  body = {
    sku = { name = "StandardSSD_LRS" }
    properties = {
      creationData        = { createOption = "Empty" }
      diskSizeGB          = each.value
      encryption          = { type = "EncryptionAtRestWithPlatformKey" }
      networkAccessPolicy = "DenyAll"
      publicNetworkAccess = "Disabled"
    }
  }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "host" {
  type      = "Microsoft.Compute/virtualMachines@2024-11-01"
  name      = local.stem
  parent_id = azapi_resource.group.id
  location  = local.location
  tags      = local.tags
  identity { type = "SystemAssigned" }
  body = { properties = {
    hardwareProfile    = { vmSize = var.config.vm_size }
    diagnosticsProfile = { bootDiagnostics = { enabled = true } }
    securityProfile    = { securityType = "TrustedLaunch", uefiSettings = { secureBootEnabled = true, vTpmEnabled = true }, encryptionAtHost = true }
    storageProfile = {
      diskControllerType = "NVMe"
      imageReference     = { publisher = "Canonical", offer = "ubuntu-24_04-lts", sku = "server", version = var.config.image_version }
      osDisk             = { name = "${local.stem}-os", createOption = "FromImage", caching = "ReadWrite", deleteOption = "Detach", managedDisk = { storageAccountType = "StandardSSD_LRS" } }
      dataDisks = [for index, name in ["database", "objects"] : {
        lun = index, name = azapi_resource.disk[name].name, createOption = "Attach", caching = "None", deleteOption = "Detach", managedDisk = { id = azapi_resource.disk[name].id }
      }]
    }
    osProfile = {
      computerName             = "supabase-${var.config.environment}"
      adminUsername            = "tonyaiops"
      allowExtensionOperations = false
      linuxConfiguration = {
        disablePasswordAuthentication = true
        provisionVMAgent              = true
        ssh                           = { publicKeys = [{ path = "/home/tonyaiops/.ssh/authorized_keys", keyData = var.config.ssh_public_key }] }
        patchSettings                 = { patchMode = "ImageDefault", assessmentMode = "ImageDefault" }
      }
    }
    networkProfile = { networkInterfaces = [{ id = azapi_resource.nic.id, properties = { primary = true, deleteOption = "Detach" } }] }
  } }
  response_export_values = ["identity.principalId"]
  lifecycle { prevent_destroy = true }
}
resource "azapi_update_resource" "os_disk_export" {
  type                   = "Microsoft.Compute/disks@2024-03-02"
  resource_id            = "${azapi_resource.group.id}/providers/Microsoft.Compute/disks/${local.stem}-os"
  body                   = { properties = { networkAccessPolicy = "DenyAll", publicNetworkAccess = "Disabled" } }
  depends_on             = [azapi_resource.host]
  response_export_values = []
}
