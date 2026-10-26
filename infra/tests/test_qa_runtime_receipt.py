"""Unit 4 complete metadata observations, role deltas and permanently blocked drafts."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from qa_discovery import digest, timestamp
from qa_runtime_fixtures import request, evidence, plan, receipt, NOW, PLAN, APPLY, BEFORE
from qa_runtime_receipt import manifest, verify, verify_after
from qa_runtime_plan import check_plan
from qa_runtime_packet import prepare


def page(rec,key):
    return next(r for r in rec['records'] if r['key']==key)['pages'][0]


def reseal(rec):
    for row in rec['records']:
        for p in row['pages']:p['result_sha256']=digest(p['result'])
    return rec


class Readback(unittest.TestCase):
    def verify(self, before=None, after=None, **kwargs):
        return verify_after(request(),evidence(),'4'*64,before or receipt(),after or receipt('after'),
                            plan_completed_at=PLAN,apply_started_at=APPLY,apply_completed_at=APPLY,now=kwargs.get('now',NOW))

    def test_exact_delta_and_public_metadata(self):
        result=self.verify()
        self.assertEqual(len(result['added_assignment_ids']),2)
        self.assertFalse(result['authorization'])
        self.assertFalse(result['effective_permissions_proven'])
        self.assertFalse(result['authenticated_azure_provenance'])

    def test_missing_partial_failure_network_and_tamper(self):
        for phase in ('before','after'):
            for attack in ('missing','partial','permission','network','page-hash','argv','manifest','plan','source','predecessor','request','future','old','time-order','pagination'):
                rec=receipt(phase)
                p=page(rec,'roles')
                if attack=='missing':rec['records'].pop()
                elif attack=='partial':rec['records'][0]['complete']=False
                elif attack in ('permission','network'):p['exit_code']=1 if attack=='permission' else 7
                elif attack=='page-hash':p['result_sha256']='f'*64
                elif attack=='argv':p['argv_sha256']='f'*64
                elif attack in ('manifest','plan','source','predecessor','request'):rec[attack+'_sha256' if attack!='source' else 'source_sha']='f'*64
                elif attack=='future':rec['completed_at']='2026-10-26T11:00:00Z'
                elif attack=='old':rec['started_at']='2026-10-25T09:00:00Z'
                elif attack=='time-order':p['started_at']='2026-10-25T09:00:00Z'
                else:p['result']['next_link']='https://evil.invalid/';p['result_sha256']=digest(p['result'])
                with self.subTest(phase=phase,attack=attack),self.assertRaises(Exception):
                    self.verify(**{phase:rec})

    def test_secret_versions_enabled_validity_no_values(self):
        for attack in ('absent','disabled','foreign','version','not-before','expires','secret','duplicate'):
            rec=receipt();rows=page(rec,'secret-database-url')['result']
            if attack=='absent':rows.clear()
            elif attack=='duplicate':rows.append(deepcopy(rows[0]))
            elif attack=='disabled':rows[0]['enabled']=False
            elif attack=='foreign':rows[0]['id']=rows[0]['id'].replace('tonyai-qa-test','foreign')
            elif attack=='version':rows[0]['id']=rows[0]['id'][:-32]+'f'*32
            elif attack=='not-before':rows[0]['not_before']='2026-10-26T12:00:00Z'
            elif attack=='expires':rows[0]['expires']=BEFORE
            else:rows[0]['value']='SECRET_CANARY'
            with self.subTest(attack=attack),self.assertRaises(Exception):self.verify(before=reseal(rec))

    def test_role_replay_extra_wrong_or_missing_assignment_and_preservation(self):
        for attack in ('already-on','other-id-on','extra','lost','changed','role','scope','principal','assignment-id','condition','duplicate'):
            before,after=receipt(),receipt('after')
            old=page(before,'roles')['result']['items'];new=page(after,'roles')['result']['items']
            if attack in ('already-on','other-id-on'):
                old.append(deepcopy(new[-1]))
                if attack=='other-id-on':old[-1]['id']=old[-1]['id'][:-36]+'00000000-0000-0000-0000-000000000001'
            elif attack=='extra':new.append({**new[-1],'id':new[-1]['id'][:-36]+'00000000-0000-0000-0000-000000000001'})
            elif attack=='lost':new.pop(0)
            elif attack=='changed':new[0]['condition']='different'
            elif attack=='role':new[-1]['roleDefinitionId']='foreign'
            elif attack=='scope':new[-1]['scope']=new[-1]['scope'].split('/secrets/')[0]
            elif attack=='principal':new[-1]['principalId']='00000000-0000-0000-0000-000000000005'
            elif attack=='assignment-id':new[-1]['id']=new[-1]['id'][:-36]+'00000000-0000-0000-0000-000000000001'
            elif attack=='condition':new[-1]['condition']='anything'
            else:new.append(deepcopy(new[-1]))
            with self.subTest(attack=attack),self.assertRaises(Exception):self.verify(reseal(before),reseal(after))

    def test_unrelated_roles_preserved_but_not_effective_permission_proof(self):
        before,after=receipt(),receipt('after')
        extra=deepcopy(page(before,'roles')['result']['items'][0])
        extra['id']=extra['id'][:-36]+'00000000-0000-0000-0000-000000000001'
        extra['principalId']='00000000-0000-0000-0000-000000000009'
        page(before,'roles')['result']['items'].append(extra)
        page(after,'roles')['result']['items'].append(deepcopy(extra))
        self.assertFalse(self.verify(reseal(before),reseal(after))['effective_permissions_proven'])
        page(after,'roles')['result']['items'][-1]['scope']='foreign'
        with self.assertRaises(Exception):self.verify(reseal(before),reseal(after))

    def test_account_identity_domain_and_resource_drift(self):
        for key,field,value in [('account','tenant_id','foreign'),('azapi_resource.identity["api"]','principal_id','00000000-0000-0000-0000-000000000009'),
                                ('azapi_resource.environment','default_domain','another.swedencentral.azurecontainerapps.io'),
                                ('azapi_resource.vault','provisioning_state','Updating'),('azapi_resource.group','tags',{})]:
            rec=receipt();page(rec,key)['result'][field]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.verify(before=reseal(rec))
        with self.assertRaises(Exception):self.verify(now=timestamp('2026-10-25T13:00:00Z'))

    def test_metadata_query_never_requests_values(self):
        import jmespath
        spec=manifest(request(),evidence(),'4'*64,'before')
        for name in ('database-url','supabase-service-role-key'):
            argv=spec['commands']['secret-'+name]['argv']
            self.assertEqual(argv[1:4],['keyvault','secret','list-versions'])
            projected=jmespath.search(argv[argv.index('--query')+1],[{'id':'public-id','value':'SECRET_CANARY',
                'attributes':{'enabled':True,'notBefore':None,'expires':None},'tags':{'secret':'SECRET_CANARY'}}])
            self.assertEqual(projected,[dict(id='public-id',enabled=True,not_before=None,expires=None)])

    def test_packet_always_blocked_with_or_without_complete_local_receipt(self):
        report={**check_plan(plan(),request(),evidence(),source_bound=True,now=NOW),
            'request_sha256':digest(request()),'predecessor_sha256':digest(evidence()),'source_sha':'b'*40,
            'before_inputs_sha256':digest(plan()['variables']['config']['value'] | {'release_sha':'a'*40,'runtime_secrets_ready':False}),
            'after_inputs_sha256':digest(plan()['variables']['config']['value']),'plan_created_at':PLAN,'plan_sha256':'4'*64,
            'saved_plan_path':'/private/tmp/saved $(unsafe).tfplan','terraform_path':'/private/tmp/terraform'}
        args=SimpleNamespace(request='/private/tmp/request.json',predecessor='/private/tmp/prior.json',
                             saved_plan='/private/tmp/saved $(unsafe).tfplan',terraform='/private/tmp/terraform')
        for observations in (None,dict(plan_completed_at=PLAN,receipt=receipt())):
            packet=prepare(request(),evidence(),report,args,observations,now=NOW)
            self.assertEqual(packet['status'],'BLOCKED_DRAFT');self.assertIs(packet['authorization'],False)
            self.assertFalse(packet['authenticated_azure_provenance'])
            self.assertIn("'/private/tmp/saved $(unsafe).tfplan'",packet['command_templates']['saved_plan_apply'])
            self.assertNotIn('SECRET_CANARY',str(packet))
        report['predecessor_sha256']='f'*64
        with self.assertRaises(Exception):prepare(request(),evidence(),report,args,now=NOW)

    def test_subscription_assignment_and_case_folded_workload_principal(self):
        from qa_contract import SUBSCRIPTION
        from qa_runtime_contract import check_roles
        from qa_foundation_expected import expected
        from qa_runtime_fixtures import foundation_data
        from qa_foundation_inputs import initial_inputs
        before,after=receipt(),receipt('after')
        extra=deepcopy(page(before,'roles')['result']['items'][0])
        extra.update(scope='/subscriptions/'+SUBSCRIPTION, principalId='00000000-0000-0000-0000-000000000009')
        extra['id']=extra['scope']+'/providers/Microsoft.Authorization/roleAssignments/00000000-0000-0000-0000-000000000010'
        page(before,'roles')['result']['items'].append(extra)
        page(after,'roles')['result']['items'].append(deepcopy(extra))
        self.verify(reseal(before),reseal(after))
        page(after,'roles')['result']['items'][-1]['scope']+='/resourceGroups/foreign'
        with self.assertRaises(Exception):self.verify(reseal(before),reseal(after))
        config=initial_inputs(request()['before_inputs'])
        principals={'api':'aaaaaaaa-0000-0000-0000-000000000004','web':'bbbbbbbb-0000-0000-0000-000000000005'}
        from qa_runtime_contract import role_rows
        resources=expected(config,principals)
        roles=list(role_rows(resources).values())
        extra['principalId']=principals['api'].upper()
        with self.assertRaises(Exception):check_roles(roles+[extra],resources,principals)

    def test_cli_metadata_utc_offsets_and_value_validity(self):
        rec=receipt()
        metadata=page(rec,'secret-database-url')['result'][0]
        metadata.update(not_before='2026-10-25T10:00:00+00:00', expires='2026-10-25T12:00:00.000000+00:00')
        verify(request(),evidence(),'4'*64,reseal(rec),'before',not_before=PLAN,now=NOW)
        metadata['expires']='2026-10-25T12:00:00+03:00'
        with self.assertRaises(Exception):verify(request(),evidence(),'4'*64,reseal(rec),'before',not_before=PLAN,now=NOW)
