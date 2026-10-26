"""Exact Unit 8 transition and two separately accepted historical chains."""
from datetime import datetime, timezone
from qa_contract import fields, match, require
from qa_discovery import digest, timestamp
from qa_foundation_inputs import initial_inputs
from qa_oidc_contract import predecessor as oidc_predecessor
from qa_oidc_receipt import verify_after, verify
from qa_deployment_source import historical_source, bind_report
from qa_deployment_history import application, acceptance


def transition(request):
    fields(request, 'before_inputs after_inputs predecessor_sha256')
    configs = []
    for phase, ready in (('before', False), ('after', True)):
        value = request[phase + '_inputs']; fields(value, 'config')
        config = value['config']
        require(config.get('runtime_secrets_ready') is True and config.get('oidc_enabled') is True
                and config.get('smtp_secret_ready') is False and config.get('apps_ready') is ready)
        normalized = initial_inputs({'config': {**config, 'runtime_secrets_ready': False,
                                               'oidc_enabled': False, 'apps_ready': False}})
        configs.append({**normalized, 'runtime_secrets_ready': True, 'oidc_enabled': True, 'apps_ready': ready})
    before, after = configs
    require({k: v for k, v in before.items() if k not in ('apps_ready', 'release_sha')} ==
            {k: v for k, v in after.items() if k not in ('apps_ready', 'release_sha')})
    match(r'[a-f0-9]{64}', request['predecessor_sha256'])
    return before, after


def predecessor(request, evidence, *, now=None):
    before, after = transition(request)
    require(digest(evidence) == request['predecessor_sha256'])
    context = accepted_history(evidence, now=now)
    require(before == context['before'])
    return {**context, 'after': after}


def accepted_history(evidence, *, now=None):
    """Shared Unit 5/7 historical consistency; never grants operation authority."""
    fields(evidence, 'unit5 unit7')
    now = now or datetime.now(timezone.utc)
    unit = evidence['unit5']
    fields(unit, 'oidc_request runtime_predecessor saved_plan before_receipt after_receipt '
           'plan_completed_at apply_started_at apply_completed_at owner_acceptance')
    req, previous, report = (unit[k] for k in ('oidc_request', 'runtime_predecessor', 'saved_plan'))
    _, accepted, data, principals = oidc_predecessor(req, previous, now=now)
    before = accepted
    # Every historical root is read from its own commit, not caller hashes or today's checkout.
    for binding in (previous['initial_predecessor']['initial_plan'], previous['saved_plan'], report):
        with historical_source(binding['source_sha']) as root:
            bind_report(binding, root)
            if binding is report:
                verify_after(req, previous, report, unit['before_receipt'], unit['after_receipt'],
                    plan_completed_at=unit['plan_completed_at'], apply_started_at=unit['apply_started_at'],
                    apply_completed_at=unit['apply_completed_at'], now=timestamp(unit['after_receipt']['completed_at']),
                    source_root=root)
    snapshot = verify(req, previous, report['plan_sha256'], unit['after_receipt'], 'after',
                      not_before=unit['apply_completed_at'], now=timestamp(unit['after_receipt']['completed_at']))
    accepted_at = acceptance(unit['owner_acceptance'], 5, report, unit['after_receipt'])
    foundation = {k: before[k] for k in ('subscription_id', 'tenant_id', 'environment', 'resource_group', 'prefix', 'registry_name', 'vault_name')}
    from qa_contract import SUBNET
    foundation.update(region='swedencentral', apps_subnet_id=SUBNET,
                      default_domain=data['azapi_resource.environment']['default_domain'])
    inputs, names, app_accepted_at = application(evidence['unit7'], foundation, accepted_at,
        previous['runtime_request']['secret_versions'], snapshot, now=now)
    require(unit['owner_acceptance']['decision_sha256'] != evidence['unit7']['owner_acceptance']['decision_sha256'])
    return dict(before=before, data=data, principals=principals, snapshot=snapshot,
                inputs=inputs, revision_names=names, accepted_at=app_accepted_at)
