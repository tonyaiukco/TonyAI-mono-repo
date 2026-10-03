"""Resource-backed restoration and dedicated OIDC identity trust boundaries."""
import copy
import hashlib
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import session_resources as session
import configure_oidc as oidc
from pooler import SafeFailure

GROUP = '/subscriptions/sub/resourceGroups/staging'
TAGS = {'application':'TonyAI','environment':'staging','task':'LP2-01'}


class ResourceTrustTests(unittest.TestCase):
    def setUp(self):
        self.resources = [dict(type=kind, name=name, id=GROUP+'/providers/'+kind+'/'+name,
                               location='germanywestcentral', tags=TAGS.copy())
                          for kind, name in [('Microsoft.ContainerRegistry/registries','registry'),
                              ('Microsoft.KeyVault/vaults','vault'),
                              ('Microsoft.App/managedEnvironments','tonyai-staging-env'),
                              ('Microsoft.ManagedIdentity/userAssignedIdentities','tonyai-staging-api'),
                              ('Microsoft.OperationalInsights/workspaces','tonyai-staging-logs')]]
        self.tags = {**TAGS,'tonyaiPrefix':'tonyai','releaseSha':'a'*40,'githubRepository':'owner/repo',
                     'apiDigest':'sha256:'+'a'*64,'webDigest':'sha256:'+'b'*64,
                     'candidateApiDigest':'sha256:'+'c'*64,'candidateWebDigest':'sha256:'+'d'*64}
        self.calls = []

    def az(self, *args):
        self.calls.append(args)
        if args[:2] == ('group','show'): return {'id':GROUP, 'tags':self.tags}
        if args[:2] == ('resource','list'): return self.resources
        if args[:2] == ('acr','show'): return {'loginServer':'registry.azurecr.io'}
        if args[:3] == ('containerapp','env','show'):
            return {'properties':{'defaultDomain':'real.germanywestcentral.azurecontainerapps.io'}}
        if args[:2] == ('account','show'): return {'tenantId':'tenant'}
        self.fail('Unexpected resource call: '+str(args))

    def test_resources_override_forged_outputs_and_keep_rollback_separate_from_candidates(self):
        with patch.object(session, 'az', side_effect=self.az): env = session.restore('sub','staging')
        self.assertEqual(env['API_ORIGIN'],'https://tonyai-staging-api.real.germanywestcentral.azurecontainerapps.io')
        self.assertEqual(env['API_DIGEST'],self.tags['apiDigest'])
        self.assertNotEqual(env['API_DIGEST'],env['CANDIDATE_API_DIGEST'])
        self.assertFalse(any(call[0]=='deployment' for call in self.calls))

    def test_forged_registry_host_and_environment_domain_refused(self):
        for wrong in ('registry', 'domain'):
            def read(*args):
                if wrong == 'registry' and args[:2] == ('acr','show'):
                    return {'loginServer':'attacker.azurecr.io'}
                if wrong == 'domain' and args[:3] == ('containerapp','env','show'):
                    return {'properties':{'defaultDomain':'attacker.example'}}
                return self.az(*args)
            with self.subTest(wrong=wrong), patch.object(session,'az',side_effect=read):
                with self.assertRaises(SafeFailure): session.restore('sub','staging')

    def test_wrong_region_identity_tags_or_ambiguous_resources_refused(self):
        original = copy.deepcopy(self.resources)
        for field, value in [('location','eastus'),('id',GROUP+'/providers/forged'),('tags',{})]:
            self.resources = copy.deepcopy(original)
            self.resources[0][field] = value
            with self.subTest(field=field), patch.object(session,'az',side_effect=self.az):
                with self.assertRaises(SafeFailure): session.restore('sub','staging')
        self.resources = original + [original[0].copy()]
        with patch.object(session,'az',side_effect=self.az):
            with self.assertRaises(SafeFailure): session.restore('sub','staging')
        self.tags['environment'] = 'production'
        with patch.object(session,'az',side_effect=self.az):
            with self.assertRaisesRegex(SafeFailure,'not tagged staging'): session.restore('sub','staging')


class OidcTrustTests(unittest.TestCase):
    def test_saved_identity_and_credentials_validated_before_federation(self):
        name = 'tonyai-staging-github-' + hashlib.sha256(GROUP.lower().encode()).hexdigest()[:12]
        for defect in ('wrong-name','wrong-client','password','certificate','wrong-principal','saved-principal','duplicate-app','unexpected-federation'):
            calls = []
            app = {'appId':'client','displayName':name}
            if defect == 'wrong-name': app['displayName'] = 'unrelated'
            if defect == 'wrong-client': app['appId'] = 'unrelated'
            if defect == 'password': app['passwordCredentials'] = [{}]
            if defect == 'certificate': app['keyCredentials'] = [{}]
            def az(*args):
                calls.append(args)
                if args[:3] == ('ad','signed-in-user','show'): return {'id':'operator'}
                if args[:4] in (('ad','app','owner','list'), ('ad','sp','owner','list')): return []
                if args[:3] == ('ad','sp','show'):
                    return {'id':'principal','appId':'wrong' if defect=='wrong-principal' else 'client',
                            'passwordCredentials':[], 'keyCredentials':[]}
                if args[:2] == ('group','show'):
                    return {'id':GROUP,'tags':{'environment':'staging','githubClientId':'client',
                            'githubPrincipalId':'wrong' if defect=='saved-principal' else 'principal'}}
                if args[:3] == ('ad','app','list'): return [app,app] if defect=='duplicate-app' else []
                if args[:3] == ('ad','app','show'): return app
                if args[:3] == ('ad','sp','list'):
                    return [{'id':'principal','appId':'wrong' if defect=='wrong-principal' else 'client'}]
                if args[:2] == ('group','update'): return {}
                if args[:4] == ('ad','app','federated-credential','list'):
                    return [{'name':'unexpected'}] if defect=='unexpected-federation' else []
                self.fail('Unexpected identity mutation: '+str(args[:4]))
            with self.subTest(defect=defect), patch.object(oidc,'az',side_effect=az):
                with self.assertRaises(SafeFailure): oidc.configure('sub','staging','owner/repo')
            self.assertFalse(any(call[:4]==('ad','app','federated-credential','create') for call in calls))
            if defect in ('wrong-name','wrong-client','password','certificate','duplicate-app'):
                self.assertFalse(any(call[:2]==('group','update') for call in calls))
