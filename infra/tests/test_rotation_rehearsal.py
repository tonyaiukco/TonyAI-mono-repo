"""Offline secret-rotation rehearsal: provider seams are doubles, never cloud proof."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_deploy_versions import inputs, app
from deploy_apps import verify as verify_apps
from release_secrets import main, verify as verify_secrets
from pooler import SafeFailure


class RotationRehearsalTests(unittest.TestCase):
    def test_store_interrupt_resume_verify_deploy_and_reject_old_reference(self):
        deployed = inputs()
        selected = copy.deepcopy(deployed)
        selected['release'].update(release_id='r002', backend_secret_version='c'*32)
        secret = 'synthetic-private-rotation-value'
        vault = Mock()
        vault.put.return_value = 'c'*32
        vault.get.side_effect = lambda name, version: {'value': secret, 'id': name + '/' + version}
        transcript = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            path.write_text(json.dumps(deployed))
            with patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_backend'), patch('release_secrets.clean_environment'), patch('release_secrets.getpass.getpass', return_value=secret), patch('release_secrets.sys.stdin.isatty', return_value=True), patch('sys.argv', ['release_secrets.py', 'store', '--inputs', str(path), '--name', 'supabase-service-role-key']), contextlib.redirect_stdout(transcript):
                main()
            # Interruption after storage cannot silently select/deploy the new version.
            self.assertEqual(json.loads(path.read_text()), deployed)
            self.assertNotIn(secret, transcript.getvalue())
            self.assertIn('c'*32, transcript.getvalue())
            with patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_backend'), patch('release_secrets.validate_pooler'), contextlib.redirect_stdout(transcript):
                verify_secrets(selected)
            self.assertEqual(vault.get.call_args_list[-1].args, ('supabase-service-role-key', 'c'*32))
            self.assertEqual(selected['release']['api_digest'], deployed['release']['api_digest'])
            self.assertEqual(selected['release']['web_digest'], deployed['release']['web_digest'])
            with contextlib.redirect_stdout(transcript):
                verify_apps(selected, lambda *args: [{'name': 'tonyai-staging-api--r002', 'properties': {'active': True}}] if args[:3] == ('containerapp', 'revision', 'list') else app('api' if args[-1].endswith('-api') else 'web', selected))
            stale = copy.deepcopy(selected)
            stale['release']['backend_secret_version'] = deployed['release']['backend_secret_version']
            with self.assertRaises(SafeFailure), contextlib.redirect_stdout(transcript):
                verify_apps(selected, lambda *args: app('api' if args[-1].endswith('-api') else 'web', stale))

    def test_initial_runtime_store_needs_no_existing_release_or_runtime_version(self):
        from test_security_failures import GOOD_URL, PROJECT
        foundation = {'config': {**{k: v for k, v in inputs()['foundation'].items() if k != 'default_domain'},
                      'repository': 'tonyaiukco/TonyAI-mono-repo', 'release_sha': 'a'*40,
                      'owner_object_id': '00000000-0000-0000-0000-000000000003'}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'foundation.json'
            path.write_text(json.dumps(foundation))
            for defect in ('none', 'owner', 'foreign-project', 'invalid-foundation', 'mixed-inputs', 'wrong-name'):
                vault = Mock()
                vault.put.return_value = 'https://vault.vault.azure.net/secrets/database-url/'+'c'*32
                value = GOOD_URL.replace('tonyai_runtime.', 'postgres.') if defect == 'owner' else GOOD_URL
                project = 'z'*20 if defect == 'foreign-project' else PROJECT
                args = ['release_secrets.py', 'store', '--foundation', str(path), '--project-ref', project, '--name', 'database-url']
                if defect == 'mixed-inputs': args += ['--inputs', 'missing.json']
                if defect == 'wrong-name':
                    args[-1] = 'direct-url'
                    value = GOOD_URL.replace('tonyai_runtime.', 'postgres.').replace(':6543/', ':5432/')
                path.write_text(json.dumps({'invalid': True} if defect == 'invalid-foundation' else foundation))
                transcript = io.StringIO()
                with self.subTest(defect=defect), patch('release_secrets.Vault', return_value=vault), patch('release_secrets.clean_environment'), patch('release_secrets.getpass.getpass', return_value=value), patch('release_secrets.sys.stdin.isatty', return_value=True), patch('sys.argv', args), contextlib.redirect_stdout(transcript):
                    if defect == 'none':
                        main()
                        vault.put.assert_called_once_with('database-url', GOOD_URL, {'project': PROJECT})
                        vault.get.assert_not_called()
                    else:
                        with self.assertRaises(SafeFailure): main()
                        vault.put.assert_not_called()
                self.assertNotIn(value, transcript.getvalue())

    def test_owner_store_rejects_runtime_credentials_and_stray_project_argument(self):
        from test_security_failures import GOOD_URL, PROJECT
        owner = GOOD_URL.replace('tonyai_runtime.', 'postgres.').replace(':6543/', ':5432/')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            path.write_text(json.dumps(inputs()))
            for value, extra, valid in [(owner, [], True), (GOOD_URL, [], False),
                                        (owner.replace(':5432/', ':6543/'), [], False),
                                        (owner.replace('postgres.', 'tonyai_runtime.'), [], False),
                                        (owner, ['--project-ref', PROJECT], False)]:
                argv = ['release_secrets.py', 'store', '--inputs', str(path), '--name', 'direct-url', *extra]
                vault = Mock()
                vault.put.return_value = 'https://vault.vault.azure.net/secrets/direct-url/'+'d'*32
                with self.subTest(value=value, extra=extra), patch('sys.argv', argv), patch('release_secrets.clean_environment'), patch('release_secrets.sys.stdin.isatty', return_value=True), patch('release_secrets.getpass.getpass', return_value=value), patch('release_secrets.Vault', return_value=vault), contextlib.redirect_stdout(io.StringIO()):
                    if valid:
                        main()
                        vault.put.assert_called_once_with('direct-url', owner, {'project': PROJECT})
                    else:
                        with self.assertRaises(SafeFailure): main()
                        vault.put.assert_not_called()
