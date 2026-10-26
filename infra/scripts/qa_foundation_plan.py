"""Exact initial-foundation JSON policy; computed references need bound source."""
from qa_contract import GROUP, SUBNET, SUBSCRIPTION, fields, match, require
from qa_foundation_expected import expected
from qa_foundation_inputs import initial_inputs, UUID
from qa_release import has_unknown

DEFAULT_OPTIONS = dict(ignore_casing=False, ignore_missing_property=True,
                       ignore_null_property=False, schema_validation_enabled=True)
EMPTY_OPTIONS = ('locks', 'replace_triggers_external_values', 'replace_triggers_refs',
                 'retry', 'sensitive_body', 'sensitive_body_version', 'timeouts') + tuple(
    f'{verb}_{suffix}' for verb in ('create', 'read', 'update', 'delete') for suffix in ('headers', 'query_parameters'))


def compare(wanted, actual, unknown, allowed=frozenset(), path=()):
    """Only individual, source-bound leaves can be unknown; never a whole body."""
    if unknown is True:
        require(path in allowed and actual is None)
        return
    if isinstance(wanted, dict):
        require(isinstance(actual, dict) and isinstance(unknown, (dict, bool)))
        masks = unknown if isinstance(unknown, dict) else {}
        require(set(actual) <= set(wanted) and set(masks) <= set(wanted))
        for key, value in wanted.items():
            require(key in actual or masks.get(key) is True or value is None)
            compare(value, actual.get(key), masks.get(key, False), allowed, path + (key,))
    elif isinstance(wanted, list):
        require(isinstance(actual, list) and len(actual) == len(wanted))
        masks = unknown if isinstance(unknown, list) else [False] * len(wanted)
        require(unknown is False or isinstance(unknown, list) and len(masks) == len(wanted))
        for index, value in enumerate(wanted):
            compare(value, actual[index], masks[index], allowed, path + (index,))
    else:
        require(unknown is False and type(actual) is type(wanted) and actual == wanted)


def reference_paths(address):
    paths = {('parent_id',)} if address != 'azapi_resource.group' else set()
    if address == 'azapi_resource.diagnostics':
        paths.add(('body', 'properties', 'workspaceId'))
    if address == 'azapi_resource.join_role':
        paths |= {('name',), ('body', 'properties', 'assignableScopes', 0)}
    if address.startswith('azapi_resource.grant['):
        paths.add(('name',))
        if address != 'azapi_resource.grant["owner_secrets"]':
            paths.add(('body', 'properties', 'principalId'))
    return paths


def check_outputs(outputs, config, source_bound):
    require(set(outputs) == {'application_contract', 'oidc_client_id'})
    oidc = outputs['oidc_client_id']
    require(oidc.get('after') is None and oidc.get('before') is None
            and oidc['actions'] in (['no-op'], ['create']) and not has_unknown(oidc.get('after_unknown', False)))
    contract = outputs['application_contract']
    require(contract['actions'] == ['create'] and contract.get('before') is None)
    value = dict(subscription_id=SUBSCRIPTION, tenant_id=config['tenant_id'], environment='staging',
                 region='swedencentral', resource_group='tonyai-staging-apps', prefix='tonyai',
                 registry_name=config['registry_name'], vault_name=config['vault_name'], apps_subnet_id=SUBNET,
                 default_domain=contract['after'].get('default_domain'))
    if value['default_domain'] is not None:
        match(r'[a-z0-9-]+\.swedencentral\.azurecontainerapps\.io', value['default_domain'])
    compare(value, contract['after'], contract.get('after_unknown', False),
            {('default_domain',)} if source_bound else set())
    require(all(not has_unknown(row.get('after_sensitive', False)) for row in outputs.values()))


def check_plan(plan, inputs, *, source_bound=False):
    config = initial_inputs(inputs)
    require(plan.get('terraform_version') == '1.13.3' and plan.get('format_version') in ('1.0', '1.1', '1.2'))
    require(plan.get('complete') is True and plan.get('errored') is False
            and plan.get('applyable') is True and not plan.get('resource_drift') and not plan.get('deferred_changes'))
    require(plan.get('variables') == {'config': {'value': config}})
    require(not plan.get('prior_state', {}).get('values', {}).get('root_module', {}).get('resources')
            and not plan.get('prior_state', {}).get('values', {}).get('root_module', {}).get('child_modules'))
    changes = plan['resource_changes']
    rows = {r['address']: r for r in changes}
    require(len(rows) == len(changes) == 15 and set(rows) == set(expected(config)))
    principals = {}
    for kind in ('api', 'web'):
        output = rows[f'azapi_resource.identity["{kind}"]']['change']['after'].get('output') or {}
        principal = output.get('properties', {}).get('principalId')
        if principal is not None:
            match(UUID, principal)
            principals[kind] = principal
    if len(principals) == 2:
        require(principals['api'] != principals['web'])
    for address, wanted in expected(config, principals).items():
        check_resource(rows[address], wanted, source_bound)
    check_outputs(plan['output_changes'], config, source_bound)
    return {'resource_count': 15, 'actions': {'create': 15},
            'computed_references_require_post_apply_readback': True}


def check_resource(row, wanted, source_bound):
    require(row.get('mode') == 'managed' and row.get('type') == 'azapi_resource'
            and row.get('provider_name') == 'registry.terraform.io/azure/azapi')
    require(not any(row.get(k) for k in ('module_address', 'previous_address', 'deposed')))
    change = row['change']
    require(change['actions'] == ['create'] and change.get('before') is None)
    require(not any(change.get(k) for k in ('importing', 'generated_config'))
            and not has_unknown(change.get('after_sensitive', False)))
    actual, unknown = dict(change['after']), dict(change.get('after_unknown', {}))
    for key in ('id', 'output'):
        actual.pop(key, None)
        unknown.pop(key, None)
    allowed = reference_paths(row['address']) if source_bound else set()
    for key in ('location', 'tags'):
        if wanted[key] is None:
            require(actual.get(key) in (None, '', {}) and unknown.get(key, False) in (False, True, {}))
            actual.pop(key, None)
            unknown.pop(key, None)
            wanted.pop(key)
    for key, value in DEFAULT_OPTIONS.items():
        if unknown.pop(key, False) is not True:
            require(type(actual.get(key)) is bool and actual[key] == value)
        actual.pop(key, None)
    # Unknown inert defaults in a mock are permitted, unknown request extensions are not.
    for key in EMPTY_OPTIONS:
        require(actual.pop(key, None) is None and not has_unknown(unknown.pop(key, False)))
    require(actual.pop('identity', []) == [] and not has_unknown(unknown.pop('identity', False)))
    compare(wanted, actual, unknown, allowed)
