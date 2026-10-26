"""Tampered, incomplete, stale, broad or adopted Azure/GitHub snapshots refuse."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from qa_contract import SUBSCRIPTION
from qa_discovery import digest
from qa_oidc_receipt import verify, verify_after
from qa_oidc_github import verify as github_verify
from qa_oidc_fixtures import request,evidence,receipt,github_receipt,report,NOW,PLAN,APPLY,PRINCIPAL,CLIENT,CLIENTS


def data(rec,key):
    value=next(r for r in rec['records'] if r['key']==key)['pages'][0]['result']
    return value['items'] if isinstance(value,dict) and 'items' in value else value


def seal(rec):
    for row in rec['records']:
        for page in row['pages']: page['result_sha256']=digest(page['result'])
    return rec


class AzureReceipts(unittest.TestCase):
    def check(self,before=None,after=None,now=NOW):
        return verify_after(request(),evidence(),report(),before or receipt(),after or receipt('after'),
            plan_completed_at=PLAN,apply_started_at=APPLY,apply_completed_at=APPLY,now=now)

    def test_complete_synthetic_evidence_never_authorizes(self):
        checked=self.check()
        self.assertFalse(checked['authorization']);self.assertFalse(checked['authenticated_azure_provenance'])
        self.assertFalse(checked['effective_permissions_proven']);self.assertEqual(len(checked['added_assignment_ids']),5)

    def test_absence_cannot_be_adoption_or_permission_error(self):
        rec=receipt();data(rec,'identities').append(data(receipt('after'),'identities')[-1])
        with self.assertRaises(Exception):self.check(before=seal(rec))
        rec=receipt();data(rec,'resources').append(data(receipt('after'),'resources')[-1])
        with self.assertRaises(Exception):self.check(before=seal(rec))
        for code in (1,3,403,404):
            rec=receipt();rec['records'][0]['pages'][0]['exit_code']=code
            with self.subTest(code=code),self.assertRaises(Exception):self.check(before=rec)

    def test_each_envelope_hash_time_and_partial_failure(self):
        for phase in ('before','after'):
            for key in ('source_sha','request_sha256','predecessor_sha256','plan_sha256','manifest_sha256','phase'):
                rec=receipt(phase);rec[key]='wrong'
                with self.subTest(phase=phase,key=key),self.assertRaises(Exception):self.check(**{phase:rec})
            for attack in ('complete','exit','argv','result-hash','missing','duplicate','next-link'):
                rec=receipt(phase);r=rec['records'][0];p=r['pages'][0]
                if attack=='complete':r['complete']=False
                if attack=='exit':p['exit_code']=1
                if attack=='argv':p['argv_sha256']='0'*64
                if attack=='result-hash':p['result_sha256']='0'*64
                if attack=='missing':rec['records'].pop()
                if attack=='duplicate':rec['records'].append(deepcopy(r))
                if attack=='next-link':next(r for r in rec['records'] if r['key']=='roles')['pages'][0]['result']['next_link']='https://management.azure.com/unread'
                with self.subTest(phase=phase,attack=attack),self.assertRaises(Exception):self.check(**{phase:rec})
        with self.assertRaises(Exception):self.check(now=NOW+timedelta(hours=2))
        rec=receipt('after');rec['started_at']='2026-10-25T11:00:00Z'
        with self.assertRaises(Exception):self.check(after=rec)

    def test_federation_exact_child_parent_issuer_subject_audience(self):
        for key,value in [('id','/wrong/parent/federatedIdentityCredentials/github-staging'),('name','other'),('issuer','https://evil'),
            ('subject','repo:other/repo:environment:staging'),('subject','repo:tonyaiukco/TonyAI-mono-repo:environment:prod'),('audiences',['other'])]:
            rec=receipt('after');data(rec,'federation-release')[0][key]=value
            with self.subTest(key=key),self.assertRaises(Exception):self.check(after=seal(rec))
        for key in ('federation-release','federation-api','federation-web'):
            rec=receipt('after');data(rec,key).append(deepcopy(data(rec,'federation-release')[0]))
            with self.subTest(extra=key),self.assertRaises(Exception):self.check(after=seal(rec))

    def test_principal_client_collisions_and_grant_correlations(self):
        for key in ('principal_id','client_id'):
            for value in ('not-uuid','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',
                          CLIENTS['web'],PRINCIPAL if key=='client_id' else CLIENT):
                rec=receipt('after');data(rec,'identities')[-1][key]=value
                with self.subTest(key=key,value=value),self.assertRaises(Exception):self.check(after=seal(rec))
        for i in range(5,10):
            for key,value in [('principalId','00000000-0000-0000-0000-000000000005'),('roleDefinitionId','Owner'),('scope','/subscriptions/'+SUBSCRIPTION)]:
                rec=receipt('after');data(rec,'roles')[i][key]=value
                with self.subTest(i=i,key=key),self.assertRaises(Exception):self.check(after=seal(rec))
        rec=receipt('after');data(rec,'identities')[0]['client_id']='00000000-0000-0000-0000-000000000010'
        with self.assertRaises(Exception):self.check(after=seal(rec))

    def test_existing_and_unrelated_assignments_inventory_preserved(self):
        for key in ('roles','resources'):
            rec=receipt('after');data(rec,key).pop(0)
            with self.subTest(deleted=key),self.assertRaises(Exception):self.check(after=seal(rec))
        rec=receipt('after');data(rec,'azapi_resource.join_role')['body']['properties']['permissions'][0]['dataActions']=['*']
        with self.assertRaises(Exception):self.check(after=seal(rec))
        rec=receipt('after');data(rec,'azapi_resource.group')['tags']['githubClientId']=CLIENT
        with self.assertRaises(Exception):self.check(after=seal(rec))
        rec=receipt('after');data(rec,'resources')[0]['tags']={'extra':'changed'}
        with self.assertRaises(Exception):self.check(after=seal(rec))
        rec=receipt('after');data(rec,'roles')[1]['principalId']=PRINCIPAL
        with self.assertRaises(Exception):self.check(after=seal(rec))

    def test_uuid_case_subscription_scope_and_full_role_preservation(self):
        before,after=receipt(),receipt('after')
        external=dict(id=f'/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleAssignments/abcdef00-0000-0000-0000-000000000099',
            scope='/subscriptions/'+SUBSCRIPTION,principalId='abcdef00-0000-0000-0000-000000000088',principalType='User',
            roleDefinitionId=f'/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7',
            condition=None,conditionVersion=None,delegated=None)
        for rec in (before,after):data(rec,'roles').append(deepcopy(external))
        for r in data(after,'roles'):
            for key in ('id','scope','principalId','roleDefinitionId'):r[key]=r[key].upper()
        self.check(seal(before),seal(after))
        data(after,'roles')[-1]['condition']='changed'
        with self.assertRaises(Exception):self.check(seal(before),seal(after))


class GitHubReceipts(unittest.TestCase):
    def check(self,rec=None,now=NOW):return github_verify(request(),'7'*64,rec or github_receipt(),not_before=PLAN,now=now)

    def test_positive_remains_unauthenticated_with_external_host_and_human_gates(self):
        value=self.check()
        for key in ('authorization','authenticated_github_provenance','independent_human_approver_proven','fresh_jit_host_proven'):
            self.assertFalse(value[key])

    def test_self_review_bypass_main_wildcard_tag_and_permanent_host(self):
        cases=[('environment',('can_admins_bypass',),True),('environment',('protection_rules',0,'prevent_self_review'),False),
            ('environment',('protection_rules',0,'reviewers'),[]),('policies',('branch_policies',0,'name'),'*'),
            ('policies',('branch_policies',0,'type'),'tag'),('mode',('value',),'persistent'),
            ('approval',('approval_policy',),'first_time_contributors'),('ruleset',('bypass_actors',),[{'actor_type':'User','actor_id':1}]),
            ('ruleset',('enforcement',),'evaluate'),('ruleset',('conditions','ref_name','include'),['refs/heads/*']),
            ('ruleset',('rules',2,'parameters','require_last_push_approval'),False),
            ('ruleset',('rules',2,'parameters','dismiss_stale_reviews_on_push'),False),
            ('ruleset',('rules',2,'parameters','required_approving_review_count'),0),
            ('ruleset',('rules',3,'parameters','strict_required_status_checks_policy'),False),
            ('ruleset',('rules',3,'parameters','required_status_checks'),[])]
        for key,path,value in cases:
            rec=github_receipt();target=data(rec,key)
            for part in path[:-1]:target=target[part]
            target[path[-1]]=value
            with self.subTest(key=key,path=path),self.assertRaises(Exception):self.check(seal(rec))

    def test_missing_failed_unreadable_stale_pages_or_binding_refuse(self):
        for key in ('source_sha','request_sha256','plan_sha256','manifest_sha256','ruleset_id'):
            rec=github_receipt();rec[key]='wrong'
            with self.subTest(key=key),self.assertRaises(Exception):self.check(rec)
        for attack in ('missing-record','missing-field','permission','network','partial','missing-page','foreign-next','projection','hash'):
            rec=github_receipt();page=rec['records'][0]['pages'][0]
            if attack=='missing-record':rec['records'].pop()
            if attack=='missing-field':data(rec,'environment').pop('can_admins_bypass')
            if attack=='permission':page['http_status']=403
            if attack=='network':page['exit_code']=1
            if attack=='partial':rec['records'][0]['complete']=False
            if attack in ('missing-page','foreign-next'):page['next_link']='https://evil.invalid?page=2'
            if attack=='projection':page['projection_sha256']='0'*64
            if attack=='hash':page['result_sha256']='0'*64
            with self.subTest(attack=attack),self.assertRaises(Exception):self.check(rec)
        with self.assertRaises(Exception):self.check(now=NOW+timedelta(hours=2))

    def test_ruleset_pagination_exact_chain_and_missing_or_foreign_page(self):
        rec=github_receipt();record=next(r for r in rec['records'] if r['key']=='rulesets')
        first=record['pages'][0];second=deepcopy(first)
        first['result']=[{'id':1,'name':'unrelated'}]
        first['next_link']='https://api.github.com/repos/tonyaiukco/TonyAI-mono-repo/rulesets?per_page=100&page=2'
        from qa_oidc_github import manifest
        argv=manifest(request(),'7'*64,42)['commands']['rulesets']['argv']
        second['argv_sha256']=digest([*argv[:-1],argv[-1]+'&page=2'])
        record['pages'].append(second)
        self.check(seal(rec))
        bad=deepcopy(rec);bad['records'][2]['pages'].pop()
        with self.assertRaises(Exception):self.check(bad)
        first['next_link']='https://api.github.com/repos/evil/repo/rulesets?per_page=100&page=2'
        with self.assertRaises(Exception):self.check(rec)


class ReviewRegressions(unittest.TestCase):
    def check(self,before,after,binding=None):
        return verify_after(request(),evidence(),binding or report(),before,after,
            plan_completed_at=PLAN,apply_started_at=APPLY,apply_completed_at=APPLY,now=NOW)

    def test_correlated_omission_of_each_known_inventory_resource_refuses(self):
        for kind in ('registries','workspaces','managedEnvironments','vaults','privateDnsZones'):
            before,after=receipt(),receipt('after')
            for rec in (before,after):
                rows=data(rec,'resources');rows[:]=[r for r in rows if not r['type'].endswith('/'+kind)]
            with self.subTest(kind=kind),self.assertRaises(Exception):self.check(seal(before),seal(after))

    def test_known_inspector_client_and_principal_must_match_readback(self):
        after=receipt('after');data(after,'identities')[-1]['client_id']='00000000-0000-0000-0000-000000000099'
        with self.assertRaises(Exception):self.check(receipt(),seal(after))
        # A complete alternative principal+five-grant universe cannot substitute a known plan identity.
        from qa_oidc_expected import additions,role_rows
        from qa_oidc_contract import transition
        after=receipt('after');data(after,'identities')[-1]['principal_id']='00000000-0000-0000-0000-000000000098'
        roles=data(after,'roles');roles[:]=roles[:5]+list(role_rows(additions(transition(request())[1],'00000000-0000-0000-0000-000000000098')).values())
        with self.assertRaises(Exception):self.check(receipt(),seal(after))

    def test_report_bindings_and_unknown_identity_resolution(self):
        for key in ('request_sha256','predecessor_sha256','after_inputs_sha256','plan_sha256','source_sha','configuration_sha256','provider_lock_sha256','terraform_version'):
            binding=report();binding[key]='wrong'
            with self.subTest(key=key),self.assertRaises(Exception):self.check(receipt(),receipt('after'),binding)
        binding=report();binding['plan_created_at']='2026-10-25T12:02:00Z'
        with self.assertRaises(Exception):self.check(receipt(),receipt('after'),binding)
        from qa_oidc_expected import additions,resource_id
        from qa_oidc_contract import transition
        binding=report();binding.update(release_principal_id=None,oidc_client_id=None,additions=additions(transition(request())[1]))
        for row in binding['resources']:
            if row['address'] in binding['additions']: row['id']=resource_id(binding['additions'][row['address']])
        self.check(receipt(),receipt('after'),binding)

    def test_real_cli_predecessor_file_hash_map_is_retained_and_validated(self):
        from qa_oidc_contract import predecessor
        ev=evidence();self.assertIsInstance(ev['saved_plan']['file_sha256'],dict)
        predecessor(request(),ev,now=NOW)
        ev['saved_plan']['file_sha256']['/synthetic/unit4-request.json']='invalid'
        req=request();req['predecessor_sha256']=digest(ev)
        with self.assertRaises(Exception):predecessor(req,ev,now=NOW)

    def test_empty_dns_tags_match_provider_representation_without_metadata_exception(self):
        before,after=receipt(),receipt('after')
        for rec in (before,after):
            data(rec,'azapi_resource.dns')['tags']={}
            next(r for r in data(rec,'resources') if r['type']=='Microsoft.Network/privateDnsZones')['tags']={}
        self.check(seal(before),seal(after))
        for rec in (before,after):
            data(rec,'azapi_resource.dns')['tags']={'unreviewed':'tag'}
            next(r for r in data(rec,'resources') if r['type']=='Microsoft.Network/privateDnsZones')['tags']={'unreviewed':'tag'}
        with self.assertRaises(Exception):self.check(seal(before),seal(after))
