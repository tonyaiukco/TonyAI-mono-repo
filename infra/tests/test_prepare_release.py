"""Approval preview and protected release use the same real provenance contract."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import candidate
import prepare_release
from pooler import SafeFailure
from test_backend import config
from test_deploy_versions import inputs


def fixture():
    contract = inputs()
    f, r = contract['foundation'], contract['release']
    env = {'SUPABASE_PROJECT_REF': r['supabase_project_ref'], 'PREFIX': f['prefix'],
           'ACA_DEFAULT_DOMAIN': f['default_domain'], 'ACR_NAME': f['registry_name'],
           'ACR_HOST': f['registry_name'] + '.azurecr.io',
           'API_ORIGIN': 'https://tonyai-staging-api.' + f['default_domain'],
           'WEB_ORIGIN': 'https://tonyai-staging-web.' + f['default_domain']}
    with patch('candidate.clean_source'):
        proof = candidate.create('a'*40, r['api_digest'], r['web_digest'], env)
    return proof, contract


def environment(contract):
    return {'GITHUB_REPOSITORY': 'owner/repo', 'GITHUB_SHA': 'a'*40, 'CANDIDATE_RUN_ID': '123',
            'RELEASE_JSON': json.dumps(contract), 'BACKEND_JSON': json.dumps(config()),
            'AZURE_SUBSCRIPTION_ID': config()['subscription_id'], 'AZURE_TENANT_ID': config()['tenant_id'],
            'APPROVED_RELEASE_SHA256': hashlib.sha256(json.dumps(contract, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


class PrepareTests(unittest.TestCase):
    def test_preview_is_public_normalized_and_protected_job_rederives_hash(self):
        proof, contract = fixture()
        env = environment(contract)
        with tempfile.TemporaryDirectory() as d, patch('prepare_release.download', return_value=proof), patch('candidate.clean_source'):
            old = os.getcwd()
            try:
                os.chdir(d)
                env.update(GITHUB_STEP_SUMMARY=str(Path(d)/'summary'), GITHUB_OUTPUT=str(Path(d)/'output'))
                prepare_release.preview(env)
                self.assertFalse(Path('.infra-local').exists())
                self.assertIn(env['APPROVED_RELEASE_SHA256'], Path(env['GITHUB_STEP_SUMMARY']).read_text())
                self.assertIn(contract['release']['database_secret_version'], Path(env['GITHUB_STEP_SUMMARY']).read_text())
                self.assertEqual(Path(env['GITHUB_OUTPUT']).read_text(), 'release_sha256='+env['APPROVED_RELEASE_SHA256']+'\n')
                prepare_release.prepare(env)
                self.assertEqual(json.loads(Path('.infra-local/staging/release.json').read_text()), contract)
            finally:
                os.chdir(old)

    def test_each_binding_refuses_before_writing_any_input(self):
        proof, contract = fixture()
        cases = []
        bad = copy.deepcopy(proof); bad['api_digest'] = 'sha256:'+'f'*64
        cases.append(('artifact-digest', bad, environment(contract)))
        for field in ('environment', 'subscription_id', 'tenant_id'):
            env = environment(contract); backend = config()
            backend[field] = 'production' if field=='environment' else '00000000-0000-0000-0000-000000000099'
            env['BACKEND_JSON'] = json.dumps(backend); cases.append((field, proof, env))
        for field in ('AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID', 'APPROVED_RELEASE_SHA256'):
            env = environment(contract); env[field] = 'f'*64
            cases.append((field, proof, env))
        env = environment(contract); env.pop('APPROVED_RELEASE_SHA256'); cases.append(('missing-approval', proof, env))
        for label, artifact, env in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as d, patch('prepare_release.download', return_value=artifact), patch('candidate.clean_source'):
                old = os.getcwd()
                try:
                    os.chdir(d)
                    with self.assertRaises((ValueError, SafeFailure)):
                        prepare_release.prepare(env)
                    self.assertFalse(Path('.infra-local').exists())
                finally:
                    os.chdir(old)
