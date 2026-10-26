"""Unit 4 public transition and predecessor bindings. Never authenticates evidence."""
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5
from qa_contract import SUBSCRIPTION, fields, match, require
from qa_discovery import digest, timestamp
from qa_foundation_inputs import initial_inputs, UUID
from qa_foundation_expected import expected, resource_id
from qa_foundation_readback import verify_receipt

SECRETS = ('database-url', 'supabase-service-role-key')
ROLE = '4633458b-17de-408a-b874-0445c86b69e6'


def transition(request):
    fields(request, 'before_inputs after_inputs predecessor_sha256 secret_versions')
    before = initial_inputs(request['before_inputs'])
    after = request['after_inputs']['config']
    require(after.get('runtime_secrets_ready') is True)
    normalized = initial_inputs({'config': {**after, 'runtime_secrets_ready': False}})
    fields(request['after_inputs'], 'config')
    require({k: v for k, v in before.items() if k != 'release_sha'} ==
            {k: v for k, v in normalized.items() if k != 'release_sha'})
    match(r'[a-f0-9]{64}', request['predecessor_sha256'])
    fields(request['secret_versions'], ' '.join(SECRETS))
    for value in request['secret_versions'].values():
        match(r'[a-f0-9]{32}', value)
    return before, {**normalized, 'runtime_secrets_ready': True}


def predecessor(request, evidence, *, now=None):
    before, after = transition(request)
    fields(evidence, 'initial_plan readback owner_acceptance_sha256')
    require(digest(evidence) == request['predecessor_sha256'])
    match(r'[a-f0-9]{64}', evidence['owner_acceptance_sha256'])
    report = evidence['initial_plan']
    fields(report, 'status authorization live_acceptance resource_count actions '
           'computed_references_require_post_apply_readback plan_sha256 source_sha '
           'normalized_inputs_sha256 provider_lock_sha256 input_file_sha256')
    require(report['status'] == 'OFFLINE_PLAN_CHECK_ONLY' and report['authorization'] is False
            and report['live_acceptance'] is False and report['resource_count'] == 15
            and report['actions'] == {'create': 15}
            and report['computed_references_require_post_apply_readback'] is True
            and report['source_sha'] == before['release_sha']
            and report['normalized_inputs_sha256'] == digest(before))
    for key in ('plan_sha256', 'provider_lock_sha256', 'input_file_sha256'):
        match(r'[a-f0-9]{64}', report[key])
    receipt = evidence['readback']
    completed = timestamp(receipt['completed_at'])
    require(completed <= (now or datetime.now(timezone.utc)))
    # Historical acceptance is retained, never called fresh. The new before
    # observation must independently re-establish this foundation before use.
    data, principals = verify_receipt(request['before_inputs'], receipt, now=completed)
    check_roles(data['roles'], expected(before, principals), principals)
    return before, after, data, principals


def grants(config, principals):
    vault = resource_id(expected(config)['azapi_resource.vault'])
    result = {}
    for secret in SECRETS:
        scope = vault + '/secrets/' + secret
        name = str(uuid5(NAMESPACE_URL, f'{scope}/{principals["api"]}/{ROLE}'.lower()))
        result[f'azapi_resource.grant["secret-{secret}"]'] = dict(
            type='Microsoft.Authorization/roleAssignments@2022-04-01', name=name,
            parent_id=scope, location=None, tags=None, response_export_values=[], body={'properties': {
                'principalId': principals['api'], 'principalType': 'ServicePrincipal',
                'roleDefinitionId': f'/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/{ROLE}'}})
    return result


def role_rows(resources):
    return {resource_id(v): dict(id=resource_id(v), scope=v['parent_id'], **v['body']['properties'],
            condition=None, conditionVersion=None, delegated=None)
            for k, v in resources.items() if k.startswith('azapi_resource.grant[')}


def check_roles(rows, resources, principals):
    require(isinstance(rows, list))
    for row in rows:
        fields(row, 'id scope principalId principalType roleDefinitionId condition conditionVersion delegated')
        match(UUID, row['principalId'].lower())
        match(r'/subscriptions/' + SUBSCRIPTION + r'(?:/[^\s]+)?', row['scope'])
        prefix = row['scope'] + '/providers/Microsoft.Authorization/roleAssignments/'
        require(isinstance(row['id'], str) and row['id'].startswith(prefix))
        match(UUID, row['id'][len(prefix):].lower())
    indexed = {r['id']: r for r in rows}
    require(len(indexed) == len(rows) == len({k.lower() for k in indexed}))
    wanted = role_rows(resources)
    require(all(indexed.get(k) == v for k, v in wanted.items()))
    # No additional direct assignment to either workload identity in this
    # observed subscription. Management-group/inherited access stays unproven.
    require(all(r['principalId'].lower() not in principals.values() or k in wanted for k, r in indexed.items()))
    return indexed
