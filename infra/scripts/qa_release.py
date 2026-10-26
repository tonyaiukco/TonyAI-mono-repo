#!/usr/bin/env python3
"""Offline release binding and saved-plan policy. Never authenticates or applies."""
import argparse
import json
from candidate import clean_source
from qa_contract import GROUP, load, release, require, sha256
from qa_expected import body, canonical, identity


def check_plan(plan, inputs, acknowledge_clear_hold=False):
    """Compare the actual two resource plans, not caller-provided approval flags."""
    require(plan.get('errored') is not True)
    changes = plan.get('resource_changes', [])
    allowed = {f'azapi_resource.app["{kind}"]' for kind in ('api', 'web')}
    require({r.get('address') for r in changes} == allowed and len(changes) == 2)
    for row in changes:
        require(row.get('mode') == 'managed' and row.get('type') == 'azapi_resource')
        change = row['change']
        require(change['actions'] in (['create'], ['update'], ['no-op']))
        after = change['after']
        kind = 'api' if row['address'].endswith('["api"]') else 'web'
        require(after['parent_id'] == GROUP and after['name'] == f'tonyai-staging-{kind}'
                and after['location'] == 'swedencentral')
        expected = body(inputs, kind)
        require(canonical(after['body']) == canonical(expected))
        require(len(after['identity']) == 1)
        actual_identity = after['identity'][0]
        require(set(actual_identity) <= {'type', 'identity_ids', 'principal_id', 'tenant_id'})
        require(actual_identity['type'] == 'UserAssigned' and actual_identity['identity_ids'] == [identity(kind)])
        require(after['type'] == 'Microsoft.App/containerApps@2025-01-01')
        require(after.get('sensitive_body') is None and after.get('sensitive_body_version') is None)
        require(after.get('response_export_values') == ['properties.configuration.ingress.fqdn', 'properties.latestReadyRevisionName'])
        require(all(value is None for key, value in after.items() if key.endswith(('_headers', '_query_parameters'))))
        require(not has_unknown(change.get('after_unknown', {}).get('body', False)))
        if change['actions'] == ['update']:
            require(change['before']['body']['properties']['template']['revisionSuffix'] != inputs['release']['release_id'])
        if kind == 'api' and not inputs['release']['storage_cleanup_hold']:
            before = change.get('before') or {}
            containers = before.get('body', {}).get('properties', {}).get('template', {}).get('containers', [])
            holds = [item.get('value') for container in containers for item in container.get('env', []) if item.get('name') == 'STORAGE_CLEANUP_HOLD']
            require(holds == ['0'] or acknowledge_clear_hold)
        props = expected['properties']
        require(props['template']['containers'][0]['image'] ==
                f"{inputs['foundation']['registry_name']}.azurecr.io/tonyai/{kind}@{inputs['release'][kind + '_digest']}")
        require(props['template']['revisionSuffix'] == inputs['release']['release_id'])
    require(plan['variables']['foundation']['value'] == inputs['foundation'])
    # Optional fields are normalized by Terraform's object type; compare supplied values.
    actual = plan['variables']['release']['value']
    require(all(actual.get(k) == v for k, v in inputs['release'].items()))


def has_unknown(value):
    if isinstance(value, dict):
        return any(has_unknown(v) for v in value.values())
    if isinstance(value, list):
        return any(has_unknown(v) for v in value)
    return value is True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--plan')
    parser.add_argument('--ack-clear-storage-hold', action='store_true')
    args = parser.parse_args()
    try:
        inputs = release(load(args.inputs), load(args.candidate))
        clean_source(inputs['release']['source_sha'])
        if args.plan:
            check_plan(load(args.plan), inputs, args.ack_clear_storage_hold)
        digest = sha256(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode())
    except Exception:
        raise SystemExit('FAIL: QA release/plan refused; details withheld.') from None
    print(f'PASS: offline QA release binding sha256={digest}; no live acceptance or authorization.')


if __name__ == '__main__':
    main()
