"""Fresh success, exact inventories, unchanged apps and permanently blocked packets."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from qa_discovery import digest
from qa_deployment_receipt import verify_after
from qa_deployment_packet import prepare
from qa_deployment_fixtures import request,evidence,report,receipt,github_receipt,synthetic_history,NOW,PLAN,APPLY
from test_qa_oidc_receipt import data,seal


class Receipts(unittest.TestCase):
    def setUp(self):
        context=synthetic_history();context.__enter__();self.addCleanup(context.__exit__,None,None,None)
        self.binding=report();self.before=receipt(binding=self.binding);self.after=receipt('after',binding=self.binding)

    def check(self,before=None,after=None,now=NOW):
        return verify_after(request(),evidence(),self.binding,before or self.before,after or self.after,
            plan_completed_at=PLAN,apply_started_at=APPLY,apply_completed_at=APPLY,now=now)

    def test_complete_synthetic_never_authorizes(self):
        result=self.check()
        self.assertFalse(result['authorization']);self.assertFalse(result['authenticated_azure_provenance'])
        self.assertEqual(len(result['added_assignment_ids']),2)

    def test_each_binding_pagination_failure_hash_and_freshness(self):
        for phase,original in [('before',self.before),('after',self.after)]:
            for key in ('source_sha','request_sha256','predecessor_sha256','report_sha256','plan_sha256','application_inputs_sha256','manifest_sha256','phase'):
                value=deepcopy(original);value[key]='wrong'
                with self.subTest(phase=phase,key=key),self.assertRaises(Exception):self.check(**{phase:value})
            for attack in ('missing','duplicate','partial','permission','not-found','hash','argv','unread-page'):
                value=deepcopy(original);row=value['records'][0];page=row['pages'][0]
                if attack=='missing':value['records'].pop()
                if attack=='duplicate':value['records'].append(deepcopy(row))
                if attack=='partial':row['complete']=False
                if attack=='permission':page['exit_code']=403
                if attack=='not-found':page['exit_code']=404
                if attack=='hash':page['result_sha256']='0'*64
                if attack=='argv':page['argv_sha256']='0'*64
                if attack=='unread-page':next(r for r in value['records'] if r['key']=='roles')['pages'][0]['result']['next_link']='https://management.azure.com/unread'
                with self.subTest(phase=phase,attack=attack),self.assertRaises(Exception):self.check(**{phase:value})
        with self.assertRaises(Exception):self.check(now=NOW+timedelta(hours=2))
        with self.assertRaises(Exception):self.check(before=self.after,after=self.before)

    def test_both_apps_must_exist_and_match_accepted_release(self):
        attacks=[('id','/wrong/app'),('location','germanywestcentral'),('identity',{}),('tags',{}),
                 ('properties',None)]
        for kind in ('api','web'):
            for field,value in attacks:
                rec=deepcopy(self.before);data(rec,'app:'+kind+'_app')[field]=value
                with self.subTest(kind=kind,field=field),self.assertRaises(Exception):self.check(before=seal(rec))
            for path,value in [(('provisioningState',),'Failed'),(('latestReadyRevisionName',),'other'),
                (('managedEnvironmentId',),'/wrong/environment'),(('template','containers',0,'image'),'unreviewed:latest'),
                (('configuration','registries'),[])]:
                rec=deepcopy(self.before);target=data(rec,'app:'+kind+'_app')['properties']
                for part in path[:-1]:target=target[part]
                target[path[-1]]=value
                with self.subTest(kind=kind,path=path),self.assertRaises(Exception):self.check(before=seal(rec))
        for inventory in ([],['tonyai-staging-api'],['tonyai-staging-web']):
            rec=deepcopy(self.before);data(rec,'app:inventory')[:]=inventory
            with self.subTest(inventory=inventory),self.assertRaises(Exception):self.check(before=seal(rec))

    def test_no_app_replica_traffic_or_allowed_default_changes_during_grants(self):
        for attack in ('replica','traffic','default','revision'):
            rec=deepcopy(self.after)
            if attack=='replica':data(rec,'app:replicas:tonyai-staging-api--qa001').append('replica-1')
            if attack=='traffic':data(rec,'app:api_app')['properties']['configuration']['ingress']['traffic']=[dict(latestRevision=True,weight=100)]
            if attack=='default':data(rec,'app:api_app')['properties']['template']['volumes']=[]
            if attack=='revision':data(rec,'app:api_revisions')[0]['properties']['active']=False
            with self.subTest(attack=attack),self.assertRaises(Exception):self.check(after=seal(rec))

    def test_correlated_omission_and_historical_inventory_reconciliation(self):
        for row in data(self.before,'resources'):
            before,after=deepcopy(self.before),deepcopy(self.after)
            for rec in (before,after):
                rows=data(rec,'resources');rows[:]=[r for r in rows if r['id']!=row['id']]
            with self.subTest(omitted=row['id']),self.assertRaises(Exception):self.check(seal(before),seal(after))
        for key in ('roles','identities','federation-release'):
            before,after=deepcopy(self.before),deepcopy(self.after)
            for rec in (before,after):data(rec,key).pop(0)
            with self.subTest(key=key),self.assertRaises(Exception):self.check(seal(before),seal(after))
        before,after=deepcopy(self.before),deepcopy(self.after)
        for rec in (before,after):data(rec,'resources').append(dict(id='/subscriptions/other/resource',type='other',location='swedencentral',tags={}))
        with self.assertRaises(Exception):self.check(seal(before),seal(after))

    def test_principals_clients_roles_federation_custom_role_and_metadata(self):
        cases=[('identities',(-1,'principal_id'),'00000000-0000-0000-0000-000000000004'),
               ('identities',(-1,'client_id'),'00000000-0000-0000-0000-000000000099'),
               ('roles',(-1,'principalId'),'00000000-0000-0000-0000-000000000003'),
               ('roles',(-1,'scope'),'/subscriptions/cb7efc2f-37a7-4672-b62c-93c207bcd33d'),
               ('roles',(-1,'roleDefinitionId'),'Owner'),('federation-release',(0,'subject'),'repo:other/repo:environment:staging'),
               ('azapi_resource.join_role',('body','properties','permissions',0,'actions'),['*']),
               ('azapi_resource.group',('tags','releaseSha'),'x'*40)]
        for key,path,value in cases:
            rec=deepcopy(self.after);target=data(rec,key)
            for part in path[:-1]:target=target[part]
            target[path[-1]]=value
            with self.subTest(key=key,path=path),self.assertRaises(Exception):self.check(after=seal(rec))
        rec=deepcopy(self.after);data(rec,'roles').append(deepcopy(data(rec,'roles')[-1]))
        with self.assertRaises(Exception):self.check(after=seal(rec))

    def test_uuid_case_and_source_defined_empty_tags(self):
        rec=deepcopy(self.after)
        for row in data(rec,'roles'):
            for key in ('id','scope','principalId','roleDefinitionId'):row[key]=row[key].upper()
        data(rec,'identities')[-1]['tags']={}
        next(r for r in data(rec,'resources') if r['id'].endswith('/tonyai-staging-release'))['tags']={}
        self.check(after=seal(rec))
        for phase in ('before','after'):
            for identity_tags,inventory_tags in ((None,{}),({},None)):
                rec=deepcopy(self.before if phase=='before' else self.after)
                data(rec,'identities')[-1]['tags']=identity_tags
                next(r for r in data(rec,'resources') if r['id'].endswith('/tonyai-staging-release'))['tags']=inventory_tags
                with self.subTest(phase=phase,identity_tags=identity_tags):self.check(**{phase:seal(rec)})

    def test_correlated_app_identity_and_inventory_contradictions_refuse(self):
        from qa_expected import identity
        for attack in ('principal','client','cross-app','missing','extra-app'):
            before,after=deepcopy(self.before),deepcopy(self.after)
            for rec in (before,after):
                assigned=data(rec,'app:api_app')['identity']['userAssignedIdentities'][identity('api')]
                if attack=='principal':assigned['principalId']='00000000-0000-0000-0000-000000000099'
                if attack=='client':assigned['clientId']='00000000-0000-0000-0000-000000000098'
                if attack=='cross-app':assigned.update(data(rec,'app:web_app')['identity']['userAssignedIdentities'][identity('web')])
                if attack=='missing':assigned.clear()
                if attack=='extra-app':data(rec,'app:inventory').append('tonyai-staging-third')
            with self.subTest(attack=attack),self.assertRaises(Exception):self.check(seal(before),seal(after))

    def test_packet_full_inventory_canonical_commands_and_external_boundaries(self):
        args=SimpleNamespace(saved_plan=self.binding['saved_plan_path'],terraform=self.binding['terraform_path'],
            request='/synthetic/request.json',predecessor='/synthetic/predecessor.json',ruleset_id=42)
        observation=dict(plan_completed_at=PLAN,receipt=self.before,github_receipt=github_receipt())
        packet=prepare(request(),evidence(),self.binding,args,observation,now=NOW)
        self.assertEqual(packet['status'],'BLOCKED_DRAFT');self.assertFalse(packet['authorization'])
        self.assertEqual(len(packet['binding']['resources']),26)
        self.assertIn('indirectly access runtime secrets',packet['scope_semantics'])
        self.assertIn('/synthetic/terraform',packet['command_templates']['saved_plan_apply'])
        self.assertNotIn('drain',packet['command_templates'])
        for attack in ('partial','self','bypass','old','mode'):
            obs=deepcopy(observation);rec=obs['github_receipt']
            if attack=='partial':rec['records'][0]['complete']=False
            if attack=='self':data(rec,'environment')['protection_rules'][0]['prevent_self_review']=False
            if attack=='bypass':data(rec,'environment')['can_admins_bypass']=True
            if attack=='old':rec['started_at']='2020-01-01T00:00:00Z'
            if attack=='mode':data(rec,'mode')['value']='persistent'
            with self.subTest(attack=attack),self.assertRaises(Exception):prepare(request(),evidence(),self.binding,args,{**obs,'github_receipt':seal(rec)},now=NOW)
        for key in ('plan_sha256','unit5_acceptance_sha256','unit7_report_sha256','candidate_provenance_sha256'):
            binding=deepcopy(self.binding);binding[key]='0'*64
            with self.subTest(key=key),self.assertRaises(Exception):prepare(request(),evidence(),binding,args,observation,now=NOW)
