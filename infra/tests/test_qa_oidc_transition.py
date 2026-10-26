"""Unit 5 authorization boundary regressions; initial/Unit 4 remain separate."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from qa_discovery import digest
from qa_oidc_contract import transition, predecessor
from qa_oidc_plan import check_plan
from qa_oidc_expected import DEPLOYER,FEDERATION,JOIN,additions,resource_id
from qa_oidc_fixtures import request,evidence,plan,NOW,PRINCIPAL,CLIENT


def row(value,address): return next(r['change'] for r in value['resource_changes'] if r['address']==address)


class Transition(unittest.TestCase):
    def check(self,value=None,req=None,ev=None,bound=False):
        return check_plan(value or plan(),req or request(),ev or evidence(),source_bound=bound,now=NOW)

    def test_exact_twenty_four_and_child_id(self):
        result=self.check()
        self.assertEqual(result['actions'],{'create':7,'update':1,'no-op':16})
        self.assertEqual(len(result['resources']),24)
        self.assertTrue(resource_id(result['additions'][FEDERATION]).endswith('/tonyai-staging-release/federatedIdentityCredentials/github-staging'))
        self.assertEqual(row(plan(),'azapi_resource.join_role')['actions'],['no-op'])

    def test_stage_skip_reverse_replay_and_changed_identity(self):
        cases=[('before','runtime_secrets_ready',False),('before','oidc_enabled',True),('after','oidc_enabled',False),
               ('after','runtime_secrets_ready',False),('after','smtp_secret_ready',True),('after','apps_ready',True)]
        cases += [('after',k,v) for k,v in dict(tenant_id='1'*36,owner_object_id='00000000-0000-0000-0000-000000000099',
            registry_name='otherregistry',vault_name='other-vault',resource_group='elsewhere',repository='evil/repo',subscription_id='elsewhere',prefix='other').items()]
        for phase,key,value in cases:
            with self.subTest(phase=phase,key=key):
                req=request();req[phase+'_inputs']['config'][key]=value
                with self.assertRaises(Exception):predecessor(req,evidence(),now=NOW)
        req=request();req['before_inputs']['config']['release_sha']='d'*40
        with self.assertRaises(Exception):predecessor(req,evidence(),now=NOW)

    def test_every_predecessor_binding_and_draft_rejection(self):
        paths=[('saved_plan',k) for k in ('plan_sha256','source_sha','previous_source_sha','request_sha256','predecessor_sha256',
            'previous_plan_sha256','previous_readback_sha256','previous_owner_acceptance_sha256','before_inputs_sha256','after_inputs_sha256')]
        paths += [('before_receipt','manifest_sha256'),('after_receipt','plan_sha256'),('initial_predecessor','owner_acceptance_sha256')]
        for path in paths:
            with self.subTest(path=path):
                ev=evidence();ev[path[0]][path[1]]='f'*64
                req=request();req['predecessor_sha256']=digest(ev)
                with self.assertRaises(Exception):predecessor(req,ev,now=NOW)
        for key in ('runtime_request','initial_predecessor','saved_plan','before_receipt','after_receipt','owner_acceptance_sha256'):
            ev=evidence();ev.pop(key);req=request();req['predecessor_sha256']=digest(ev)
            with self.subTest(missing=key),self.assertRaises(Exception):predecessor(req,ev,now=NOW)
        ev=evidence();ev['saved_plan']={'status':'BLOCKED_DRAFT','authorization':False};req=request();req['predecessor_sha256']=digest(ev)
        with self.assertRaises(Exception):predecessor(req,ev,now=NOW)
        for key in ('plan_completed_at','apply_started_at','apply_completed_at'):
            ev=evidence();ev[key]='2026-10-25T09:00:00Z';req=request();req['predecessor_sha256']=digest(ev)
            with self.subTest(time=key),self.assertRaises(Exception):predecessor(req,ev,now=NOW)

    def test_wrong_federation_fields_and_parent(self):
        for key,value in [('issuer','https://evil.invalid'),('subject','repo:other/repo:environment:staging'),
                          ('subject','repo:tonyaiukco/TonyAI-mono-repo:environment:prod'),('audiences',['other']),
                          ('audiences',['api://AzureADTokenExchange','other'])]:
            p=plan();row(p,FEDERATION)['after']['body']['properties'][key]=value
            with self.subTest(key=key,value=value),self.assertRaises(Exception):self.check(p, bound=True)
        for key,value in [('parent_id', '/subscriptions/elsewhere'),('id', '/invalid/child'),('name','other')]:
            p=plan();row(p,FEDERATION)['after'][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(p,bound=True)

    def test_each_grant_scope_role_principal_and_options(self):
        for address in additions(transition(request())[1],PRINCIPAL):
            if address in (DEPLOYER,FEDERATION):continue
            for key,value in [('principalId','00000000-0000-0000-0000-000000000004'),
                ('principalId','00000000-0000-0000-0000-000000000005'),('principalId','00000000-0000-0000-0000-000000000003'),
                ('principalType','User'),('roleDefinitionId','/subscriptions/owner'),('roleDefinitionId','Contributor')]:
                p=plan();row(p,address)['after']['body']['properties'][key]=value
                with self.subTest(address=address,key=key,value=value),self.assertRaises(Exception):self.check(p,bound=True)
            for key,value in [('parent_id','/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d'),('retry',{}),
                              ('identity',[{'type':'SystemAssigned'}]),('ignore_casing',True),('create_headers',{'x':'y'})]:
                p=plan();row(p,address)['after'][key]=value
                with self.subTest(address=address,key=key),self.assertRaises(Exception):self.check(p,bound=True)

    def test_identity_collisions_and_output_contract(self):
        for key in ('principalId','clientId'):
            for value in ('bad','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005',PRINCIPAL if key=='clientId' else CLIENT):
                p=plan();row(p,DEPLOYER)['after']['output']['properties'][key]=value
                with self.subTest(key=key,value=value),self.assertRaises(Exception):self.check(p,bound=True)
        for key in ('oidc_client_id','application_contract'):
            p=plan();p['output_changes'][key]['after']='wrong'
            with self.subTest(output=key),self.assertRaises(Exception):self.check(p,bound=True)

    def test_preserve_all_existing_resources_no_metadata_exception(self):
        for address in [r['address'] for r in plan()['resource_changes'] if r['change']['before'] is not None]:
            p=plan();row(p,address)['after']['tags']={'githubClientId':'recovery-marker'}
            with self.subTest(address=address),self.assertRaises(Exception):self.check(p,bound=True)
        p=plan();row(p,'azapi_resource.join_role')['after']['body']['properties']['permissions'][0]['actions']=['*']
        with self.assertRaises(Exception):self.check(p)
        p=plan();row(p,'azapi_resource.grant["secret-database-url"]')['after']['body']['properties']['principalId']=PRINCIPAL
        with self.assertRaises(Exception):self.check(p)

    def test_destructive_actions_import_move_drift_partial_and_extras(self):
        for actions in (['delete'],['delete','create'],['update'],['no-op']):
            p=plan();row(p,FEDERATION)['actions']=actions
            with self.subTest(actions=actions),self.assertRaises(Exception):self.check(p)
        for key,value in [('importing',{'id':'anything'}),('replace_paths',[['body']]),('generated_config','x')]:
            p=plan();row(p,DEPLOYER)[key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(p)
        for key,value in [('previous_address','old'),('deposed','old'),('module_address','other')]:
            p=plan();p['resource_changes'][0][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(p)
        for key,value in [('resource_drift',[{}]),('complete',False),('deferred_changes',[{}]),('errored',True),('applyable',False)]:
            p=plan();p[key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(p)
        for address in ('azapi_resource.grant["app-api"]','azapi_resource.grant["secret-smtp-password"]','azapi_resource.federation["evil"]'):
            p=plan();extra=deepcopy(p['resource_changes'][-1]);extra['address']=address;p['resource_changes'].append(extra)
            with self.subTest(extra=address),self.assertRaises(Exception):self.check(p)

    def test_only_demonstrated_unknown_leaves_with_source_binding(self):
        p=plan()
        release=row(p,DEPLOYER);release['after'].pop('output');release['after_unknown']['output']=True
        for address in additions(transition(request())[1]):
            change=row(p,address)
            for key in ('id','output'):
                change['after'].pop(key,None);change['after_unknown'][key]=True
            if address==FEDERATION:
                change['after'].pop('parent_id');change['after_unknown']['parent_id']=True
            if address not in (DEPLOYER,FEDERATION):
                change['after'].pop('name');change['after_unknown']['name']=True
                change['after']['body']['properties'].pop('principalId')
                change['after_unknown']['body']={'properties':{'principalId':True}}
        p['output_changes']['oidc_client_id'].update(after=None,after_unknown=True)
        self.check(p,bound=True)
        with self.assertRaises(Exception):self.check(p)
        for key in ('body','identity','parent_id','type'):
            bad=deepcopy(p);c=row(bad,'azapi_resource.grant["registry_push"]');c['after'].pop(key);c['after_unknown'][key]=True
            with self.subTest(key=key),self.assertRaises(Exception):self.check(bad,bound=True)
        bad=deepcopy(p);c=row(bad,JOIN);c['after']['body']['properties']['principalId']='00000000-0000-0000-0000-000000000004'
        with self.assertRaises(Exception):self.check(bad,bound=True)
        bad=deepcopy(p);c=row(bad,JOIN);c['after_unknown']['body']['properties']['principalId']=False
        with self.assertRaises(Exception):self.check(bad,bound=True)

    def test_initial_and_runtime_policies_refuse_unit_five(self):
        from qa_foundation_plan import check_plan as initial
        from qa_runtime_plan import check_plan as runtime_check
        import qa_runtime_fixtures as runtime
        with self.assertRaises(Exception):initial(plan(),runtime.request()['before_inputs'],source_bound=True)
        with self.assertRaises(Exception):runtime_check(plan(),runtime.request(),runtime.evidence(),source_bound=True,now=NOW)
