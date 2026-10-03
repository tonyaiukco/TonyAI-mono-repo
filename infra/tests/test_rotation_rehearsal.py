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
                verify_apps(selected, lambda *args: app('api' if args[-1].endswith('-api') else 'web', selected))
            stale = copy.deepcopy(selected)
            stale['release']['backend_secret_version'] = deployed['release']['backend_secret_version']
            with self.assertRaises(SafeFailure), contextlib.redirect_stdout(transcript):
                verify_apps(selected, lambda *args: app('api' if args[-1].endswith('-api') else 'web', stale))
