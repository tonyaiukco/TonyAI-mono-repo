"""Synthetic Unit 8 documents, explicitly unauthenticated and never executable."""
from contextlib import contextmanager
from functools import lru_cache, wraps
from copy import deepcopy
from unittest.mock import patch
from qa_contract import ROOT, GROUP, sha256, origins
from qa_discovery import digest, timestamp
from qa_application import QA_ROOT as APP_ROOT, CONFIG_FILES as APP_FILES
from qa_application_receipt import manifest as app_manifest
from qa_application_policy import tags
from qa_expected import body, identity
from qa_deployment_contract import predecessor
from qa_deployment_plan import check_plan
from qa_deployment_report import bindings
from qa_deployment_expected import existing, grants
from qa_oidc_expected import resource_id, role_rows, DEPLOYER
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS
from qa_runtime_plan import exported
from qa_foundation import QA_ROOT, CONFIG_FILES
import qa_oidc_fixtures as oidc
import qa_runtime_fixtures as runtime
from test_qa_application import fixture

PLAN = '2026-10-25T14:00:00Z'
BEFORE = '2026-10-25T14:01:00Z'
APPLY = '2026-10-25T14:02:00Z'
AFTER = '2026-10-25T14:03:00Z'
NOW = timestamp(AFTER)


def fresh_cached(fn):
    cached = lru_cache(maxsize=1)(fn)
    @wraps(fn)
    def fresh():
        return deepcopy(cached())
    return fresh


@contextmanager
def synthetic_history():
    @contextmanager
    def source(_):
        yield ROOT
    with patch('qa_deployment_contract.historical_source', source), patch('qa_deployment_history.historical_source', source):
        yield


def contents(receipt):
    result = {}
    for row in receipt['records']:
        value = row['pages'][0]['result']
        result[row['key']] = value['items'] if isinstance(value, dict) and 'items' in value else value
    return result


def accepted(unit, report, receipt):
    return dict(unit=unit, decision_sha256=str(unit)*64, report_sha256=digest(report),
                after_receipt_sha256=digest(receipt), accepted_at=receipt['completed_at'])


def app_data(inputs, names):
    result = dict(inventory=['tonyai-staging-api', 'tonyai-staging-web'])
    for kind in ('api', 'web'):
        app = body(inputs, kind)
        app.update(id=GROUP+'/providers/Microsoft.App/containerApps/tonyai-staging-'+kind,
                   location='swedencentral', tags=tags(inputs),
                   identity=dict(type='UserAssigned', userAssignedIdentities={identity(kind): dict(
                       principalId=runtime.PRINCIPALS[kind], clientId=oidc.CLIENTS[kind])}))
        intended = 'tonyai-staging-'+kind+'--'+inputs['release']['release_id']
        app['properties'].update(provisioningState='Succeeded', latestReadyRevisionName=intended)
        app['properties']['configuration']['ingress']['fqdn'] = origins(inputs['foundation'])[kind].removeprefix('https://')
        result[kind+'_app'] = app
        result[kind+'_revisions'] = [dict(name=n, properties=dict(active=n == intended)) for n in names[kind]]
        for name in names[kind]: result['replicas:'+name] = []
    from qa_contract import SUBNET
    result['environment'] = dict(id=GROUP+'/providers/Microsoft.App/managedEnvironments/tonyai-staging-env',
        location='swedencentral', properties=dict(defaultDomain=inputs['foundation']['default_domain'],
        vnetConfiguration=dict(infrastructureSubnetId=SUBNET, internal=False),
        workloadProfiles=[dict(name='Consumption', workloadProfileType='Consumption')]))
    return result


def app_receipt(inputs, phase, stamp, names, data):
    spec = app_manifest(inputs, '8'*64, names, phase)
    return {**{k: spec[k] for k in ('source_sha', 'release_id', 'inputs_sha256', 'plan_sha256', 'phase', 'revision_names')},
        'manifest_sha256': digest(spec), 'started_at': stamp, 'completed_at': stamp,
        'records': runtime.records({**spec, 'commands': {k:v for k,v in spec['commands'].items() if k in data}}, data, stamp)}


