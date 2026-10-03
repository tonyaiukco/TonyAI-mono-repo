"""Release guards execute against mutated provenance, workflows and saved plans."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import candidate
from release_checks import verify
from terraform_run import invoke
from pooler import SafeFailure
from test_backend import config
from test_deploy_versions import inputs

ROOT = Path(__file__).resolve().parents[2]


class CandidateTests(unittest.TestCase):
    def test_every_provenance_field_bound_to_release_and_checkout(self):
        contract = inputs()
        f, r = contract['foundation'], contract['release']
        env = {'SUPABASE_PROJECT_REF': r['supabase_project_ref'], 'PREFIX': f['prefix'],
               'ACA_DEFAULT_DOMAIN': f['default_domain'], 'ACR_NAME': f['registry_name'],
               'ACR_HOST': 'registry.azurecr.io',
               'API_ORIGIN': 'https://tonyai-staging-api.' + f['default_domain'],
               'WEB_ORIGIN': 'https://tonyai-staging-web.' + f['default_domain']}
        with patch('candidate.clean_source'):
            good = candidate.create('a'*40, r['api_digest'], r['web_digest'], env)
            self.assertEqual(candidate.bind(good, contract, 'a'*40), good)
            for field in good:
                bad = copy.deepcopy(good)
                bad[field] = 'tampered'
                with self.subTest(field=field), self.assertRaises(SafeFailure):
                    candidate.bind(bad, contract, 'a'*40)
            for field, value in [('api_digest', 'latest'), ('source_sha', 'b'*40), ('supabase_project_ref', 'z'*20)]:
                bad = copy.deepcopy(contract); bad['release'][field] = value
                with self.subTest(field=field), self.assertRaises(SafeFailure): candidate.bind(good, bad, 'a'*40)
            production = copy.deepcopy(contract); production['foundation']['environment'] = 'production'
            with self.assertRaises(SafeFailure): candidate.bind(good, production, 'a'*40)

    def test_source_must_be_clean_and_exact(self):
        for responses in [('b'*40, ''), ('a'*40, ' M tracked'), ('a'*40, '?? untracked')]:
            with patch('candidate.subprocess.check_output', side_effect=responses), self.assertRaises(SafeFailure):
                candidate.clean_source('a'*40)
        with patch('candidate.subprocess.check_output', side_effect=['a'*40, '']): candidate.clean_source('a'*40)

    def test_migration_bytes_and_lockfile_are_fingerprinted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            migration = root / 'packages/db/prisma/migrations/001/migration.sql'
            migration.parent.mkdir(parents=True); migration.write_text('SELECT 1;')
            lock = root / 'pnpm-lock.yaml'; lock.write_text('lock')
            before = candidate.fingerprint(root)
            migration.write_text('SELECT 2;'); self.assertNotEqual(candidate.fingerprint(root), before)
            before = candidate.fingerprint(root)
            lock.write_text('changed'); self.assertNotEqual(candidate.fingerprint(root), before)

    def test_exact_candidate_checks_refuse_foreign_failed_or_stale_runs(self):
        run = {'head_sha': 'a'*40, 'head_branch': 'main', 'head_repository': {'full_name':'owner/repo'},
               'event':'workflow_dispatch', 'run_number': 1, 'id': 10, 'status':'completed', 'conclusion':'success'}
        self.assertEqual(len(verify('owner/repo', 'a'*40, lambda _: {'workflow_runs':[run]})), 3)
        for field, value in [('head_sha','b'*40), ('head_branch','feature'), ('event','pull_request'),
                             ('head_repository',{'full_name':'foreign/repo'}), ('status','in_progress'), ('conclusion','failure')]:
            bad = {**run, field:value}
            with self.subTest(field=field), self.assertRaises(SafeFailure):
                verify('owner/repo', 'a'*40, lambda _: {'workflow_runs':[bad]})
        with self.assertRaises(SafeFailure):
            verify('owner/repo', 'a'*40, lambda _: {'workflow_runs':[run, {**run, 'run_number':2, 'conclusion':'failure'}]})

    def test_approved_apply_uses_same_plan_and_never_applies_failed_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = Path(directory)/'backend.json'; backend.write_text(json.dumps(config()))
            release = Path(directory)/'release.json'; release.write_text(json.dumps(inputs()))
            with patch('terraform_run.subprocess.run') as run:
                run.return_value.returncode = 0
                invoke('application', backend, release, 'approved-apply')
                calls = [call.args[0] for call in run.call_args_list]
                plan = next(arg[5:] for arg in calls[1] if arg.startswith('-out='))
                self.assertIn('plan', calls[1]); self.assertIn('apply', calls[2]); self.assertEqual(calls[2][-1], plan)
                self.assertFalse(Path(plan).parent.exists())
                self.assertFalse(any(arg.startswith('-var-file') for arg in calls[2]))
            with patch('terraform_run.subprocess.run') as run:
                run.side_effect = [Mock(returncode=0), Mock(returncode=1), Mock(returncode=0)]
                with self.assertRaises(SafeFailure): invoke('application', backend, release, 'approved-apply')
                self.assertEqual(len(run.call_args_list), 2)
                self.assertIn('plan', run.call_args_list[1].args[0])
                self.assertFalse(any('apply' in call.args[0] for call in run.call_args_list))
            foundation = json.loads((ROOT/'infra/config/foundation.example.json').read_text())
            foundation['config'].update(subscription_id=config()['subscription_id'], tenant_id=config()['tenant_id'],
                owner_object_id=config()['owner_object_id'], deployer_object_id=config()['application_object_id'],
                release_sha='a'*40, repository='owner/repo', registry_name='registry', vault_name='vault')
            from foundation_contract import validate_foundation
            validate_foundation(foundation)
            release.write_text(json.dumps(foundation))
            with patch('terraform_run.subprocess.run') as run, self.assertRaises(SafeFailure):
                invoke('foundation', backend, release, 'approved-apply')
            run.assert_not_called()

    def test_rls_demo_guard_refuses_remote_before_fetch(self):
        for url in ['https://project.invalid', 'http://localhost.evil.test', 'http://localhost@evil.test',
                    'file:///tmp/test', 'http://127.0.0.1:54321/path', 'http://localhost:54321?host=evil']:
            result = subprocess.run(['node', 'scripts/rls-probes.mjs'], cwd=ROOT, capture_output=True, text=True,
                                    env={**os.environ, 'E2E_SUPABASE_URL':url,
                                         'E2E_SUPABASE_ANON_KEY':'synthetic', 'E2E_SUPABASE_SERVICE_KEY':'synthetic'})
            self.assertEqual(result.returncode, 2)
            self.assertIn('cloud targets are refused', result.stderr)

    def test_integration_is_independently_required_at_exact_sha(self):
        good = {'head_sha': 'a'*40, 'head_branch': 'main', 'head_repository': {'full_name': 'owner/repo'},
                'event': 'workflow_dispatch', 'run_number': 1, 'id': 10, 'status': 'completed', 'conclusion': 'success'}
        for bad in ([], [{**good, 'head_sha': 'b'*40}], [{**good, 'conclusion': 'failure'}],
                    [good, {**good, 'run_number': 2, 'status': 'in_progress', 'conclusion': None}]):
            def read(path):
                return {'workflow_runs': bad if '/integration.yml/' in path else [good]}
            with self.subTest(bad=bad), self.assertRaises(SafeFailure):
                verify('owner/repo', 'a'*40, read)

    def test_node_smoke_contract_boundaries(self):
        result = subprocess.run(['node', '--test', 'infra/tests/smoke-contract.test.mjs'],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
