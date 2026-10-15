"""Discriminating recovery gates: rejected operations cannot mutate their destinations."""
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import selfhost_start as start
import selfhost_pin as pin
import selfhost_restore_env as restore
import selfhost_escrow as escrow
import selfhost_db_config as db
import selfhost_runtime_guard as guard
from test_selfhost_runtime import config

IMAGE = 'example/image@sha256:' + 'a' * 64
PAYLOAD = b"COMPOSE_FILE='locked'\nPOSTGRES_PASSWORD='synthetic-only'\n"
TEMPLATE = b'header\n inline_string: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %REQ(REFERER)%"\nfooter\n'
FSTAB = 'UUID=database /srv/tonyai/database ext4 defaults 0 2\nUUID=objects /srv/tonyai/objects ext4 defaults 0 2'
RULES = [
    '-A DOCKER-USER -d 169.254.169.254/32 -j DROP',
    '-A DOCKER-USER -d 168.63.129.16/32 -p tcp -m tcp --dport 53 -j ACCEPT',
    '-A DOCKER-USER -d 168.63.129.16/32 -p udp -m udp --dport 53 -j ACCEPT',
    '-A DOCKER-USER -d 168.63.129.16/32 -j DROP',
]


class StartupTests(unittest.TestCase):
    def test_start_recovery_and_failure_gates(self):
        for scenario in ('recovery', 'recovery-http', 'hash', 'guard', 'image', 'effective-image', 'invalid-bind', 'up-failure', 'gateway-directory'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                root = Path(directory); original = Path.cwd(); stack.callback(os.chdir, original)
                source = root / 'volumes/api/envoy/lds.template.yaml'; source.parent.mkdir(parents=True); source.write_bytes(TEMPLATE)
                (root / '.env').write_bytes(PAYLOAD)
                locked = {'services': {'db': {'image': 'example:latest' if scenario == 'image' else IMAGE}}}
                (root / 'compose.images.json').write_text(json.dumps(locked))
                marker = root / 'escrow.json'; marker.write_text(json.dumps({'sha256': 'wrong' if scenario == 'hash' else hashlib.sha256(PAYLOAD).hexdigest()}))
                stack.enter_context(patch('selfhost_start.Path', side_effect=lambda p: marker if str(p) == '/etc/tonyai/escrow.json' else root))
                stack.enter_context(patch('selfhost_start.os.geteuid', return_value=0))
                stack.enter_context(patch('sys.argv', ['start'] + ([] if scenario == 'recovery-http' else ['--https'])))
                stack.enter_context(patch('selfhost_pin.GATEWAY_TEMPLATE_SHA256', hashlib.sha256(TEMPLATE).hexdigest()))
                effective = config()
                for service in effective['services'].values(): service['image'] = IMAGE
                if scenario == 'gateway-directory': source.with_name('lds.qa.yaml').mkdir()
                if scenario == 'invalid-bind': effective['services']['api-gw']['volumes'][0]['read_only'] = False
                if scenario == 'effective-image': effective['services']['db']['image'] = 'example:latest'
                compose = stack.enter_context(patch('selfhost_pin.compose_config', return_value=effective))
                def run(command, **kwargs):
                    if command[0] == '/usr/local/sbin/tonyai-runtime-guard' and scenario == 'guard':
                        if kwargs.get('check'): raise subprocess.CalledProcessError(1, command)
                        return SimpleNamespace(returncode=1)
                    return SimpleNamespace(returncode=1 if scenario == 'up-failure' else 0)
                calls = stack.enter_context(patch('selfhost_start.subprocess.run', side_effect=run))
                output = stack.enter_context(redirect_stdout(io.StringIO()))
                if scenario.startswith('recovery'):
                    start.main()
                    self.assertTrue(source.with_name('lds.qa.yaml').is_file())
                    clean = source.with_name('lds.qa.yaml').read_bytes()
                    source.with_name('lds.qa.yaml').write_text('tampered')
                    start.main()
                    generated = source.with_name('lds.qa.yaml')
                    self.assertTrue(generated.is_file()); self.assertNotIn('%REQ', generated.read_text())
                    self.assertEqual(generated.read_bytes(), clean)
                    self.assertEqual(json.loads((root / 'compose.images.json').read_text()), locked)
                    expected = ['docker', 'compose', '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'compose.qa.yml',
                                '-f', 'compose.https.yml', '-f', 'compose.images.json']
                    if scenario != 'recovery-http': expected += ['--profile', 'https']
                    expected += ['up', '-d', '--wait', '--wait-timeout', '240']
                    self.assertEqual([c.args[0] for c in calls.call_args_list if c.args[0][:2] == ['docker', 'compose']], [expected, expected])
                else:
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)): start.main()
                    self.assertNotIn('PASS:', output.getvalue())
                    up_calls = [c for c in calls.call_args_list if c.args[0][:2] == ['docker', 'compose']]
                    self.assertEqual(len(up_calls), 1 if scenario == 'up-failure' else 0)
                    if scenario in ('hash', 'guard', 'image', 'gateway-directory'):
                        compose.assert_not_called()
                        if scenario != 'gateway-directory': self.assertFalse(source.with_name('lds.qa.yaml').exists())
                    if scenario in ('up-failure', 'gateway-directory'):
                        with patch('pathlib.Path', side_effect=lambda p: marker if str(p) == '/etc/tonyai/escrow.json' else root):
                            message = 'FAIL: guarded runtime start refused' if scenario == 'up-failure' else 'FAIL: .*inspect and manually remove the leftover directory'
                            with self.assertRaisesRegex(SystemExit, message): runpy.run_path(start.__file__, run_name='__main__')
                        self.assertNotIn('PASS:', output.getvalue())

    def test_pin_existing_lock_and_foreign_digest_never_write_lock(self):
        for existing in (True, False):
            with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                previous = Path.cwd(); os.chdir(directory); stack.callback(os.chdir, previous)
                target = Path('compose.images.json')
                if existing: target.write_text('preserve')
                fixture = config(); locked = {name: {'image': IMAGE, 'platform': 'linux/amd64'} for name in fixture['services']}
                Path('reviewed.json').write_text(json.dumps({'services': locked}))
                stack.enter_context(patch('sys.argv', ['pin', 'reviewed.json']))
                redact = stack.enter_context(patch('selfhost_pin.redact_gateway'))
                compose = stack.enter_context(patch('selfhost_pin.compose_config', return_value=fixture))
                run = stack.enter_context(patch('selfhost_pin.subprocess.run', return_value=SimpleNamespace(stdout=json.dumps(['example/image@sha256:' + 'b' * 64]), returncode=0)))
                with self.assertRaisesRegex(ValueError, 'lock exists' if existing else 'recorded digest'): pin.main()
                if existing:
                    redact.assert_not_called(); compose.assert_not_called(); run.assert_not_called()
                    self.assertEqual(target.read_text(), 'preserve')
                else: self.assertFalse(target.exists())


