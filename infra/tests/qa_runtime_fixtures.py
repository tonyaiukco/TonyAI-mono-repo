"""Synthetic Unit 4 evidence; never owner execution inputs or authenticated receipts."""
from copy import deepcopy
from qa_contract import sha256
from qa_discovery import digest, timestamp
from qa_foundation import QA_ROOT
from qa_foundation_inputs import initial_inputs
from qa_foundation_expected import expected, resource_id
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS
from qa_foundation_readback import manifest as initial_manifest
from qa_preflight_fixtures import inputs, PRINCIPALS, plan as initial_plan, record
from qa_runtime_contract import grants, role_rows
from qa_runtime_plan import exported
from qa_runtime_receipt import manifest

OLD = '2026-10-25T10:00:00Z'
PLAN = '2026-10-25T11:00:00Z'
BEFORE = '2026-10-25T11:01:00Z'
APPLY = '2026-10-25T11:02:00Z'
AFTER = '2026-10-25T11:03:00Z'
NOW = timestamp(AFTER)


def foundation_data(config):
    data = {}
    resources = expected(config, PRINCIPALS)
    for address, row in resources.items():
        if address.startswith('azapi_resource.grant['):
            continue
        data[address] = dict(id=resource_id(row), location=row['location'], tags=row['tags'],
                             body=deepcopy(row['body']), provisioning_state='Succeeded')
        if address.startswith('azapi_resource.identity['):
            data[address]['principal_id'] = PRINCIPALS['api' if '"api"' in address else 'web']
        if address == 'azapi_resource.environment':
            data[address]['default_domain'] = 'example.swedencentral.azurecontainerapps.io'
    data['roles'] = list(role_rows(resources).values())
    return data


def records(spec, data, stamp):
    result = [record(k, v, data[k]) for k, v in spec['commands'].items()]
    for row in result:
        for page in row['pages']:
            page.update(started_at=stamp, completed_at=stamp)
    return result


def evidence():
    config = initial_inputs(inputs())
    spec = initial_manifest(inputs())
    receipt = dict(source_sha=config['release_sha'], manifest_sha256=digest(spec), started_at=OLD, completed_at=OLD,
                   records=records(spec, foundation_data(config), OLD))
    report = dict(status='OFFLINE_PLAN_CHECK_ONLY', authorization=False, live_acceptance=False,
        resource_count=15, actions={'create': 15}, computed_references_require_post_apply_readback=True,
        source_sha=config['release_sha'], plan_sha256='1'*64, normalized_inputs_sha256=digest(config),
        provider_lock_sha256=sha256((QA_ROOT / '.terraform.lock.hcl').read_bytes()), input_file_sha256='2'*64)
    return dict(initial_plan=report, readback=receipt, owner_acceptance_sha256='3'*64)


def request():
    before = inputs()
    after = deepcopy(before)
    after['config'].update(runtime_secrets_ready=True, release_sha='b'*40)
    return dict(before_inputs=before, after_inputs=after, predecessor_sha256=digest(evidence()),
                secret_versions={'database-url': 'a'*32, 'supabase-service-role-key': 'b'*32})


def plan():
    req = request()
    before = initial_inputs(req['before_inputs'])
    after = {**before, **req['after_inputs']['config']}
    data = foundation_data(before)
    rows, prior = [], []
    for address, wanted in expected(before, PRINCIPALS).items():
        value = {**deepcopy(wanted), **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS), 'identity': [],
                 'id': resource_id(wanted), 'output': exported(address, before, data, PRINCIPALS)}
        prior.append(dict(address=address, mode='managed', type='azapi_resource',
                          provider_name='registry.terraform.io/azure/azapi', values=deepcopy(value)))
        change = dict(actions=['no-op'], before=deepcopy(value), after=value, after_unknown={})
        if address == 'azapi_resource.group':
            change['actions'] = ['update']
            change['after']['tags']['releaseSha'] = after['release_sha']
        rows.append(dict(address=address, mode='managed', type='azapi_resource', provider_name='registry.terraform.io/azure/azapi', change=change))
    for address, wanted in grants(after, PRINCIPALS).items():
        value = {**wanted, **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS), 'identity': [],
                 'id': resource_id(wanted), 'output': {}}
        rows.append(dict(address=address, mode='managed', type='azapi_resource', provider_name='registry.terraform.io/azure/azapi',
                         change=dict(actions=['create'], before=None, after=value, after_unknown={})))
    outputs = initial_plan()['output_changes']
    for row in outputs.values():
        row.update(actions=['no-op'], before=deepcopy(row['after']))
    return dict(terraform_version='1.13.3', format_version='1.2', complete=True, errored=False, applyable=True,
                timestamp=PLAN, variables={'config': {'value': after}}, prior_state={'values': {'root_module': {'resources': prior}}},
                resource_changes=rows, output_changes=outputs)


def receipt(phase='before', plan_hash='4'*64):
    req, ev = request(), evidence()
    config = {**initial_inputs(req['before_inputs']), **req['after_inputs' if phase == 'after' else 'before_inputs']['config']}
    spec = manifest(req, ev, plan_hash, phase)
    data = foundation_data(config)
    if phase == 'after': data['roles'] += list(role_rows(grants(config, PRINCIPALS)).values())
    data['account'] = {k: config[k] for k in ('subscription_id', 'tenant_id')}
    for name, version in req['secret_versions'].items():
        data['secret-'+name] = [dict(id=f'https://{config["vault_name"]}.vault.azure.net/secrets/{name}/{version}',
                                     enabled=True, not_before=None, expires=None)]
    stamp = AFTER if phase == 'after' else BEFORE
    return {**{k: spec[k] for k in ('source_sha', 'request_sha256', 'predecessor_sha256', 'plan_sha256', 'phase')},
            'manifest_sha256': digest(spec), 'started_at': stamp, 'completed_at': stamp, 'records': records(spec, data, stamp)}
