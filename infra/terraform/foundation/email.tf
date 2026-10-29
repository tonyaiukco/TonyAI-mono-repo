# Entra application/SP and client secret are owner-managed outside Terraform.
# https://learn.microsoft.com/azure/communication-services/quickstarts/email/send-email-smtp/smtp-authentication
locals {
  email = var.config.email == null ? {} : { enabled = var.config.email }
}
resource "azapi_resource" "email" {
  for_each               = local.email
  type                   = "Microsoft.Communication/emailServices@2023-03-31"
  name                   = "${local.stem}-email"
  parent_id              = azapi_resource.group.id
  location               = "global"
  tags                   = local.tags
  body                   = { properties = { dataLocation = "Europe" } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "email_domain" {
  for_each               = local.email
  type                   = "Microsoft.Communication/emailServices/domains@2023-03-31"
  name                   = "AzureManagedDomain"
  parent_id              = azapi_resource.email[each.key].id
  location               = "global"
  tags                   = local.tags
  body                   = { properties = { domainManagement = "AzureManaged", userEngagementTracking = "Disabled" } }
  response_export_values = ["properties.mailFromSenderDomain"]
  lifecycle { prevent_destroy = true }
}
# Create first, verify DNS outside Terraform, then link the verified domain.
resource "azapi_resource" "email_custom_domain" {
  for_each               = { for key, email in local.email : key => email if email.custom_domain != null }
  type                   = "Microsoft.Communication/emailServices/domains@2023-03-31"
  name                   = each.value.custom_domain
  parent_id              = azapi_resource.email[each.key].id
  location               = "global"
  tags                   = local.tags
  body                   = { properties = { domainManagement = "CustomerManaged", userEngagementTracking = "Disabled" } }
  response_export_values = ["properties.mailFromSenderDomain", "properties.verificationRecords"]
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "communication" {
  for_each  = local.email
  type      = "Microsoft.Communication/communicationServices@2023-03-31"
  name      = "${local.stem}-communication"
  parent_id = azapi_resource.group.id
  location  = "global"
  tags      = local.tags
  body = { properties = {
    dataLocation  = "Europe"
    linkedDomains = concat([azapi_resource.email_domain[each.key].id], each.value.custom_domain_verified ? [azapi_resource.email_custom_domain[each.key].id] : [])
  } }
  response_export_values = []
  lifecycle { prevent_destroy = true }
}
resource "azapi_resource" "smtp_username" {
  for_each = local.email
  type     = "Microsoft.Communication/communicationServices/smtpUsernames@2024-09-01-preview"
  # ACS requires the ARM child name to differ from the public SMTP login.
  name      = "${local.stem}-smtp-user"
  parent_id = azapi_resource.communication[each.key].id
  body = { properties = {
    entraApplicationId = each.value.client_id
    tenantId           = each.value.tenant_id
    username           = "${local.stem}-smtp"
  } }
  response_export_values = []
}
resource "azapi_resource" "smtp_role" {
  for_each  = local.email
  type      = "Microsoft.Authorization/roleDefinitions@2022-04-01"
  name      = uuidv5("url", "${local.group_id}/smtp-send")
  parent_id = azapi_resource.group.id
  body = { properties = {
    roleName         = "${local.stem}-smtp-send-${var.config.registry_name}"
    description      = "Only the documented ACS SMTP authentication operations on this Communication resource."
    type             = "CustomRole"
    assignableScopes = [azapi_resource.communication[each.key].id]
    permissions = [{
      actions    = ["Microsoft.Communication/CommunicationServices/Read", "Microsoft.Communication/CommunicationServices/Write", "Microsoft.Communication/EmailServices/write"]
      notActions = [], dataActions = [], notDataActions = []
    }]
  } }
  response_export_values = []
}
resource "azapi_resource" "smtp_grant" {
  for_each  = local.email
  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "${local.group_id}/smtp-send/${each.value.principal_id}")
  parent_id = azapi_resource.communication[each.key].id
  body = { properties = {
    principalId      = each.value.principal_id
    principalType    = "ServicePrincipal"
    roleDefinitionId = azapi_resource.smtp_role[each.key].id
  } }
  response_export_values = []
}
output "email_contract" {
  description = "Public SMTP settings only; the owner stores the Entra client secret directly in Key Vault."
  value = { for key, email in local.email : key => {
    host                       = "smtp.azurecomm.net", port = 587, secure = false
    username                   = azapi_resource.smtp_username[key].body.properties.username
    sender                     = "DoNotReply@${email.custom_domain_verified ? azapi_resource.email_custom_domain[key].output.properties.mailFromSenderDomain : azapi_resource.email_domain[key].output.properties.mailFromSenderDomain}"
    custom_domain_verification = try(azapi_resource.email_custom_domain[key].output.properties.verificationRecords, null)
  } }
}
