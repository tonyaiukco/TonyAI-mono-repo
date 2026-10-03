"""Exact-ID fixture cleanup and owner smoke orchestration, with no network access."""
import copy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cloud_smoke import cleanup, target_for, auth_call
from pooler import SafeFailure


class CloudSmokeTests(unittest.TestCase):
    def target(self):
        return target_for({'source_sha':'a'*40, 'supabase_project_ref':'abcdefghijklmnopqrst',
                           'web_origin':'https://web.example', 'api_origin':'https://api.example'})

    def test_cleanup_matches_id_email_and_metadata_and_proves_absence(self):
        for defect in ('none', 'id', 'email', 'metadata', 'still-present'):
            target = self.target(); calls = []; deleted = set()
            def auth(base, key, method, path, body=None, missing=False):
                calls.append((method, path))
                tenant = next(t for t in target['tenants'] if path == '/' + t['userId'])
                if method == 'DELETE': deleted.add(path); return {}
                if path in deleted and defect != 'still-present': return None
                return {'id': 'foreign' if defect=='id' else tenant['userId'],
                        'email': 'foreign' if defect=='email' else tenant['email'],
                        'app_metadata': {'lp2_smoke':'foreign' if defect=='metadata' else tenant['organisationId']}}
            with self.subTest(defect=defect), patch('cloud_smoke.auth_call', side_effect=auth):
                if defect == 'none': cleanup(target, 'synthetic')
                else:
                    with self.assertRaises(SafeFailure): cleanup(target, 'synthetic')
            if defect in ('id','email','metadata'): self.assertFalse(deleted)
            if defect == 'none': self.assertEqual(len(deleted), 2)

    def test_auth_missing_is_only_404_and_failures_are_redacted(self):
        for status in (401, 403, 429, 500):
            with patch('cloud_smoke.request', return_value=(status,b'sensitive')), self.assertRaises(SafeFailure) as caught:
                auth_call('https://synthetic.supabase.co', 'synthetic', 'GET', '/id', missing=True)
            self.assertNotIn('sensitive', str(caught.exception))
        with patch('cloud_smoke.request', return_value=(404,b'')):
            self.assertIsNone(auth_call('https://synthetic.supabase.co', 'synthetic', 'GET', '/id', missing=True))

    def test_new_ids_and_password_free_target(self):
        first, second = self.target(), self.target()
        ids = [t[k] for target in (first,second) for t in target['tenants'] for k in ('userId','organisationId','subsidiaryId')]
        self.assertEqual(len(ids),len(set(ids)))
        self.assertNotIn('password',json.dumps(first).lower())

    def test_one_failed_cleanup_does_not_strand_other_account(self):
        target = self.target(); deleted = set()
        def auth(base, key, method, path, **kwargs):
            tenant = next(t for t in target['tenants'] if path == '/' + t['userId'])
            if tenant == target['tenants'][0]: raise SafeFailure('synthetic failure')
            if method == 'DELETE': deleted.add(path); return {}
            if path in deleted: return None
            return {'id':tenant['userId'], 'email':tenant['email'], 'app_metadata':{'lp2_smoke':tenant['organisationId']}}
        with patch('cloud_smoke.auth_call',side_effect=auth), self.assertRaises(SafeFailure): cleanup(target,'synthetic')
        self.assertEqual(deleted, {'/'+target['tenants'][1]['userId']})

    def test_owner_orchestration_passes_raw_strict_url_and_never_qualifies_failure(self):
        import tempfile
        from contextlib import ExitStack, redirect_stdout
        import io
        from cloud_smoke import run
        from test_deploy_versions import inputs
        contract = inputs()
        candidate = {'source_sha':'a'*40, 'supabase_project_ref':'abcdefghijklmnopqrst',
                     'api_origin':'https://tonyai-staging-api.real.germanywestcentral.azurecontainerapps.io',
                     'web_origin':'https://tonyai-staging-web.real.germanywestcentral.azurecontainerapps.io'}
        database = 'postgresql://postgres.abcdefghijklmnopqrst:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt'
        for failure in ('none','fixture','browser','cleanup','readback','created-id','created-email'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                journal = Path(directory)/'journal.json'
                ambient = {name:'ambient-'+name for name in ('GITHUB_TOKEN','AZURE_CLIENT_SECRET','DATABASE_URL','DIRECT_URL','SERVICE_KEY','SERVICE_ROLE','PASSWORD','UNCLASSIFIED_CREDENTIAL','NODE_OPTIONS')}
                stack.enter_context(patch.dict(os.environ, ambient))
                for name in ('bind','check_inputs'):
                    stack.enter_context(patch('cloud_smoke.'+name))
                readback = stack.enter_context(patch('cloud_smoke.verify'))
                if failure == 'readback': readback.side_effect = [None, SafeFailure('readback')]
                stack.enter_context(patch('cloud_smoke.getpass.getpass', return_value='sb_publishable_synthetic'))
                stack.enter_context(patch('cloud_smoke.secret', side_effect=lambda vault,name,version: database if name=='database-url' else 'backend-synthetic'))
                def auth(base,key,method,path,body=None):
                    # Durable ID intent must precede every POST; password is not persisted.
                    self.assertTrue(journal.exists())
                    self.assertNotIn('password',journal.read_text())
                    return {'id':'foreign' if failure=='created-id' else body['id'], 'email':'foreign' if failure=='created-email' else body['email']}
                stack.enter_context(patch('cloud_smoke.auth_call',side_effect=auth))
                clean = stack.enter_context(patch('cloud_smoke.cleanup'))
                if failure == 'cleanup': clean.side_effect = SafeFailure('cleanup')
                calls = []
                def child(script,env):
                    calls.append(script)
                    if script == 'smoke-fixtures.mjs':
                        self.assertEqual(env['DATABASE_URL'],database)
                        if failure == 'fixture': raise SafeFailure('fixture')
                    else:
                        self.assertFalse(set(ambient) & set(env))
                        self.assertNotIn('DATABASE_URL',env)
                        self.assertNotIn('backend-synthetic',env.values())
                        if failure == 'browser': raise SafeFailure('browser')
                stack.enter_context(patch('cloud_smoke.child',side_effect=child))
                stack.enter_context(redirect_stdout(io.StringIO()))
                if failure == 'none': run(candidate,contract,journal)
                else:
                    with self.assertRaises(SafeFailure): run(candidate,contract,journal)
                clean.assert_called_once()
                self.assertEqual(Path(str(journal)+'.passed.json').exists(),failure=='none')
                if failure in ('created-id','created-email'): self.assertEqual(calls,[])
                if failure == 'fixture': self.assertEqual(calls,['smoke-fixtures.mjs'])

    def test_cleanup_only_checks_journal_candidate_and_every_target_binding(self):
        import tempfile
        from cloud_smoke import run
        from test_prepare_release import fixture
        candidate, contract = fixture()
        for defect in ('none', 'candidate', 'sourceSha', 'projectRef', 'web', 'api', 'supabase', 'mode',
                       'tenants-missing', 'tenants-count', 'userId', 'organisationId', 'subsidiaryId',
                       'duplicate-across', 'duplicate-within', 'email', 'name'):
            target = target_for(candidate)
            journal = {'candidate': candidate, 'target': target}
            if defect=='candidate': journal['candidate'] = {**candidate, 'source_sha':'b'*40}
            elif defect == 'tenants-missing': target.pop('tenants')
            elif defect == 'tenants-count': target['tenants'] = target['tenants'][:1]
            elif defect in ('userId', 'organisationId', 'subsidiaryId', 'email', 'name'):
                target['tenants'][0][defect] = 'foreign'
            elif defect == 'duplicate-across': target['tenants'][1]['userId'] = target['tenants'][0]['userId']
            elif defect == 'duplicate-within': target['tenants'][0]['subsidiaryId'] = target['tenants'][0]['userId']
            elif defect!='none': target[defect] = 'https://foreign.invalid' if defect=='supabase' else 'foreign'
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as d:
                path = Path(d)/'journal.json'; path.write_text(json.dumps(journal))
                with patch('cloud_smoke.bind'), patch('cloud_smoke.secret', return_value='synthetic') as secret, patch('cloud_smoke.child') as child, patch('cloud_smoke.cleanup') as cleanup:
                    if defect=='none':
                        run(candidate, contract, path, cleanup_only=True)
                        cleanup.assert_called_once_with(target, 'synthetic')
                        secret.assert_called_once()
                    else:
                        with self.assertRaises(SafeFailure): run(candidate, contract, path, cleanup_only=True)
                        cleanup.assert_not_called()
                        secret.assert_not_called()
                    child.assert_not_called()
                self.assertFalse(Path(str(path)+'.passed.json').exists())
