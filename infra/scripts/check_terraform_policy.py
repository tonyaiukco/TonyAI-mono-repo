#!/usr/bin/env python3
"""Offline allowlist for provider surfaces that are permitted to enter Terraform state."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1] / 'terraform'
ALLOWED = {
    'foundation': {'Microsoft.Resources/resourceGroups', 'Microsoft.ContainerRegistry/registries',
        'Microsoft.OperationalInsights/workspaces', 'Microsoft.App/managedEnvironments',
        'Microsoft.Insights/diagnosticSettings', 'Microsoft.KeyVault/vaults',
        'Microsoft.ManagedIdentity/userAssignedIdentities', 'Microsoft.Authorization/roleAssignments',
        'Microsoft.Authorization/roleDefinitions', 'Microsoft.App/jobs',
        'Microsoft.Insights/actionGroups', 'Microsoft.Insights/scheduledQueryRules'},
    'application': {'Microsoft.App/containerApps'},
}


def check(root=ROOT):
    for lane, allowed in ALLOWED.items():
        source = '\n'.join(p.read_text() for p in (root / lane).glob('*.tf'))
        if re.search(r'\b(data|provisioner|import)\s+"|\b(local-exec|remote-exec|listKeys|listSecrets|primary_shared_key|sensitive_body)\b',source):
            raise ValueError('Unreviewed state/command surface in ' + lane)
        resources = re.findall(r'resource\s+"([^"]+)"\s+"([^"]+)"\s*\{',source)
        if not resources or any(kind != 'azapi_resource' for kind,name in resources):
            raise ValueError('Only reviewed AzAPI resources are permitted.')
        types = re.findall(r'^\s*type\s*=\s*"(Microsoft\.[^"@]+)@[^\"]+"', source, re.M)
        if set(types) != allowed or len(types) != len(resources):
            raise ValueError('Writer boundary or resource-type allowlist changed.')
        exports = re.findall(r'response_export_values\s*=\s*\[([^\]]*)\]',source)
        if len(exports) != len(resources) or any('*' in item or 'secret' in item.lower() or 'key' in item.lower() for item in exports):
            raise ValueError('Every resource needs bounded, nonsecret response exports.')
        if 'disable_default_output = true' not in source:
            raise ValueError('Provider default computed output must remain disabled.')
    print('PASS: bounded provider reads, resource writer split and nonsecret export policy.')


if __name__ == '__main__':
    try:
        check()
    except ValueError as error:
        sys.exit('FAIL: ' + str(error))
