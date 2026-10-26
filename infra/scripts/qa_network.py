#!/usr/bin/env python3
"""Offline r02 three-subnet preflight. Does not authenticate snapshots or approve R4."""
import argparse
from qa_contract import GROUP, SUBNET, SUBSCRIPTION, fields, load, match, require
from qa_foundation_expected import DATA_GROUP, VM, VNET
from qa_foundation_inputs import UUID

PREFIXES = {'supabase': '10.80.0.0/24', 'supabase-r02': '10.80.1.0/24', 'container-apps': '10.80.2.0/23'}


def same_id(left, right):
    return isinstance(left, str) and isinstance(right, str) and left.lower() == right.lower()


def check_network(data, tenant):
    """Input is a verified discovery bundle's nonsecret data map, not raw ARM."""
    match(UUID, tenant)
    account = data['account']
    require(account == {'subscription_id': SUBSCRIPTION, 'tenant_id': tenant})
    host, nic, network = data['host'], data['nic'], data['network']
    require(same_id(host['id'], VM) and host['location'] == 'swedencentral'
            and host['provisioning_state'] == 'Succeeded')
    match(UUID, host['vm_id'])
    require(len(host['data_disks']) == 2 and len({d['lun'] for d in host['data_disks']}) == 2)
    require({d['id'].lower() for d in host['data_disks']} == {
        (DATA_GROUP + '/providers/Microsoft.Compute/disks/tonyai-staging-data-r02-' + name).lower()
        for name in ('database', 'objects')})
    nic_id = DATA_GROUP + '/providers/Microsoft.Network/networkInterfaces/tonyai-staging-data-r02-nic'
    require(len(host['nic_ids']) == 1 and same_id(host['nic_ids'][0], nic_id) and same_id(nic['id'], nic_id))
    require(nic['location'] == 'swedencentral' and nic['forwarding'] is False)
    require(len(nic['ip_configurations']) == 1)
    ip = nic['ip_configurations'][0]
    require(ip['private_ip'] == '10.80.1.4' and ip['allocation'] == 'Static'
            and same_id(ip['subnet_id'], VNET + '/subnets/supabase-r02'))
    require(same_id(network['id'], VNET) and network['location'] == 'swedencentral'
            and network['prefixes'] == ['10.80.0.0/16'])
    subnets = network['subnets']
    require(len(subnets) == 3)
    mapped = {s['id'].lower(): s for s in subnets}
    require(set(mapped) == {f'{VNET}/subnets/{name}'.lower() for name in PREFIXES})
    for name, prefix in PREFIXES.items():
        subnet = mapped[f'{VNET}/subnets/{name}'.lower()]
        require(subnet['prefix'] == prefix and subnet['prefixes'] in (None, []))
        require(subnet['delegations'] == (['Microsoft.App/environments'] if name == 'container-apps' else []))
        for field in ('ip_configuration_count', 'association_count', 'resource_navigation_count'):
            require(type(subnet[field]) is int and subnet[field] >= 0)
        if name == 'container-apps':
            require(all(subnet[f] == 0 for f in ('ip_configuration_count', 'association_count', 'resource_navigation_count')))
        else:
            suffix = '-r02-nsg' if name == 'supabase-r02' else '-nsg'
            require(same_id(subnet['nsg_id'], DATA_GROUP + '/providers/Microsoft.Network/networkSecurityGroups/tonyai-staging-data' + suffix))
            require(subnet['default_outbound_access'] is False)
    seen = set()
    for environment in data['environments']:
        identity = environment['id'].lower()
        require(identity not in seen and identity.startswith(f'/subscriptions/{SUBSCRIPTION}/'.lower()))
        seen.add(identity)
        require(not same_id(environment['subnet_id'], SUBNET)
                and not identity.startswith(GROUP.lower() + '/'))
    # Full rule/route/DNS interpretation, capacity and accepted host trust are human gates.
    return {'status': 'OFFLINE_NETWORK_SHAPE_ONLY', 'subnet_count': 3,
            'pending': ['R3/R4 and PD-3 acceptance', 'provenance and current ARM freshness',
                        'NSG/routes/peerings/DNS and service CIDR review', 'capacity/quota',
                        'backend/state ownership and competing writers']}


def compare_protected(before, after):
    """No data-plane reconfiguration; only app-subnet service occupancy may grow."""
    from copy import deepcopy
    for key in ('account', 'host', 'nic', 'disks', 'nsgs', 'routes', 'backend', 'containers', 'blobs_foundation', 'blobs_application'):
        if key.startswith('blobs_'):
            # New app keys may be created, never ignore changes to existing keys.
            old = {r['name']: r for r in before[key]}
            new = {r['name']: r for r in after[key]}
            require(len(new) == len(after[key]) and len(old) == len(before[key]))
            require(set(new) - set(old) <= {'staging-selfhost-apps.tfstate'})
            require(all(new.get(name) == row for name, row in old.items() if name != 'staging-selfhost-apps.tfstate'))
        else:
            require(before[key] == after[key])
    left, right = deepcopy(before['network']), deepcopy(after['network'])
    observed = {}
    for network in (left, right):
        for subnet in network['subnets']:
            if same_id(subnet['id'], SUBNET):
                for field in ('ip_configuration_count', 'association_count', 'resource_navigation_count'):
                    require(type(subnet[field]) is int and subnet[field] >= 0)
                    observed[field] = subnet.pop(field)
        network['subnets'].sort(key=lambda s: s['id'].lower())
    require(left == right)
    return observed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--bundle', required=True)
    args = parser.parse_args()
    try:
        from qa_discovery import verify_bundle
        request = load(args.request)
        data = verify_bundle(request, load(args.bundle))
        result = check_network(data, request['tenant_id'])
    except Exception:
        raise SystemExit('FAIL: r02 QA network projection refused; details withheld.') from None
    import json
    print(json.dumps(result, sort_keys=True))
