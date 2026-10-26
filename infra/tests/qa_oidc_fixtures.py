"""Entirely synthetic Unit 5 evidence. Never an owner approval."""
from copy import deepcopy
from qa_discovery import digest, timestamp
from qa_contract import sha256, ROOT
from qa_foundation import QA_ROOT, CONFIG_FILES
from qa_runtime import inspect_plan
from qa_runtime_plan import check_plan as runtime_check, exported
from qa_runtime_contract import grants
from qa_foundation_expected import expected
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS
import qa_runtime_fixtures as runtime
from qa_oidc_expected import additions, resource_id, DEPLOYER

PLAN = '2026-10-25T12:00:00Z'
BEFORE = '2026-10-25T12:01:00Z'
APPLY = '2026-10-25T12:02:00Z'
AFTER = '2026-10-25T12:03:00Z'
NOW = timestamp(AFTER)
PRINCIPAL = '00000000-0000-0000-0000-000000000006'
CLIENT = '00000000-0000-0000-0000-000000000007'
CLIENTS = dict(api='00000000-0000-0000-0000-000000000008', web='00000000-0000-0000-0000-000000000009')


def evidence():
    req, initial = runtime.request(), runtime.evidence()
    from qa_runtime_contract import predecessor
    old, new, _, _ = predecessor(req, initial, now=NOW)
    report = runtime_check(runtime.plan(), req, initial, now=NOW)
    report.update(source_sha=new['release_sha'], previous_source_sha=old['release_sha'],
        saved_plan_path='/synthetic/unit4.tfplan', terraform_path='/synthetic/terraform', terraform_version='1.13.3',
        terraform_binary_sha256='5'*64, plan_created_at=runtime.PLAN, plan_sha256='4'*64,
        request_sha256=digest(req), predecessor_sha256=digest(initial), previous_plan_sha256=initial['initial_plan']['plan_sha256'],
        previous_readback_sha256=digest(initial['readback']), previous_owner_acceptance_sha256=initial['owner_acceptance_sha256'],
        before_inputs_sha256=digest(old), after_inputs_sha256=digest(new),
        provider_lock_sha256=sha256((QA_ROOT/'.terraform.lock.hcl').read_bytes()),
        deployment_policy_sha256=sha256((ROOT/'infra/config/deployment-policy.json').read_bytes()),
        configuration_sha256=digest({n:sha256((QA_ROOT/n).read_bytes()) for n in sorted(CONFIG_FILES)}),
        file_sha256={'/synthetic/unit4-request.json':digest(req),'/synthetic/initial-predecessor.json':digest(initial)})
    return dict(runtime_request=req, initial_predecessor=initial, saved_plan=report,
        before_receipt=runtime.receipt(), after_receipt=runtime.receipt('after'), plan_completed_at=runtime.PLAN,
        apply_started_at=runtime.APPLY, apply_completed_at=runtime.APPLY, owner_acceptance_sha256='6'*64)


def request():
    before = deepcopy(runtime.request()['after_inputs'])
    after = deepcopy(before)
    after['config'].update(oidc_enabled=True, release_sha='c'*40)
    return dict(before_inputs=before, after_inputs=after, predecessor_sha256=digest(evidence()))


def plan():
    from qa_oidc_contract import predecessor
    before, after, data, principals = predecessor(request(), evidence(), now=NOW)
    rows, prior = [], []
    old = {**expected(before, principals), **grants(before, principals)}
    for address, wanted in {**old, **additions(after, PRINCIPAL)}.items():
        output = exported(address, before, data, principals)
        if address == DEPLOYER:
            output = {'properties': {'principalId': PRINCIPAL, 'clientId': CLIENT}}
        value = {**deepcopy(wanted), **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS),
                 'identity': [], 'id': resource_id(wanted), 'output': output}
        row = dict(address=address, mode='managed', type='azapi_resource', provider_name='registry.terraform.io/azure/azapi')
        if address in old:
            prior.append({**row, 'values': deepcopy(value)})
        change = dict(actions=['no-op'] if address in old else ['create'], before=deepcopy(value) if address in old else None,
                      after=value, after_unknown={})
        if address == 'azapi_resource.group':
            change['actions']=['update'];change['after']['tags']['releaseSha']=after['release_sha']
        rows.append({**row,'change':change})
    outputs=runtime.plan()['output_changes']
    outputs['oidc_client_id']=dict(actions=['create'],before=None,after=CLIENT)
    return dict(terraform_version='1.13.3',format_version='1.2',complete=True,errored=False,applyable=True,
        timestamp=PLAN,variables={'config':{'value':after}},prior_state={'values':{'root_module':{'resources':prior}}},
        resource_changes=rows,output_changes=outputs)


