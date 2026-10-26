#!/usr/bin/env python3
"""Offline application observation manifest/receipt checks; no Azure executor."""
import argparse
from datetime import datetime, timezone
import json
from qa_contract import GROUP, SUBSCRIPTION, fields, load, match, release, require
from qa_discovery import digest, timestamp, verify_record
from qa_expected import body
from qa_foundation_readback import query_shape
from qa_readback import verify


def revision_names(value):
    fields(value, 'api web')
    for kind, names in value.items():
        require(isinstance(names, list) and len(names) == len(set(names)) and names == sorted(names))
        for name in names:
            match('tonyai-staging-' + kind + r'--[a-z][a-z0-9-]{0,29}', name)
    return value


def manifest(inputs, plan_sha256, names, phase):
    match(r'[a-f0-9]{64}', plan_sha256)
    revision_names(names)
    require(phase in ('before', 'drained', 'after'))
    commands = {}
    def cli(key, argv):
        commands[key] = {'argv': ['az', *argv, '--subscription', SUBSCRIPTION, '--only-show-errors', '--output', 'json'], 'pagination': 'single'}
    cli('inventory', ['containerapp', 'list', '-g', 'tonyai-staging-apps', '--query', '[].name'])
    for kind in ('api', 'web'):
        scope = ['-g', 'tonyai-staging-apps', '-n', 'tonyai-staging-' + kind]
        cli(kind + '_revisions', ['containerapp', 'revision', 'list', '--all', *scope,
                                 '--query', '[].{name:name,properties:{active:properties.active}}'])
        for name in names[kind]:
            cli('replicas:' + name, ['containerapp', 'replica', 'list', *scope, '--revision', name, '--query', '[].name'])
        if phase == 'after':
            shape = body(inputs, kind)
            props = shape['properties']
            props.update(provisioningState=None, latestReadyRevisionName=None)
            props['configuration']['ingress'] = None  # Public routing policy, including every denied extension.
            props['configuration'].update(dapr=None, service=None)
            props['configuration']['secrets'] = [{'name': None, 'keyVaultUrl': None, 'identity': None}]
            props['template'].update(initContainers=[], volumes=[], serviceBinds=[])
            props['template']['containers'][0].update(command=[], args=[], volumeMounts=[])
            # Project references, never secret values. Env values are public operational inputs.
            props['template']['containers'][0]['env'] = [{'name': None, 'value': None, 'secretRef': None}]
            shape.update(id=None, location=None, tags={}, identity={})
            query = query_shape(shape).replace('tags:`{}`', 'tags:tags').replace('identity:`{}`', 'identity:identity')
            cli(kind + '_app', ['containerapp', 'show', *scope, '--query', query])
    if phase == 'after':
        cli('environment', ['containerapp', 'env', 'show', '-g', 'tonyai-staging-apps', '-n', 'tonyai-staging-env', '--query',
            '{id:id,location:location,properties:{vnetConfiguration:properties.vnetConfiguration,workloadProfiles:properties.workloadProfiles,defaultDomain:properties.defaultDomain}}'])
    return {'schema': 1, 'source_sha': inputs['release']['source_sha'], 'release_id': inputs['release']['release_id'],
            'inputs_sha256': digest(inputs), 'plan_sha256': plan_sha256, 'phase': phase, 'revision_names': names, 'commands': commands}


def expected_names(inputs, outgoing, phase):
    revision_names(outgoing)
    if phase != 'after':
        return outgoing
    return {k: sorted(set(v) | {f'tonyai-staging-{k}--{inputs["release"]["release_id"]}'}) for k, v in outgoing.items()}


def verify_receipt(inputs, plan_hash, receipt, names, phase, *, not_before, outgoing=None, now=None):
    if phase != 'before':
        require(outgoing is not None and names == expected_names(inputs, outgoing, phase))
    fields(receipt, 'source_sha release_id inputs_sha256 plan_sha256 phase revision_names manifest_sha256 started_at completed_at records')
    spec = manifest(inputs, plan_hash, names, phase)
    for key in ('source_sha', 'release_id', 'inputs_sha256', 'plan_sha256', 'phase', 'revision_names'):
        require(receipt[key] == spec[key])
    require(receipt['manifest_sha256'] == digest(spec))
    start, end = timestamp(receipt['started_at']), timestamp(receipt['completed_at'])
    now = now or datetime.now(timezone.utc)
    require(timestamp(not_before) <= start <= end <= now and (end - start).total_seconds() <= 1800
            and (now - start).total_seconds() <= 3600)
    rows = {r['key']: r for r in receipt['records']}
    # An absent app needs no revision command, but only successful full inventory proves absence.
    require('inventory' in rows and len(rows) == len(receipt['records']))
    inventory = verify_record(rows['inventory'], spec['commands']['inventory'], start, end)
    require(isinstance(inventory, list) and all(isinstance(n, str) for n in inventory) and len(inventory) == len(set(inventory)))
    present = {k for k in ('api', 'web') if 'tonyai-staging-' + k in inventory}
    require(present in (set(), {'api', 'web'}))
    required = set(spec['commands'])
    if not present:
        require(phase != 'after' and names == {'api': [], 'web': []})
        required -= {'api_revisions', 'web_revisions'}
    require(set(rows) == required)
    data = {key: verify_record(rows[key], spec['commands'][key], start, end) for key in required}
    revisions = {}
    for kind in present:
        actual = data[kind + '_revisions']
        require(isinstance(actual, list) and bool(actual) and sorted(r['name'] for r in actual) == names[kind])
        for row in actual:
            fields(row, 'name properties'); fields(row['properties'], 'active')
            require(type(row['properties']['active']) is bool)
            replicas = data['replicas:' + row['name']]
            require(isinstance(replicas, list) and all(isinstance(n, str) for n in replicas) and len(replicas) == len(set(replicas)))
            intended = 'tonyai-staging-' + kind + '--' + inputs['release']['release_id']
            if phase == 'before':
                require(row['name'] != intended)
            if (phase == 'drained' and kind == 'api') or (phase == 'after' and row['name'] != intended):
                require(row['properties']['active'] is False and replicas == [])
        revisions[kind] = actual
    if phase == 'after':
        verify(inputs, data['environment'], {k: data[k + '_app'] for k in present}, revisions)
    return {'mode': 'first_deployment' if not present else 'existing_revision_update',
            'revision_names': names, 'receipt_sha256': digest(receipt), 'completed_at': receipt['completed_at'],
            'authenticated_azure_provenance': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['manifest', 'verify'])
    for name in ('inputs', 'candidate', 'plan-sha256', 'revision-names', 'revision-names-sha256', 'phase'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--receipt')
    parser.add_argument('--not-before', help='Owner-recorded plan completion (before/drained) or apply completion (after), UTC')
    args = parser.parse_args()
    try:
        inputs = release(load(args.inputs), load(args.candidate))
        outgoing = load(args.revision_names)
        require(digest(outgoing) == args.revision_names_sha256)
        names = expected_names(inputs, outgoing, args.phase)
        result = manifest(inputs, args.plan_sha256, names, args.phase) if args.operation == 'manifest' else verify_receipt(
            inputs, args.plan_sha256, load(args.receipt), names, args.phase, not_before=args.not_before, outgoing=outgoing)
    except Exception:
        raise SystemExit('FAIL: QA application receipt refused; details withheld.') from None
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
