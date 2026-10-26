"""Fresh Unit 8 snapshots: preserve the accepted apps, add exactly two assignments."""
from copy import deepcopy
from datetime import datetime, timezone
from qa_contract import GROUP, fields, require
from qa_discovery import digest, timestamp, verify_record
from qa_oidc_receipt import manifest as oidc_manifest, check_snapshot, normalized
from qa_oidc_expected import role_rows, resource_id
from qa_application_receipt import manifest as app_manifest, verify_receipt
from qa_application_policy import tags
from qa_deployment_expected import grants
from qa_deployment_report import validate
from qa_deployment_history import app_identities


def manifests(request, evidence, report, *, now=None):
    context = validate(request, evidence, report, now=now)
    unit = evidence['unit5']
    commands = oidc_manifest(unit['oidc_request'], unit['runtime_predecessor'], report['plan_sha256'], 'after')['commands']
    apps = app_manifest(context['inputs'], report['plan_sha256'], context['revision_names'], 'after')
    commands.update({'app:' + k: v for k, v in apps['commands'].items()})
    return {phase: dict(schema=1, unit=8, source_sha=report['source_sha'], request_sha256=digest(request),
        predecessor_sha256=digest(evidence), report_sha256=digest(report), plan_sha256=report['plan_sha256'],
        application_inputs_sha256=digest(context['inputs']), phase=phase, commands=deepcopy(commands))
        for phase in ('before', 'after')}


def empty_tags(snapshot):
    """Normalize only source-defined empty release-identity tags, never arbitrary metadata."""
    snapshot = deepcopy(snapshot)
    for key, row in snapshot['identities'].items():
        if row['principal_id'] == snapshot['release_principal_id']:
            require(row['tags'] in (None, {})); row['tags'] = {}
            require(snapshot['resources'][key]['tags'] in (None, {})); snapshot['resources'][key]['tags'] = {}
    return snapshot


