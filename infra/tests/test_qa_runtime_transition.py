"""Unit 4 privilege, transition, prior-state and metadata mutation regressions."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from qa_discovery import digest
from qa_runtime_contract import transition, predecessor
from qa_runtime_plan import check_plan
from qa_runtime_fixtures import request, evidence, plan, NOW
from qa_foundation_plan import check_plan as check_initial
from qa_preflight_fixtures import plan as initial_plan, inputs


def row(value, suffix):
    return next(r for r in value['resource_changes'] if r['address'] == 'azapi_resource.' + suffix)


class Transition(unittest.TestCase):
    def check(self, value=None, req=None, ev=None):
        return check_plan(value or plan(), req or request(), ev or evidence(), source_bound=True, now=NOW)

    def test_exact_transition_and_source_tag_exception(self):
        self.assertEqual(self.check()['actions'], {'create': 2, 'update': 1, 'no-op': 14})
        p, req = plan(), request()
        req['after_inputs']['config']['release_sha'] = 'a'*40
        p['variables']['config']['value']['release_sha'] = 'a'*40
        group = row(p, 'group')['change']
        group.update(actions=['no-op'], after=deepcopy(group['before']))
        self.assertEqual(self.check(p, req)['actions'], {'create': 2, 'update': 0, 'no-op': 15})

    def test_flags_reverse_replay_skipped_stage_and_missing(self):
        for side in ('before_inputs', 'after_inputs'):
            for key in ('runtime_secrets_ready', 'smtp_secret_ready', 'oidc_enabled', 'apps_ready'):
                req = request()
                req[side]['config'][key] = not req[side]['config'][key]
                with self.subTest(side=side, key=key), self.assertRaises(Exception): transition(req)
                del req[side]['config'][key]
                with self.assertRaises(Exception): transition(req)
        for invalid in (1, 0, None, 'true'):
            req = request(); req['after_inputs']['config']['runtime_secrets_ready'] = invalid
            with self.assertRaises(Exception): transition(req)

    def test_other_input_changes_refuse(self):
        for key, value in [('tenant_id', '0'*8+'-0000-0000-0000-'+'0'*12), ('owner_object_id','0'*8+'-0000-0000-0000-'+'0'*12),
                           ('registry_name','anotherregistry'), ('vault_name','another-vault'), ('subscription_id','foreign'),
                           ('resource_group','other'), ('prefix','other'), ('repository','other'), ('apps_subnet_id','foreign')]:
            req = request(); req['after_inputs']['config'][key] = value
            with self.subTest(key=key), self.assertRaises(Exception): transition(req)

    def test_predecessor_tamper_and_rebound_inconsistency(self):
        for key in ('source_sha','normalized_inputs_sha256','plan_sha256','provider_lock_sha256','input_file_sha256'):
            ev=evidence(); ev['initial_plan'][key]='f'*64
            with self.subTest(key=key), self.assertRaises(Exception): self.check(ev=ev)
        for attack in ('missing','source','inputs','count','authorization','receipt'):
            req,ev=request(),evidence()
            if attack=='missing': ev.pop('readback')
            elif attack=='source': ev['initial_plan']['source_sha']='f'*40
            elif attack=='inputs': ev['initial_plan']['normalized_inputs_sha256']='f'*64
            elif attack=='count': ev['initial_plan']['resource_count']=17
            elif attack=='authorization': ev['initial_plan']['authorization']=True
            else: ev['readback']['manifest_sha256']='f'*64
            req['predecessor_sha256']=digest(ev)
            with self.subTest(attack=attack), self.assertRaises(Exception): self.check(req=req,ev=ev)

    def test_exact_two_creates_not_extra_or_already_present(self):
        for attack in ('extra','missing','prior-runtime','duplicate','replay'):
            p=plan(); grant=row(p,'grant["secret-database-url"]')
            if attack=='extra':
                extra=deepcopy(grant); extra['address']='azapi_resource.grant["secret-smtp-password"]'; p['resource_changes'].append(extra)
            elif attack=='missing': p['resource_changes'].remove(grant)
            elif attack=='duplicate': p['resource_changes'].append(deepcopy(grant))
            elif attack=='replay': grant['change'].update(actions=['no-op'],before=deepcopy(grant['change']['after']))
            else: p['prior_state']['values']['root_module']['resources'].append(dict(address=grant['address'],values=grant['change']['after']))
            with self.subTest(attack=attack), self.assertRaises(Exception): self.check(p)

    def test_every_resource_rejects_delete_replace_import_move_and_unknown_body(self):
        for index in range(17):
            for attack in ('delete','replace','import','move','provider','deposed','unknown-body','sensitive'):
                p=plan(); r=p['resource_changes'][index]; c=r['change']
                if attack=='delete': c['actions']=['delete']
                elif attack=='replace': c['actions']=['delete','create']
                elif attack=='import': c['importing']={'id':'foreign'}
                elif attack=='move': r['previous_address']='foreign'
                elif attack=='provider': r['provider_name']='foreign'
                elif attack=='deposed': r['deposed']='old'
                elif attack=='sensitive': c['after_sensitive']={'body':True}
                else: c['after'].pop('body');c['after_unknown']['body']=True
                with self.subTest(index=index,attack=attack),self.assertRaises(Exception):self.check(p)

    def test_wrong_principal_role_and_scope(self):
        p=plan(); original=row(p,'grant["secret-database-url"]')['change']['after']
        scopes=[original['parent_id'].split('/secrets/')[0],'/subscriptions/foreign',
                original['parent_id'].rsplit('/providers/Microsoft.KeyVault/',1)[0]]
        scopes += [original['parent_id'].rsplit('/',1)[0]+'/'+n for n in ('direct-url','owner','recovery','smtp-password')]
        scopes += [original['parent_id']+'/'+'a'*32]
        for scope in scopes:
            p=plan();row(p,'grant["secret-database-url"]')['change']['after']['parent_id']=scope
            with self.subTest(scope=scope),self.assertRaises(Exception):self.check(p)
        for field, value in [('principalId','00000000-0000-0000-0000-000000000005'),
                              ('principalId','00000000-0000-0000-0000-000000000003'),
                              ('roleDefinitionId',original['body']['properties']['roleDefinitionId'].replace('4633458b-17de-408a-b874-0445c86b69e6','b86a8fe4-44ce-4948-aee5-eccb2c155cd7')),
                              ('principalType','User'),('condition','anything')]:
            p=plan();row(p,'grant["secret-database-url"]')['change']['after']['body']['properties'][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(Exception):self.check(p)

    def test_metadata_drift_incomplete_deferred_error_and_prior_gaps(self):
        for field,value in [('complete',False),('errored',True),('applyable',False),('resource_drift',[{}]),
                            ('deferred_changes',[{}]),('terraform_version','1.14.0'),('variables',{}),('prior_state',{})]:
            p=plan();p[field]=value
            with self.subTest(field=field),self.assertRaises(Exception):self.check(p)
        for attack in ('child','missing','before-diff','id','prior-provider','identity-output'):
            p=plan(); root=p['prior_state']['values']['root_module']
            if attack=='child':root['child_modules']=[{}]
            elif attack=='missing':root['resources'].pop()
            elif attack=='prior-provider':root['resources'][0]['provider_name']='foreign'
            elif attack=='before-diff':root['resources'][0]['values']['name']='foreign'
            else:
                r=row(p,'identity["api"]');key='id' if attack=='id' else 'output'
                r['change']['before'][key]='foreign';r['change']['after'][key]='foreign'
                next(s for s in root['resources'] if s['address']==r['address'])['values'][key]='foreign'
            with self.subTest(attack=attack),self.assertRaises(Exception):self.check(p)

    def test_source_tag_exception_cannot_hide_other_writes(self):
        for target, field, value in [('group','body',{'properties':{'extra':True}}),('group','tags',{'releaseSha':'b'*40}),
                                    ('group','name','other'),('vault','body',{}),('registry','location','global')]:
            p=plan();row(p,target)['change']['after'][field]=value
            with self.subTest(target=target,field=field),self.assertRaises(Exception):self.check(p)
        for tag in ('githubClientId','githubPrincipalId','extra'):
            p=plan();row(p,'group')['change']['after']['tags'][tag]='anything'
            with self.assertRaises(Exception):self.check(p)

    def test_provider_options_and_unknowns_exact(self):
        for target in ('group','grant["secret-database-url"]'):
            for key,value in [('create_headers',{'Authorization':'SECRET_CANARY'}),('retry',{}),('sensitive_body','SECRET_CANARY'),
                              ('response_export_values',['*']),('ignore_casing',True),('schema_validation_enabled',False)]:
                p=plan();row(p,target)['change']['after'][key]=value
                with self.subTest(target=target,key=key),self.assertRaises(Exception):self.check(p)
        for key in ('name','parent_id','body','create_headers'):
            p=plan();c=row(p,'grant["secret-database-url"]')['change'];c['after'].pop(key,None);c['after_unknown'][key]=True
            with self.subTest(key=key),self.assertRaises(Exception):self.check(p)

    def test_initial_policy_not_weakened(self):
        self.assertEqual(check_initial(initial_plan(),inputs())['resource_count'],15)
        with self.assertRaises(Exception):check_initial(plan(),request()['after_inputs'])
        changed=inputs();changed['config']['runtime_secrets_ready']=True
        with self.assertRaises(Exception):check_initial(initial_plan(),changed)
