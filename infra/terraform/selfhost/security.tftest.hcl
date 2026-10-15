mock_provider "azapi" {
  override_during = plan
  mock_resource "azapi_resource" {
    defaults = {
      id     = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock"
      output = { properties = { ipAddress = "192.0.2.1", dnsSettings = { fqdn = "tonyai-staging-00000000.swedencentral.cloudapp.azure.com" } }, identity = { principalId = "00000000-0000-0000-0000-000000000004" } }
    }
  }
}
variables {
  config = {
    subscription_id          = "00000000-0000-0000-0000-000000000001"
    tenant_id                = "00000000-0000-0000-0000-000000000002"
    environment              = "staging"
    operator_ipv4            = "8.8.8.8/32"
    ssh_public_key           = "ssh-rsa c3ludGhldGlj"
    image_version            = "24.04.202601010"
    vm_size                  = "Standard_D2as_v7"
    recovery_owner_object_id = "00000000-0000-0000-0000-000000000003"
    https_enabled            = false
  }
}
run "private_host_foundation" {
  command = plan
  assert {
    condition     = azapi_resource.scoped_public_ip.body.properties.dnsSettings.domainNameLabelScope == "NoReuse" && length(azapi_resource.delete_lock) == 3 && alltrue([for lock in azapi_resource.delete_lock : lock.body.properties.level == "CanNotDelete"])
    error_message = "DNS reuse and resource deletion protections must remain enabled."
  }
  assert {
    condition     = azapi_resource.host.body.properties.diagnosticsProfile.bootDiagnostics.enabled && azapi_update_resource.os_disk_export.body.properties.networkAccessPolicy == "DenyAll" && azapi_update_resource.os_disk_export.body.properties.publicNetworkAccess == "Disabled"
    error_message = "Boot diagnostics and OS disk export restrictions are required."
  }
  assert {
    condition     = azapi_resource.recovery_vault.body.properties.enableSoftDelete && jsonencode(azapi_resource.recovery_vault.body.properties.networkAcls.virtualNetworkRules) == "[]" && azapi_resource.recovery_owner.body.properties.principalType == "User" && azapi_resource.recovery_vault.body.properties.enableRbacAuthorization && azapi_resource.recovery_vault.body.properties.enablePurgeProtection && azapi_resource.recovery_vault.body.properties.softDeleteRetentionInDays == 90 && azapi_resource.recovery_vault.body.properties.networkAcls.defaultAction == "Deny" && azapi_resource.recovery_vault.body.properties.networkAcls.bypass == "None" && azapi_resource.recovery_vault.body.properties.networkAcls.ipRules[0].value == var.config.operator_ipv4 && azapi_resource.recovery_owner.body.properties.principalId == var.config.recovery_owner_object_id
    error_message = "Recovery credentials require owner-only access and a protected vault."
  }
  assert {
    condition     = azapi_resource.host.location == "swedencentral" && azapi_resource.host.body.properties.hardwareProfile.vmSize == "Standard_D2as_v7" && azapi_resource.host.body.properties.storageProfile.diskControllerType == "NVMe"
    error_message = "QA must use the approved Sweden v7 host and NVMe-compatible image."
  }
  assert {
    condition = jsonencode(azapi_resource.firewall.body.properties.securityRules) == jsonencode([
      { name = "owner-ssh", properties = { priority = 100, direction = "Inbound", access = "Allow", protocol = "Tcp", sourcePortRange = "*", destinationPortRange = "22", sourceAddressPrefix = "8.8.8.8/32", destinationAddressPrefix = "10.80.0.4" } },
      { name = "apps-postgres", properties = { priority = 110, direction = "Inbound", access = "Allow", protocol = "Tcp", sourcePortRange = "*", destinationPortRange = "5432", sourceAddressPrefix = "10.80.2.0/23", destinationAddressPrefix = "10.80.0.4" } },
      { name = "deny-other-inbound", properties = { priority = 4000, direction = "Inbound", access = "Deny", protocol = "*", sourcePortRange = "*", destinationPortRange = "*", sourceAddressPrefix = "*", destinationAddressPrefix = "*" } }
    ])
    error_message = "Only owner SSH and private app-subnet PostgreSQL may enter the host."
  }
  assert {
    condition     = azapi_resource.host.body.properties.osProfile.linuxConfiguration.disablePasswordAuthentication && !azapi_resource.host.body.properties.osProfile.allowExtensionOperations && !can(azapi_resource.host.body.properties.osProfile.customData) && !can(azapi_resource.host.body.properties.osProfile.adminPassword)
    error_message = "Password login, extensions and secret-bearing bootstrap data must remain absent."
  }
  assert {
    condition     = azapi_resource.host.body.properties.securityProfile.securityType == "TrustedLaunch" && azapi_resource.host.body.properties.securityProfile.encryptionAtHost && azapi_resource.host.body.properties.securityProfile.uefiSettings.secureBootEnabled && azapi_resource.host.body.properties.securityProfile.uefiSettings.vTpmEnabled
    error_message = "Trusted boot and encryption must not be downgraded."
  }
  assert {
    condition     = azapi_resource.host.body.properties.storageProfile.osDisk.deleteOption == "Detach" && length(azapi_resource.host.body.properties.storageProfile.dataDisks) == 2 && alltrue([for disk in azapi_resource.host.body.properties.storageProfile.dataDisks : disk.deleteOption == "Detach" && disk.caching == "None"]) && azapi_resource.host.body.properties.networkProfile.networkInterfaces[0].properties.deleteOption == "Detach"
    error_message = "Host removal must detach both persistent data disks, OS disk and network interface."
  }
  assert {
    condition     = alltrue([for disk in azapi_resource.disk : disk.body.properties.networkAccessPolicy == "DenyAll" && disk.body.properties.publicNetworkAccess == "Disabled" && disk.body.properties.encryption.type == "EncryptionAtRestWithPlatformKey"]) && azapi_resource.disk["database"].body.properties.diskSizeGB == 64 && azapi_resource.disk["objects"].body.properties.diskSizeGB == 32
    error_message = "Separate encrypted data disks must prohibit public export."
  }
  assert {
    condition     = azapi_resource.host.body.properties.storageProfile.imageReference.version == var.config.image_version && length(azapi_resource.network.body.properties.subnets) == 2 && azapi_resource.network.body.properties.subnets[0].name == "supabase" && azapi_resource.network.body.properties.subnets[0].properties.addressPrefix == "10.80.0.0/24" && !azapi_resource.network.body.properties.subnets[0].properties.defaultOutboundAccess && azapi_resource.network.body.properties.subnets[1].name == "container-apps" && azapi_resource.network.body.properties.subnets[1].properties.addressPrefix == "10.80.2.0/23" && azapi_resource.network.body.properties.subnets[1].properties.delegations[0].properties.serviceName == "Microsoft.App/environments"
    error_message = "Image pin and both inline nonoverlapping subnets must survive every VNet update."
  }
}
run "production_requires_owned_domain_and_acceptance" {
  command = plan
  variables {
    config = {
      subscription_id          = "00000000-0000-0000-0000-000000000001"
      tenant_id                = "00000000-0000-0000-0000-000000000002"
      environment              = "production"
      operator_ipv4            = "8.8.8.8/32"
      ssh_public_key           = "ssh-rsa c3ludGhldGlj"
      image_version            = "24.04.202601010"
      vm_size                  = "Standard_D2as_v7"
      recovery_owner_object_id = "00000000-0000-0000-0000-000000000003"
      https_enabled            = true
    }
  }
  expect_failures = [var.config]
}
run "qa_https_is_explicit" {
  command = plan
  variables { config = merge(var.config, { https_enabled = true }) }
  assert {
    condition     = length(azapi_resource.firewall.body.properties.securityRules) == 4 && azapi_resource.firewall.body.properties.securityRules[2].properties.destinationPortRange == "443" && azapi_resource.firewall.body.properties.securityRules[2].properties.protocol == "Tcp" && azapi_resource.firewall.body.properties.securityRules[2].properties.sourceAddressPrefix == "Internet"
    error_message = "Explicit QA exposure must be HTTPS TCP443 only."
  }
}

