#!/usr/bin/env python3
"""Prepare read-only argv manifests or verify collected projections, entirely offline."""
import argparse
from datetime import datetime, timezone
import json
from urllib.parse import parse_qs, urlsplit
from qa_contract import SUBSCRIPTION, fields, load, match, require, sha256
from qa_discovery_commands import SUB, commands, zone_ids
from qa_discovery_shapes import shape_for, validate_shape


def digest(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode())


def manifest(request):
    specs = commands(request)
    return {'schema': 1, 'source_sha': request['source_sha'], 'request_sha256': digest(request),
            'subscription_id': SUBSCRIPTION, 'tenant_id': request['tenant_id'],
            'commands': {k: {**v, 'argv_sha256': digest(v['argv'])} for k, v in specs.items()}}


def timestamp(value):
    match(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value)
    return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)


def next_command(spec, link):
    """Never execute arbitrary nextLink origins, paths, filters or API versions."""
    base = urlsplit(spec['argv'][spec['argv'].index('--url') + 1])
    next_url = urlsplit(link)
    query = parse_qs(next_url.query, strict_parsing=True)
    require(next_url.scheme == 'https' and next_url.netloc == 'management.azure.com'
            and next_url.path == base.path and not next_url.fragment)
    require(set(query) <= {'api-version', '$skiptoken', 'skiptoken'} and
            query.get('api-version') == parse_qs(base.query)['api-version']
            and all(len(v) == 1 for v in query.values())
            and bool(set(query) & {'$skiptoken', 'skiptoken'}))
    argv = list(spec['argv'])
    argv[argv.index('--url') + 1] = link
    return argv


def verify_record(record, spec, started, completed):
    fields(record, 'key complete pages')
    require(record['complete'] is True and 1 <= len(record['pages']) <= 100)
    require(spec['pagination'] == 'arm' or len(record['pages']) == 1)
    argv, data, seen = spec['argv'], [], set()
    for index, page in enumerate(record['pages']):
        fields(page, 'argv_sha256 exit_code started_at completed_at result result_sha256')
        require(page['argv_sha256'] == digest(argv) and type(page['exit_code']) is int and page['exit_code'] == 0)
        begin, end = timestamp(page['started_at']), timestamp(page['completed_at'])
        require(started <= begin <= end <= completed)
        require(page['result_sha256'] == digest(page['result']))
        if spec['pagination'] != 'arm':
            return page['result']
        fields(page['result'], 'items next_link')
        require(isinstance(page['result']['items'], list))
        data.extend(page['result']['items'])
        link = page['result']['next_link']
        if index == len(record['pages']) - 1:
            require(link is None)
        else:
            require(isinstance(link, str) and link not in seen)
            seen.add(link)
            argv = next_command(spec, link)
        started = end
    return data


def correlate(request, data):
    require(data['account'] == {'subscription_id': SUBSCRIPTION, 'tenant_id': request['tenant_id']})
    inventory = {r['id'].lower(): r for r in data['resources']}
    require(all(k.startswith(SUB.lower() + '/') for k in inventory))
    for key, kind in {'environments': 'Microsoft.App/managedEnvironments', 'nsgs': 'Microsoft.Network/networkSecurityGroups',
                      'routes': 'Microsoft.Network/routeTables', 'zones': 'Microsoft.Network/privateDnsZones',
                      'disks': 'Microsoft.Compute/disks'}.items():
        require({r['id'].lower() for r in data[key]} == {k for k, r in inventory.items() if r['type'].lower() == kind.lower()})
    zones = zone_ids(request)
    require({v.lower() for v in zones} == {v['id'].lower() for v in data['zones']})
    for key in ('host', 'nic', 'network', 'backend'):
        require(data[key]['id'].lower() in inventory)
    disks = {row['id'].lower(): row for row in data['disks']}
    attached = [data['host']['os_disk_id']] + [row['id'] for row in data['host']['data_disks']]
    require(len(set(attached)) == len(attached))
    for identity in attached:
        require(identity.lower() in disks and disks[identity.lower()]['managed_by'].lower() == data['host']['id'].lower()
                and disks[identity.lower()]['location'] == 'swedencentral')
    for index, zone in enumerate(zones):
        for prefix in ('dns_links_', 'dns_a_'):
            require(all(row['id'].lower().startswith(zone.lower() + '/') for row in data[prefix + str(index)]))
    backend = SUB + '/resourceGroups/' + request['backend_group'] + '/providers/Microsoft.Storage/storageAccounts/' + request['backend_account']
    require(data['backend']['id'].lower() == backend.lower() and data['backend']['location'] == 'swedencentral'
            and data['backend']['shared_key'] is False and data['backend']['https_only'] is True
            and data['backend']['tls'] == 'TLS1_2')
    containers = {r['name']: r for r in data['containers']}
    require({'foundation', 'application'} <= set(containers))
    for name in ('foundation', 'application'):
        require(containers[name]['id'].lower() == (backend + '/blobServices/default/containers/' + name).lower()
                and containers[name]['public_access'] == 'None')
    require('staging-selfhost.tfstate' in {r['name'] for r in data['blobs_foundation']})
    for subnet in data['network']['subnets']:
        for field, key in [('nsg_id', 'nsgs'), ('route_table_id', 'routes')]:
            if subnet[field]:
                require(subnet[field].lower() in {r['id'].lower() for r in data[key]})


def verify_bundle(request, bundle, *, now=None):
    wanted = manifest(request)
    fields(bundle, 'schema source_sha manifest_sha256 started_at completed_at records')
    require(type(bundle['schema']) is int and bundle['schema'] == 1 and bundle['source_sha'] == request['source_sha']
            and bundle['manifest_sha256'] == digest(wanted))
    started, completed = timestamp(bundle['started_at']), timestamp(bundle['completed_at'])
    now = now or datetime.now(timezone.utc)
    require(started <= completed <= now and (completed - started).total_seconds() <= 1800
            and (now - started).total_seconds() <= 3600)
    records = {r['key']: r for r in bundle['records']}
    require(len(records) == len(bundle['records']) and set(records) == set(wanted['commands']))
    data = {}
    for key, spec in wanted['commands'].items():
        data[key] = verify_record(records[key], spec, started, completed)
        validate_shape(data[key], shape_for(key))
    correlate(request, data)
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('manifest', 'verify'))
    parser.add_argument('--request', required=True)
    parser.add_argument('--bundle')
    args = parser.parse_args()
    try:
        request = load(args.request)
        if args.operation == 'manifest':
            result = manifest(request)
        else:
            verify_bundle(request, load(args.bundle))
            result = {'status': 'OFFLINE_PROJECTION_CONSISTENCY_ONLY', 'bundle_sha256': digest(load(args.bundle)),
                      'authorization': False, 'authenticated_provenance': False}
    except Exception:
        raise SystemExit('FAIL: QA discovery manifest/projection refused; details withheld.') from None
    print(json.dumps(result, indent=2, sort_keys=True))
