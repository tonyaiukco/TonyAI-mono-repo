"""Unit 5 transition and historical Unit 4 chain; consistency is not provenance."""
from datetime import datetime, timezone
from qa_contract import fields, match, require
from qa_discovery import digest, timestamp
from qa_foundation_inputs import initial_inputs
from qa_foundation_expected import expected
from qa_runtime_contract import predecessor as runtime_predecessor, grants
from qa_runtime_receipt import verify_after
from qa_oidc_expected import resource_id


def transition(request):
    fields(request, 'before_inputs after_inputs predecessor_sha256')
    configs = []
    for phase, oidc in (('before', False), ('after', True)):
        value = request[phase + '_inputs']
        fields(value, 'config')
        config = value['config']
        require(config.get('runtime_secrets_ready') is True and config.get('oidc_enabled') is oidc)
        normalized = initial_inputs({'config': {**config, 'runtime_secrets_ready': False, 'oidc_enabled': False}})
        configs.append({**normalized, 'runtime_secrets_ready': True, 'oidc_enabled': oidc})
    before, after = configs
    require({k: v for k, v in before.items() if k not in ('oidc_enabled', 'release_sha')} ==
            {k: v for k, v in after.items() if k not in ('oidc_enabled', 'release_sha')})
    match(r'[a-f0-9]{64}', request['predecessor_sha256'])
    return before, after


def predecessor(request, evidence, *, now=None):
    before, after = transition(request)
    fields(evidence, 'runtime_request initial_predecessor saved_plan before_receipt after_receipt '
           'plan_completed_at apply_started_at apply_completed_at owner_acceptance_sha256')
    require(digest(evidence) == request['predecessor_sha256'])
    match(r'[a-f0-9]{64}', evidence['owner_acceptance_sha256'])
    req, initial, report = evidence['runtime_request'], evidence['initial_predecessor'], evidence['saved_plan']
    old, accepted, data, principals = runtime_predecessor(req, initial, now=now)
    require(before == accepted)
    fields(report, 'resource_count actions resources grants principals source_tag_change source_sha previous_source_sha '
           'saved_plan_path terraform_path terraform_version terraform_binary_sha256 plan_created_at plan_sha256 '
           'request_sha256 predecessor_sha256 previous_plan_sha256 previous_readback_sha256 previous_owner_acceptance_sha256 '
           'before_inputs_sha256 after_inputs_sha256 provider_lock_sha256 deployment_policy_sha256 configuration_sha256', 'file_sha256')
    require(report['resource_count'] == 17 and report['terraform_version'] == '1.13.3'
            and report['source_sha'] == accepted['release_sha'] and report['previous_source_sha'] == old['release_sha']
            and report['request_sha256'] == digest(req) and report['predecessor_sha256'] == digest(initial)
            and report['before_inputs_sha256'] == digest(old) and report['after_inputs_sha256'] == digest(accepted)
            and report['previous_plan_sha256'] == initial['initial_plan']['plan_sha256']
            and report['previous_readback_sha256'] == digest(initial['readback'])
            and report['previous_owner_acceptance_sha256'] == initial['owner_acceptance_sha256'])
    for key, value in report.items():
        if key.endswith('_sha256') and key != 'file_sha256':
            match(r'[a-f0-9]{64}', value)
    for key in ('saved_plan_path', 'terraform_path'):
        require(isinstance(report[key], str) and report[key].startswith('/'))
    for value in report.get('file_sha256', {}).values():
        match(r'[a-f0-9]{64}', value)
    changed = old['release_sha'] != accepted['release_sha']
    resources = {**expected(accepted, principals), **grants(accepted, principals)}
    require(report['actions'] == {'create': 2, 'update': int(changed), 'no-op': 15-int(changed)}
            and report['principals'] == principals and report['grants'] == list(grants(accepted, principals).values())
            and report['source_tag_change'] == ({'before': old['release_sha'], 'after': accepted['release_sha']} if changed else None))
    require(report['resources'] == [{'address': k, 'id': resource_id(v), 'actions':
        ['create'] if k in grants(accepted, principals) else ['update'] if k == 'azapi_resource.group' and changed else ['no-op']}
        for k, v in sorted(resources.items())])
    completed = timestamp(evidence['after_receipt']['completed_at'])
    require(completed <= (now or datetime.now(timezone.utc)))
    require(timestamp(initial['readback']['completed_at']) <= timestamp(report['plan_created_at'])
            <= timestamp(evidence['plan_completed_at']))
    verify_after(req, initial, report['plan_sha256'], evidence['before_receipt'], evidence['after_receipt'],
        plan_completed_at=evidence['plan_completed_at'], apply_started_at=evidence['apply_started_at'],
        apply_completed_at=evidence['apply_completed_at'], now=completed)
    # Historical observations are validated at their own completion, never fresh.
    return before, after, data, principals
