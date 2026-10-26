"""Initial-plan mutations and binary snapshot binding; entirely offline."""
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from qa_foundation import QA_ROOT, bind_snapshot, inspect_plan
from qa_foundation_inputs import initial_inputs
from qa_foundation_plan import check_plan
from qa_preflight_fixtures import inputs, plan


class InitialPlan(unittest.TestCase):
    def test_exact_initial_plan(self):
        self.assertEqual(check_plan(plan(), inputs())['resource_count'], 15)

    def test_initial_inputs_refuse_unknown_fields_placeholders_and_flags(self):
        for field, value in [('oidc_enabled', True), ('apps_ready', 0), ('runtime_secrets_ready', None),
                             ('smtp_secret_ready', True), ('tenant_id', 'REQUIRED_OWNER_UUID'),
                             ('DATABASE_URL', 'SECRET_CANARY'), ('environment', 'production')]:
            changed = inputs()
            changed['config'][field] = value
            with self.subTest(field=field), self.assertRaises(Exception):
                initial_inputs(changed)
        changed = inputs()
        del changed['config']['apps_ready']
        with self.assertRaises(Exception):
            initial_inputs(changed)

    def test_every_resource_refuses_delete_update_replay_import_move_and_duplicates(self):
        for index in range(15):
            for action in (['delete'], ['update'], ['no-op'], ['delete', 'create']):
                changed = plan()
                changed['resource_changes'][index]['change']['actions'] = action
                with self.subTest(index=index, action=action), self.assertRaises(Exception):
                    check_plan(changed, inputs())
            for attack in ('import', 'move', 'duplicate', 'before', 'provider'):
                changed = plan()
                row = changed['resource_changes'][index]
                if attack == 'import': row['change']['importing'] = {'id': 'foreign'}
                elif attack == 'move': row['previous_address'] = 'foreign'
                elif attack == 'duplicate': changed['resource_changes'].append(deepcopy(row))
                elif attack == 'before': row['change']['before'] = {}
                else: row['provider_name'] = 'foreign'
                with self.subTest(index=index, attack=attack), self.assertRaises(Exception):
                    check_plan(changed, inputs())

    def test_metadata_drift_and_prior_state_refused(self):
        for key, value in [('terraform_version', '1.14.0'), ('complete', False), ('errored', True),
                           ('applyable', False), ('resource_drift', [{}]), ('deferred_changes', [{}]),
                           ('prior_state', {'values': {'root_module': {'resources': [{}]}}})]:
            changed = plan(); changed[key] = value
            with self.subTest(key=key), self.assertRaises(Exception):
                check_plan(changed, inputs())

    def test_request_leaf_mutations_refused(self):
        attacks = [
            ('environment', ['body', 'properties', 'vnetConfiguration', 'infrastructureSubnetId'], 'foreign'),
            ('environment', ['body', 'properties', 'workloadProfiles'], []),
            ('db_address', ['body', 'properties', 'aRecords', 0, 'ipv4Address'], '10.80.0.4'),
            ('dns_link', ['body', 'properties', 'registrationEnabled'], True),
            ('vault', ['body', 'properties', 'enablePurgeProtection'], False),
            ('registry', ['body', 'properties', 'adminUserEnabled'], True),
            ('join_role', ['body', 'properties', 'permissions', 0, 'actions'], ['*']),
            ('grant["owner_secrets"]', ['body', 'properties', 'principalId'], 'foreign'),
            ('grant["pull-api"]', ['body', 'properties', 'principalId'], '00000000-0000-0000-0000-000000000005'),
            ('grant["pull-web"]', ['parent_id'], '/subscriptions/foreign'),
            ('logs', ['location'], 'germanywestcentral'),
        ]
        for address, path, value in attacks:
            changed = plan()
            row = next(r for r in changed['resource_changes'] if r['address'] == 'azapi_resource.' + address)
            target = row['change']['after']
            for key in path[:-1]: target = target[key]
            target[path[-1]] = value
            with self.subTest(address=address, path=path), self.assertRaises(Exception):
                check_plan(changed, inputs(), source_bound=True)

    def test_unknowns_require_bound_source_and_remain_leaf_limited(self):
        changed = plan()
        env = next(r for r in changed['resource_changes'] if r['address'] == 'azapi_resource.environment')['change']
        env['after'].pop('parent_id'); env['after_unknown']['parent_id'] = True
        with self.assertRaises(Exception): check_plan(changed, inputs())
        check_plan(changed, inputs(), source_bound=True)
        env['after'].pop('body'); env['after_unknown']['body'] = True
        with self.assertRaises(Exception): check_plan(changed, inputs(), source_bound=True)

    def test_extensions_exports_and_output_changes_refused(self):
        for field, value in [('create_headers', {'Authorization': 'SECRET_CANARY'}),
                             ('sensitive_body', 'SECRET_CANARY'), ('body', {'properties': {'foreign': True}}),
                             ('response_export_values', ['*']), ('identity', [{'type': 'SystemAssigned'}]),
                             ('unknown_option', True)]:
            changed = plan(); changed['resource_changes'][0]['change']['after'][field] = value
            with self.subTest(field=field), self.assertRaises(Exception): check_plan(changed, inputs())
        changed = plan(); changed['output_changes']['foreign'] = {}
        with self.assertRaises(Exception): check_plan(changed, inputs())


