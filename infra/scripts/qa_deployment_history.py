"""Historical Unit 7 consistency; acceptance references never authenticate provenance."""
from qa_contract import GROUP, fields, match, release, require
from qa_discovery import digest, timestamp
from qa_application_receipt import verify_receipt, expected_names
from qa_expected import body
from qa_deployment_source import historical_source, bind_report
from qa_oidc_receipt import normalized
from qa_expected import identity


def app_identities(apps, snapshot):
    for kind, app in apps.items():
        assigned = app['identity']['userAssignedIdentities']
        known = snapshot['identities'][identity(kind).lower()]
        fields(assigned[identity(kind)], 'principalId clientId')
        require(normalized(assigned[identity(kind)]) == dict(principalId=known['principal_id'], clientId=known['client_id']))


def acceptance(value, unit, report, receipt):
    fields(value, 'unit decision_sha256 report_sha256 after_receipt_sha256 accepted_at')
    require(value['unit'] == unit and type(value['unit']) is int
            and value['report_sha256'] == digest(report) and value['after_receipt_sha256'] == digest(receipt))
    match(r'[a-f0-9]{64}', value['decision_sha256'])
    require(timestamp(receipt['completed_at']) <= timestamp(value['accepted_at']))
    return value['accepted_at']


def application(evidence, foundation, unit5_accepted_at, versions, snapshot, *, now):
    fields(evidence, 'inputs candidate candidate_provenance saved_plan outgoing_revisions before_receipt drained_receipt '
           'after_receipt plan_completed_at apply_started_at apply_completed_at owner_acceptance')
    inputs, candidate, report = (evidence[k] for k in ('inputs', 'candidate', 'saved_plan'))
    with historical_source(inputs['release']['source_sha']) as root:
        release(inputs, candidate, root=root)
        bind_report(report, root, 'application')
    require(inputs['foundation'] == foundation and not inputs['release'].get('mail'))
    require(inputs['release']['database_secret_version'] == versions['database-url']
            and inputs['release']['backend_secret_version'] == versions['supabase-service-role-key'])
    fields(report, 'source_sha release_id terraform_version terraform_binary_sha256 plan_created_at plan_sha256 '
           'normalized_inputs_sha256 candidate_sha256 provider_lock_sha256 configuration_sha256 resources '
           'input_file_sha256 candidate_file_sha256')
    for key, value in report.items():
        if key.endswith('_sha256'): match(r'[a-f0-9]{64}', value)
    require(report['source_sha'] == inputs['release']['source_sha'] and report['release_id'] == inputs['release']['release_id']
            and report['normalized_inputs_sha256'] == digest(inputs) and report['candidate_sha256'] == digest(candidate)
            and report['terraform_version'] == '1.13.3')
    provenance = evidence['candidate_provenance']
    fields(provenance, 'verification repository source_sha run_id artifact_id archive_sha256 candidate_file_sha256')
    require(provenance['verification'] == 'github_api_run_and_archive_digest'
            and provenance['repository'] == 'tonyaiukco/TonyAI-mono-repo'
            and provenance['source_sha'] == report['source_sha']
            and provenance['candidate_file_sha256'] == report['candidate_file_sha256']
            and type(provenance['artifact_id']) is int and provenance['artifact_id'] > 0)
    match(r'[1-9][0-9]*', provenance['run_id']); match(r'[a-f0-9]{64}', provenance['archive_sha256'])
    names, plan_hash = evidence['outgoing_revisions'], report['plan_sha256']
    boundary = evidence['plan_completed_at']
    require(timestamp(unit5_accepted_at) <= timestamp(report['plan_created_at']) <= timestamp(boundary))
    observation_end = timestamp(evidence['after_receipt']['completed_at'])
    before = verify_receipt(inputs, plan_hash, evidence['before_receipt'], names, 'before',
        not_before=boundary, now=observation_end)
    rows = report['resources']
    require(len(rows) == 2 and [r['address'] for r in rows] == [f'azapi_resource.app["{k}"]' for k in ('api', 'web')])
    for kind, row in zip(('api', 'web'), rows):
        fields(row, 'address actions expected_body_sha256 previous_body_sha256 id')
        require(row['id'] == GROUP + '/providers/Microsoft.App/containerApps/tonyai-staging-' + kind
                and row['expected_body_sha256'] == digest(body(inputs, kind)))
        if before['mode'] == 'first_deployment':
            require(row['actions'] == ['create'] and row['previous_body_sha256'] is None)
        else:
            require(row['actions'] == ['update']); match(r'[a-f0-9]{64}', row['previous_body_sha256'])
    end = evidence['before_receipt']['completed_at']
    if before['mode'] == 'existing_revision_update':
        drained = evidence['drained_receipt']
        verify_receipt(inputs, plan_hash, drained, names, 'drained', not_before=end, outgoing=names,
                       now=observation_end)
        end = drained['completed_at']
    else:
        require(evidence['drained_receipt'] is None)
    require(timestamp(end) <= timestamp(evidence['apply_started_at']) <= timestamp(evidence['apply_completed_at']))
    after_names = expected_names(inputs, names, 'after')
    verify_receipt(inputs, plan_hash, evidence['after_receipt'], after_names, 'after',
        not_before=evidence['apply_completed_at'], outgoing=names, now=observation_end)
    apps = {r['key'].removesuffix('_app'): r['pages'][0]['result'] for r in evidence['after_receipt']['records']
            if r['key'] in ('api_app', 'web_app')}
    app_identities(apps, snapshot)
    accepted = acceptance(evidence['owner_acceptance'], 7, report, evidence['after_receipt'])
    require(timestamp(accepted) <= now)
    return inputs, after_names, accepted
