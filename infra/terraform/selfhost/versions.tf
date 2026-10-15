terraform {
  required_version = "= 1.13.3"
  required_providers {
    azapi = { source = "Azure/azapi", version = "= 2.6.1" }
  }
  backend "azurerm" { use_azuread_auth = true }
}
provider "azapi" {
  subscription_id        = var.config.subscription_id
  tenant_id              = var.config.tenant_id
  enable_preflight       = false
  disable_default_output = true
}
