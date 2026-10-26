"""Independent exact Unit 4 policy; initial foundation policy is unchanged."""
from copy import deepcopy
from datetime import datetime, timezone
from qa_contract import foundation, require, has_unknown
from qa_discovery import timestamp
from qa_foundation_expected import expected, resource_id
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS, compare
from qa_runtime_contract import predecessor, grants


def check_value(actual, unknown, wanted, output, *, computed=False):
    actual, unknown, wanted = deepcopy(actual), deepcopy(unknown), deepcopy(wanted)
    require(isinstance(unknown, dict))
    wanted.update(id=resource_id(wanted), output=output, identity=[], **DEFAULT_OPTIONS,
                  **dict.fromkeys(EMPTY_OPTIONS))
    allowed = {('id',), ('output',), ('location',), ('tags',)} | {(k,) for k in DEFAULT_OPTIONS} if computed else set()
    for key in ('location', 'tags'):
        if wanted[key] is None and not has_unknown(unknown.get(key, False)):
            require(actual.get(key) in ((None, '') if key == 'location' else (None, {})))
            wanted[key] = actual.get(key)
    compare(wanted, actual, unknown, allowed)


def exported(address, config, data, principals):
    if address.startswith('azapi_resource.identity['):
        return {'properties': {'principalId': principals['api' if '"api"' in address else 'web']}}
    if address == 'azapi_resource.environment':
        return {'properties': {'defaultDomain': data[address]['default_domain']}}
    if address == 'azapi_resource.registry':
        return {'properties': {'loginServer': config['registry_name'] + '.azurecr.io'}}
    return {}


def check_plan(plan, request, evidence, *, source_bound=False, now=None):
    before, after, data, principals = predecessor(request, evidence, now=now)
    require(plan.get('terraform_version') == '1.13.3' and plan.get('format_version') in ('1.0', '1.1', '1.2'))
    require(plan.get('complete') is True and plan.get('errored') is False and plan.get('applyable') is True
            and not plan.get('resource_drift') and not plan.get('deferred_changes'))
    require(timestamp(evidence['readback']['completed_at']) <= timestamp(plan['timestamp'])
            <= (now or datetime.now(timezone.utc)))
    require(plan.get('variables') == {'config': {'value': after}})
    prior = plan['prior_state']['values']['root_module']
    require(not prior.get('child_modules'))
    old = {r['address']: r for r in prior['resources']}
    old_expected, new = expected(before, principals), grants(after, principals)
    require(len(old) == len(prior['resources']) == 15 and set(old) == set(old_expected))
    rows = {r['address']: r for r in plan['resource_changes']}
    require(len(rows) == len(plan['resource_changes']) == 17 and set(rows) == set(old) | set(new))
    tag_update = before['release_sha'] != after['release_sha']
    for address, row in rows.items():
        check_row(row)
        change = row['change']
        if address in new:
            require(change['actions'] == ['create'] and change.get('before') is None)
            check_value(change['after'], change.get('after_unknown', {}), new[address], {}, computed=source_bound)
            continue
        state = old[address]
        require(state.get('mode') == 'managed' and state.get('type') == 'azapi_resource'
                and state.get('provider_name') == 'registry.terraform.io/azure/azapi'
                and not has_unknown(state.get('sensitive_values', {})))
        require(state['values'] == change['before'])
        output = exported(address, before, data, principals)
        check_value(change['before'], {}, old_expected[address], output)
        is_tag = address == 'azapi_resource.group' and tag_update
        require(change['actions'] == (['update'] if is_tag else ['no-op']))
        wanted_after = deepcopy(change['before'])
        if is_tag:
            wanted_after['tags']['releaseSha'] = after['release_sha']
        # An empty export can recompute on the tag update, but no request leaf can.
        compare(wanted_after, change['after'], change.get('after_unknown', {}),
                {('output',)} if is_tag and source_bound else set())
    check_outputs(plan['output_changes'], before, data)
    return {'resource_count': 17, 'actions': {'create': 2, 'update': int(tag_update), 'no-op': 15 - int(tag_update)},
            'resources': [{'address': k, 'id': resource_id(v), 'actions': rows[k]['change']['actions']}
                          for k, v in sorted({**expected(after, principals), **new}.items())],
            'grants': list(new.values()), 'principals': principals,
            'source_tag_change': {'before': before['release_sha'], 'after': after['release_sha']} if tag_update else None}


def check_row(row):
    require(row.get('mode') == 'managed' and row.get('type') == 'azapi_resource'
            and row.get('provider_name') == 'registry.terraform.io/azure/azapi')
    require(not any(row.get(k) for k in ('module_address', 'previous_address', 'deposed')))
    change = row['change']
    require(not any(change.get(k) for k in ('importing', 'generated_config', 'replace_paths'))
            and not has_unknown(change.get('before_sensitive', False))
            and not has_unknown(change.get('after_sensitive', False)))


def check_outputs(outputs, config, data):
    require(set(outputs) == {'application_contract', 'oidc_client_id'})
    value = {k: config[k] for k in ('subscription_id', 'tenant_id', 'environment', 'resource_group', 'prefix', 'registry_name', 'vault_name')}
    from qa_contract import SUBNET
    value.update(region='swedencentral', apps_subnet_id=SUBNET,
                 default_domain=data['azapi_resource.environment']['default_domain'])
    foundation(value)
    for key, wanted in {'application_contract': value, 'oidc_client_id': None}.items():
        row = outputs[key]
        require(row['actions'] == ['no-op'] and row.get('before') == row.get('after') == wanted
                and not any(has_unknown(row.get(k, False)) for k in ('after_unknown', 'before_sensitive', 'after_sensitive')))
