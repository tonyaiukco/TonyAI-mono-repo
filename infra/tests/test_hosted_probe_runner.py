"""Offline exact-source/stdin/container lifetime boundaries for hosted probes."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import hosted_probe_runner as runner
import hosted_smoke
from pooler import SafeFailure
from test_deploy_versions import inputs

CID = '1' * 64
NAME = 'tonyai-hosted-probe-' + 'a' * 32
SEAL = 'b' * 64
IMAGE = 'fixture.azurecr.io/tonyai/api@sha256:' + 'c' * 64


class TransportTests(unittest.TestCase):
    def test_exact_image_readonly_limits_no_secret_environment_and_verify_has_no_network(self):
        with patch.object(os, 'getuid', return_value=501), patch.object(os, 'getgid', return_value=20):
            args = runner.arguments(NAME, IMAGE, Path('/public'), Path('/private'), SEAL, 'verify')
            self.assertIn('--network=none', args)
            for flag in ['--pull=never', '--read-only', '--user=1000:20', '--log-driver=none', '--cap-drop=ALL', '--memory=512m']:
                self.assertIn(flag, args)
            self.assertEqual(args[-2:], [IMAGE, '/observer/hosted-smoke-fixture.mjs'])
            self.assertNotIn('--rm', args)
            self.assertFalse(any('DIRECT_URL' in arg or 'SERVICE_ROLE' in arg for arg in args))
            for bad in [IMAGE.split('@')[0] + ':latest', 'evil.invalid/api@sha256:' + 'c' * 64]:
                with self.assertRaises(SafeFailure): runner.arguments(NAME, bad, Path('/public'), Path('/private'), SEAL, 'fixtures')

    def test_cleanup_requires_matching_exact_cid_name_operation_and_seal(self):
        for defect in ['none', 'id', 'name', 'operation', 'seal', 'still-present']:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                execution = Path(directory); (execution / 'container.id').write_text(CID)
                calls = []
                def call(args, **kwargs):
                    calls.append(args)
                    if args[1] == 'inspect':
                        item = {'Id': '2' * 64 if defect == 'id' else CID, 'Name': '/wrong' if defect == 'name' else '/' + NAME,
                                'Config': {'Labels': {'tonyai.operation': 'wrong' if defect == 'operation' else runner.OPERATION,
                                                       'tonyai.seal': 'wrong' if defect == 'seal' else SEAL}}, 'State': {'Running': True}}
                        return Mock(returncode=0, stdout=json.dumps([item]).encode())
                    if args[1] in ['stop', 'rm']: return Mock(returncode=0, stdout=CID.encode())
                    return Mock(returncode=0, stdout=CID.encode() if defect == 'still-present' else b'')
                report = runner.cleanup(NAME, execution, SEAL, {}, call)
                self.assertEqual(report['absent'], defect == 'none')
                mutations = [args for args in calls if args[1] in ['stop', 'rm']]
                if defect in ['id', 'name', 'operation', 'seal']: self.assertFalse(mutations)
                else:
                    self.assertEqual(len(mutations), 2)
                    self.assertTrue(all(args[-1] == CID for args in mutations))

    def test_failed_inspect_cannot_hide_a_known_cid_behind_an_empty_name_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            execution = Path(directory); (execution / 'container.id').write_text(CID)
            calls = []
            def call(args, **kwargs):
                calls.append(args)
                if args[1] == 'inspect': return Mock(returncode=1, stdout=b'')
                return Mock(returncode=0, stdout=CID.encode() if 'id=' + CID in args else b'')
            self.assertFalse(runner.cleanup(NAME, execution, SEAL, {}, call)['absent'])
            self.assertTrue(any('id=' + CID in args for args in calls))
            self.assertFalse(any(args[1] in ['stop', 'rm'] for args in calls))

    def test_receipt_distinguishes_exit_zero_acceptance_from_rejected_output(self):
        valid = {'status': 'RUNTIME_VERIFIED', 'node_major': 22, 'prisma_version': '6.19.3', 'ca_sha256': SEAL}
        for report in [valid, {'status': 'STOPPED'}, {'status': 'RUNTIME_VERIFIED'}, 'not-json']:
            with self.subTest(report=report), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'receipt.json'; child = Mock(); child.poll.return_value = 0
                child.communicate.return_value = (json.dumps(report) if isinstance(report, dict) else report, '')
                with patch.object(runner.subprocess, 'Popen', return_value=child), patch.object(runner, 'cleanup', return_value={'absent': True}):
                    if report == valid: runner.run(IMAGE, directory, 'verify', {'operation': 'verify', 'caSha256': SEAL}, path, SEAL, {})
                    else:
                        with self.assertRaises(SafeFailure): runner.run(IMAGE, directory, 'verify', {'operation': 'verify', 'caSha256': SEAL}, path, SEAL, {})
                observed = json.loads(path.read_text())
                self.assertEqual(observed['accepted'], report == valid)
                self.assertEqual(observed['validation'], 'ACCEPTED' if report == valid else 'REJECTED')
                self.assertEqual(Path(observed['container_id_file']).parent, Path(observed['execution_directory']))
                self.assertTrue(Path(observed['execution_directory']).is_dir())

    def test_lifecycle_receipt_binds_step_target_and_checked_retirement(self):
        for step, observed in [('inject-disable', {'provider_calls': 0, 'injected_failures': 1, 'pending': 1}),
                               ('offboard-apply', {'pending': 0, 'retired': True})]:
            for wrong in [False, True]:
                with tempfile.TemporaryDirectory() as directory:
                    payload = {'operation': 'lifecycle', 'step': step, 'target': {'id': 'exact-private'},
                               'invitees': [], 'backendKey': 'SECRET'}
                    report = {'status': 'LIFECYCLE_OBSERVED', 'step': 'wrong' if wrong else step, **observed}
                    child = Mock(); child.poll.return_value = 0
                    child.communicate.return_value = (json.dumps(report), 'raw SECRET')
                    path = Path(directory) / 'receipt.json'
                    with patch.object(runner.subprocess, 'Popen', return_value=child), patch.object(runner, 'cleanup', return_value={'absent': True}):
                        if wrong:
                            with self.assertRaises(SafeFailure): runner.run(IMAGE, directory, 'lifecycle', payload, path, SEAL, {})
                        else: runner.run(IMAGE, directory, 'lifecycle', payload, path, SEAL, {})
                    stored = json.loads(path.read_text())
                    self.assertEqual(stored['step'], step); self.assertEqual(len(stored['target_sha256']), 64)
                    self.assertEqual(stored['accepted'], not wrong)
                    if not wrong: self.assertEqual(stored['observations'], observed)
                    self.assertNotIn('SECRET', path.read_text())

    def test_missing_cidfile_discovers_only_our_name_then_matches_labels_before_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []
            def call(args, **kwargs):
                calls.append(args)
                if args[1] == 'inspect':
                    self.assertEqual(args[-1], NAME)
                    return Mock(returncode=0, stdout=json.dumps([{'Id': CID, 'Name': '/' + NAME,
                        'Config': {'Labels': {'tonyai.operation': runner.OPERATION, 'tonyai.seal': SEAL}}, 'State': {'Running': False}}]).encode())
                if args[1] == 'rm': return Mock(returncode=0, stdout=CID.encode())
                return Mock(returncode=0, stdout=b'')
            self.assertTrue(runner.cleanup(NAME, Path(directory), SEAL, {}, call)['absent'])
            self.assertEqual(next(args for args in calls if args[1] == 'rm')[-1], CID)

    def test_credentials_only_stdin_and_safe_receipt_even_when_interrupted(self):
        for interrupted in [False, True]:
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as directory:
                child = Mock(); child.poll.return_value = 0
                child.communicate.side_effect = [subprocess.TimeoutExpired('docker', 300), ('', '')] if interrupted else [(json.dumps({'status': 'FIXTURES_CREATED', 'application_rows': 6, 'audit_rows': 6}), 'PRIVATE stderr')]
                receipt = Path(directory) / 'receipt.json'
                payload = {'operation': 'fixtures', 'url': 'SENSITIVE_OWNER_URL'}
                with patch.object(runner.subprocess, 'Popen', return_value=child) as popen, patch.object(runner, 'cleanup', return_value={'absent': True}):
                    if interrupted:
                        with self.assertRaises(SafeFailure): runner.run(IMAGE, directory, 'fixtures', payload, receipt, SEAL, {'PATH': 'safe'})
                    else: self.assertEqual(runner.run(IMAGE, directory, 'fixtures', payload, receipt, SEAL, {'PATH': 'safe'})['status'], 'FIXTURES_CREATED')
                self.assertNotIn('SENSITIVE', str(popen.call_args))
                self.assertIn('SENSITIVE_OWNER_URL', child.communicate.call_args_list[0].args[0])
                self.assertNotIn('SENSITIVE', receipt.read_text()); self.assertNotIn('PRIVATE', receipt.read_text())
                self.assertEqual(json.loads(receipt.read_text())['interrupted'], interrupted)

    def test_unsafe_receipt_parent_is_rejected_before_container_or_secret_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); root.chmod(0o755)
            with patch.object(runner.subprocess, 'Popen') as popen:
                with self.assertRaises(SafeFailure): runner.run(IMAGE, root, 'verify', {'operation': 'verify'}, root / 'receipt.json', SEAL, {})
                popen.assert_not_called()
            root.chmod(0o700)

    def test_cleanup_failure_never_returns_pass_and_existing_receipt_never_launches(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'receipt.json'; child = Mock(); child.poll.return_value = 0
            child.communicate.return_value = (json.dumps({'status': 'RUNTIME_VERIFIED', 'node_major': 22, 'prisma_version': '6.19.3', 'ca_sha256': SEAL}), '')
            with patch.object(runner.subprocess, 'Popen', return_value=child), patch.object(runner, 'cleanup', return_value={'absent': False}):
                with self.assertRaises(SafeFailure): runner.run(IMAGE, directory, 'verify', {'operation': 'verify', 'caSha256': SEAL}, receipt, SEAL, {})
            with patch.object(runner.subprocess, 'Popen') as popen:
                with self.assertRaises(SafeFailure): runner.run(IMAGE, directory, 'verify', {'operation': 'verify'}, receipt, SEAL, {})
                popen.assert_not_called()


class SourceSeparationTests(unittest.TestCase):
    def invoke(self, bad=None, verify=False):
        contract = inputs(); candidate = {'supabase_project_ref': contract['release']['supabase_project_ref']}
        with tempfile.TemporaryDirectory() as directory:
            def prepare(source, actual, proof, bundle):
                self.assertEqual(source, Path('/selected-source')); self.assertEqual(actual, contract); self.assertEqual(proof, candidate)
                (bundle / 'ca.crt').write_bytes(b'public CA')
                if bad == 'application': raise SafeFailure('wrong application source')
                return IMAGE
            with patch.object(hosted_smoke, 'clean', side_effect=SafeFailure('wrong helper') if bad == 'helper' else None) as clean, \
                 patch.object(hosted_smoke, 'prepare', side_effect=prepare), patch.object(hosted_smoke, 'committed', return_value=b'public helper bytes') as committed, \
                 patch.object(hosted_smoke, 'inspect_image', side_effect=SafeFailure('uncached') if bad == 'image' else None) as image, \
                 patch.object(hosted_smoke, 'run_probe', return_value={'status': 'RUNTIME_VERIFIED'}) as runtime, \
                 patch.object(hosted_smoke, 'execute', return_value={}) as execute, patch.dict(os.environ, {}, clear=True):
                if bad:
                    with self.assertRaises(SafeFailure): hosted_smoke.run(candidate, contract, Path(directory) / 'journal', 'a' * 40, '/selected-source', verify_only=verify)
                    execute.assert_not_called(); runtime.assert_not_called()
                else:
                    hosted_smoke.run(candidate, contract, Path(directory) / 'journal', 'a' * 40, '/selected-source', verify_only=verify)
                    clean.assert_called_once_with(hosted_smoke.ROOT, 'a' * 40)
                    image.assert_called_once_with(IMAGE)
                    self.assertEqual(committed.call_count, len(hosted_smoke.PUBLIC_SCRIPTS))
                    if verify: execute.assert_not_called(); runtime.assert_called_once()
                    else: execute.assert_called_once(); self.assertIn('fixture_runner', execute.call_args.kwargs)

    def test_both_sources_and_cached_image_are_verified_before_execution_or_credentials(self):
        for bad in ['helper', 'application', 'image']: self.invoke(bad)
        self.invoke(); self.invoke(verify=True)


class ExecutionCoreGuards(unittest.TestCase):
    def test_direct_execution_core_cannot_skip_legacy_or_separate_source_proof(self):
        from cloud_smoke import execute
        for mode in ['legacy', 'helper', 'application', 'missing-fixture']:
            with self.subTest(mode=mode), patch('cloud_smoke.bind', side_effect=SafeFailure('legacy proof refused')) as bind, patch('migration_binding.clean', side_effect=SafeFailure('helper proof refused') if mode == 'helper' else None) as clean, patch('migration_binding.prepare', side_effect=SafeFailure('application proof refused')) as prepare, patch('cloud_smoke.secret') as secret, patch('cloud_smoke.verify') as remote:
                extra = {} if mode == 'legacy' else {'source_binding': ('a' * 40, '/selected-source')}
                if mode not in ['legacy', 'missing-fixture']: extra['fixture_runner'] = lambda *args: None
                with self.assertRaises(SafeFailure): execute({}, inputs(), 'unused', **extra)
                secret.assert_not_called(); remote.assert_not_called()
                if mode == 'legacy': bind.assert_called_once()
                if mode == 'application': clean.assert_called_once(); prepare.assert_called_once()
