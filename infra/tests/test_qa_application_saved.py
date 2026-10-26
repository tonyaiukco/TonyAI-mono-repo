"""Saved-binary binding and request-surface regressions; no real plan or cloud."""
from copy import deepcopy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
from test_qa_application import fixture, plan_fixture
from qa_application import QA_ROOT, inspect_plan
from qa_release import check_plan
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS


def archive(changed=None):
    files = {'tfconfig/m-/' + p.name: p.read_bytes() for p in QA_ROOT.glob('*.tf')}
    files.update({'.terraform.lock.hcl': (QA_ROOT / '.terraform.lock.hcl').read_bytes(),
                  'tfconfig/modules.json': json.dumps([{'Key': '', 'Dir': '.'}]),
                  'tfstate': 'SECRET_CANARY_NOT_READ'})
    files.update(changed or {})
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for key, value in files.items():
            z.writestr(key, value)
    return out.getvalue()


class Policy(unittest.TestCase):
    def setUp(self):
        _, self.candidate, self.inputs, _, _ = fixture()
        self.plan = plan_fixture(self.inputs)

    def test_envelope_mutations(self):
        for key, value in [('complete', False), ('complete', None), ('errored', True), ('applyable', False),
                           ('terraform_version', '1.14.0'), ('resource_drift', [{}]), ('deferred_changes', [{}]),
                           ('checks', [{'status': 'unknown'}]), ('output_changes', {})]:
            plan = deepcopy(self.plan); plan[key] = value
            with self.subTest(key=key), self.assertRaises(Exception): check_plan(plan, self.inputs)

    def test_every_resource_envelope_and_request_extension(self):
        for index in (0, 1):
            for key, value in [('previous_address', 'other'), ('deposed', 'old'), ('module_address', 'module.x'), ('provider_name', 'foreign')]:
                plan = deepcopy(self.plan); plan['resource_changes'][index][key] = value
                with self.subTest(key=key, index=index), self.assertRaises(Exception): check_plan(plan, self.inputs)
            for key, value in [('importing', {'id': 'foreign'}), ('generated_config', 'resource {}'),
                               ('replace_paths', [['body']]), ('after_sensitive', {'body': True})]:
                plan = deepcopy(self.plan); plan['resource_changes'][index]['change'][key] = value
                with self.subTest(key=key, index=index), self.assertRaises(Exception): check_plan(plan, self.inputs)
            for key in (*EMPTY_OPTIONS, *DEFAULT_OPTIONS, 'unknown_option', 'tags'):
                plan = deepcopy(self.plan); plan['resource_changes'][index]['change']['after'][key] = 'unsafe'
                with self.subTest(key=key, index=index), self.assertRaises(Exception): check_plan(plan, self.inputs, source_bound=True)
            for key in (*EMPTY_OPTIONS, 'parent_id', 'name', 'location', 'tags', 'type', 'unknown_option'):
                plan = deepcopy(self.plan); plan['resource_changes'][index]['change']['after_unknown'][key] = True
                with self.subTest(key=key, index=index), self.assertRaises(Exception): check_plan(plan, self.inputs, source_bound=True)

    def test_only_specific_computed_fields(self):
        change = self.plan['resource_changes'][0]['change']
        change['after_unknown'].update(id=True, output=True, identity=[{'principal_id': True, 'tenant_id': True}])
        check_plan(self.plan, self.inputs)
        change['after_unknown']['identity'][0]['identity_ids'] = [True]
        with self.assertRaises(Exception): check_plan(self.plan, self.inputs, source_bound=True)

    def test_input_and_source_and_secret_version_binding(self):
        for area, key, value in [('release', 'source_sha', 'b' * 40), ('release', 'release_id', 'qa002'),
                                  ('release', 'backend_secret_version', 'c' * 32), ('release', 'storage_cleanup_hold', False),
                                  ('foundation', 'vault_name', 'different-vault')]:
            inputs = deepcopy(self.inputs); inputs[area][key] = value
            with self.subTest(key=key), self.assertRaises(Exception): check_plan(self.plan, inputs, True, source_bound=True)
        self.plan['variables']['release']['value']['unexpected'] = 'unsafe'
        with self.assertRaises(Exception): check_plan(self.plan, self.inputs)

    def test_extra_privilege_resource(self):
        extra = deepcopy(self.plan['resource_changes'][0]); extra['address'] = 'azapi_resource.grant'
        self.plan['resource_changes'].append(extra)
        with self.assertRaises(Exception): check_plan(self.plan, self.inputs)


class Binary(unittest.TestCase):
    setUp = Policy.setUp
    def test_private_copy_show_only_and_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'application.tfplan'; binary = archive(); path.write_bytes(binary)
            def runner(argv, **kwargs):
                self.assertEqual(argv[:3], [sys.executable, 'show', '-json'])
                self.assertNotEqual(Path(argv[3]), path)
                self.assertEqual(Path(argv[3]).read_bytes(), binary)
                self.assertEqual(Path(argv[3]).stat().st_mode & 0o777, 0o600)
                self.assertEqual(kwargs['env'], {'PATH': __import__('os').defpath, 'HOME': str(Path(argv[3]).parent), 'CHECKPOINT_DISABLE': '1'})
                return SimpleNamespace(returncode=0, stdout=json.dumps(self.plan))
            with patch('qa_application.clean_source') as clean:
                result = inspect_plan(self.inputs, self.candidate, path, sys.executable, runner=runner)
            self.assertEqual(clean.call_count, 2)
            self.assertNotIn('SECRET_CANARY', json.dumps(result))
            self.assertEqual(len(result['resources']), 2)
            for attack in ('source', 'binary-swap', 'wrong-json', 'timeout', 'nonzero'):
                path.write_bytes(binary)
                def bad(argv, **kwargs):
                    plan = deepcopy(self.plan)
                    if attack == 'binary-swap': path.write_bytes(b'foreign')
                    if attack == 'wrong-json': plan['variables']['release']['value']['api_digest'] = 'sha256:' + 'c' * 64
                    if attack == 'timeout': raise subprocess.TimeoutExpired(argv, 120)
                    return SimpleNamespace(returncode=1 if attack == 'nonzero' else 0, stdout=json.dumps(plan))
                with patch('qa_application.clean_source', side_effect=[None, ValueError()] if attack == 'source' else None):
                    with self.subTest(attack=attack), self.assertRaises(Exception):
                        inspect_plan(self.inputs, self.candidate, path, sys.executable, runner=bad)

    def test_foreign_binary_configuration_and_lock_fail_before_show(self):
        with tempfile.TemporaryDirectory() as directory, patch('qa_application.clean_source'):
            path = Path(directory) / 'application.tfplan'
            for key in ('tfconfig/m-/main.tf', '.terraform.lock.hcl', 'tfconfig/m-/extra.tf', 'tfconfig/m-child/main.tf'):
                path.write_bytes(archive({key: 'foreign'}))
                with patch('subprocess.run') as run, self.subTest(key=key), self.assertRaises(Exception):
                    inspect_plan(self.inputs, self.candidate, path, sys.executable, runner=run)
                run.assert_not_called()

    def test_cli_redacts_and_has_no_json_plan_escape_hatch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.json'; path.write_text('{"secret":"SECRET_CANARY"}')
            result = subprocess.run([sys.executable, str(QA_ROOT.parents[2] / 'scripts/qa_application.py'),
                '--inputs', str(path), '--candidate', str(path), '--saved-plan', str(path), '--terraform', sys.executable],
                capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('SECRET_CANARY', result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stderr)
