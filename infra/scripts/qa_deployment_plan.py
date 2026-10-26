"""Independent 24-to-26 Unit 8 policy, with known principals and app scopes."""
from copy import deepcopy
from datetime import datetime, timezone
from qa_contract import require, has_unknown
from qa_discovery import timestamp
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS, compare
from qa_runtime_plan import check_row, exported, check_outputs
from qa_oidc_expected import resource_id, DEPLOYER
from qa_deployment_expected import existing, grants
from qa_deployment_contract import predecessor


def value(actual, unknown, wanted, output, *, computed=False):
    wanted = deepcopy(wanted)
    wanted.update(id=resource_id(wanted), output=output, identity=[], **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS))
    # Actual provider mock creates compute only these leaves. No body/name/parent/identity exception.
    allowed = {('id',), ('output',)} | {(k,) for k in DEFAULT_OPTIONS} if computed else set()
    for key in ('location', 'tags'):
        if wanted[key] is None:
            if computed: allowed.add((key,))
            if not has_unknown(unknown.get(key, False)):
                require(actual.get(key) in ((None, '') if key == 'location' else (None, {})))
                wanted[key] = actual.get(key)
    compare(wanted, actual, unknown, allowed)


def summary(context):
    before, after, snap = (context[k] for k in ('before', 'after', 'snapshot'))
    new = grants(snap['release_principal_id'])
    resources = {**existing(after, context['principals'], snap['release_principal_id']), **new}
    changed = before['release_sha'] != after['release_sha']
    return dict(resource_count=26, actions={'create': 2, 'update': int(changed), 'no-op': 24-int(changed)},
        resources=[dict(address=k, id=resource_id(v), actions=['create'] if k in new else
            ['update'] if k == 'azapi_resource.group' and changed else ['no-op']) for k, v in sorted(resources.items())],
        grants=new, principals=context['principals'], release_principal_id=snap['release_principal_id'],
        oidc_client_id=snap['oidc_client_id'], source_tag_change={'before': before['release_sha'], 'after': after['release_sha']} if changed else None)


def check_plan(plan, request, evidence, *, source_bound=False, now=None):
    context = predecessor(request, evidence, now=now)
    before, after, snap = (context[k] for k in ('before', 'after', 'snapshot'))
    require(plan.get('terraform_version') == '1.13.3' and plan.get('format_version') in ('1.0', '1.1', '1.2'))
    require(plan.get('complete') is True and plan.get('errored') is False and plan.get('applyable') is True
            and not plan.get('resource_drift') and not plan.get('deferred_changes')
            and all(c.get('status') == 'pass' for c in plan.get('checks', [])))
    require(timestamp(context['accepted_at']) <= timestamp(plan['timestamp']) <= (now or datetime.now(timezone.utc)))
    require(plan.get('variables') == {'config': {'value': after}})
    prior = plan['prior_state']['values']['root_module']; require(not prior.get('child_modules'))
    old = {r['address']: r for r in prior['resources']}
    expected = existing(before, context['principals'], snap['release_principal_id'])
    new = grants(snap['release_principal_id'])
    require(len(old) == len(prior['resources']) == 24 and set(old) == set(expected))
    rows = {r['address']: r for r in plan['resource_changes']}
    require(len(rows) == len(plan['resource_changes']) == 26 and set(rows) == set(old) | set(new))
    for address, row in rows.items():
        check_row(row); change = row['change']
        if address in new:
            require(change['actions'] == ['create'] and change.get('before') is None)
            value(change['after'], change.get('after_unknown', {}), new[address], {}, computed=source_bound)
            continue
        state = old[address]
        require(state.get('mode') == 'managed' and state.get('type') == 'azapi_resource'
                and state.get('provider_name') == 'registry.terraform.io/azure/azapi'
                and not has_unknown(state.get('sensitive_values', {})) and state['values'] == change['before'])
        output = exported(address, before, context['data'], context['principals'])
        if address == DEPLOYER:
            output = {'properties': {'principalId': snap['release_principal_id'], 'clientId': snap['oidc_client_id']}}
        value(change['before'], {}, expected[address], output)
        tag = address == 'azapi_resource.group' and before['release_sha'] != after['release_sha']
        require(change['actions'] == (['update'] if tag else ['no-op']))
        wanted = deepcopy(change['before'])
        if tag: wanted['tags']['releaseSha'] = after['release_sha']
        compare(wanted, change['after'], change.get('after_unknown', {}), {('output',)} if tag and source_bound else set())
    outputs = deepcopy(plan['output_changes'])
    oidc = outputs['oidc_client_id']
    require(oidc['actions'] == ['no-op'] and oidc.get('before') == oidc.get('after') == snap['oidc_client_id']
            and not any(has_unknown(oidc.get(k, False)) for k in ('after_unknown', 'before_sensitive', 'after_sensitive')))
    outputs['oidc_client_id'] = dict(actions=['no-op'], before=None, after=None)
    check_outputs(outputs, before, context['data'])
    return summary(context)