def verify(request, evidence, report, receipt, phase, *, not_before, now=None):
    context = validate(request, evidence, report, now=now)
    spec = manifests(request, evidence, report, now=now)[phase]
    keys = 'source_sha request_sha256 predecessor_sha256 report_sha256 plan_sha256 application_inputs_sha256 phase'
    fields(receipt, keys + ' manifest_sha256 started_at completed_at records')
    require(all(receipt[k] == spec[k] for k in keys.split()) and receipt['manifest_sha256'] == digest(spec))
    start, end = timestamp(receipt['started_at']), timestamp(receipt['completed_at'])
    now = now or datetime.now(timezone.utc)
    require(timestamp(context['accepted_at']) <= timestamp(report['plan_created_at']) <= timestamp(not_before) <= start <= end <= now
            and (now-start).total_seconds() <= 3600 and (end-start).total_seconds() <= 1800)
    rows = {r['key']: r for r in receipt['records']}
    require(len(rows) == len(receipt['records']) and set(rows) == set(spec['commands']))
    data = {k: verify_record(rows[k], v, start, end) for k, v in spec['commands'].items()}
    # Reuse the unchanged Unit 7 AFTER oracle for both observations, with this new plan and window.
    inputs, names = context['inputs'], context['revision_names']
    app_spec = app_manifest(inputs, report['plan_sha256'], names, 'after')
    app_receipt = {k: app_spec[k] for k in ('source_sha', 'release_id', 'inputs_sha256', 'plan_sha256', 'phase', 'revision_names')}
    app_receipt.update(manifest_sha256=digest(app_spec), started_at=receipt['started_at'], completed_at=receipt['completed_at'],
        records=[{**rows['app:'+k], 'key': k} for k in app_spec['commands']])
    verify_receipt(inputs, report['plan_sha256'], app_receipt, names, 'after', not_before=not_before,
                   outgoing=evidence['unit7']['outgoing_revisions'], now=now)
    config = context[phase]
    new = {k.lower(): normalized(v) for k, v in role_rows(grants(report['release_principal_id'])).items()}
    full_roles = data['roles']
    # The Unit 5 oracle must still see exactly its old grant surface.
    data['roles'] = [r for r in full_roles if r['id'].lower() not in new]
    snapshot = empty_tags(check_snapshot(config, context['data'], context['principals'], data, 'after'))
    from qa_oidc_receipt import indexed
    snapshot['roles'] = indexed(full_roles, 'id scope principalId principalType roleDefinitionId condition conditionVersion delegated')
    historical = empty_tags(context['snapshot'])
    require(snapshot['identities'] == historical['identities']
            and snapshot['release_principal_id'] == report['release_principal_id'] and snapshot['oidc_client_id'] == report['oidc_client_id'])
    wanted_roles = historical['roles']
    require(not set(wanted_roles) & set(new))
    require(snapshot['roles'] == ({**wanted_roles, **new} if phase == 'after' else wanted_roles))
    inventory = deepcopy(historical['resources'])
    for kind in ('api', 'web'):
        key = (GROUP + '/providers/Microsoft.App/containerApps/tonyai-staging-' + kind).lower()
        require(key not in inventory)
        inventory[key] = dict(id=key, type='Microsoft.App/containerApps', location='swedencentral', tags=tags(inputs))
    if phase == 'after' and context['before']['release_sha'] != config['release_sha'] and GROUP.lower() in inventory:
        inventory[GROUP.lower()]['tags']['releaseSha'] = config['release_sha']
    require(snapshot['resources'] == normalized(inventory))
    app_identities({k: data['app:'+k+'_app'] for k in ('api', 'web')}, snapshot)
    group_prefix = (GROUP + '/providers/Microsoft.App/containerApps/').lower()
    listed = {r['id'][len(group_prefix):] for r in snapshot['resources'].values()
              if r['id'].startswith(group_prefix) and r['type'].lower() == 'microsoft.app/containerapps'}
    require(set(data['app:inventory']) == listed)
    return dict(receipt_sha256=digest(receipt), manifest_sha256=digest(spec), started_at=receipt['started_at'],
                completed_at=receipt['completed_at'], snapshot=snapshot,
                application={k: v for k, v in data.items() if k.startswith('app:')})


def verify_after(request, evidence, report, before_receipt, after_receipt, *, plan_completed_at,
                 apply_started_at, apply_completed_at, now=None):
    before = verify(request, evidence, report, before_receipt, 'before', not_before=plan_completed_at, now=now)
    require(timestamp(before['completed_at']) <= timestamp(apply_started_at) <= timestamp(apply_completed_at))
    after = verify(request, evidence, report, after_receipt, 'after', not_before=apply_completed_at, now=now)
    require(before['application'] == after['application'])
    return dict(status='OFFLINE_READBACK_CONSISTENCY_ONLY', authorization=False, authenticated_azure_provenance=False,
        effective_permissions_proven=False, before_receipt_sha256=before['receipt_sha256'], after_receipt_sha256=after['receipt_sha256'],
        added_assignment_ids=sorted(resource_id(v) for v in grants(report['release_principal_id']).values()))


def main():
    import argparse
    import json
    from qa_contract import load
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('manifest', 'verify'))
    for name in ('request', 'predecessor', 'packet'): parser.add_argument('--'+name, required=True)
    for name in ('before', 'after', 'plan-completed-at', 'apply-started-at', 'apply-completed-at'): parser.add_argument('--'+name)
    args = parser.parse_args()
    try:
        req, ev, report = load(args.request), load(args.predecessor), load(args.packet)['binding']
        result = manifests(req, ev, report) if args.operation == 'manifest' else verify_after(req, ev, report,
            load(args.before), load(args.after), plan_completed_at=args.plan_completed_at,
            apply_started_at=args.apply_started_at, apply_completed_at=args.apply_completed_at)
    except Exception:
        raise SystemExit('FAIL: QA Unit 8 public readback refused; details withheld.') from None
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__': main()
