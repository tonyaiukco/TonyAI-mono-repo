#!/usr/bin/env python3
"""Owner-run ARM bootstrap. No storage keys, SAS tokens or Terraform state required."""
import argparse
import ipaddress
import json
import re
import sys
import time
from uuid import UUID, uuid5, NAMESPACE_URL
from secure_transport import azure_token, json_request
from pooler import SafeFailure


def validate(config):
    required = {'subscription_id', 'tenant_id', 'environment', 'resource_group', 'storage_account',
                'owner_object_id', 'application_object_id', 'allowed_ipv4'}
    if set(config) != required or config['environment'] not in ('staging', 'production'):
        raise SafeFailure('Backend configuration fields or environment are invalid.')
    for name in ('subscription_id', 'tenant_id', 'owner_object_id'):
        UUID(config[name])
    if config['application_object_id']:
        UUID(config['application_object_id'])
        if config['application_object_id'] == config['owner_object_id']:
            raise SafeFailure('Application identity must differ from the foundation owner.')
    if not re.fullmatch(r'[a-z0-9]{3,24}', config['storage_account']):
        raise SafeFailure('Invalid backend account name.')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', config['resource_group']) or config['environment'] not in config['resource_group']:
        raise SafeFailure('Use an environment-specific backend resource group.')
    if not config['allowed_ipv4']:
        raise SafeFailure('At least one explicit owner/runner public IPv4 is required.')
    for address in config['allowed_ipv4']:
        network = ipaddress.ip_network(address)
        if network.version != 4 or (network.prefixlen < 24 or network.prefixlen == 31) or not network.is_global:
            raise SafeFailure('Backend firewall accepts only narrow public IPv4 ranges (/24 or narrower).')


def bootstrap(config, arm):
    validate(config)
    subscription = '/subscriptions/' + config['subscription_id']
    group = subscription + '/resourceGroups/' + config['resource_group']
    account = group + '/providers/Microsoft.Storage/storageAccounts/' + config['storage_account']
    tags = {'application': 'TonyAI', 'environment': config['environment'], 'purpose': 'terraform-state'}
    for resource, version in [(group, '2024-03-01'), (account, '2023-05-01')]:
        existing = arm(resource, version, missing_ok=True)
        if existing and any(existing.get('tags', {}).get(k) != v for k, v in tags.items()):
            raise SafeFailure('Refusing to adopt an unrelated backend group/account.')
    arm(group, '2024-03-01', 'PUT', {'location': 'germanywestcentral', 'tags': tags, 'properties': {}})
    arm(account, '2023-05-01', 'PUT', {
        'location': 'germanywestcentral', 'tags': tags, 'kind': 'StorageV2', 'sku': {'name': 'Standard_LRS'},
        'properties': {
            'allowSharedKeyAccess': False, 'allowBlobPublicAccess': False, 'minimumTlsVersion': 'TLS1_2',
            'supportsHttpsTrafficOnly': True, 'defaultToOAuthAuthentication': True,
            'publicNetworkAccess': 'Enabled',
            'networkAcls': {'bypass': 'None', 'defaultAction': 'Deny',
                            'ipRules': [{'value': str(ipaddress.ip_network(ip).network_address) if ipaddress.ip_network(ip).prefixlen == 32 else ip, 'action': 'Allow'} for ip in config['allowed_ipv4']]},
            'encryption': {'keySource': 'Microsoft.Storage', 'services': {'blob': {'enabled': True}}},
        }})
    # Asynchronous account creation is expected. A bounded wait, then rerun the same PUTs.
    for _ in range(30):
        actual = arm(account, '2023-05-01')
        if actual.get('properties', {}).get('provisioningState') == 'Succeeded':
            break
        time.sleep(2)
    else:
        raise SafeFailure('Storage still provisioning; resume the same configuration.')
    props = actual['properties']
    expected_ips = {str(ipaddress.ip_network(ip).network_address) if ipaddress.ip_network(ip).prefixlen == 32 else ip
                    for ip in config['allowed_ipv4']}
    actual_ips = {rule.get('value') for rule in props.get('networkAcls', {}).get('ipRules', [])}
    if (props.get('allowSharedKeyAccess') is not False or props.get('allowBlobPublicAccess') is not False
            or props.get('networkAcls', {}).get('defaultAction') != 'Deny'
            or props.get('networkAcls', {}).get('bypass') != 'None' or actual_ips != expected_ips
            or props.get('supportsHttpsTrafficOnly') is not True
            or props.get('publicNetworkAccess') != 'Enabled'
            or props.get('minimumTlsVersion') != 'TLS1_2'):
        raise SafeFailure('Backend security settings did not read back.')
    service = account + '/blobServices/default'
    recovery = {'isVersioningEnabled': True, 'deleteRetentionPolicy': {'enabled': True, 'days': 30},
                'containerDeleteRetentionPolicy': {'enabled': True, 'days': 30}}
    arm(service, '2023-05-01', 'PUT', {'properties': recovery})
    readback = arm(service, '2023-05-01')['properties']
    if (readback.get('isVersioningEnabled') is not True
            or any(readback.get(k, {}).get(field) != value for k in ('deleteRetentionPolicy', 'containerDeleteRetentionPolicy')
                   for field, value in recovery[k].items())):
        raise SafeFailure('Backend recovery policy did not read back.')
    role = subscription + '/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    for lane in ('foundation', 'application'):
        container = service + '/containers/' + lane
        arm(container, '2023-05-01', 'PUT', {'properties': {'publicAccess': 'None'}})
        principals = [(config['owner_object_id'], 'User')]
        if lane == 'application' and config['application_object_id']:
            principals.append((config['application_object_id'], 'ServicePrincipal'))
        for principal, kind in principals:
            assignment = container + '/providers/Microsoft.Authorization/roleAssignments/' + str(uuid5(NAMESPACE_URL, (container + principal + role).lower()))
            arm(assignment, '2022-04-01', 'PUT', {'properties': {
                'principalId': principal, 'principalType': kind, 'roleDefinitionId': role}})
    arm(account + '/providers/Microsoft.Authorization/locks/state-recovery', '2016-09-01', 'PUT',
        {'properties': {'level': 'CanNotDelete', 'notes': 'Owner-reviewed recovery required before backend deletion.'}})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.load(open(args.config))
    validate(config)
    # Verify CLI tenant/subscription; never change the owner's ambient account silently.
    from configure_oidc import az
    account = az('account', 'show')
    if account.get('id') != config['subscription_id'] or account.get('tenantId') != config['tenant_id']:
        raise SafeFailure('Sign in and select the configured tenant/subscription first.')
    token = azure_token('https://management.azure.com/')
    def arm(path, version, method='GET', body=None, missing_ok=False):
        return json_request('https://management.azure.com' + path + '?api-version=' + version,
                            method, token, body, missing_ok)
    bootstrap(config, arm)
    print('PASS: Entra-only backend reconciled; leases provide Terraform locking. Verify scoped access before use.')


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: backend operation failed; details withheld. Resume the same configuration.')