def receipt(phase='before', plan_hash='7'*64):
    from qa_oidc_receipt import manifest
    from qa_oidc_contract import predecessor
    from qa_oidc_expected import role_rows, FEDERATION
    req,ev=request(),evidence()
    before,after,_,principals=predecessor(req,ev,now=NOW)
    config=before if phase=='before' else after
    spec=manifest(req,ev,plan_hash,phase)
    data=runtime.foundation_data(config)
    resources={**expected(config,principals),**grants(config,principals)}
    data['roles']=list(role_rows(resources).values())
    data['account']={k:config[k] for k in ('subscription_id','tenant_id')}
    data['resources']=[dict(id=resource_id(v),type=v['type'].split('@')[0],location=v['location'],tags=v['tags'])
        for k,v in resources.items() if not v['type'].startswith('Microsoft.Authorization/') and k not in ('azapi_resource.group','azapi_resource.diagnostics','azapi_resource.dns_link','azapi_resource.db_address')]
    data['identities']=[dict(id=resource_id(resources[f'azapi_resource.identity["{k}"]']),location='swedencentral',
        tags=resources[f'azapi_resource.identity["{k}"]']['tags'],principal_id=principals[k],client_id=CLIENTS[k],tenant_id=config['tenant_id']) for k in ('api','web')]
    data['federation-api']=[];data['federation-web']=[]
    if phase=='after':
        new=additions(config,PRINCIPAL);identity=new[DEPLOYER];fed=new[FEDERATION]
        data['roles']+=list(role_rows(new).values())
        data['resources'].append(dict(id=resource_id(identity),type=identity['type'].split('@')[0],location='swedencentral',tags=None))
        data['identities'].append(dict(id=resource_id(identity),location='swedencentral',tags=None,principal_id=PRINCIPAL,client_id=CLIENT,tenant_id=config['tenant_id']))
        data['federation-release']=[dict(id=resource_id(fed),name=fed['name'],**fed['body']['properties'])]
    stamp=BEFORE if phase=='before' else AFTER
    return {**{k:spec[k] for k in ('source_sha','request_sha256','predecessor_sha256','plan_sha256','phase')},
        'manifest_sha256':digest(spec),'started_at':stamp,'completed_at':stamp,'records':runtime.records(spec,data,stamp)}


def github_receipt(plan_hash='7'*64):
    from qa_oidc_github import manifest
    from test_github_policy import ruleset
    data=ruleset();
    for rule in data['rules']: rule.setdefault('parameters',{})
    data['id']=42;data['name']='tonyai-main-release'
    values=dict(environment=dict(name='staging',can_admins_bypass=False,
        deployment_branch_policy=dict(protected_branches=False,custom_branch_policies=True),
        protection_rules=[dict(type='required_reviewers',prevent_self_review=True,reviewers=[dict(type='User',reviewer=dict(id=12))])]),
        policies=dict(total_count=1,branch_policies=[dict(name='main',type='branch')]),
        rulesets=[dict(id=42,name='tonyai-main-release')],ruleset=data,
        mode=dict(name='STAGING_RUNNER_MODE',value='ephemeral-jit'),approval=dict(approval_policy='all_external_contributors'))
    spec=manifest(request(),plan_hash,42)
    records=[]
    for k,v in spec['commands'].items():
        records.append(dict(key=k,complete=True,pages=[dict(argv_sha256=digest(v['argv']),projection_sha256=digest(v['projection']),
            exit_code=0,http_status=200,started_at=BEFORE,completed_at=BEFORE,result=values[k],result_sha256=digest(values[k]),next_link=None)]))
    return {**{k:spec[k] for k in ('source_sha','request_sha256','plan_sha256','ruleset_id')},
        'manifest_sha256':digest(spec),'started_at':BEFORE,'completed_at':BEFORE,'records':records}


def report(plan_hash='7'*64):
    from qa_oidc_contract import predecessor
    from qa_oidc_plan import check_plan
    ev=evidence();req=request();before,after,_,_=predecessor(req,ev,now=NOW)
    value={**ev['saved_plan'],**check_plan(plan(),req,ev,now=NOW)}
    for key in ('grants',):value.pop(key)
    value.update(source_sha=after['release_sha'],previous_source_sha=before['release_sha'],plan_sha256=plan_hash,plan_created_at=PLAN,
        request_sha256=digest(req),predecessor_sha256=digest(ev),previous_plan_sha256=ev['saved_plan']['plan_sha256'],
        previous_readback_sha256=digest(ev['after_receipt']),previous_owner_acceptance_sha256=ev['owner_acceptance_sha256'],
        before_inputs_sha256=digest(before),after_inputs_sha256=digest(after),saved_plan_path='/synthetic/unit5.tfplan',
        file_sha256={'/synthetic/unit5-request.json':digest(req),'/synthetic/unit4-evidence.json':digest(ev)})
    return value