class RestoreTests(unittest.TestCase):
    def test_restore_guards_and_exclusive_create(self):
        for scenario in ('success', 'exists', 'symlink', 'database-unmounted', 'objects-unmounted', 'unsafe-parent', 'race'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                root = Path(directory) / 'opt/tonyai/supabase'; root.mkdir(parents=True)
                target = root / '.env'; other = root / 'preserved'; other.write_bytes(b'preserve')
                if scenario == 'exists': target.write_bytes(b'original')
                if scenario == 'symlink': target.symlink_to(root / 'missing')
                def mapped(value): return root if str(value) == '/opt/tonyai/supabase' else root.parent.parent
                stack.enter_context(patch('selfhost_restore_env.Path', side_effect=mapped))
                stack.enter_context(patch('selfhost_restore_env.os.geteuid', return_value=0))
                stack.enter_context(patch('selfhost_restore_env.os.path.ismount', side_effect=lambda p: scenario != p.rsplit('/', 1)[-1] + '-unmounted'))
                actual_stat = Path.lstat
                def stat(path):
                    value = actual_stat(path)
                    return SimpleNamespace(st_uid=0, st_mode=value.st_mode | (0o022 if scenario == 'unsafe-parent' and path == root.parent else 0))
                stack.enter_context(patch.object(Path, 'lstat', stat))
                stack.enter_context(patch('selfhost_restore_env.sys.stdin', SimpleNamespace(buffer=io.BytesIO(PAYLOAD))))
                real_open = os.open
                def exclusive(path, flags, mode):
                    if scenario == 'race': Path(path).write_bytes(b'raced-original')
                    return real_open(path, flags, mode)
                opened = stack.enter_context(patch('selfhost_restore_env.os.open', side_effect=exclusive))
                if scenario == 'success':
                    restore.main(); self.assertEqual(target.read_bytes(), PAYLOAD)
                    self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                else:
                    with self.assertRaises((ValueError, FileExistsError)): restore.main()
                    if scenario == 'race': self.assertEqual(target.read_bytes(), b'raced-original')
                    else: opened.assert_not_called()
                    if scenario == 'exists': self.assertEqual(target.read_bytes(), b'original')
                    elif scenario == 'symlink':
                        self.assertTrue(target.is_symlink()); self.assertFalse((root / 'missing').exists())
                    elif scenario != 'race': self.assertFalse(target.exists())
                self.assertEqual(other.read_bytes(), b'preserve')


class EscrowTests(unittest.TestCase):
    def test_account_versions_and_readback_abort_without_markers(self):
        sub = '00000000-0000-0000-0000-000000000001'
        contract = {'subscription_id': sub, 'tenant_id': 'tenant', 'environment': 'staging', 'public_ip': '8.8.8.8', 'recovery_vault_url': 'https://tonyai-qa-rec-00000000.vault.azure.net'}
        for scenario in ('account', 'tenant', 'version-invalid', 'version-missing', 'saved-version-invalid', 'saved-version-missing', 'readback'):
            with self.subTest(scenario=scenario), ExitStack() as stack:
                args = ['escrow', 'verify' if scenario.startswith('version-') else 'save', '--contract', 'contract', '--key', 'key', '--known-hosts', 'hosts']
                if scenario == 'version-invalid': args += ['--version', '../other']
                stack.enter_context(patch('sys.argv', args))
                stack.enter_context(patch('selfhost_escrow.Path.read_text', return_value=json.dumps(contract)))
                writes = stack.enter_context(patch('selfhost_escrow.Path.write_bytes'))
                chmod = stack.enter_context(patch('selfhost_escrow.Path.chmod'))
                commands = []
                def capture(command, data=None):
                    commands.append(command)
                    if command[:3] == ['az', 'account', 'show']:
                        return json.dumps({'id': 'wrong' if scenario == 'account' else sub, 'tenantId': 'wrong' if scenario == 'tenant' else 'tenant'}).encode()
                    if command[:3] == ['az', 'account', 'get-access-token']: return b'{"accessToken":"synthetic"}'
                    if command[-1] == 'sudo cat /opt/tonyai/supabase/.env': return PAYLOAD
                    return b''
                stack.enter_context(patch('selfhost_escrow.capture', side_effect=capture))
                requests = []
                def open_request(req, **kwargs):
                    requests.append(req)
                    if req.method == 'PUT':
                        result = {} if scenario == 'saved-version-missing' else {'id': contract['recovery_vault_url'] + '/secrets/supabase-runtime-env/' + ('invalid' if scenario == 'saved-version-invalid' else 'a' * 32)}
                    else: result = {'value': PAYLOAD.decode().replace('synthetic-only', 'different')}
                    return io.BytesIO(json.dumps(result).encode())
                opener = stack.enter_context(patch('selfhost_escrow.build_opener'))
                opener.return_value.open.side_effect = open_request
                with self.assertRaisesRegex(ValueError, 'CLI account' if scenario in ('account', 'tenant') else ('Exact secret version' if 'version' in scenario else 'differs from live')): escrow.main()
                writes.assert_not_called(); chmod.assert_not_called()
                self.assertFalse(any('escrow.json' in c[-1] for c in commands))
                if scenario in ('account', 'tenant'):
                    self.assertEqual(commands, [['az', 'account', 'show', '-o', 'json']]); opener.assert_not_called()
                if 'version' in scenario: self.assertFalse(any(req.method == 'GET' for req in requests))


class GuardTests(unittest.TestCase):
    def test_both_disk_uuids_are_checked_before_firewall(self):
        for actual in (['foreign', 'objects'], ['database', 'foreign']):
            def output(command, **kwargs):
                if command[0] == 'findmnt': return actual[0 if command[-1].endswith('database') else 1]
                return '\n'.join(RULES)
            with patch('selfhost_runtime_guard.os.geteuid', return_value=0), patch('selfhost_runtime_guard.Path.read_text', return_value=FSTAB), patch('selfhost_runtime_guard.os.path.ismount', return_value=True), patch('selfhost_runtime_guard.subprocess.check_output', side_effect=output), patch('selfhost_runtime_guard.subprocess.run', return_value=SimpleNamespace(returncode=0)) as mutate:
                with self.assertRaisesRegex(ValueError, 'identity mismatch'): guard.main()
                mutate.assert_not_called()

    def test_metadata_prefix_order_idempotence_and_readback(self):
        for initial, accepted in ((RULES, True), (['-A DOCKER-USER -j RETURN'], True), (list(reversed(RULES)), True), (['-A DOCKER-USER -j RETURN'], False)):
            state = list(initial)
            def output(command, **kwargs):
                if command[0] == 'findmnt': return command[-1].rsplit('/', 1)[-1]
                return '-N DOCKER-USER\n' + '\n'.join(state)
            def run(command, **kwargs):
                if command[2] == '-I' and accepted: state.insert(0, '-A DOCKER-USER ' + ' '.join(command[5:]))
                return SimpleNamespace(returncode=0)
            with patch('selfhost_runtime_guard.os.geteuid', return_value=0), patch('selfhost_runtime_guard.Path.read_text', return_value=FSTAB), patch('selfhost_runtime_guard.os.path.ismount', return_value=True), patch('selfhost_runtime_guard.subprocess.check_output', side_effect=output), patch('selfhost_runtime_guard.subprocess.run', side_effect=run) as mutate:
                if accepted:
                    try: guard.main()
                    except ValueError as error: self.fail('Valid mounted host must install the required firewall prefix: ' + str(error))
                    self.assertEqual(state[:4], RULES)
                    before = len(mutate.call_args_list); guard.main()
                    self.assertEqual(len(mutate.call_args_list), before + 1)
                else:
                    with self.assertRaisesRegex(ValueError, 'read back'): guard.main()
                if initial == RULES: self.assertFalse(any(c.args[0][2] == '-I' for c in mutate.call_args_list))

    def test_db_config_preconditions_have_zero_docker_or_chown(self):
        for scenario in ('marker', 'unmounted', 'foreign'):
            with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                root = Path(directory); target = root / 'db-config'; target.mkdir()
                (root / 'compose.images.json').write_text(json.dumps({'services': {'db': {'image': IMAGE}}}))
                if scenario == 'marker': (target / '.tonyai-image').write_text('foreign-image')
                if scenario == 'foreign': (target / 'valuable').write_text('preserve')
                before = {p.name: p.read_bytes() for p in target.iterdir()}
                stack.enter_context(patch('selfhost_db_config.Path', side_effect=lambda p: root / Path(p).name))
                stack.enter_context(patch('selfhost_db_config.os.geteuid', return_value=0))
                stack.enter_context(patch('selfhost_db_config.os.path.ismount', return_value=scenario != 'unmounted'))
                output = stack.enter_context(patch('selfhost_db_config.subprocess.check_output'))
                run = stack.enter_context(patch('selfhost_db_config.subprocess.run'))
                chown = stack.enter_context(patch('selfhost_db_config.os.chown'))
                with self.assertRaisesRegex(ValueError, {'marker': 'another image', 'unmounted': 'mounted', 'foreign': 'unrecognized'}[scenario]): db.main()
                output.assert_not_called(); run.assert_not_called(); chown.assert_not_called()
                self.assertEqual({p.name: p.read_bytes() for p in target.iterdir()}, before)


class ExtendedRecoveryTests(unittest.TestCase):
    def test_every_recovery_parent_is_checked_before_open(self):
        for parent in ('opt', 'opt/tonyai', 'opt/tonyai/supabase'):
            for defect in ('owner', 'symlink', 'file', 'group-write', 'other-write'):
                with self.subTest(parent=parent, defect=defect), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                    base = Path(directory); root = base / 'opt/tonyai/supabase'; root.mkdir(parents=True)
                    bad = base / parent
                    stack.enter_context(patch('selfhost_restore_env.Path', side_effect=lambda p: base / str(p).lstrip('/')))
                    stack.enter_context(patch('selfhost_restore_env.os.geteuid', return_value=0))
                    stack.enter_context(patch('selfhost_restore_env.os.path.ismount', return_value=True))
                    def stat(path):
                        mode = 0o40755 | ({'group-write': 0o020, 'other-write': 0o002}.get(defect, 0) if path == bad else 0)
                        return SimpleNamespace(st_uid=1 if path == bad and defect == 'owner' else 0, st_mode=mode)
                    stack.enter_context(patch.object(Path, 'lstat', stat))
                    stack.enter_context(patch.object(Path, 'is_symlink', lambda p: p == bad and defect == 'symlink'))
                    stack.enter_context(patch.object(Path, 'is_dir', lambda p: not (p == bad and defect == 'file')))
                    stack.enter_context(patch('selfhost_restore_env.sys.stdin', SimpleNamespace(buffer=io.BytesIO(PAYLOAD))))
                    opened = stack.enter_context(patch('selfhost_restore_env.os.open', side_effect=AssertionError('Unsafe parent reached credential write.')))
                    with self.assertRaisesRegex(ValueError, 'Unsafe recovery destination'): restore.main()
                    opened.assert_not_called(); self.assertFalse((root / '.env').exists())

    def test_escrow_restore_stdin_order_and_failure_prevent_marker(self):
        sub = '00000000-0000-0000-0000-000000000001'
        origin = 'https://tonyai-qa-rec-00000000.vault.azure.net'
        contract = {'subscription_id': sub, 'tenant_id': 'tenant', 'environment': 'staging', 'public_ip': '8.8.8.8', 'recovery_vault_url': origin}
        for fail in (False, True):
            with self.subTest(fail=fail), ExitStack() as stack:
                stack.enter_context(patch('sys.argv', ['escrow', 'restore', '--contract', 'contract', '--key', 'key', '--known-hosts', 'hosts', '--version', 'a' * 32]))
                stack.enter_context(patch('selfhost_escrow.Path.read_text', return_value=json.dumps(contract)))
                stack.enter_context(patch('selfhost_escrow.Path.is_symlink', return_value=False))
                writes = stack.enter_context(patch('selfhost_escrow.Path.write_bytes'))
                chmod = stack.enter_context(patch('selfhost_escrow.Path.chmod'))
                calls = []
                def capture(command, data=None):
                    calls.append((command, data))
                    self.assertNotIn(PAYLOAD.decode(), repr(command))
                    if command[:3] == ['az', 'account', 'show']: return json.dumps({'id': sub, 'tenantId': 'tenant'}).encode()
                    if command[:3] == ['az', 'account', 'get-access-token']: return b'{"accessToken":"synthetic"}'
                    if 'selfhost_restore_env.py' in command[-1] and fail: raise ValueError('Private subprocess failed')
                    return b''
                stack.enter_context(patch('selfhost_escrow.capture', side_effect=capture))
                opener = stack.enter_context(patch('selfhost_escrow.build_opener'))
                opener.return_value.open.return_value = io.BytesIO(json.dumps({'value': PAYLOAD.decode()}).encode())
                stack.enter_context(redirect_stdout(io.StringIO()))
                if fail:
                    with self.assertRaisesRegex(ValueError, 'Private subprocess failed'): escrow.main()
                    writes.assert_not_called(); chmod.assert_not_called()
                else: escrow.main()
                self.assertEqual(len(opener.call_args.args), 1)
                self.assertIsInstance(opener.call_args.args[0], escrow.NoRedirect)
                operations = [(c, data) for c, data in calls if c[0] == 'ssh']
                self.assertEqual(operations[0][0][-1], 'sudo python3 /home/tonyaiops/selfhost_restore_env.py')
                self.assertEqual(operations[0][1], PAYLOAD)
                if fail: self.assertEqual(len(operations), 1)
                else:
                    self.assertEqual(len(operations), 2)
                    self.assertIn('/etc/tonyai/escrow.json', operations[1][0][-1])
                    self.assertEqual(json.loads(operations[1][1])['sha256'], hashlib.sha256(PAYLOAD).hexdigest())
                    writes.assert_called_once_with(operations[1][1])

    def test_matching_uuids_do_not_replace_mount_requirement(self):
        with patch('selfhost_runtime_guard.os.geteuid', return_value=0), patch('selfhost_runtime_guard.Path.read_text', return_value=FSTAB), patch('selfhost_runtime_guard.os.path.ismount', return_value=False), patch('selfhost_runtime_guard.subprocess.check_output', side_effect=lambda command, **kw: command[-1].rsplit('/', 1)[-1]), patch('selfhost_runtime_guard.subprocess.run', side_effect=AssertionError('Unmounted disk reached firewall.')) as mutate:
            with self.assertRaisesRegex(ValueError, 'disk is unavailable'): guard.main()
            mutate.assert_not_called()
