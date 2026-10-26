"""Separate exact seven-create OIDC policy; initial and Unit 4 policies stay strict."""
from copy import deepcopy
from datetime import datetime, timezone
from qa_contract import require, has_unknown, fields, match
from qa_discovery import timestamp
from qa_foundation_inputs import UUID
from qa_foundation_expected import expected
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS, compare
from qa_runtime_contract import grants
from qa_runtime_plan import check_row, check_value, exported, check_outputs
from qa_oidc_contract import predecessor
from qa_oidc_expected import additions, resource_id, DEPLOYER, FEDERATION


def release_identity(row, principals, owner):
    output = row['change']['after'].get('output')
    if output is None:
        require(row['change'].get('after_unknown', {}).get('output') is True)
        return None, None
    fields(output, 'properties')
    fields(output['properties'], 'principalId clientId')
    principal, client = (output['properties'][k] for k in ('principalId', 'clientId'))
    for value in (principal, client):
        match(UUID, value)
    require(len({principal, client, owner, *principals.values()}) == 5)
    return principal, client


def new_value(address, change, wanted, principal, client, source_bound):
    wanted = deepcopy(wanted)
    output = {'properties': {'principalId': principal, 'clientId': client}} if address == DEPLOYER else {}
    wanted.update(id=resource_id(wanted), output=output, identity=[], **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS))
    allowed = set()
    if source_bound:
        allowed = {('id',), ('output',)} | {(k,) for k in DEFAULT_OPTIONS}
        allowed |= {(k,) for k in ('location', 'tags') if wanted[k] is None}
        if address == FEDERATION:
            allowed.add(('parent_id',))
        if wanted['type'].startswith('Microsoft.Authorization/roleAssignments@') and principal is None:
            allowed |= {('name',), ('body', 'properties', 'principalId')}
    actual, unknown = change['after'], change.get('after_unknown', {})
    if principal is None and wanted['type'].startswith('Microsoft.Authorization/roleAssignments@'):
        require(unknown.get('name') is True and unknown.get('body', {}).get('properties', {}).get('principalId') is True)
    for key in ('location', 'tags'):
        if wanted[key] is None and not has_unknown(unknown.get(key, False)):
            require(actual.get(key) in ((None, '') if key == 'location' else (None, {})))
            wanted[key] = actual.get(key)
    compare(wanted, actual, unknown, allowed)


def check_plan(plan, request, evidence, *, source_bound=False, now=None):
    before, after, data, principals = predecessor(request, evidence, now=now)
    require(plan.get('terraform_version') == '1.13.3' and plan.get('format_version') in ('1.0', '1.1', '1.2'))
    require(plan.get('complete') is True and plan.get('errored') is False and plan.get('applyable') is True
            and not plan.get('resource_drift') and not plan.get('deferred_changes'))
    require(timestamp(evidence['after_receipt']['completed_at']) <= timestamp(plan['timestamp']) <= (now or datetime.now(timezone.utc)))
    require(plan.get('variables') == {'config': {'value': after}})
    prior = plan['prior_state']['values']['root_module']
    require(not prior.get('child_modules'))
    old = {r['address']: r for r in prior['resources']}
    old_expected = {**expected(before, principals), **grants(before, principals)}
    require(len(old) == len(prior['resources']) == 17 and set(old) == set(old_expected))
    rows = {r['address']: r for r in plan['resource_changes']}
    require(len(rows) == len(plan['resource_changes']) == 24 and set(rows) == set(old) | set(additions(after)))
    principal, client = release_identity(rows[DEPLOYER], principals, before['owner_object_id'])
    new = additions(after, principal)
    tag_update = before['release_sha'] != after['release_sha']
    for address, row in rows.items():
        check_row(row)
        change = row['change']
        if address in new:
            require(change['actions'] == ['create'] and change.get('before') is None)
            new_value(address, change, new[address], principal, client, source_bound)
            continue
        state = old[address]
        require(state.get('mode') == 'managed' and state.get('type') == 'azapi_resource'
                and state.get('provider_name') == 'registry.terraform.io/azure/azapi'
                and not has_unknown(state.get('sensitive_values', {})) and state['values'] == change['before'])
        check_value(change['before'], {}, old_expected[address], exported(address, before, data, principals))
        is_tag = address == 'azapi_resource.group' and tag_update
        require(change['actions'] == (['update'] if is_tag else ['no-op']))
        wanted = deepcopy(change['before'])
        if is_tag:
            wanted['tags']['releaseSha'] = after['release_sha']
        compare(wanted, change['after'], change.get('after_unknown', {}), {('output',)} if is_tag and source_bound else set())
    outputs = deepcopy(plan['output_changes'])
    require(set(outputs) == {'application_contract', 'oidc_client_id'})
    oidc = outputs['oidc_client_id']
    require(oidc['actions'] == ['create'] and oidc.get('before') is None
            and not has_unknown(oidc.get('before_sensitive', False)) and not has_unknown(oidc.get('after_sensitive', False)))
    if client is None:
        require(oidc.get('after_unknown') is True)
    compare(client, oidc.get('after'), oidc.get('after_unknown', False), {()} if source_bound and client is None else set())
    outputs['oidc_client_id'] = dict(actions=['no-op'], before=None, after=None)
    check_outputs(outputs, before, data)
    return {'resource_count': 24, 'actions': {'create': 7, 'update': int(tag_update), 'no-op': 17-int(tag_update)},
        'resources': [{'address': k, 'id': resource_id(v), 'actions': rows[k]['change']['actions']}
                      for k, v in sorted({**expected(after, principals), **grants(after, principals), **new}.items())],
        'additions': new, 'principals': principals, 'release_principal_id': principal, 'oidc_client_id': client,
        'computed_references_require_post_apply_readback': True,
        'source_tag_change': {'before': before['release_sha'], 'after': after['release_sha']} if tag_update else None}
