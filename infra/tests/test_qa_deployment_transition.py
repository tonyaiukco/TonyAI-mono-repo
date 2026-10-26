"""Independent Unit 8 action/RBAC, historical-chain and unknown-leaf negatives."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from qa_discovery import digest
from qa_deployment_contract import predecessor, transition
from qa_deployment_plan import check_plan
from qa_deployment_fixtures import request, evidence, plan, NOW, synthetic_history


class Transition(unittest.TestCase):
    def setUp(self):
        context=synthetic_history(); context.__enter__(); self.addCleanup(context.__exit__,None,None,None)

    def check(self, value=None):
        return check_plan(value or plan(), request(), evidence(), source_bound=True, now=NOW)

    def test_exact_two_grants_known_identity_and_separate_sources(self):
        result=self.check()
        self.assertEqual(result['actions'],dict(create=2,update=1,**{'no-op':23}))
        self.assertEqual(result['resource_count'],26)
        self.assertEqual(set(result['grants']),{'azapi_resource.grant["app-api"]','azapi_resource.grant["app-web"]'})
        context=predecessor(request(),evidence(),now=NOW)
        self.assertEqual(len({context['before']['release_sha'],context['after']['release_sha'],context['inputs']['release']['source_sha']}),3)

    def test_same_source_needs_no_tag_update(self):
        req=request();req['after_inputs']['config']['release_sha']=req['before_inputs']['config']['release_sha']
        value=plan();value['variables']['config']['value']['release_sha']=req['after_inputs']['config']['release_sha']
        group=next(r['change'] for r in value['resource_changes'] if r['address']=='azapi_resource.group')
        group.update(actions=['no-op'],after=deepcopy(group['before']))
        result=check_plan(value,req,evidence(),now=NOW)
        self.assertEqual(result['actions'],{'create':2,'update':0,'no-op':24})
        self.assertIsNone(result['source_tag_change'])

    def test_existing_release_history_requires_exact_fresh_drained_set(self):
        from qa_deployment_fixtures import app_receipt,app_data,accepted
        from test_qa_oidc_receipt import data,seal
        ev=evidence();unit=ev['unit7'];inputs=unit['inputs']
        outgoing={k:['tonyai-staging-'+k+'--old'] for k in ('api','web')}
        names={k:sorted(outgoing[k]+['tonyai-staging-'+k+'--qa001']) for k in outgoing}
        before=dict(inventory=['tonyai-staging-api','tonyai-staging-web'])
        for kind in outgoing:
            before[kind+'_revisions']=[dict(name=outgoing[kind][0],properties=dict(active=True))]
            before['replicas:'+outgoing[kind][0]]=[]
        drained=deepcopy(before);drained['api_revisions'][0]['properties']['active']=False
        unit.update(outgoing_revisions=outgoing,
            before_receipt=app_receipt(inputs,'before','2026-10-25T13:01:00Z',outgoing,before),
            drained_receipt=app_receipt(inputs,'drained','2026-10-25T13:01:30Z',outgoing,drained),
            after_receipt=app_receipt(inputs,'after','2026-10-25T13:03:00Z',names,app_data(inputs,names)))
        for row in unit['saved_plan']['resources']:row.update(actions=['update'],previous_body_sha256='f'*64)
        unit['owner_acceptance']=accepted(7,unit['saved_plan'],unit['after_receipt'])
        self.assertEqual(predecessor(request(ev),ev,now=NOW)['revision_names'],names)
        for attack in ('missing','active','replicas','late','stale','outgoing'):
            changed=deepcopy(ev);unit=changed['unit7'];rec=unit['drained_receipt']
            if attack=='missing':unit['drained_receipt']=None
            if attack=='active':data(rec,'api_revisions')[0]['properties']['active']=True;seal(rec)
            if attack=='replicas':data(rec,'replicas:tonyai-staging-api--old').append('left');seal(rec)
            if attack in ('late','stale'):
                target=rec if attack=='late' else unit['after_receipt']
                stamp='2026-10-25T13:02:30Z' if attack=='late' else '2026-10-25T14:03:00Z'
                target['started_at']=target['completed_at']=stamp
                for row in target['records']:
                    for page in row['pages']:page.update(started_at=stamp,completed_at=stamp)
                if attack=='stale':unit['owner_acceptance']=accepted(7,unit['saved_plan'],target)
            if attack=='outgoing':unit['outgoing_revisions']['api']=[]
            with self.subTest(attack=attack),self.assertRaises(Exception):predecessor(request(changed),changed,now=NOW)

    def test_stage_skip_reverse_replay_and_unrelated_input(self):
        for phase in ('before','after'):
            for key in ('runtime_secrets_ready','oidc_enabled','smtp_secret_ready','apps_ready'):
                req=request();req[phase+'_inputs']['config'][key]=not req[phase+'_inputs']['config'][key]
                with self.subTest(phase=phase,key=key),self.assertRaises(Exception):transition(req)
        for key,value in [('owner_object_id','00000000-0000-0000-0000-000000000099'),('registry_name','otherregistry'),('recovery_marker',True)]:
            req=request();req['after_inputs']['config'][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):transition(req)

    def test_every_resource_actions_import_move_provider_or_sensitive(self):
        for index in range(26):
            for attack in ('delete','replace','import','move','provider','sensitive','duplicate'):
                value=plan();row=value['resource_changes'][index]
                if attack=='delete':row['change']['actions']=['delete']
                if attack=='replace':row['change']['actions']=['delete','create']
                if attack=='import':row['change']['importing']={'id':'foreign'}
                if attack=='move':row['previous_address']='foreign'
                if attack=='provider':row['provider_name']='foreign'
                if attack=='sensitive':row['change']['after_sensitive']={'body':True}
                if attack=='duplicate':value['resource_changes'].append(deepcopy(row))
                with self.subTest(index=index,attack=attack),self.assertRaises(Exception):self.check(value)

    def test_each_existing_resource_and_output_preserved(self):
        for index,row in enumerate(plan()['resource_changes']):
            if row['change']['before'] is None: continue
            for field,content in [('body',{}),('tags',{'recovery_marker':'allowed?'}),('identity',[{}]),('output',{'changed':True})]:
                value=plan();value['resource_changes'][index]['change']['after'][field]=content
                # Empty bodies/outputs are common: always introduce a difference.
                if content==row['change']['after'].get(field):value['resource_changes'][index]['change']['after'][field]={'foreign':True}
                with self.subTest(address=row['address'],field=field),self.assertRaises(Exception):self.check(value)
        for key in ('application_contract','oidc_client_id'):
            value=plan();value['output_changes'][key]['after']=None
            with self.subTest(output=key),self.assertRaises(Exception):self.check(value)

    def test_exact_role_scope_principal_name_and_no_unknown_escape(self):
        for kind in ('api','web'):
            for key,bad in [('principalId','00000000-0000-0000-0000-000000000004'),('principalId','00000000-0000-0000-0000-000000000003'),
                            ('principalType','User'),('roleDefinitionId','Owner'),('roleDefinitionId','Contributor')]:
                value=plan();row=next(r for r in value['resource_changes'] if r['address']==f'azapi_resource.grant["app-{kind}"]')
                row['change']['after']['body']['properties'][key]=bad
                with self.subTest(kind=kind,key=key,bad=bad),self.assertRaises(Exception):self.check(value)
            for key in ('body','identity','parent_id','name','type'):
                for unknown in (False,True):
                    value=plan();row=next(r for r in value['resource_changes'] if r['address']==f'azapi_resource.grant["app-{kind}"]')
                    row['change']['after'][key]=None if unknown else 'foreign'
                    row['change']['after_unknown'][key]=unknown
                    with self.subTest(kind=kind,key=key,unknown=unknown),self.assertRaises(Exception):self.check(value)
            for key in ('id','output','ignore_casing','location','tags'):
                value=plan();row=next(r for r in value['resource_changes'] if r['address']==f'azapi_resource.grant["app-{kind}"]')
                row['change']['after'][key]='known-wrong';row['change']['after_unknown'][key]=True
                with self.subTest(known_wrong=key),self.assertRaises(Exception):self.check(value)

    def test_plan_envelope_and_extra_resource_or_request_options(self):
        for key,value in [('complete',False),('errored',True),('applyable',False),('resource_drift',[{}]),('deferred_changes',[{}]),
                          ('checks',[{'status':'unknown'}]),('timestamp','2026-10-25T12:00:00Z')]:
            changed=plan();changed[key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(changed)
        for key,value in [('create_headers',{'Authorization':'SECRET_CANARY'}),('sensitive_body','SECRET_CANARY'),
                          ('response_export_values',['*']),('unexpected_option',True)]:
            changed=plan();changed['resource_changes'][-1]['change']['after'][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(changed)
        value=plan();value['resource_changes'].pop()
        with self.assertRaises(Exception):self.check(value)

    def test_predecessor_substitution_draft_hashes_candidate_replay_and_order(self):
        paths=[('unit5','saved_plan','plan_sha256'),('unit5','saved_plan','configuration_sha256'),
               ('unit5','saved_plan','provider_lock_sha256'),('unit5','saved_plan','terraform_binary_sha256'),
               ('unit5','owner_acceptance','report_sha256'),('unit5','owner_acceptance','accepted_at'),
               ('unit7','candidate','api_digest'),('unit7','candidate','lockfile_sha256'),
               ('unit7','inputs','release','source_sha'),('unit7','inputs','release','release_id'),
               ('unit7','saved_plan','configuration_sha256'),('unit7','candidate_provenance','source_sha'),
               ('unit7','outgoing_revisions','api'),('unit7','owner_acceptance','after_receipt_sha256'),
               ('unit7','apply_started_at'),('unit7','plan_completed_at')]
        for path in paths:
            ev=evidence();target=ev
            for part in path[:-1]:target=target[part]
            target[path[-1]]='wrong'
            with self.subTest(path=path),self.assertRaises(Exception):predecessor(request(ev),ev,now=NOW)
        for unit in ('unit5','unit7'):
            ev=evidence();ev[unit]['owner_acceptance']={'status':'BLOCKED_DRAFT','authorization':False,'binding':ev[unit]['saved_plan']}
            with self.subTest(unit=unit),self.assertRaises(Exception):predecessor(request(ev),ev,now=NOW)
        ev=evidence();ev['unit5'],ev['unit7']=ev['unit7'],ev['unit5']
        with self.assertRaises(Exception):predecessor(request(ev),ev,now=NOW)

    def test_other_policies_do_not_accept_unit8(self):
        import qa_preflight_fixtures as initial
        import qa_runtime_fixtures as runtime
        import qa_oidc_fixtures as oidc
        from qa_foundation_plan import check_plan as foundation_check
        from qa_runtime_plan import check_plan as runtime_check
        from qa_oidc_plan import check_plan as oidc_check
        from qa_release import check_plan as application_check
        for fn,args in [(foundation_check,(initial.inputs(),)),(runtime_check,(runtime.request(),runtime.evidence())),
                        (oidc_check,(oidc.request(),oidc.evidence())),(application_check,(evidence()['unit7']['inputs'],))]:
            with self.subTest(fn=fn.__module__),self.assertRaises(Exception):fn(plan(),*args)
