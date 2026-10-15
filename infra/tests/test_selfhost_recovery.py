"""Recovery and startup gates fail before host mutations and never expose credentials."""
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import selfhost_db_config
import selfhost_runtime_guard
import selfhost_escrow
from foundation_contract import validate_foundation
from terraform_run import invoke, validate_release
from pooler import SafeFailure
from test_deploy_versions import inputs as release_inputs
from test_backend import config as backend_config

SUB = 'cb7efc2f-37a7-4672-b62c-93c207bcd33d'


class RecoveryTests(unittest.TestCase):
    def test_sweden_legacy_roots_fail_before_any_cloud_call(self):
        for sub in (SUB, SUB.upper()):
            foundation = {'config': {'subscription_id': sub}}
            release = release_inputs(); release['foundation']['subscription_id'] = sub
            for data, validate in ((foundation, validate_foundation), (release, validate_release)):
                with self.assertRaisesRegex(SafeFailure, 'Sweden'): validate(data)
            with tempfile.TemporaryDirectory() as directory:
                backend = Path(directory, 'backend.json'); inputs = Path(directory, 'inputs.json')
                config = backend_config(); config['subscription_id'] = SUB
                backend.write_text(json.dumps(config))
                for lane, data in (('foundation', foundation), ('application', release)):
                    inputs.write_text(json.dumps(data))
                    for action in ('plan', 'apply'):
                        with patch('terraform_run.subprocess.run') as run, self.assertRaisesRegex(SafeFailure, 'Sweden'):
                            invoke(lane, backend, inputs, action)
                        run.assert_not_called()

    def test_runtime_guard_rejects_missing_or_wrong_disk_before_firewall(self):
        for mounted, actual in ((False, 'database'), (True, 'foreign')):
            with patch('selfhost_runtime_guard.os.geteuid', return_value=0), patch('selfhost_runtime_guard.Path.read_text', return_value='UUID=database /srv/tonyai/database ext4 defaults 0 2\nUUID=objects /srv/tonyai/objects ext4 defaults 0 2'), patch('selfhost_runtime_guard.os.path.ismount', return_value=mounted), patch('selfhost_runtime_guard.subprocess.check_output', return_value=actual), patch('selfhost_runtime_guard.subprocess.run') as mutate:
                with self.assertRaises(ValueError): selfhost_runtime_guard.main()
                mutate.assert_not_called()

    def test_imds_drop_precedes_existing_return(self):
        fstab = '\n'.join(f'UUID={name} /srv/tonyai/{name} ext4 defaults 0 2' for name in ('database', 'objects'))
        expected = '-A DOCKER-USER -d 169.254.169.254/32 -j DROP\n-A DOCKER-USER -d 168.63.129.16/32 -p tcp -m tcp --dport 53 -j ACCEPT\n-A DOCKER-USER -d 168.63.129.16/32 -p udp -m udp --dport 53 -j ACCEPT\n-A DOCKER-USER -d 168.63.129.16/32 -j DROP\n'
        state = ['-A DOCKER-USER -j RETURN']
        def output(command, **kwargs):
            if command[0] == 'findmnt': return command[-1].rsplit('/', 1)[-1]
            self.assertEqual(command, ['iptables', '-w', '-S', 'DOCKER-USER'])
            return '-N DOCKER-USER\n' + '\n'.join(state)
        def apply(command, **kwargs):
            if command[2] == '-I': state.insert(0, '-A DOCKER-USER ' + ' '.join(command[5:]))
            return SimpleNamespace(returncode=0)
        with patch('selfhost_runtime_guard.os.geteuid', return_value=0), patch('selfhost_runtime_guard.Path.read_text', return_value=fstab), patch('selfhost_runtime_guard.os.path.ismount', return_value=True), patch('selfhost_runtime_guard.subprocess.check_output', side_effect=output), patch('selfhost_runtime_guard.subprocess.run', side_effect=apply):
            try: selfhost_runtime_guard.main()
            except ValueError as error: self.fail('Valid firewall installation must succeed: ' + str(error))
            self.assertEqual(state[:4], expected.splitlines())
            self.assertEqual(state[4], '-A DOCKER-USER -j RETURN')

    def test_database_config_refuses_foreign_data_and_failed_copy_has_no_marker(self):
        image = 'supabase/postgres@sha256:' + 'a' * 64
        for scenario in ('failed-copy',):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); target = root / 'db-config'; target.mkdir()
                (root / 'compose.images.json').write_text(json.dumps({'services': {'db': {'image': image}}}))
                if scenario == 'foreign': (target / 'valuable').write_text('preserve')
                if scenario == 'wrong-marker': (target / '.tonyai-image').write_text('other-image')
                def path(value): return root / Path(value).name if str(value).startswith('/srv/') else root / value
                def run(command, **kwargs):
                    if command[:2] == ['docker', 'cp']: raise subprocess.CalledProcessError(1, command)
                    return SimpleNamespace(returncode=0)
                with patch('selfhost_db_config.Path', side_effect=path), patch('selfhost_db_config.os.geteuid', return_value=0), patch('selfhost_db_config.os.path.ismount', return_value=True), patch('selfhost_db_config.subprocess.check_output', side_effect=['100:101:755', 'temporary-container']), patch('selfhost_db_config.subprocess.run', side_effect=run):
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)): selfhost_db_config.main()
                if scenario == 'foreign': self.assertEqual((target / 'valuable').read_text(), 'preserve')
                if scenario != 'wrong-marker': self.assertFalse((target / '.tonyai-image').exists())

    def test_database_config_loss_never_reseeds_existing_cluster(self):
        image = 'supabase/postgres@sha256:' + 'a' * 64
        for scenario in ('missing-config', 'missing-static-file', 'missing-key', 'empty-key'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); target = root / 'db-config'; target.mkdir()
                postgres = root / 'postgres'; postgres.mkdir(); (postgres / 'PG_VERSION').write_text('17')
                (root / 'compose.images.json').write_text(json.dumps({'services': {'db': {'image': image}}}))
                if scenario != 'missing-config':
                    (target / '.tonyai-image').write_text(image)
                    (target / 'conf.d').mkdir()
                    for name in ('wal-g.conf', 'read-replica.conf', 'supautils.conf'):
                        if scenario != 'missing-static-file' or name != 'wal-g.conf': (target / name).touch()
                    if scenario == 'empty-key': (target / 'pgsodium_root.key').touch()
                before = sorted(str(path.relative_to(root)) for path in root.rglob('*'))
                def path(value): return root / Path(value).name
                with patch('selfhost_db_config.Path', side_effect=path), patch('selfhost_db_config.os.geteuid', return_value=0), patch('selfhost_db_config.os.path.ismount', return_value=True), patch('selfhost_db_config.subprocess.check_output') as inspect, patch('selfhost_db_config.subprocess.run') as mutate, patch('selfhost_db_config.os.chown') as chown:
                    with self.assertRaises(ValueError): selfhost_db_config.main()
                    inspect.assert_not_called(); mutate.assert_not_called(); chown.assert_not_called()
                self.assertEqual(before, sorted(str(path.relative_to(root)) for path in root.rglob('*')))
                self.assertEqual((postgres / 'PG_VERSION').read_text(), '17')

    def test_escrow_exact_origin_redirect_and_subprocess_redaction(self):
        contract = {'subscription_id': SUB, 'environment': 'staging', 'public_ip': '8.8.8.8',
                    'recovery_vault_url': 'https://tonyai-qa-rec-cb7efc2f.vault.azure.net'}
        self.assertEqual(selfhost_escrow.validate_contract(contract), contract['recovery_vault_url'])
        for url in ('http://tonyai-qa-rec-cb7efc2f.vault.azure.net', 'https://attacker.example', contract['recovery_vault_url'] + '@attacker.example'):
            with self.assertRaises(ValueError): selfhost_escrow.validate_contract({**contract, 'recovery_vault_url': url})
        with self.assertRaises(ValueError): selfhost_escrow.NoRedirect().redirect_request()
        with patch('selfhost_escrow.subprocess.run', return_value=SimpleNamespace(returncode=1, stdout=b'synthetic-secret', stderr=b'synthetic-secret')):
            with self.assertRaises(ValueError) as result: selfhost_escrow.capture(['synthetic-command'])
            self.assertNotIn('synthetic-secret', str(result.exception))

    def test_escrow_save_uses_memory_and_exact_version_readback(self):
        contract = {'subscription_id': SUB, 'tenant_id': 'tenant', 'environment': 'staging', 'public_ip': '8.8.8.8',
                    'recovery_vault_url': 'https://tonyai-qa-rec-cb7efc2f.vault.azure.net'}
        value = "COMPOSE_FILE='locked'\nPOSTGRES_PASSWORD='synthetic-secret-value'\n"
        origin = contract['recovery_vault_url']; version = 'a' * 32; commands = []
        def capture(command, data=None):
            commands.append(command)
            if command[:3] == ['az', 'account', 'show']: return json.dumps({'id': SUB, 'tenantId': 'tenant'}).encode()
            if command[:3] == ['az', 'account', 'get-access-token']: return b'{"accessToken":"synthetic-access-token"}'
            if command[-1] == 'sudo cat /opt/tonyai/supabase/.env': return value.encode()
            return b''
        with patch('sys.argv', ['escrow', 'save', '--contract', 'contract', '--key', 'key', '--known-hosts', 'hosts']), patch('selfhost_escrow.Path.read_text', return_value=json.dumps(contract)), patch('selfhost_escrow.capture', side_effect=capture), patch('selfhost_escrow.Path.is_symlink', return_value=False), patch('selfhost_escrow.Path.write_bytes'), patch('selfhost_escrow.Path.chmod'), patch('selfhost_escrow.build_opener') as opener, contextlib.redirect_stdout(io.StringIO()) as output:
            opener.return_value.open.side_effect = [io.BytesIO(json.dumps({'id': origin + '/secrets/supabase-runtime-env/' + version}).encode()), io.BytesIO(json.dumps({'value': value}).encode())]
            selfhost_escrow.main()
        self.assertNotIn('synthetic-secret-value', repr(commands) + output.getvalue())
        self.assertNotIn('synthetic-access-token', repr(commands) + output.getvalue())
        self.assertIn(version, output.getvalue())

    def test_fetch_rejects_escape_symlink_and_hash_mismatch_without_writes(self):
        import selfhost_fetch
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, 'runtime'); target.mkdir()
            outside = Path(directory, 'valuable'); outside.write_text('preserve')
            (target / 'link').symlink_to(outside)
            for name in ('../valuable', 'link'):
                with patch('selfhost_fetch.urlopen') as network, self.assertRaises(ValueError):
                    selfhost_fetch.fetch_file(target, name, 'a' * 64, 'b' * 40)
                network.assert_not_called()
                self.assertEqual(outside.read_text(), 'preserve')
            with patch('selfhost_fetch.urlopen', return_value=io.BytesIO(b'tampered')), self.assertRaises(ValueError):
                selfhost_fetch.fetch_file(target, 'compose.yml', 'a' * 64, 'b' * 40)
            self.assertFalse((target / 'compose.yml').exists())

    def test_fresh_source_permissions_allow_container_reads_without_exposing_runtime(self):
        import selfhost_fetch
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory, 'runtime'); target.mkdir(mode=0o700)
            secret = target / '.env'; secret.write_text('synthetic-secret'); secret.chmod(0o600)
            content = b'-- verified initialization SQL\n'; digest = hashlib.sha256(content).hexdigest()
            previous = os.umask(0o077)
            try:
                with patch('selfhost_fetch.urlopen', return_value=io.BytesIO(content)):
                    selfhost_fetch.fetch_file(target, 'volumes/db/init.sql', digest, 'b' * 40)
            finally:
                os.umask(previous)
            self.assertEqual((target / 'volumes/db/init.sql').stat().st_mode & 0o777, 0o644)
            for name in ('volumes', 'volumes/db'):
                self.assertEqual((target / name).stat().st_mode & 0o777, 0o755)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
            (target / 'alias').symlink_to(target / 'volumes', target_is_directory=True)
            with self.assertRaises(ValueError):
                selfhost_fetch.fetch_file(target, 'alias/db/init.sql', digest, 'b' * 40)
