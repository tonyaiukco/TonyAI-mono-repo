"""Offline regressions for the independent clean-replacement review findings."""
import contextlib
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import replacement_run as runner
import replacement_start as start
import replacement_custody_host as custody_host
import replacement_restore as restore
from replacement_bundle import digest, encoded, write_new
from replacement_custody import ENV, SODIUM, marker
from pooler import SafeFailure
from terraform_run import invoke
from test_backend import config as backend_config
from test_selfhost_foundation import inputs as legacy_inputs
from test_replacement_custody import contract
from test_replacement_plan import inputs, plan


class ReplacementReviewTests(unittest.TestCase):
    def spawn(self, process, stdout, stderr):
        def start_process(command, **kwargs):
            for name, data in (('stdout', stdout), ('stderr', stderr)):
                kwargs[name].write(data)
                kwargs[name].flush()
            return process
        return start_process

    def test_legacy_config_only_plan_and_apply_refuse_before_any_terraform_call(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = Path(folder) / 'backend'; config = Path(folder) / 'inputs'
            backend.write_bytes(encoded(backend_config())); config.write_bytes(encoded(legacy_inputs()))
            with patch('terraform_run.subprocess.run') as run:
                run.return_value.returncode = 0
                for action in ('plan', 'apply'):
                    with self.subTest(action=action), self.assertRaisesRegex(SafeFailure, 'replacement_run.py'):
                        invoke('selfhost', backend, config, action)
                run.assert_not_called()

    @contextlib.contextmanager
    def saved_packet(self, phase='R1'):
        with tempfile.TemporaryDirectory() as folder, contextlib.ExitStack() as stack:
            directory = Path(folder)
            raw = encoded(dict(phase=phase, created_at=1000, state={'serial': 1},
                               plan_sha256=digest(b'plan'), projection_sha256=digest(encoded(plan(phase)))))
            write_new(directory / 'binding.json', raw); write_new(directory / 'saved.tfplan', b'plan')
            stack.enter_context(patch.object(runner, 'context', return_value=(['terraform'], {}, {'phase': phase}, inputs(phase))))
            stack.enter_context(patch.object(runner, 'state', return_value={'serial': 1}))
            stack.enter_context(patch.object(runner.time, 'time', return_value=1001))
            stack.enter_context(patch.object(runner, 'check_collisions'))
            stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
            yield directory, digest(raw)

    def test_apply_deadline_sends_one_sigint_waits_and_never_kills(self):
        with self.saved_packet('R2') as (directory, approved):
            process = MagicMock(); process.returncode = 0
            def wait(**kwargs):
                if process.wait.call_count == 1:
                    raise subprocess.TimeoutExpired('terraform', 900)
                self.assertIs(signal.getsignal(signal.SIGINT), signal.SIG_IGN)
                return 0
            process.wait.side_effect = wait
            def metadata(command, **kwargs):
                self.assertNotIn('apply', command, 'Apply must not use subprocess.run and its timeout/SIGKILL path')
                return subprocess.CompletedProcess(command, 0, encoded(plan('R2')), b'')
            with patch.object(runner.subprocess, 'run', side_effect=metadata), patch.object(runner.subprocess, 'Popen', side_effect=self.spawn(process, b'partial-output', b'partial-error')) as popen:
                with self.assertRaises(ValueError): runner.apply('backend', 'inputs', 'R2', directory, approved)
            self.assertIs(popen.call_args.kwargs.get('start_new_session'), True)
            process.send_signal.assert_called_once_with(signal.SIGINT)
            process.kill.assert_not_called(); process.terminate.assert_not_called()
            self.assertEqual(process.wait.call_args_list[-1].kwargs, {})
            self.assertEqual((directory / 'apply.stderr.log').read_bytes(), b'partial-error')
            self.assertTrue((directory / 'apply-attempt.json').exists())
            self.assertFalse((directory / 'apply-completed.json').exists())

    def test_failed_command_never_overwrites_existing_diagnostics(self):
        for action in ('plan', 'apply'):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                path = directory / (action + '.stdout.log')
                write_new(path, b'original-diagnostics')
                process = MagicMock(); process.returncode = 1
                process.wait.return_value = 1
                with patch.object(runner.subprocess, 'Popen', return_value=process) as popen:
                    try:
                        with self.assertRaises(FileExistsError):
                            runner.terraform_capture(['terraform', action], {}, directory, action)
                    finally:
                        self.assertEqual(path.read_bytes(), b'original-diagnostics')
                        popen.assert_not_called()

    def test_failed_apply_keeps_private_diagnostics_and_refuses_second_attempt(self):
        with self.saved_packet() as (directory, approved):
            process = MagicMock(); process.returncode = 1
            process.wait.return_value = 1
            def result(command, **kwargs):
                return subprocess.CompletedProcess(command, int('apply' in command),
                    b'synthetic-stdout-secret' if 'apply' in command else encoded(plan('R1')), b'synthetic-stderr-secret')
            with patch.object(runner.subprocess, 'run', side_effect=result), patch.object(runner.subprocess, 'Popen', side_effect=self.spawn(process, b'synthetic-stdout-secret', b'synthetic-stderr-secret')) as popen, patch('sys.stdout', new_callable=io.StringIO) as output:
                with self.assertRaises(ValueError): runner.apply('backend', 'inputs', 'R1', directory, approved)
                for stream in ('stdout', 'stderr'):
                    path = directory / ('apply.' + stream + '.log')
                    self.assertEqual(path.read_bytes(), ('synthetic-' + stream + '-secret').encode())
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('synthetic-', output.getvalue())
                with self.assertRaises(FileExistsError): runner.apply('backend', 'inputs', 'R1', directory, approved)
                self.assertEqual(popen.call_count, 1)
                self.assertFalse((directory / 'apply-completed.json').exists())

    def test_plan_interrupt_keeps_diagnostics_without_binding_or_kill(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / 'packet'; process = MagicMock(); process.returncode = 1
            process.wait.side_effect = [KeyboardInterrupt(), 1]
            with patch.object(runner, 'context', return_value=(['terraform'], {}, {}, inputs('R1'))), patch.object(runner, 'state', return_value={}), patch.object(runner.subprocess, 'Popen', side_effect=self.spawn(process, b'partial-plan', b'plan-error')), patch.object(runner.subprocess, 'run', side_effect=AssertionError('Plan must not use subprocess.run')):
                with self.assertRaises(ValueError): runner.prepare('backend', 'inputs', 'R1', directory)
            process.send_signal.assert_called_once_with(signal.SIGINT); process.kill.assert_not_called()
            self.assertEqual((directory / 'plan.stdout.log').read_bytes(), b'partial-plan')
            self.assertEqual((directory / 'plan.stdout.log').stat().st_mode & 0o777, 0o600)
            self.assertFalse((directory / 'binding.json').exists())

    def test_runtime_rejects_environment_changed_between_custody_stages(self):
        data = contract(); first = {ENV: b'original-environment'}
        changed = {ENV: b'changed-environment', SODIUM: b'intrinsic-key'}
        image = 'example/db@sha256:' + 'a' * 64
        locked = {name: {'image': image, 'platform': 'linux/amd64'} for name in ('db', 'realtime')}
        config = {'services': {name: {**value, 'restart': 'no'} for name, value in locked.items()}}
        config['services']['realtime']['environment'] = {'DB_ENC_WRITE_GCM': 'true', 'DB_ENC_KEY_GCM': 'a' * 32}
        def safe(path):
            name = str(path)
            value = ({'services': locked} if name.endswith('compose.images.json') else
                dict(generation='r02', vm_id=data['vm_id'], source_sha256=data['source_sha256'], state='started') if 'initialization' in name else
                marker(data, 'environment', 'a' * 32, first) if 'environment' in name else
                marker(data, 'intrinsic', 'b' * 32, changed))
            fake = MagicMock(); fake.read_bytes.return_value = encoded(value); return fake
        def run(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, encoded(config) if 'config' in command else b'')
        with patch.object(sys, 'argv', ['start', 'runtime-start']), patch.object(start, 'check', return_value=data), patch.object(start.os, 'chdir'), patch.object(start, 'safe_path', side_effect=safe), patch.object(start, 'collect', return_value=changed), patch.object(start, 'redact_gateway'), patch.object(start, 'validate'), patch.object(start.subprocess, 'run', side_effect=run) as commands:
            with self.assertRaisesRegex(ValueError, 'marker'): start.main()
            self.assertFalse(any('up' in call.args[0] for call in commands.call_args_list))

    def test_intrinsic_export_rejects_changed_environment_before_secret_output(self):
        data = contract(); changed = {ENV: b'changed-environment', SODIUM: b'intrinsic-key'}
        checkpoint = MagicMock(); checkpoint.read_bytes.return_value = encoded(marker(data, 'environment', 'a' * 32, {ENV: b'original-environment'}))
        with patch.object(sys, 'argv', ['custody', 'export', 'intrinsic']), patch.object(custody_host, 'check', return_value=data), patch.object(custody_host, 'collect', return_value=changed), patch.object(custody_host, 'safe_path', return_value=checkpoint), patch('sys.stdout') as output:
            with self.assertRaisesRegex(ValueError, 'marker'): custody_host.main()
            output.buffer.write.assert_not_called()

    def test_restore_rejects_cross_stage_environment_before_writing(self):
        from replacement_custody import envelope
        data = contract(); files = {ENV: b'changed-environment', SODIUM: b'intrinsic-key'}
        record = marker(data, 'intrinsic', 'b' * 32, files)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); key = root / 'db-config/pgsodium_root.key'
            key.parent.mkdir(mode=0o700); write_new(key, files[SODIUM])
            environment = root / 'environment-marker'; write_new(environment, encoded(marker(data, 'environment', 'a' * 32, {ENV: b'original-environment'})))
            mapping = {ENV: root / '.env', SODIUM: key, '/etc/tonyai/escrow-r02-environment.json': environment,
                       '/etc/tonyai/escrow-r02-intrinsic.json': root / 'intrinsic-marker'}
            def safe(path, **kwargs): return mapping.get(str(path), Path(path))
            stream = MagicMock(); stream.buffer = io.BytesIO(encoded({'envelope': envelope(data, 'intrinsic', files), 'record': record}))
            with patch.object(sys, 'argv', ['restore']), patch.object(sys, 'stdin', stream), patch.object(restore, 'check', return_value=data), patch.object(restore, 'safe_path', side_effect=safe), patch.object(restore, 'Path', side_effect=safe), patch.object(restore.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'')), patch.object(custody_host, 'collect', return_value=files):
                with self.assertRaisesRegex(ValueError, 'marker'): restore.main()
                self.assertFalse((root / '.env').exists())
                self.assertFalse((root / 'intrinsic-marker').exists())
