variable "config" {
  validation {
    condition     = var.config.environment == "staging"
    error_message = "Production requires owned-domain integration, recovery acceptance and the legacy-key decision; this bootstrap is QA-only."
  }
  description = "Owner-only nonsecret host inputs. Use terraform_run.py for strict validation."
  type = object({
    subscription_id          = string
    tenant_id                = string
    environment              = string
    operator_ipv4            = string
    ssh_public_key           = string
    image_version            = string
    vm_size                  = string
    https_enabled            = bool
    recovery_owner_object_id = string
  })
  validation {
    condition     = contains(["staging", "production"], var.config.environment) && contains(["Standard_D2as_v7", "Standard_D4as_v7"], var.config.vm_size)
    error_message = "Use a supported environment and a reviewed VM size."
  }
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.config.image_version)) && can(regex("^ssh-rsa [A-Za-z0-9+/]+=*$", var.config.ssh_public_key)) && can(cidrhost(var.config.operator_ipv4, 0)) && endswith(var.config.operator_ipv4, "/32")
    error_message = "An exact image version, RSA public key and operator IPv4 /32 are required."
  }
}
locals {
  location = "swedencentral"
  stem     = "tonyai-${var.config.environment}-data"
  octet    = var.config.environment == "staging" ? 80 : 81
  host_net = "10.${local.octet}.0.0/24"
  apps_net = "10.${local.octet}.2.0/23"
  host_ip  = "10.${local.octet}.0.4"
  tags     = { application = "TonyAI", environment = var.config.environment, component = "supabase-host" }
}
