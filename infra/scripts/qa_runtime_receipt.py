"""Public metadata only: strict fresh Unit 4 observations and exact role delta."""
from datetime import datetime, timezone
import re
from qa_contract import SUBSCRIPTION, fields, match, require
from qa_discovery import digest, timestamp, verify_record
from qa_foundation_expected import expected
from qa_foundation_readback import manifest as foundation_manifest, verify_receipt as foundation_receipt
from qa_runtime_contract import predecessor, grants, check_roles, SECRETS


def metadata_inputs(config):
    return {'config': {**config, 'runtime_secrets_ready': False}}


def metadata_time(value):
    # Azure CLI serializes SecretItem datetimes with a UTC offset; collection
    # boundaries retain the existing strict Z receipt format.
    match(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)', value)
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def manifest(request, evidence, plan_hash, phase):
    before, after, _, _ = predecessor(request, evidence)
    require(phase in ('before', 'after'))
    match(r'[a-f0-9]{64}', plan_hash)
    config = before if phase == 'before' else after
    commands = foundation_manifest(metadata_inputs(config))['commands']
    commands['account'] = {'argv': ['az', 'account', 'show', '--subscription', SUBSCRIPTION,
        '--query', '{subscription_id:id,tenant_id:tenantId}', '--only-show-errors', '--output', 'json'], 'pagination': 'single'}
    for name in SECRETS:
        # list-versions returns SecretItem metadata, never SecretBundle/value.
        # Azure CLI exhausts its pager; receipt also explicitly attests complete.
        commands['secret-' + name] = {'argv': ['az', 'keyvault', 'secret', 'list-versions',
            '--vault-name', config['vault_name'], '--name', name, '--subscription', SUBSCRIPTION,
            '--query', '[].{id:id,enabled:attributes.enabled,not_before:attributes.notBefore,expires:attributes.expires}',
            '--only-show-errors', '--output', 'json'], 'pagination': 'cli-all'}
    return dict(schema=1, source_sha=after['release_sha'], request_sha256=digest(request),
                predecessor_sha256=digest(evidence), plan_sha256=plan_hash, phase=phase, commands=commands)


def verify(request, evidence, plan_hash, receipt, phase, *, not_before, now=None):
    before, after, historical, principals = predecessor(request, evidence, now=now)
    spec = manifest(request, evidence, plan_hash, phase)
    fields(receipt, 'source_sha request_sha256 predecessor_sha256 plan_sha256 phase manifest_sha256 started_at completed_at records')
    require(all(receipt[k] == spec[k] for k in ('source_sha', 'request_sha256', 'predecessor_sha256', 'plan_sha256', 'phase'))
            and receipt['manifest_sha256'] == digest(spec))
    start, end = timestamp(receipt['started_at']), timestamp(receipt['completed_at'])
    now = now or datetime.now(timezone.utc)
    require(timestamp(evidence['readback']['completed_at']) <= timestamp(not_before) <= start <= end <= now
            and (now - start).total_seconds() <= 3600
            and (end - start).total_seconds() <= 1800)
    records = {r['key']: r for r in receipt['records']}
    require(len(records) == len(receipt['records']) and set(records) == set(spec['commands']))
    data = {k: verify_record(records[k], s, start, end) for k, s in spec['commands'].items()}
    require(data['account'] == {'subscription_id': SUBSCRIPTION, 'tenant_id': after['tenant_id']})
    config = before if phase == 'before' else after
    subinputs = metadata_inputs(config)
    submanifest = foundation_manifest(subinputs)
    subreceipt = {k: receipt[k] for k in ('started_at', 'completed_at')}
    subreceipt.update(source_sha=config['release_sha'], manifest_sha256=digest(submanifest),
                      records=[records[k] for k in submanifest['commands']])
    observed, actual_principals = foundation_receipt(subinputs, subreceipt, now=now)
    require(actual_principals == principals)
    require(observed['azapi_resource.environment']['default_domain'] == historical['azapi_resource.environment']['default_domain'])
    resources = expected(config, principals)
    if phase == 'after':
        resources.update(grants(config, principals))
    roles = check_roles(observed['roles'], resources, principals)
    versions = {}
    for name in SECRETS:
        rows = data['secret-' + name]
        require(isinstance(rows, list))
        prefix = f'https://{config["vault_name"]}.vault.azure.net/secrets/{name}/'
        for row in rows:
            fields(row, 'id enabled not_before expires')
            match(re.escape(prefix) + r'[a-f0-9]{32}', row['id'])
            require(type(row['enabled']) is bool)
        indexed = {r['id']: r for r in rows}
        require(len(indexed) == len(rows))
        selected = indexed[prefix + request['secret_versions'][name]]
        require(selected['enabled'] is True)
        require(selected['not_before'] is None or metadata_time(selected['not_before']) <= start)
        require(selected['expires'] is None or metadata_time(selected['expires']) > now)
        versions[name] = selected
    return {'receipt_sha256': digest(receipt), 'manifest_sha256': digest(spec),
            'started_at': receipt['started_at'], 'completed_at': receipt['completed_at'],
            'roles': roles, 'secret_metadata': versions}


def verify_after(request, evidence, plan_hash, before_receipt, after_receipt, *, plan_completed_at,
                 apply_started_at, apply_completed_at, now=None):
    before = verify(request, evidence, plan_hash, before_receipt, 'before', not_before=plan_completed_at, now=now)
    require(timestamp(before['completed_at']) <= timestamp(apply_started_at) <= timestamp(apply_completed_at))
    after = verify(request, evidence, plan_hash, after_receipt, 'after', not_before=apply_completed_at, now=now)
    _, config, _, principals = predecessor(request, evidence, now=now)
    from qa_runtime_contract import role_rows
    added = role_rows(grants(config, principals))
    require(not set(before['roles']) & set(added)
            and after['roles'] == {**before['roles'], **added}
            and before['secret_metadata'] == after['secret_metadata'])
    return {'status': 'OFFLINE_READBACK_CONSISTENCY_ONLY', 'authorization': False,
            'authenticated_azure_provenance': False, 'effective_permissions_proven': False,
            'before_receipt_sha256': before['receipt_sha256'], 'after_receipt_sha256': after['receipt_sha256'],
            'added_assignment_ids': sorted(added)}


def main():
    import argparse
    import json
    from qa_contract import load
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('manifest', 'verify'))
    for name in ('request', 'predecessor', 'plan-sha256'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--phase', choices=('before', 'after'))
    for name in ('before', 'after', 'plan-created-at', 'plan-completed-at', 'apply-started-at', 'apply-completed-at'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    try:
        request, evidence = load(args.request), load(args.predecessor)
        if args.operation == 'manifest':
            result = manifest(request, evidence, args.plan_sha256, args.phase)
        else:
            require(timestamp(evidence['readback']['completed_at']) <= timestamp(args.plan_created_at)
                    <= timestamp(args.plan_completed_at))
            result = verify_after(request, evidence, args.plan_sha256, load(args.before), load(args.after),
                plan_completed_at=args.plan_completed_at, apply_started_at=args.apply_started_at,
                apply_completed_at=args.apply_completed_at)
    except Exception:
        raise SystemExit('FAIL: QA Unit 4 metadata/readback refused; details withheld.') from None
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
