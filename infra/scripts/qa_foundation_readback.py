#!/usr/bin/env python3
"""Prepare public foundation readback queries; compare receipts and protected metadata offline."""
import argparse
import json
from datetime import datetime, timezone
from qa_contract import SUBSCRIPTION, fields, load, match, require
from qa_discovery import digest, timestamp, verify_bundle, verify_record
from qa_discovery_commands import ARM
from qa_foundation_expected import expected, resource_id
from qa_foundation_inputs import UUID, initial_inputs
from qa_foundation_plan import compare
from qa_network import check_network, compare_protected


def query_shape(shape, path=''):
    """Project only independently enumerated fields; never entire ARM properties."""
    if isinstance(shape, dict):
        if not shape:
            return '`{}`'
        return '{' + ','.join(k + ':' + query_shape(v, path + '.' + k if path else k) for k, v in shape.items()) + '}'
    if isinstance(shape, list) and shape and isinstance(shape[0], dict):
        return path + '[].' + query_shape(shape[0])
    return path


def manifest(inputs):
    config = initial_inputs(inputs)
    commands = {}
    for address, wanted in expected(config).items():
        if address.startswith('azapi_resource.grant['):
            continue
        path = resource_id(wanted)
        query = '{id:id,location:location,tags:tags,body:' + query_shape(wanted['body']) + ',provisioning_state:properties.provisioningState'
        if address.startswith('azapi_resource.identity['):
            query += ',principal_id:properties.principalId'
        if address == 'azapi_resource.environment':
            query += ',default_domain:properties.defaultDomain'
        query += '}'
        commands[address] = {'argv': ['az', 'rest', '--method', 'GET', '--url', ARM + path + '?api-version=' + wanted['type'].split('@')[1],
            '--query', query, '--subscription', SUBSCRIPTION, '--only-show-errors', '--output', 'json'], 'pagination': 'single'}
    commands['roles'] = {'argv': ['az', 'rest', '--method', 'GET', '--url', ARM + '/subscriptions/' + SUBSCRIPTION + '/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01',
        '--query', '{items:value[].{id:id,scope:properties.scope,principalId:properties.principalId,principalType:properties.principalType,roleDefinitionId:properties.roleDefinitionId,condition:properties.condition,conditionVersion:properties.conditionVersion,delegated:properties.delegatedManagedIdentityResourceId},next_link:nextLink}',
        '--subscription', SUBSCRIPTION, '--only-show-errors', '--output', 'json'], 'pagination': 'arm'}
    return {'schema': 1, 'source_sha': config['release_sha'], 'inputs_sha256': digest(config), 'commands': commands}


def canonical(value):
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return sorted([canonical(v) for v in value], key=lambda v: json.dumps(v, sort_keys=True))
    return value


def verify_receipt(inputs, receipt, *, now=None):
    config, spec = initial_inputs(inputs), manifest(inputs)
    fields(receipt, 'source_sha manifest_sha256 started_at completed_at records')
    require(receipt['source_sha'] == config['release_sha'] and receipt['manifest_sha256'] == digest(spec))
    started, completed = timestamp(receipt['started_at']), timestamp(receipt['completed_at'])
    now = now or datetime.now(timezone.utc)
    require(started <= completed <= now and (now - started).total_seconds() <= 3600
            and (completed - started).total_seconds() <= 1800)
    records = {r['key']: r for r in receipt['records']}
    require(len(records) == len(receipt['records']) and set(records) == set(spec['commands']))
    data = {k: verify_record(records[k], v, started, completed) for k, v in spec['commands'].items()}
    principals = {kind: data[f'azapi_resource.identity["{kind}"]']['principal_id'] for kind in ('api', 'web')}
    for value in principals.values():
        match(UUID, value)
    require(principals['api'] != principals['web'] and config['owner_object_id'] not in principals.values())
    for address, wanted in expected(config, principals).items():
        if address.startswith('azapi_resource.grant['):
            continue
        row = data[address]
        extra = 'principal_id' if address.startswith('azapi_resource.identity[') else 'default_domain' if address == 'azapi_resource.environment' else ''
        fields(row, 'id location tags body provisioning_state ' + extra)
        if address == 'azapi_resource.environment':
            match(r'[a-z0-9-]+\.swedencentral\.azurecontainerapps\.io', row['default_domain'])
        require(row['id'].lower() == resource_id(wanted).lower())
        require(row['location'] == wanted['location'] if wanted['location'] else row['location'] in (None, ''))
        require(row['tags'] == wanted['tags'] if wanted['tags'] else row['tags'] in (None, {}))
        compare(canonical(wanted['body']), canonical(row['body']), False)
        if address in ('azapi_resource.group', 'azapi_resource.registry', 'azapi_resource.logs', 'azapi_resource.environment', 'azapi_resource.vault', 'azapi_resource.dns', 'azapi_resource.dns_link'):
            require(row['provisioning_state'] == 'Succeeded')
        else:
            require(row['provisioning_state'] in (None, 'Succeeded'))
    return data, principals


