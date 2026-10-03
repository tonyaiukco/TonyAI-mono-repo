# State security and provider read review

Pin: Terraform 1.13.3 / Azure AzAPI 2.6.1. This is a review of configuration and
provider source, not evidence from a live state. Re-review before any version or
resource-type change. Marking a value `sensitive` only redacts display; it does
not remove it from state.

The two roots intentionally do not use AzureRM resource/data sources. In
particular, [AzureRM workspace read](https://github.com/hashicorp/terraform-provider-azurerm/blob/v4.46.0/internal/services/loganalytics/log_analytics_workspace_resource.go)
retrieves workspace shared keys. No `azurerm_log_analytics_workspace`, storage
account key reads, ACR admin reads, Key Vault secret resource/data source,
Supabase provider, `external` data source or provisioner is permitted.

[AzAPI 2.6.1 resource implementation](https://github.com/Azure/terraform-provider-azapi/blob/v2.6.1/internal/services/azapi_resource.go)
uses the declared ARM resource GET for refresh/create readback, not key-list
actions. `Read` merges configured fields with the response and separately builds exported
output. Remote list entries can be appended during refresh; the field-selection
mechanism is not a sanitizer for arbitrary out-of-band drift. This is why the
declared GET surfaces themselves must be nonsecret and inline secrets are forbidden. Every resource declares explicit `response_export_values`;
`disable_default_output = true` disables implicit read-only exports. Only public
registry hostname, environment domain, identity principal IDs and app FQDN/ready
revision are exported. Do not enable wildcard exports or move AzureRM state into
these resources: the provider's state-move path can flatten the entire body.

| ARM surface | Secret-bearing action avoided |
|---|---|
| Log Analytics workspace GET | No `sharedKeys` or `listKeys`; diagnostics routes by workspace ID |
| Managed environment GET | `appLogsConfiguration.destination = azure-monitor`; no shared key in body |
| Registry GET | Admin disabled; no `listCredentials` |
| Vault ARM GET | Metadata only; no `/secrets` data-plane calls from Terraform |
| Container Apps GET | Reference metadata only; no `listSecrets`; all configured secrets use versioned `keyVaultUrl`, never `value` |
| Identity/RBAC/group/diagnostic GET | IDs, tags and permissions only |

The owner must confirm these assumptions on the first real plan/apply and verify
state locally without uploading raw state or running secret-revealing CLI commands.
If an out-of-band inline secret ever existed, stop; don't import or refresh it
blindly. Review sanitization and rotate any leaked credential before proceeding.

[Azure Monitor log routing](https://learn.microsoft.com/en-us/azure/container-apps/log-options)
replaces Bicep's Log Analytics shared-key path. Diagnostics target workspace ID and
resource-specific `ContainerAppConsoleLogs` / `ContainerAppSystemLogs` tables.
There is no Application Insights duplication.

The [Azure Blob backend](https://developer.hashicorp.com/terraform/language/backend/azurerm)
uses `use_azuread_auth=true`, Blob leases for concurrent-write locking, no access
key/SAS. Bootstrap disables shared keys/public blobs, denies nonallowlisted IPs,
enables HTTPS/TLS 1.2, blob versioning, 30-day blob/container deletion recovery,
and a CanNotDelete management lock. State still contains sensitive infrastructure
metadata: restrict access and review inherited roles. Blob version history is
not an application database backup.

Owner state recovery: identify the affected blob (`foundation/staging.tfstate`
or `application/staging.tfstate`), stop writers, preserve current version metadata,
restore a reviewed prior blob version through Entra-authenticated Storage Explorer,
and inspect `terraform plan` before any apply. A prior state does not roll back
cloud resources. Never force-unlock an active lease; verify the lock ID and dead
writer, then use `terraform force-unlock <lock-id>` only after owner review. Never
turn off locking or remove the recovery lock merely to clear an error.
