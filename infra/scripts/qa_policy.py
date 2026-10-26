#!/usr/bin/env python3
"""Offline allowlist for the additive QA writers; legacy policy stays unchanged."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1] / 'terraform'
FOUNDATION = {
    'Microsoft.Resources/resourceGroups', 'Microsoft.ContainerRegistry/registries',
    'Microsoft.OperationalInsights/workspaces', 'Microsoft.App/managedEnvironments',
    'Microsoft.Insights/diagnosticSettings', 'Microsoft.KeyVault/vaults',
    'Microsoft.ManagedIdentity/userAssignedIdentities', 'Microsoft.Authorization/roleAssignments',
    'Microsoft.Authorization/roleDefinitions', 'Microsoft.Network/privateDnsZones',
    'Microsoft.Network/privateDnsZones/virtualNetworkLinks', 'Microsoft.Network/privateDnsZones/A',
    'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials',
}


def check(root=ROOT):
    for lane, allowed in [('foundation', FOUNDATION), ('application', {'Microsoft.App/containerApps'})]:
        source = '\n'.join(p.read_text() for p in (root / lane / 'qa').glob('*.tf'))
        if re.search(r'\b(data|provisioner|import|module)\s+"|\b(local-exec|remote-exec|listKeys|listSecrets|sensitive_body)\b', source):
            raise ValueError('Unreviewed QA state or execution surface.')
        resources = re.findall(r'resource\s+"([^"]+)"\s+"([^"]+)"\s*\{', source)
        types = re.findall(r'^\s*type\s*=\s*"(Microsoft\.[^"@]+)@[^\"]+"', source, re.M)
        exports = re.findall(r'response_export_values\s*=\s*\[([^\]]*)\]', source)
        if (not resources or any(kind != 'azapi_resource' for kind, _ in resources)
                or set(types) != allowed or len(types) != len(resources)
                or len(exports) != len(resources)
                or any('*' in value or 'secret' in value.lower() or 'key' in value.lower() for value in exports)
                or 'disable_default_output = true' not in source):
            raise ValueError('QA resource/export allowlist differs.')


if __name__ == '__main__':
    check()
    print('PASS: QA writer split and bounded nonsecret exports.')