def compare_inventory(before, after, config, principals):
    """Preserve existing inventory and DNS; report service-managed additions for review."""
    wanted = {resource_id(v).lower() for v in expected(config, principals).values()}
    old = {r['id'].lower(): r for r in before['resources']}
    new = {r['id'].lower(): r for r in after['resources']}
    require(not set(old) & wanted and all(new.get(k) == v for k, v in old.items()))
    resources = expected(config, principals)
    for address in ('registry', 'logs', 'environment', 'vault', 'identity["api"]', 'identity["web"]', 'dns'):
        row = resources['azapi_resource.' + address]
        actual = new.get(resource_id(row).lower())
        require(actual is not None and actual['type'].lower() == row['type'].split('@')[0].lower()
                and actual['location'] == row['location'])
    unexpected = set(new) - set(old) - wanted
    # No unplanned direct resource inside the application group can be accepted.
    from qa_contract import GROUP
    require(not any(i.startswith(GROUP.lower() + '/') for i in unexpected))
    old_env = {r['id'].lower(): r for r in before['environments']}
    new_env = {r['id'].lower(): r for r in after['environments']}
    env_id = resource_id(expected(config)['azapi_resource.environment']).lower()
    require(set(new_env) == set(old_env) | {env_id} and all(new_env[k] == v for k, v in old_env.items()))
    require(new_env[env_id]['subnet_id'].lower() == expected(config)['azapi_resource.environment']['body']['properties']['vnetConfiguration']['infrastructureSubnetId'].lower()
            and new_env[env_id]['location'] == 'swedencentral')
    # Compare DNS by resource ID, not zone index (new zone changes collection order).
    for prefix in ('dns_links_', 'dns_a_'):
        left = {r['id'].lower(): r for key, rows in before.items() if key.startswith(prefix) for r in rows}
        right = {r['id'].lower(): r for key, rows in after.items() if key.startswith(prefix) for r in rows}
        require(all(right.get(k) == v for k, v in left.items()) and set(right) - set(left) <= wanted)
        key = 'azapi_resource.dns_link' if prefix == 'dns_links_' else 'azapi_resource.db_address'
        row = resources[key]
        observed = right.get(resource_id(row).lower())
        require(observed is not None)
        if prefix == 'dns_links_':
            require(observed['vnet_id'].lower() == row['body']['properties']['virtualNetwork']['id'].lower()
                    and observed['registration'] is False)
        else:
            require(observed['ttl'] == 300 and observed['addresses'] == ['10.80.1.4'])
    return sorted(unexpected)


def verify_roles(config, principals, before, after):
    def indexed(rows):
        require(isinstance(rows, list))
        for row in rows:
            fields(row, 'id scope principalId principalType roleDefinitionId condition conditionVersion delegated')
            require(isinstance(row['id'], str))
        result = {r['id'].lower(): r for r in rows}
        require(len(result) == len(rows))
        return result
    old, new = indexed(before), indexed(after)
    grants = [v for k, v in expected(config, principals).items() if k.startswith('azapi_resource.grant[')]
    ids = {resource_id(v).lower() for v in grants}
    require(not set(old) & ids and set(new) == set(old) | ids)
    require(all(new[k] == v for k, v in old.items()))
    for grant in grants:
        row = new[resource_id(grant).lower()]
        require(row['scope'].lower() == grant['parent_id'].lower())
        require({k: row[k] for k in ('principalId', 'principalType', 'roleDefinitionId')} == grant['body']['properties'])
        require(all(row[k] is None for k in ('condition', 'conditionVersion', 'delegated')))


def verify_readback(inputs, receipt, before_request, before_bundle, after_request, after_bundle, roles, *, now=None):
    config = initial_inputs(inputs)
    require(before_request['source_sha'] == after_request['source_sha'] == config['release_sha']
            and before_request['tenant_id'] == after_request['tenant_id'] == config['tenant_id'])
    before = verify_bundle(before_request, before_bundle, now=now)
    after = verify_bundle(after_request, after_bundle, now=now)
    require(timestamp(before_bundle['completed_at']) <= timestamp(after_bundle['started_at'])
            <= timestamp(receipt['started_at']) <= timestamp(receipt['completed_at'])
            <= timestamp(after_bundle['completed_at']))
    check_network(before, config['tenant_id'])
    data, principals = verify_receipt(inputs, receipt, now=now)
    fields(roles, 'started_at completed_at record')
    start, end = timestamp(roles['started_at']), timestamp(roles['completed_at'])
    require(timestamp(before_bundle['started_at']) <= start <= end <= timestamp(before_bundle['completed_at']))
    old_roles = verify_record(roles['record'], manifest(inputs)['commands']['roles'], start, end)
    verify_roles(config, principals, old_roles, data['roles'])
    unreviewed = compare_inventory(before, after, config, principals)
    return {'status': 'REVIEW_REQUIRED' if unreviewed else 'OFFLINE_READBACK_CONSISTENCY_ONLY', 'authorization': False,
            'unreviewed_inventory_additions': unreviewed,
            'service_managed_app_subnet_counts': compare_protected(before, after),
            'pending': ['authenticated provenance', 'service-managed infrastructure reconciliation',
                        'effective inherited permissions', 'R3/R4 and live acceptance']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('manifest', 'verify'))
    parser.add_argument('--inputs', required=True)
    for name in ('receipt', 'before-request', 'before', 'after-request', 'after', 'before-roles'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    try:
        inputs = load(args.inputs)
        if args.operation == 'manifest':
            result = manifest(inputs)
        else:
            result = verify_readback(inputs, load(args.receipt), load(args.before_request), load(args.before),
                                     load(args.after_request), load(args.after), load(args.before_roles))
    except Exception:
        raise SystemExit('FAIL: QA foundation readback refused; details withheld.') from None
    print(json.dumps(result, indent=2, sort_keys=True))