run "exact_recovery_bindings" {
  command = plan
  assert {
    condition     = azapi_resource.nic.body.properties.ipConfigurations[0].properties.publicIPAddress.id == azapi_resource.scoped_public_ip.id
    error_message = "The NIC must use the scoped public IP."
  }
  assert {
    condition     = { for key, lock in azapi_resource.delete_lock : key => lock.parent_id } == { group = azapi_resource.group.id, public_ip = azapi_resource.public_ip.id, scoped_public_ip = azapi_resource.scoped_public_ip.id }
    error_message = "All and only the reviewed resource lock targets must be retained."
  }
  assert {
    condition     = jsonencode(azapi_resource.recovery_vault.body.properties.networkAcls.ipRules) == jsonencode([{ value = var.config.operator_ipv4 }])
    error_message = "The vault IP allowlist must contain only the operator."
  }
  assert {
    condition     = azapi_resource.recovery_owner.body.properties.roleDefinitionId == "/subscriptions/${var.config.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
    error_message = "Recovery owner must use the Key Vault Secrets Officer role."
  }
  assert {
    condition     = azapi_update_resource.os_disk_export.resource_id == "${azapi_resource.group.id}/providers/Microsoft.Compute/disks/${azapi_resource.host.body.properties.storageProfile.osDisk.name}"
    error_message = "Export restriction must target this VM's OS disk."
  }
}

override_resource {
  override_during = plan
  target          = azapi_resource.network
  values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/test" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.public_ip
  values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/publicIPAddresses/old" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.scoped_public_ip
  values = {
    id     = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/publicIPAddresses/scoped"
    output = { properties = { ipAddress = "192.0.2.1", dnsSettings = { fqdn = "qa.example.invalid" } } }
  }
}

override_resource {
  override_during = plan
  target          = azapi_resource.nic
  values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/networkInterfaces/test" }
}

override_resource {
  override_during = plan
  target          = azapi_resource.recovery_vault
  values          = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/test" }
}
