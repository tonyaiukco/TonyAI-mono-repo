"""Local synthetic identity/refusal tests; never run native or target commands."""
import base64
from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_noble_common as common
import r3_noble_fixture as host
import r3_noble_guest as guest
import r3_noble_identity as identity
import r3_noble_inputs as inputs
import r3_package_state as state
from r3_package_fixtures import baseline, installed, render, trace
import test_r3_noble_fixture as fixtures

PINS = fixtures.PINS


def context():
    return {'format': 1, 'purpose': 'REFUSAL_CONTEXT_ONLY', 'identity_proves_inactivity': False}


class IdentityReads(unittest.TestCase):
    def test_zero_reported_size_and_binary_overflow_read_to_cap(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name).resolve() / 'cmdline'
            path.write_bytes(b'python\0\xffsecret\0')
            info = path.stat()
            zero = Mock(**{'st_' + key: value for key, value in identity.metadata(info).items()})
            zero.st_size = 0
            with patch.object(identity.os, 'fstat', return_value=zero):
                data, meta = identity.bounded_file(path, 8, proc=True)
            self.assertEqual(data, b'python\0\xff')
            self.assertTrue(meta['truncated'])
            self.assertEqual(base64.b64decode(identity.byte_record(data)['base64']), data)

    def test_refuse_final_and_intermediate_symlinks_with_under_cap_target(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve()
            (root / 'data').write_bytes(b'1234')
            (root / 'link').symlink_to(root / 'data')
            (root / 'dirlink').symlink_to(root, target_is_directory=True)
            self.assertEqual(identity.bounded_file(root / 'data', 8)[0], b'1234')
            for path in (root / 'link', root / 'dirlink/data'):
                with self.subTest(path=path), self.assertRaises(OSError):
                    identity.bounded_file(path, 8)

    def test_refuse_fifo_directory_and_oversized_regular_file(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve()
            os.mkfifo(root / 'fifo')
            (root / 'data').write_bytes(b'1234')
            for path, limit in ((root / 'fifo', 8), (root, 8), (root / 'data', 3)):
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'Unsafe or oversized'):
                    identity.bounded_file(path, limit)

    def test_changed_metadata_is_explicit(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name).resolve() / 'data'
            path.write_bytes(b'bytes')
            info = path.stat()
            after = Mock(**{'st_' + key: value for key, value in identity.metadata(info).items()})
            after.st_mtime_ns += 1
            with patch.object(identity.os, 'fstat', side_effect=[info, after]):
                data, meta = identity.bounded_file(path, 10)
            self.assertEqual(data, b'bytes')
            self.assertFalse(meta['metadata_equal'])

    def test_process_stat_parsing_with_parentheses_and_truncation(self):
        raw = b'42 (name ) with spaces) S 1 42 ' + b'0 ' * 16 + b'99 0\n'
        with patch.object(identity, 'bounded_file', return_value=(raw, {'truncated': False})):
            self.assertEqual(identity.proc_identity(Path('/proc/42')), {'pid': 42, 'ppid': 1, 'pgrp': 42, 'start_ticks': 99})
        with patch.object(identity, 'bounded_file', return_value=(raw, {'truncated': False})), self.assertRaisesRegex(ValueError, 'Process identity differs'):
            identity.proc_identity(Path('/proc/43'))
        with patch.object(identity, 'bounded_file', return_value=(raw, {'truncated': True})), self.assertRaises(ValueError):
            identity.proc_identity(Path('/proc/42'))
        with patch.object(identity, 'bounded_file', return_value=(b'invalid', {'truncated': False})), self.assertRaises(ValueError):
            identity.proc_identity(Path('/proc/42'))

    def test_reused_pid_refuses_further_reads_and_disappearance_is_explicit(self):
        original = {'pid': 42, 'pgrp': 42, 'start_ticks': 99}
        with patch.object(identity, 'proc_identity', return_value={**original, 'start_ticks': 100}), patch.object(identity, 'bounded_file') as read:
            got = identity.process_record(original)
            self.assertFalse(got['identity_matches_observation'])
            read.assert_not_called()
        for exc in (FileNotFoundError(), PermissionError(), ValueError()):
            with self.subTest(exc=type(exc).__name__), patch.object(identity, 'proc_identity', side_effect=exc):
                got = identity.process_record(original)
                self.assertEqual(got['error'], type(exc).__name__)
                self.assertFalse(got['identity_matches_observation'])

    def test_process_reread_and_dynamic_exe_never_opened(self):
        original = {'pid': 42, 'pgrp': 42, 'start_ticks': 99}
        with patch.object(identity, 'proc_identity', side_effect=[{**original, 'ppid': 1}, {**original, 'ppid': 1, 'start_ticks': 100}]), patch.object(identity, 'bounded_file', return_value=(b'\xff\0', {'truncated': False})) as read, patch.object(identity, 'open_parent', return_value=123), patch.object(identity.os, 'close'), patch.object(identity.os, 'readlink', return_value='/untrusted/credential'):
            got = identity.process_record(original)
        self.assertFalse(got['identity_matches_observation'])
        self.assertEqual([c.args[0].name for c in read.call_args_list], ['cmdline', 'cgroup'])
        self.assertEqual(base64.b64decode(got['exe_link']['base64']), b'/untrusted/credential')

    def test_deadline_not_swallowed_by_field_handlers(self):
        with patch.object(identity, 'proc_identity', side_effect=identity.IdentityDeadline), self.assertRaises(identity.IdentityDeadline):
            identity.process_record({'pid': 42, 'pgrp': 42, 'start_ticks': 99})

    def test_process_cap_and_combined_payload_budget(self):
        observation = {'processes': [{'pid': n + 1} for n in range(17)]}
        calls = []
        def read(path, limit):
            calls.append((path, limit))
            return b'x' * limit, {'truncated': False}
        with patch.object(identity, 'unit_record', return_value={}), patch.object(identity, 'process_record', side_effect=lambda x: x), patch.object(identity, 'bounded_file', side_effect=read):
            got = identity.collect(observation, Path('/unused'), time.monotonic() + 10)
        self.assertEqual(len(got['processes']), 16)
        self.assertEqual(got['omitted_process_count'], 1)
        self.assertEqual([limit for _, limit in calls], [1024 * 1024, 0, 0])
        self.assertLess(len(common.encoded(got)), identity.SNAPSHOT_LIMIT)
        self.assertEqual([name for name, _ in calls], [name for name, _ in identity.FIXED_FILES])


class IdentityRetention(unittest.TestCase):
    def test_query_output_overflow_and_interrupt_reap_only_the_query(self):
        cases = [('overflow', 'print("x"*40000,flush=True); time.sleep(30)', ValueError),
                 ('interrupt', 'time.sleep(30)', identity.IdentityDeadline)]
        for mode, body, failure in cases:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as name, ExitStack() as stack:
                root = Path(name)
                argv = [sys.executable, '-c', 'import time; ' + body]
                stack.enter_context(patch.object(identity, 'UNIT_ARGV', argv))
                if mode == 'interrupt':
                    real_run = identity.run
                    def interrupted(*args, **kwargs):
                        def sample(_child):
                            raise identity.IdentityDeadline()
                        return real_run(*args, sample=sample, **kwargs)
                    stack.enter_context(patch.object(identity, 'run', side_effect=interrupted))
                    with self.assertRaises(identity.IdentityDeadline):
                        identity.unit_record(root, time.monotonic() + 10)
                else:
                    got = identity.unit_record(root, time.monotonic() + 10)
                    self.assertEqual(got['error'], failure.__name__)
                    self.assertEqual(got['stdout']['bytes'], 16384)
                command = json.loads((root / 'unit.command.json').read_bytes())
                with self.assertRaises(ProcessLookupError):
                    os.kill(command['child']['pid'], 0)
                self.assertEqual(json.loads((root / 'unit.exit.json').read_bytes())['failure_type'], failure.__name__)

    def test_unit_query_single_bounded_invocation_retains_bytes_on_timeout(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            def run(argv, directory, label, **kwargs):
                self.assertEqual(argv, identity.UNIT_ARGV)
                self.assertEqual(kwargs, {'timeout': 2, 'limit': 16384})
                for suffix, data in [('stdout', b'DropInPaths=/untrusted/secret\n'), ('stderr', b'partial'), ('command.json', b'{"argv":[]}'), ('exit.json', b'{"failure_type":"TimeoutError"}')]:
                    common.write(directory / (label + '.' + suffix), data)
                raise TimeoutError()
            with patch.object(identity, 'run', side_effect=run) as command:
                got = identity.unit_record(root, time.monotonic() + 10)
            command.assert_called_once()
            self.assertEqual(got['error'], 'TimeoutError')
            self.assertEqual(base64.b64decode(got['stdout']['base64']), b'DropInPaths=/untrusted/secret\n')
            with patch.object(identity, 'run') as command:
                self.assertEqual(identity.unit_record(root, time.monotonic() + 1)['error'], 'InsufficientBudget')
                command.assert_not_called()

    def test_atomic_retention_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as name:
            output = Path(name) / 'out'
            output.mkdir()
            with patch.object(identity, 'collect', return_value=context()):
                got = identity.retain(output, {'processes': []}, time.monotonic() + 120)
                first = (output / identity.SNAPSHOT).read_bytes()
                self.assertEqual(got['sha256'], common.digest(first))
                again = identity.retain(output, {'processes': []}, time.monotonic() + 120)
            self.assertEqual(again['error'], 'FileExistsError')
            self.assertEqual((output / identity.SNAPSHOT).read_bytes(), first)
            self.assertEqual([p.name for p in output.iterdir()], [identity.SNAPSHOT])

    def test_serialized_cap_interrupt_and_partial_write_leave_no_export_member(self):
        for failure in ('oversize', 'interrupt', 'write'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as name, ExitStack() as stack:
                output = Path(name) / 'out'
                output.mkdir()
                if failure == 'interrupt':
                    stack.enter_context(patch.object(identity, 'collect', side_effect=KeyboardInterrupt))
                else:
                    stack.enter_context(patch.object(identity, 'collect', return_value={**context(), 'data': 'x' * (identity.SNAPSHOT_LIMIT if failure == 'oversize' else 1)}))
                if failure == 'write':
                    def partial(path, _data):
                        path.write_bytes(b'partial')
                        raise identity.IdentityDeadline()
                    stack.enter_context(patch.object(identity, 'write', side_effect=partial))
                got = identity.retain(output, {'processes': []}, time.monotonic() + 120)
                self.assertIn('error', got)
                self.assertEqual(list(output.iterdir()), [])

    def test_interrupted_cleanup_cannot_poison_export_directory(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            output = root / 'out'
            output.mkdir()
            scratch = root / '.identity-synthetic'
            scratch.mkdir()
            class Scratch:
                def __enter__(self):
                    return str(scratch)
                def __exit__(self, *_args):
                    raise identity.IdentityDeadline()
            with patch.object(identity.tempfile, 'TemporaryDirectory', return_value=Scratch()) as temporary, patch.object(identity, 'collect', return_value=context()):
                got = identity.retain(output, {'processes': []}, time.monotonic() + 120)
            self.assertEqual(temporary.call_args.kwargs['dir'], output.parent)
            self.assertEqual(got['error'], 'IdentityDeadline')
            self.assertTrue((output / identity.SNAPSHOT).is_file())
            self.assertEqual([p.name for p in output.iterdir()], [identity.SNAPSHOT])
            manifest = {'source': {'sha': 'a' * 40}, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY'}
            common.write(output / 'manifest.json', common.encoded(manifest))
            result = {'source': manifest['source'], 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY',
                      'status': 'REFUSED', 'phase': 'native-baseline', 'qa_ready': False,
                      'target_qualified': False, 'install_attempted': False,
                      'failure_type': 'ValueError', 'failure': 'Foreign fixture package writer',
                      'checks': {'refusal_identity': got},
                      'files': {p.name: common.file_hash(p) for p in output.iterdir()}}
            common.write(output / 'result.json', common.encoded(result))
            readback = host.validate_frame(guest.archive(output), manifest)
            self.assertEqual(readback['checks']['refusal_identity']['error'], 'IdentityDeadline')
            self.assertEqual(readback['files'][identity.SNAPSHOT], common.file_hash(output / identity.SNAPSHOT))

    def test_real_deadline_restores_prior_timer_without_extension(self):
        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)
        try:
            signal.setitimer(signal.ITIMER_REAL, 20)
            with tempfile.TemporaryDirectory() as name, patch.object(identity, 'collect', side_effect=lambda *_: time.sleep(0.2)):
                started = time.monotonic()
                got = identity.retain(Path(name), {'processes': []}, started + 0.03)
                elapsed = time.monotonic() - started
                remaining = signal.getitimer(signal.ITIMER_REAL)[0]
            self.assertEqual(got['error'], 'IdentityDeadline')
            self.assertLess(elapsed, 0.15)
            self.assertLess(remaining, 20)
            self.assertGreater(remaining, 19)
            self.assertEqual(signal.getsignal(signal.SIGALRM), previous_handler)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            if previous_timer[0]:
                signal.setitimer(signal.ITIMER_REAL, *previous_timer)


class GuestAndFrame(unittest.TestCase):
    def run_guest(self, mode, capture=None, real_capture=False):
        """Synthetic command results only; every guest effect is replaced."""
        with tempfile.TemporaryDirectory() as name, ExitStack() as stack:
            root = Path(name)
            inp, out = root / 'input', root / 'output'
            inp.mkdir()
            (inp / 'r3-toolchain.lock.json').write_bytes(common.encoded(PINS))
            manifest = {'source': {'sha': 'a' * 40, 'run_id': '123'}, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY'}
            def verify():
                for key, value in [('manifest.json', manifest), ('native-files.json', {}), ('native-state.json', {})]:
                    common.write(out / key, common.encoded(value))
                return manifest
            labels = []
            def run(argv, directory, label, **_kwargs):
                labels.append(label)
                data = b''
                if label == 'arch': data = b'amd64\n'
                elif label == 'os': data = b'ID=ubuntu\nVERSION_ID="24.04"\n'
                elif label in ('before', 'pre-execute'): data = render(baseline()).encode()
                elif label in ('after', 'final'):
                    data = render(installed(PINS, held=(label == 'final' and mode == 'pass')) if mode in ('pass', 'transaction') else baseline()).encode()
                elif label == 'simulate':
                    if mode == 'later-process':
                        _kwargs['sample']()
                    data = ('\n'.join(f"{a} {p['name']} ({p['version']} local [amd64])" for a in ('Inst', 'Conf') for p in PINS['packages']) + '\n').encode()
                elif label.startswith('metadata-'):
                    pin = PINS['packages'][int(label.split('-')[-1])]
                    data = ('\n'.join([pin['name'], pin['version'], 'amd64']) + '\n').encode()
                elif label == 'install':
                    common.write(out / 'transaction.log', (trace(PINS) if mode == 'pass' else '2026-10-22 00:00:00 trigproc man-db:amd64 2.12.0-4build2 <none>\n').encode())
                for suffix, value in [('stdout', data), ('stderr', b''), ('command.json', common.encoded({'argv': argv})), ('exit.json', common.encoded({'returncode': 0, 'failure_type': None, 'stdout_sha256': common.digest(data), 'stderr_sha256': common.digest(b'')}))]:
                    common.write(directory / (label + '.' + suffix), value)
                return data
            observation = fixtures.NativePolicy().observation()
            if mode in ('process', 'pending'):
                observation['processes'] = [{'pid': 42, 'pgrp': 42, 'start_ticks': 99, 'comm': 'unattended-upgr'}]
            if mode == 'pending': observation['units'][guest.UNITS[0]]['Job'] = '7 start'
            def file_hash(path):
                if 'artifacts' in str(path):
                    return next(p['sha256'] for p in PINS['packages'] if str(path).endswith(p['url'].rsplit('/', 1)[-1]))
                return common.file_hash(path)
            class Port(io.BytesIO):
                def close(self): pass
            port = Port()
            for key, value in [('INPUT', inp), ('OUTPUT', out)]: stack.enter_context(patch.object(guest, key, value))
            for key, effect in [('verify_input', verify), ('run', run), ('file_hash', file_hash)]: stack.enter_context(patch.object(guest, key, side_effect=effect))
            for key in ('native_identity', 'native_files'): stack.enter_context(patch.object(guest, key))
            if mode == 'lock':
                stack.enter_context(patch.object(guest, 'observe', side_effect=BlockingIOError('synthetic held lock')))
            elif mode == 'later-process':
                later = {**observation, 'processes': [{'pid': 42, 'pgrp': 42, 'start_ticks': 99}]}
                stack.enter_context(patch.object(guest, 'observe', side_effect=[observation, later]))
            else:
                stack.enter_context(patch.object(guest, 'observe', return_value=observation))
            if real_capture:
                recorder = stack.enter_context(patch.object(guest, 'retain_refusal_identity', wraps=identity.retain))
                previous_handler = signal.getsignal(signal.SIGALRM)
                previous_timer = signal.getitimer(signal.ITIMER_REAL)
                timer_started = time.monotonic()
                def restore_timer():
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    signal.signal(signal.SIGALRM, previous_handler)
                    if previous_timer[0]:
                        signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous_timer[0] - (time.monotonic() - timer_started)), previous_timer[1])
                stack.callback(restore_timer)
            else:
                recorder = stack.enter_context(patch.object(guest, 'retain_refusal_identity', side_effect=capture))
                stack.enter_context(patch.object(guest.signal, 'signal'))
            stack.enter_context(patch.object(guest.signal, 'alarm'))
            stack.enter_context(patch('builtins.open', return_value=port))
            code = guest.main()
            result = host.validate_frame(port.getvalue(), manifest)
            return code, result, labels, recorder.call_count, {p.name: p.read_bytes() for p in out.iterdir()}

    def test_process_refusal_preserved_for_capture_success_failure_and_interrupt(self):
        def capture(out, observation, deadline):
            self.assertEqual(observation['processes'][0]['pid'], 42)
            self.assertGreater(deadline, time.monotonic())
            data = common.encoded(context())
            common.write(out / identity.SNAPSHOT, data)
            return {'file': identity.SNAPSHOT, 'sha256': common.digest(data)}
        for effect in (capture, TimeoutError(), KeyboardInterrupt(), identity.IdentityDeadline()):
            with self.subTest(effect=type(effect).__name__):
                code, result, labels, calls, files = self.run_guest('process', effect)
                self.assertEqual(code, 1)
                self.assertEqual(calls, 1)
                self.assertEqual(result['failure'], 'Foreign fixture package writer')
                self.assertEqual(result['failure_type'], 'ValueError')
                self.assertEqual(result['status'], 'REFUSED')
                self.assertEqual(result['phase'], 'native-baseline')
                self.assertFalse(result['install_attempted'])
                self.assertFalse(set(labels) & {'simulate', 'install', 'holds', 'pre-execute'})
                self.assertTrue(set(('after', 'final', 'audit-post', 'audit-final')) <= set(labels))
                if callable(effect): self.assertEqual(result['files'][identity.SNAPSHOT], common.digest(files[identity.SNAPSHOT]))
                else: self.assertNotIn(identity.SNAPSHOT, files)

    def test_no_capture_on_success_pending_unit_or_later_transaction_refusal(self):
        for mode in ('pass', 'pending', 'transaction', 'later-process', 'lock'):
            with self.subTest(mode=mode):
                code, result, _, calls, files = self.run_guest(mode, AssertionError('unexpected capture'))
                self.assertEqual(calls, 0)
                self.assertNotIn(identity.SNAPSHOT, files)
                if mode == 'pass':
                    self.assertEqual(code, 0)
                    self.assertEqual(set(files), guest.GUEST_REQUIRED_FILES)
                    self.assertEqual(result['status'], 'DIAGNOSTIC_PASS_REVIEW_REQUIRED')
                else:
                    self.assertEqual(code, 1)
                    self.assertEqual(result['status'], 'REFUSED')
                    self.assertEqual(result['phase'], {'pending': 'native-baseline', 'transaction': 'installation', 'later-process': 'simulation', 'lock': 'native-baseline'}[mode])
                    if mode == 'lock':
                        self.assertEqual(result['failure_type'], 'BlockingIOError')
                        self.assertEqual(json.loads(files['observations.json']), [])

    def test_real_retention_collection_export_and_readback_with_synthetic_native_inputs(self):
        # Keep the actual collector, query transport, retention, archive and host
        # validator connected. Only native inputs/argv are replaced locally.
        with tempfile.TemporaryDirectory() as name, ExitStack() as stack:
            root = Path(name).resolve()
            proc = root / 'proc' / '42'
            proc.mkdir(parents=True)
            (proc / 'stat').write_bytes(b'42 (unattended-upgr) S 1 42 ' + b'0 ' * 16 + b'99 0\n')
            (proc / 'cmdline').write_bytes(b'/usr/bin/python3\0/untrusted/entrypoint\0\xff\0')
            (proc / 'cgroup').write_bytes(b'0::/system.slice/unattended-upgrades.service\n')
            dynamic = root / 'must-not-read'
            dynamic.write_bytes(b'not part of the public-file allowlist')
            (proc / 'exe').symlink_to(dynamic)
            fixed = root / 'fixed-unit'
            fixed.write_bytes(b'[Service]\nExecStart=/untrusted/entrypoint\n')
            unit_stdout = f'MainPID=42\nDropInPaths={dynamic}\nExecStart=/untrusted/entrypoint\n'
            stack.enter_context(patch.object(identity, 'UNIT_ARGV', [sys.executable, '-c', 'print(' + repr(unit_stdout) + ',end="")']))
            stack.enter_context(patch.object(identity, 'FIXED_FILES', ((str(fixed), 1024),)))
            actual_parent = identity.open_parent
            paths = []
            def parent(path):
                path = Path(path)
                paths.append(path)
                if path.parts[:3] == ('/', 'proc', '42'):
                    return actual_parent(proc / path.name)
                return actual_parent(path)
            stack.enter_context(patch.object(identity, 'open_parent', side_effect=parent))
            try:
                code, result, labels, calls, files = self.run_guest('process', real_capture=True)
            except Exception as exc:
                self.fail(f'Real retention/export chain lost the refusal: {type(exc).__name__}: {exc}')
            self.assertEqual((code, calls), (1, 1))
            self.assertEqual(result['status'], 'REFUSED')
            self.assertEqual(result['phase'], 'native-baseline')
            self.assertEqual(result['failure'], 'Foreign fixture package writer')
            self.assertEqual(result['failure_type'], 'ValueError')
            self.assertFalse(result['install_attempted'])
            self.assertFalse(set(labels) & {'simulate', 'pre-execute', 'install', 'holds'})
            self.assertFalse(any(name.startswith('unit.') for name in files))
            snapshot = json.loads(files[identity.SNAPSHOT])
            self.assertEqual(result['files'][identity.SNAPSHOT], common.digest(files[identity.SNAPSHOT]))
            self.assertEqual(result['checks']['refusal_identity']['sha256'], result['files'][identity.SNAPSHOT])
            self.assertEqual(base64.b64decode(snapshot['unit']['stdout']['base64']), unit_stdout.encode())
            self.assertEqual(json.loads(base64.b64decode(snapshot['unit']['exit.json']['base64']))['returncode'], 0)
            process = snapshot['processes'][0]
            self.assertTrue(process['identity_matches_observation'])
            self.assertEqual(process['before'], process['after'])
            self.assertEqual(base64.b64decode(process['cmdline']['base64']), (proc / 'cmdline').read_bytes())
            self.assertEqual(base64.b64decode(process['exe_link']['base64']), os.fsencode(dynamic))
            self.assertEqual(snapshot['fixed_files'][str(fixed)]['sha256'], common.digest(fixed.read_bytes()))
            allowed = {Path('/proc/42') / name for name in ('stat', 'cmdline', 'cgroup', 'exe')} | {fixed}
            self.assertEqual(set(paths), allowed)
            self.assertNotIn(dynamic, paths)

    def test_success_without_snapshot_remains_valid_but_missing_required_or_extra_snapshot_refuses(self):
        _, _, _, _, files = self.run_guest('pass', AssertionError('unexpected capture'))
        fixture = fixtures.FrameValidation()
        fixture.setUp()
        fixture.result = json.loads(files['result.json'])
        fixture.manifest = json.loads(files['manifest.json'])
        fixture.entries = {k: v for k, v in files.items() if k != 'result.json'}
        self.assertEqual(host.validate_frame(fixture.frame(), fixture.manifest)['status'], 'DIAGNOSTIC_PASS_REVIEW_REQUIRED')
        for missing in ('native-files.json', 'observations.json', 'holds.exit.json'):
            saved = fixture.entries.pop(missing)
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, 'Incomplete native pass'):
                host.validate_frame(fixture.frame(), fixture.manifest)
            fixture.entries[missing] = saved
        fixture.entries[identity.SNAPSHOT] = common.encoded(context())
        with self.assertRaises(ValueError):
            host.validate_frame(fixture.frame(), fixture.manifest)

    def test_optional_frame_member_limit_and_refusal_binding(self):
        test = fixtures.FrameValidation()
        test.setUp()
        test.result.update({'phase': 'native-baseline', 'install_attempted': False, 'failure_type': 'ValueError', 'failure': 'Foreign fixture package writer'})
        self.assertEqual(host.validate_frame(test.frame(), test.manifest)['status'], 'REFUSED')
        test.entries[identity.SNAPSHOT] = common.encoded(context())
        self.assertEqual(host.validate_frame(test.frame(), test.manifest)['status'], 'REFUSED')
        for change in ({'phase': 'installation'}, {'status': 'DIAGNOSTIC_PASS_REVIEW_REQUIRED'}, {'install_attempted': True},
                       {'failure_type': 'TimeoutError'}, {'failure': 'Pending package unit job'}):
            old = dict(test.result)
            test.result.update(change)
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'Identity context is only valid'):
                host.validate_frame(test.frame(), test.manifest)
            test.result = old
        for change in ({'format': 2}, {'purpose': 'UNREVIEWED'}, {'identity_proves_inactivity': True}):
            test.entries[identity.SNAPSHOT] = common.encoded({**context(), **change})
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'Identity context is only valid'):
                host.validate_frame(test.frame(), test.manifest)
        # A valid positive-boundary document distinguishes the member cap from
        # JSON/schema refusal; one byte over must fail before JSON parsing.
        value = {**context(), 'padding': ''}
        overhead = len(common.encoded(value))
        value['padding'] = 'x' * (identity.SNAPSHOT_LIMIT - overhead)
        test.entries[identity.SNAPSHOT] = common.encoded(value)
        self.assertEqual(len(test.entries[identity.SNAPSHOT]), identity.SNAPSHOT_LIMIT)
        self.assertEqual(host.validate_frame(test.frame(), test.manifest)['status'], 'REFUSED')
        value['padding'] += 'x'
        test.entries[identity.SNAPSHOT] = common.encoded(value)
        with self.assertRaisesRegex(ValueError, 'Unexpected native evidence archive member'):
            host.validate_frame(test.frame(), test.manifest)

    def test_snapshot_bytes_bound_by_manifest(self):
        test = fixtures.FrameValidation()
        test.setUp()
        test.entries[identity.SNAPSHOT] = common.encoded(context())
        original_digest = host.digest
        with patch.object(host, 'digest', side_effect=lambda data: '0' * 64 if data == test.entries[identity.SNAPSHOT] else original_digest(data)), self.assertRaisesRegex(ValueError, 'manifest differs'):
            host.validate_frame(test.frame(), test.manifest)

    def test_helper_is_staged_and_required_set_unchanged(self):
        self.assertIn('r3_noble_identity.py', inputs.HELPERS)
        self.assertEqual(len(guest.GUEST_REQUIRED_FILES), 102)
        self.assertEqual(guest.GUEST_FILES - guest.GUEST_REQUIRED_FILES, {identity.SNAPSHOT})


if __name__ == '__main__':
    unittest.main()