@fresh_cached
def evidence():
    unit5 = dict(oidc_request=oidc.request(), runtime_predecessor=oidc.evidence(), saved_plan=oidc.report(),
        before_receipt=oidc.receipt(), after_receipt=oidc.receipt('after'), plan_completed_at=oidc.PLAN,
        apply_started_at=oidc.APPLY, apply_completed_at=oidc.APPLY)
    unit5['owner_acceptance'] = accepted(5, unit5['saved_plan'], unit5['after_receipt'])
    _, candidate, inputs, _, _ = fixture()
    config = unit5['oidc_request']['after_inputs']['config']
    inputs['foundation'].update(registry_name=config['registry_name'], vault_name=config['vault_name'])
    inputs['release']['source_sha'] = 'e'*40
    candidate['target']['foundation'] = deepcopy(inputs['foundation'])
    candidate['target']['build']['source_sha'] = 'e'*40
    names = {k: ['tonyai-staging-'+k+'--qa001'] for k in ('api', 'web')}
    outgoing = dict(api=[], web=[])
    report = dict(source_sha='e'*40, release_id='qa001', terraform_version='1.13.3', terraform_binary_sha256='5'*64,
        plan_created_at='2026-10-25T13:00:00Z', plan_sha256='8'*64, normalized_inputs_sha256=digest(inputs),
        candidate_sha256=digest(candidate), provider_lock_sha256=sha256((APP_ROOT/'.terraform.lock.hcl').read_bytes()),
        configuration_sha256=digest({n:sha256((APP_ROOT/n).read_bytes()) for n in sorted(APP_FILES)}),
        input_file_sha256=digest(inputs), candidate_file_sha256=digest(candidate),
        resources=[dict(address=f'azapi_resource.app["{k}"]', actions=['create'], expected_body_sha256=digest(body(inputs,k)),
            previous_body_sha256=None, id=GROUP+'/providers/Microsoft.App/containerApps/tonyai-staging-'+k) for k in ('api','web')])
    unit7 = dict(inputs=inputs, candidate=candidate, saved_plan=report, outgoing_revisions=outgoing,
        candidate_provenance=dict(verification='github_api_run_and_archive_digest', repository='tonyaiukco/TonyAI-mono-repo',
            source_sha='e'*40, run_id='123', artifact_id=456, archive_sha256='9'*64, candidate_file_sha256=digest(candidate)),
        before_receipt=app_receipt(inputs, 'before', '2026-10-25T13:01:00Z', outgoing, dict(inventory=[])),
        drained_receipt=None, after_receipt=app_receipt(inputs,'after','2026-10-25T13:03:00Z',names,app_data(inputs,names)),
        plan_completed_at='2026-10-25T13:00:00Z', apply_started_at='2026-10-25T13:02:00Z', apply_completed_at='2026-10-25T13:02:00Z')
    unit7['owner_acceptance'] = accepted(7, report, unit7['after_receipt'])
    return dict(unit5=unit5, unit7=unit7)


def request(ev=None):
    ev = ev or evidence()
    before = deepcopy(ev['unit5']['oidc_request']['after_inputs'])
    after = deepcopy(before); after['config'].update(apps_ready=True, release_sha='d'*40)
    return dict(before_inputs=before, after_inputs=after, predecessor_sha256=digest(ev))