class Snapshot(unittest.TestCase):
    def archive(self, files):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for name, value in files.items(): archive.writestr(name, value)
        return output.getvalue()

    def test_exact_snapshot_and_mismatched_sources_locks_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'main.tf').write_text('resource "test" "only" {}')
            (root / '.terraform.lock.hcl').write_text('synthetic lock')
            files = {'tfconfig/m-/main.tf': (root / 'main.tf').read_bytes(), '.terraform.lock.hcl': b'synthetic lock',
                     'tfconfig/modules.json': json.dumps([{'Key': '', 'Dir': '.'}]),
                     'tfstate': 'SECRET_CANARY_NEVER_READ'}
            self.assertEqual(len(bind_snapshot(self.archive(files), root, config_files={'main.tf'})), 64)
            for name, value in [('tfconfig/m-/main.tf', 'changed'), ('.terraform.lock.hcl', 'changed'),
                                ('tfconfig/m-/override.tf', 'injected'), ('tfconfig/m-child/main.tf', 'injected'),
                                ('tfconfig/modules.json', '[{"Key":"child","Dir":"."}]')]:
                altered = {**files, name: value}
                with self.subTest(name=name), self.assertRaises(Exception): bind_snapshot(self.archive(altered), root, config_files={'main.tf'})

    def test_cli_redacts_invalid_inputs_and_never_invokes_terraform(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'inputs.json'
            path.write_text('{"config":{"credential":"SECRET_CANARY"}}')
            result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'scripts/qa_foundation.py'),
                '--inputs', str(path), '--saved-plan', '/nonexistent', '--terraform', '/nonexistent'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('SECRET_CANARY', result.stdout + result.stderr)
            self.assertNotIn('Traceback', result.stderr)

    def test_inspector_private_copy_sterile_runner_and_tamper_failures(self):
        files = {'tfconfig/m-/' + p.name: p.read_bytes() for p in QA_ROOT.glob('*.tf')}
        files.update({'.terraform.lock.hcl': (QA_ROOT / '.terraform.lock.hcl').read_bytes(),
                      'tfconfig/modules.json': json.dumps([{'Key': '', 'Dir': '.'}])})
        binary = self.archive(files)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'saved.tfplan'; path.write_bytes(binary)
            def runner(argv, **kwargs):
                self.assertEqual(argv[:3], [sys.executable, 'show', '-json'])
                self.assertNotEqual(Path(argv[3]), path)
                self.assertEqual(Path(argv[3]).read_bytes(), binary)
                self.assertEqual(set(kwargs['env']), {'PATH', 'HOME', 'CHECKPOINT_DISABLE'})
                return SimpleNamespace(returncode=0, stdout=json.dumps(plan()))
            with patch('qa_foundation.clean_source') as clean:
                result = inspect_plan(inputs(), path, sys.executable, runner=runner)
                self.assertEqual(result['resource_count'], 15)
                self.assertEqual(clean.call_count, 2)
            for failure in ('nonzero', 'timeout', 'binary-swap', 'source-change'):
                path.write_bytes(binary)
                def bad(argv, **kwargs):
                    if failure == 'timeout': raise subprocess.TimeoutExpired(argv, 120)
                    if failure == 'binary-swap': path.write_bytes(b'changed')
                    return SimpleNamespace(returncode=1 if failure == 'nonzero' else 0, stdout=json.dumps(plan()))
                with patch('qa_foundation.clean_source', side_effect=[None, ValueError('changed')] if failure == 'source-change' else None):
                    with self.subTest(failure=failure), self.assertRaises(Exception):
                        inspect_plan(inputs(), path, sys.executable, runner=bad)

    @unittest.skipUnless(os.environ.get('TERRAFORM_TEST_BINARY'), 'Set trusted Terraform 1.13.3 path for output-only archive test')
    def test_real_output_only_archive_without_init_or_cloud(self):
        binary = os.environ['TERRAFORM_TEST_BINARY']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'main.tf').write_text('output "synthetic" { value = "offline-only" }\n')
            result = subprocess.run([binary, 'plan', '-input=false', '-out=synthetic.tfplan'], cwd=root,
                env={'PATH': os.defpath, 'HOME': directory, 'CHECKPOINT_DISABLE': '1'}, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0)
            saved = (root / 'synthetic.tfplan').read_bytes()
            with zipfile.ZipFile(io.BytesIO(saved)) as archive:
                (root / '.terraform.lock.hcl').write_bytes(archive.read('.terraform.lock.hcl'))
            self.assertEqual(len(bind_snapshot(saved, root, config_files={'main.tf'})), 64)
