#!/usr/bin/env python3
"""Offline creation preflight for the reserved Sweden QA Container Apps subnet.

Consumes nonsecret ARM projections; never authenticates, initializes state or
deploys. A passing snapshot is not current cloud evidence or deploy authority.
"""
import argparse
import ipaddress
import json
from pathlib import Path
import re
from uuid import UUID

from pooler import SafeFailure


def require(condition, message):
    if not condition:
        raise SafeFailure(message)


def fields(value, names):
    require(isinstance(value, dict) and set(value) == set(names.split()),
            'Missing or unknown fields in network preflight input.')


def validate_network(host, network, environments):
    """Validate a fresh, unoccupied subnet against the existing host contract.

network: explicit ARM projection documented in runbook 08. environments: the
complete subscription managed-environment projection, not a region-filtered list.
Existing environments are never adopted by this creation-only preflight.
"""
    fields(host, 'subscription_id tenant_id environment resource_group vm_name '
           'private_ip public_ip public_hostname apps_subnet_id principal_id recovery_vault_url')
    require(host['environment'] == 'staging', 'Only QA staging is supported.')
    try:
        for key in ('subscription_id', 'tenant_id', 'principal_id'):
            require(isinstance(host[key], str) and str(UUID(host[key])) == host[key],
                    'Canonical contract UUIDs are required.')
    except (ValueError, TypeError, AttributeError):
        raise SafeFailure('Canonical contract UUIDs are required.') from None
    require(host['resource_group'] == host['vm_name'] == 'tonyai-staging-data',
            'The existing QA data resource group and VM are required.')
    vnet_id = (f"/subscriptions/{host['subscription_id']}/resourceGroups/"
               f"{host['resource_group']}/providers/Microsoft.Network/virtualNetworks/"
               f"{host['resource_group']}-vnet")
    subnet_id = vnet_id + '/subnets/container-apps'
    require(host['apps_subnet_id'] == subnet_id, 'Foreign or missing application subnet.')
    fields(network, 'id location prefixes subnets')
    require(network['id'] == vnet_id and network['location'] == 'swedencentral',
            'The existing Sweden Central VNet is required.')
    # These are the selfhost root\'s current QA locals, not caller-selected CIDRs.
    require(network['prefixes'] == ['10.80.0.0/16'], 'Unexpected QA VNet address space.')
    require(host['private_ip'] == '10.80.0.4', 'Unexpected QA host address.')
    require(isinstance(network['subnets'], list) and len(network['subnets']) == 2,
            'Both existing QA subnets, and no additional subnet, are required.')
    subnets = {}
    for subnet in network['subnets']:
        fields(subnet, 'id prefix delegations ip_configuration_count association_count')
        require(isinstance(subnet['id'], str) and subnet['id'] not in subnets,
                'Duplicate or invalid subnet identity.')
        require(isinstance(subnet['delegations'], list), 'Invalid subnet delegation list.')
        for key in ('ip_configuration_count', 'association_count'):
            require(type(subnet[key]) is int and subnet[key] >= 0,
                    'Explicit nonnegative subnet usage counts are required.')
        subnets[subnet['id']] = subnet
    require(set(subnets) == {subnet_id, vnet_id + '/subnets/supabase'},
            'Foreign or missing subnet in VNet readback.')
    apps = subnets[subnet_id]
    data = subnets[vnet_id + '/subnets/supabase']
    require(apps['prefix'] == '10.80.2.0/23' and data['prefix'] == '10.80.0.0/24',
            'Subnet ranges differ from selfhost local.apps_net/local.host_net.')
    require(apps['delegations'] == ['Microsoft.App/environments'] and data['delegations'] == [],
            'Unexpected subnet delegation.')
    require(apps['ip_configuration_count'] == apps['association_count'] == 0,
            'The app subnet is occupied; reconcile existing ownership first.')
    # Explicitly retain the address-space invariant if the reviewed locals change.
    app_net, data_net = (ipaddress.ip_network(s['prefix']) for s in (apps, data))
    require(not app_net.overlaps(data_net), 'Host and app subnets overlap.')
    require(isinstance(environments, list), 'A complete environment inventory is required.')
    for environment in environments:
        fields(environment, 'id location infrastructure_subnet_id')
        require(all(isinstance(v, str) for v in environment.values()),
                'Invalid environment inventory projection.')
        require(re.fullmatch(
            re.escape('/subscriptions/' + host['subscription_id']) +
            r'/resourceGroups/[^/]+/providers/Microsoft.App/managedEnvironments/[^/]+',
            environment['id'], re.IGNORECASE) is not None,
            'Foreign environment inventory.')
        require(environment['infrastructure_subnet_id'].lower() != subnet_id.lower(),
                'An environment already uses the subnet; creation must stop.')
        require('/resourcegroups/tonyai-staging-apps/' not in environment['id'].lower(),
                'The proposed application group already has an environment; reconcile it first.')
    return {
        'location': 'swedencentral',
        'properties': {
            'vnetConfiguration': {'infrastructureSubnetId': subnet_id, 'internal': False},
            'workloadProfiles': [{'name': 'Consumption', 'workloadProfileType': 'Consumption'}],
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--network', required=True)
    parser.add_argument('--environments', required=True)
    args = parser.parse_args()
    try:
        values = [json.loads(Path(p).read_text()) for p in
                  (args.contract, args.network, args.environments)]
        validate_network(*values)
    except (SafeFailure, OSError, ValueError, TypeError, KeyError):
        # JSON and filesystem errors can contain private values; never echo them.
        raise SystemExit('FAIL: network preflight refused; inspect inputs privately.') from None
    print('PASS: offline QA network creation preflight only; no deployment or live acceptance.')


if __name__ == '__main__':
    main()