@fresh_cached
def plan():
    context = predecessor(request(), evidence(), now=NOW)
    before, after, snap = (context[k] for k in ('before','after','snapshot'))
    old = existing(before,context['principals'],snap['release_principal_id'])
    rows, prior = [], []
    for address, wanted in {**old, **grants(snap['release_principal_id'])}.items():
        output = exported(address,before,context['data'],context['principals'])
        if address == DEPLOYER: output = {'properties': dict(principalId=oidc.PRINCIPAL,clientId=oidc.CLIENT)}
        value = {**deepcopy(wanted), **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS), 'identity': [], 'id': resource_id(wanted), 'output': output}
        row = dict(address=address,mode='managed',type='azapi_resource',provider_name='registry.terraform.io/azure/azapi')
        if address in old: prior.append({**row,'values':deepcopy(value)})
        change = dict(actions=['no-op'] if address in old else ['create'],before=deepcopy(value) if address in old else None,after=value,after_unknown={})
        if address=='azapi_resource.group': change['actions']=['update'];change['after']['tags']['releaseSha']=after['release_sha']
        rows.append({**row,'change':change})
    outputs = oidc.plan()['output_changes'];outputs['oidc_client_id']=dict(actions=['no-op'],before=oidc.CLIENT,after=oidc.CLIENT)
    return dict(terraform_version='1.13.3',format_version='1.2',complete=True,errored=False,applyable=True,timestamp=PLAN,
        variables={'config':{'value':after}},prior_state={'values':{'root_module':{'resources':prior}}},resource_changes=rows,output_changes=outputs)


@fresh_cached
def report():
    req, ev = request(), evidence(); context = predecessor(req, ev, now=NOW)
    return {**check_plan(plan(),req,ev,now=NOW), **bindings(req,ev,context),
        'source_sha':'d'*40,'previous_source_sha':'c'*40,'application_source_sha':'e'*40,
        'saved_plan_path':'/synthetic/unit8.tfplan','terraform_path':'/synthetic/terraform','terraform_version':'1.13.3',
        'terraform_binary_sha256':'5'*64,'plan_created_at':PLAN,'plan_sha256':'a'*64,
        'provider_lock_sha256':sha256((QA_ROOT/'.terraform.lock.hcl').read_bytes()),
        'deployment_policy_sha256':sha256((ROOT/'infra/config/deployment-policy.json').read_bytes()),
        'configuration_sha256':digest({n:sha256((QA_ROOT/n).read_bytes()) for n in sorted(CONFIG_FILES)}),
        'file_sha256':{'/synthetic/request.json':digest(req),'/synthetic/predecessor.json':digest(ev)}}


def receipt(phase='before', binding=None):
    from qa_deployment_receipt import manifests
    req,ev=request(),evidence(); binding=binding or report()
    spec=manifests(req,ev,binding,now=NOW)[phase]
    data=contents(oidc.receipt('after'))
    config=req[phase+'_inputs']['config']
    data['azapi_resource.group']['tags']['releaseSha']=config['release_sha']
    for kind in ('api','web'):
        data['resources'].append(dict(id=GROUP+'/providers/Microsoft.App/containerApps/tonyai-staging-'+kind,
            type='Microsoft.App/containerApps',location='swedencentral',tags=tags(ev['unit7']['inputs'])))
    if phase=='after': data['roles']+=list(role_rows(grants(oidc.PRINCIPAL)).values())
    data.update({'app:'+k:v for k,v in contents(ev['unit7']['after_receipt']).items()})
    stamp=BEFORE if phase=='before' else AFTER
    return {**{k:spec[k] for k in ('source_sha','request_sha256','predecessor_sha256','report_sha256','plan_sha256','application_inputs_sha256','phase')},
        'manifest_sha256':digest(spec),'started_at':stamp,'completed_at':stamp,'records':runtime.records(spec,data,stamp)}


def github_receipt():
    from qa_oidc_github import manifest
    from qa_deployment_contract import transition
    rec=oidc.github_receipt('a'*64);spec=manifest(request(),'a'*64,42,transition_validator=transition)
    for k in ('source_sha','request_sha256','plan_sha256','ruleset_id'): rec[k]=spec[k]
    rec.update(manifest_sha256=digest(spec),started_at=BEFORE,completed_at=BEFORE)
    for row in rec['records']:
        for page in row['pages']:page.update(started_at=BEFORE,completed_at=BEFORE)
    return rec
