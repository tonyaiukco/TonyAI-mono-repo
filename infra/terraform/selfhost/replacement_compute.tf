resource "azapi_resource" "replacement_disk" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = var.replacement == null ? {} : { database = 64, objects = 32 }
  type                      = "Microsoft.Compute/disks@2024-03-02"
  name                      = "${local.r02_stem}-${each.key}"
  parent_id                 = local.r02_group_id
  location                  = local.location
  tags                      = local.r02_tags
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
resource "azapi_resource" "replacement_host" {
  schema_validation_enabled = true
  ignore_missing_property   = true
  ignore_casing             = false
  ignore_null_property      = false
  for_each                  = local.r02
  type                      = "Microsoft.Compute/virtualMachines@2024-11-01"
  name                      = local.r02_stem
  parent_id                 = local.r02_group_id
  location                  = local.location
  tags                      = local.r02_tags
  identity { type = "SystemAssigned" }
  body = { properties = {
    hardwareProfile    = { vmSize = var.config.vm_size }
    diagnosticsProfile = { bootDiagnostics = { enabled = true } }
    securityProfile    = { securityType = "TrustedLaunch", uefiSettings = { secureBootEnabled = true, vTpmEnabled = true }, encryptionAtHost = true }
    storageProfile = {
      diskControllerType = "NVMe"
      imageReference     = { publisher = "Canonical", offer = "ubuntu-24_04-lts", sku = "server", version = var.config.image_version }
      osDisk             = { name = "${local.r02_stem}-os", diskSizeGB = 32, createOption = "FromImage", caching = "ReadWrite", deleteOption = "Detach", managedDisk = { storageAccountType = "StandardSSD_LRS" } }
      dataDisks = [for index, name in ["database", "objects"] : {
        lun = index, name = "${local.r02_stem}-${name}", createOption = "Attach", caching = "None", deleteOption = "Detach", managedDisk = { id = "${local.r02_group_id}/providers/Microsoft.Compute/disks/${local.r02_stem}-${name}" }
      }]
    }
    osProfile = {
      computerName             = "supabase-staging-r02"
      adminUsername            = "tonyaiops"
      allowExtensionOperations = false
      linuxConfiguration = {
        disablePasswordAuthentication = true
        provisionVMAgent              = true
        ssh                           = { publicKeys = [{ path = "/home/tonyaiops/.ssh/authorized_keys", keyData = each.value.ssh_public_key }] }
        patchSettings                 = { patchMode = "ImageDefault", assessmentMode = "ImageDefault" }
      }
    }
    networkProfile = { networkInterfaces = [{ id = local.r02_nic_id, properties = { primary = true, deleteOption = "Detach" } }] }
  } }
  depends_on             = [azapi_resource.replacement_disk, azapi_resource.replacement_nic]
  response_export_values = ["identity.principalId"]
  lifecycle { prevent_destroy = true }
}
resource "azapi_update_resource" "replacement_os_disk_export" {
  ignore_casing           = false
  ignore_missing_property = true
  for_each                = local.r02
  type                    = "Microsoft.Compute/disks@2024-03-02"
  resource_id             = "${local.r02_group_id}/providers/Microsoft.Compute/disks/${local.r02_stem}-os"
  body                    = { properties = { networkAccessPolicy = "DenyAll", publicNetworkAccess = "Disabled" } }
  depends_on              = [azapi_resource.replacement_host]
  response_export_values  = []
}
