"""Local controller/transport negatives. These never qualify native Noble/APT."""
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_noble_common as common
import r3_noble_fixture as host
import r3_noble_guest as guest
import r3_noble_inputs as inputs
import r3_toolchain as toolchain

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / 'infra/selfhost/r3-noble-fixture.lock.json').read_text())
PINS = json.loads((ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_text())


class BoundedCommands(unittest.TestCase):
    def test_capture_and_no_payload_file_limit(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            payload = root / 'payload'
            script = 'from pathlib import Path; Path(' + repr(str(payload)) + ').write_bytes(b"x"*10000); print("ok")'
            self.assertEqual(common.run([sys.executable, '-c', script], root, 'cmd', limit=100), b'ok\n')
            self.assertEqual(payload.stat().st_size, 10000)
            result = json.loads((root / 'cmd.exit.json').read_bytes())
            self.assertEqual(result['returncode'], 0)
            self.assertIsNone(result['failure_type'])

    def test_nonzero_retains_both_streams(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            with self.assertRaises(ValueError):
                common.run([sys.executable, '-c', 'import sys; print("out"); print("err",file=sys.stderr);sys.exit(7)'], root, 'cmd')
            self.assertEqual((root / 'cmd.stdout').read_bytes(), b'out\n')
            self.assertEqual((root / 'cmd.stderr').read_bytes(), b'err\n')
            self.assertEqual(json.loads((root / 'cmd.exit.json').read_bytes())['returncode'], 7)

    def test_output_overflow_refuses_and_retains_bounded_prefix(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            with self.assertRaises(ValueError):
                common.run([sys.executable, '-c', 'print("x"*10000)'], root, 'cmd', limit=100)
            self.assertEqual((root / 'cmd.stdout').stat().st_size, 100)
            self.assertEqual(json.loads((root / 'cmd.exit.json').read_bytes())['failure_type'], 'ValueError')

    def test_timeout_kills_and_reaps_group(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            with self.assertRaises(TimeoutError):
                common.run([sys.executable, '-c', 'import time; time.sleep(30)'], root, 'cmd', timeout=0.1)
            identity = json.loads((root / 'cmd.command.json').read_bytes())['child']
            with self.assertRaises(ProcessLookupError):
                os.kill(identity['pid'], 0)
            self.assertEqual(json.loads((root / 'cmd.exit.json').read_bytes())['failure_type'], 'TimeoutError')

    def test_sampler_refusal_records_failure(self):
        with tempfile.TemporaryDirectory() as name:
            def refuse(_):
                raise ValueError('foreign writer')
            with self.assertRaises(ValueError):
                common.run([sys.executable, '-c', 'import time; time.sleep(30)'], Path(name), 'cmd', sample=refuse)
            self.assertEqual(json.loads((Path(name) / 'cmd.exit.json').read_bytes())['failure_type'], 'ValueError')

    def test_read_refuses_link_and_oversize(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / 'data').write_bytes(b'123')
            (root / 'link').symlink_to(root / 'data')
            with self.assertRaises(OSError):
                common.read(root / 'link')
            with self.assertRaises(ValueError):
                common.read(root / 'data', 2)


class NativePolicy(unittest.TestCase):
    def observation(self):
        return {'units': {name: {'Id': name, 'Job': '', 'ActiveState': 'active'} for name in guest.UNITS},
                'processes': [], 'locks_probed': True}

    def test_original_unit_state_is_observed_not_masked_or_production_qualified(self):
        guest.fixture_observation(self.observation())
        import r3_apt_observer
        with self.assertRaises((KeyError, ValueError)):
            r3_apt_observer.validate(self.observation())

    def test_exact_empty_job_required(self):
        for job in ('0', '0 /', '22 start'):
            value = self.observation()
            value['units'][guest.UNITS[0]]['Job'] = job
            with self.subTest(job=job), self.assertRaises(ValueError):
                guest.fixture_observation(value)

    def test_unit_change_refused(self):
        value = self.observation()
        value['units'][guest.UNITS[0]]['ActiveState'] = 'inactive'
        with self.assertRaises(ValueError):
            guest.fixture_observation(value, self.observation())

    def test_foreign_group_and_reused_child_refused(self):
        value = self.observation()
        value['processes'] = [{'pid': 42, 'pgrp': 42}]
        child = {'pid': 55, 'pgrp': 55, 'start_ticks': 10}
        with self.assertRaises(ValueError):
            guest.fixture_observation(value, child=child)
        value['processes'] = []
        with patch.object(guest, 'process_identity', return_value={**child, 'start_ticks': 11}), self.assertRaises(ValueError):
            guest.fixture_observation(value, child=child)

    def test_pure_simulation_parser_keeps_strict_nonpin_refusal(self):
        output = '\n'.join(f"{action} {p['name']} ({p['version']} local [amd64])" for action in ('Inst', 'Conf') for p in PINS['packages']) + '\n'
        self.assertEqual(toolchain.validate_dependency_plan(PINS, output), output)
        for extra in ('Processing triggers for man-db', 'Inst man-db (2.0 local [amd64])', 'Remv vim [1]'):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                toolchain.validate_dependency_plan(PINS, output + extra + '\n')
        with patch.object(toolchain, 'capture', return_value=output):
            self.assertEqual(toolchain.dependency_plan(PINS, ['x']), output)

    def test_simulation_and_install_keep_no_pty(self):
        for simulate in (True, False):
            args = toolchain.install_argv(['a.deb'], simulate=simulate)
            self.assertIn('Dpkg::Use-Pty=0', args)
            self.assertIn('--no-download', args)
            self.assertNotIn('--no-triggers', args)


class FrameValidation(unittest.TestCase):
    def setUp(self):
        self.manifest = {'source': {'sha': 'a' * 40, 'run_id': '123'}, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY'}
        self.entries = {'manifest.json': common.encoded(self.manifest), 'observations.json': b'[]'}
        self.result = {'source': self.manifest['source'], 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY',
                       'qa_ready': False, 'target_qualified': False, 'status': 'REFUSED'}

    def frame(self, mutate=None):
        entries = dict(self.entries)
        result = dict(self.result)
        result['files'] = {k: common.digest(v) for k, v in entries.items()}
        entries['result.json'] = common.encoded(result)
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode='w') as tar:
            for name, data in entries.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                if mutate:
                    mutate(info)
                tar.addfile(info, io.BytesIO(data))
        data = out.getvalue()
        return b'R3NOBLE1\n' + len(data).to_bytes(8, 'big') + data + common.digest(data).encode() + b'\n'

    def test_refusal_is_valid_evidence_not_success(self):
        result = host.validate_frame(self.frame(), self.manifest)
        self.assertEqual(result['status'], 'REFUSED')

    def test_frame_corruption_truncation_and_tail_refused(self):
        data = self.frame()
        for bad in (b'x' + data[1:], data[:-1], data + b'x', data[:-65] + b'0' * 64 + b'\n'):
            with self.subTest(size=len(bad)), self.assertRaises(ValueError):
                host.validate_frame(bad, self.manifest)

    def test_wrong_source_and_run_refused(self):
        with self.assertRaises(ValueError):
            host.validate_frame(self.frame(), {**self.manifest, 'source': {'sha': 'b' * 40}})

    def test_path_escape_unexpected_file_link_and_duplicate_refused(self):
        for change in ('escape', 'extra', 'link', 'duplicate'):
            def mutate(info):
                if change == 'escape':
                    info.name = '../' + info.name
                elif change == 'extra':
                    info.name = 'unapproved.txt'
                elif change == 'link':
                    info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
                else:
                    info.name = 'manifest.json'
            with self.subTest(change=change), self.assertRaises(ValueError):
                host.validate_frame(self.frame(mutate), self.manifest)

    def test_incomplete_pass_and_target_claim_refused(self):
        for change in ({'status': 'DIAGNOSTIC_PASS_REVIEW_REQUIRED'}, {'qa_ready': True}, {'target_qualified': True}):
            self.result.update(change)
            with self.assertRaises(ValueError):
                host.validate_frame(self.frame(), self.manifest)
            self.setUp()

    def test_export_allowlist(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for key, value in self.entries.items():
                (root / key).write_bytes(value)
            result = {**self.result, 'files': {k: common.digest(v) for k, v in self.entries.items()}}
            (root / 'result.json').write_bytes(common.encoded(result))
            self.assertEqual(host.validate_frame(guest.archive(root), self.manifest)['status'], 'REFUSED')
            (root / 'raw-secret').write_bytes(b'x')
            with self.assertRaises(ValueError):
                guest.archive(root)


class InputAndWorkflow(unittest.TestCase):
    def test_recipient_hash_normalization_and_syntax(self):
        key = 'ssh-ed25519 YWJj'
        expected = common.digest((key + '\n').encode())
        self.assertEqual(inputs.recipient('  ' + key + '\n', expected), (key + '\n').encode())
        for invalid in (key + ' comment', '/tmp/key', 'age-plugin-foo abc', 'ssh-rsa @@@'):
            with self.subTest(invalid=invalid), self.assertRaises((ValueError, Exception)):
                inputs.recipient(invalid, expected)
        with self.assertRaises(ValueError):
            inputs.recipient(key, '0' * 64)

    def test_seed_is_public_readonly_and_no_service_changes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name) / 'seed'
            inputs.seed(root, {'run_id': '123'})
            value = json.loads((root / 'user-data').read_text().split('\n', 1)[1])
            self.assertEqual(value['runcmd'][1], ['mount', '-o', 'ro', '/dev/disk/by-label/R3INPUT', '/mnt/r3-input'])
            self.assertEqual(value['runcmd'][-1][0:3], ['/usr/bin/python3', '-I', '-B'])
            self.assertEqual(set(value), {'runcmd'})

    def test_qemu_has_no_network_host_mounts_or_monitor(self):
        args = host.qemu_argv(Path('/tmp/private'), LOCK)
        self.assertEqual(args[args.index('-nic') + 1], 'none')
        self.assertEqual(args[args.index('-monitor') + 1], 'none')
        self.assertEqual(args[args.index('-machine') + 1], 'q35,accel=tcg')
        self.assertFalse(set(args) & {'-virtfs', '-fsdev', '-netdev', '-nographic'})
        self.assertEqual(sum('readonly=on' in arg for arg in args), 2)

    def test_workflow_manual_no_credentials_no_plaintext_upload(self):
        import yaml
        value = yaml.safe_load((ROOT / inputs.WORKFLOW).read_text())
        self.assertEqual(set(value.get('on', value.get(True))), {'workflow_dispatch'})
        self.assertEqual(value['permissions'], {'contents': 'read'})
        job = value['jobs']['native-noble']
        self.assertEqual(job['runs-on'], 'ubuntu-24.04')
        self.assertIn('github.run_attempt == 1', job['if'])
        self.assertFalse(job['steps'][0]['with']['persist-credentials'])
        upload = job['steps'][-1]['with']
        self.assertEqual(upload['retention-days'], 7)
        self.assertEqual({line.rsplit('/', 1)[-1] for line in upload['path'].splitlines()},
                         {'fixture-evidence.tar.age', 'binding.json', 'summary.json'})
        self.assertNotIn('secrets.', (ROOT / inputs.WORKFLOW).read_text())

    def test_source_refuses_rerun_wrong_workflow_selfhosted_or_source(self):
        env = {'R3_SOURCE_SHA': 'a' * 40, 'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKFLOW_SHA': 'a' * 40,
               'GITHUB_REF': 'refs/heads/approved', 'GITHUB_REPOSITORY': 'owner/repo',
               'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_RUN_ID': '12',
               'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
               'GITHUB_WORKFLOW_REF': 'owner/repo/' + inputs.WORKFLOW + '@refs/heads/approved'}
        for key, bad in (('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_WORKFLOW_SHA', 'b' * 40),
                         ('RUNNER_ENVIRONMENT', 'self-hosted'), ('RUNNER_ARCH', 'ARM64'),
                         ('GITHUB_WORKFLOW_REF', 'unapproved'), ('GITHUB_EVENT_NAME', 'pull_request')):
            with self.subTest(key=key), patch.object(host, 'git') as git, self.assertRaises(ValueError):
                host.source_binding({**env, key: bad})
            git.assert_not_called()


class VmTransport(unittest.TestCase):
    def test_real_socket_transport_and_teardown(self):
        with tempfile.TemporaryDirectory(prefix='r3test-', dir='/tmp') as name:
            work = Path(name)
            raw = work / 'raw'
            raw.mkdir()
            frame = b'R3NOBLE1\n' + (3).to_bytes(8, 'big') + b'abc' + common.digest(b'abc').encode() + b'\n'
            script = ('import socket,time; s=socket.socket(socket.AF_UNIX); s.connect(' + repr(str(work / 'evidence.sock')) + ');'
                      's.sendall(' + repr(frame) + ');time.sleep(30)')
            with patch.object(host, 'qemu_argv', return_value=[sys.executable, '-c', script]):
                self.assertEqual(host.vm(work, raw, LOCK, timeout=5), frame)
            self.assertEqual((raw / 'evidence.bin').read_bytes(), frame)
            self.assertEqual(json.loads((raw / 'qemu.exit.json').read_bytes())['returncode'], -signal.SIGKILL)

    def test_vm_deadline_retains_output(self):
        with tempfile.TemporaryDirectory(prefix='r3test-', dir='/tmp') as name:
            work = Path(name)
            raw = work / 'raw'
            raw.mkdir()
            with patch.object(host, 'qemu_argv', return_value=[sys.executable, '-c', 'import time; print("started",flush=True);time.sleep(30)']), self.assertRaises(TimeoutError):
                host.vm(work, raw, LOCK, timeout=0.3)
            self.assertEqual((raw / 'qemu-stdout.log').read_bytes(), b'started\n')
            self.assertEqual(json.loads((raw / 'qemu.exit.json').read_bytes())['returncode'], -signal.SIGKILL)


class LifecycleFailures(unittest.TestCase):
    def test_partial_export_writes_every_byte_and_refuses_no_progress(self):
        class Partial:
            def __init__(self):
                self.data = bytearray()
            def write(self, data):
                count = min(7, len(data))
                self.data.extend(data[:count])
                return count
        port = Partial()
        guest.write_all(port, b'abc' * 100)
        self.assertEqual(port.data, b'abc' * 100)
        with patch.object(port, 'write', return_value=0), self.assertRaises(ValueError):
            guest.write_all(port, b'a')

    def test_cleanup_failure_retains_exit(self):
        with tempfile.TemporaryDirectory() as name:
            with patch.object(common, 'kill_group', side_effect=PermissionError('denied')), self.assertRaises(PermissionError):
                common.run([sys.executable, '-c', 'print(1)'], Path(name), 'cmd')
            self.assertEqual(json.loads((Path(name) / 'cmd.exit.json').read_bytes())['failure_type'], 'PermissionError')

    def test_privileged_residual_group_is_not_reported_clean(self):
        from unittest.mock import Mock
        child = Mock(pid=123)
        with patch.object(common.subprocess, 'run', return_value=Mock(returncode=1)), patch.object(common.os, 'killpg', side_effect=PermissionError), self.assertRaises(ValueError):
            common.kill_group(child, privileged=True)
        child.wait.assert_called_once_with(timeout=5)

    def test_native_man_db_transaction_refuses_before_holds_and_exports_actual_state(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            inp, out = root / 'input', root / 'output'
            inp.mkdir()
            (inp / 'r3-toolchain.lock.json').write_text(json.dumps(PINS))
            manifest = {'source': {'sha': 'a' * 40, 'run_id': '123'}, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY'}
            def verify():
                common.write(out / 'manifest.json', common.encoded(manifest))
                return manifest
            def row(name, version, status='install ok installed'):
                return '\t'.join([name, 'amd64', version, status, 'no', '', '', '']) + '\n'
            before = row('man-db', '2.12.0-4build2')
            after = before + ''.join(row(p['name'], p['version']) for p in PINS['packages'])
            simulation = '\n'.join(f"{action} {p['name']} ({p['version']} local [amd64])" for action in ('Inst', 'Conf') for p in PINS['packages']) + '\n'
            labels = []
            def run(argv, directory, label, **_kwargs):
                labels.append(label)
                data = b''
                if label == 'arch':
                    data = b'amd64\n'
                elif label == 'os':
                    data = b'ID=ubuntu\nVERSION_ID="24.04"\n'
                elif label in ('before', 'pre-execute'):
                    data = before.encode()
                elif label in ('after', 'final'):
                    data = after.encode()
                elif label == 'simulate':
                    data = simulation.encode()
                elif label.startswith('metadata-'):
                    pin = PINS['packages'][int(label.split('-')[-1])]
                    data = ('\n'.join([pin['name'], pin['version'], 'amd64']) + '\n').encode()
                elif label == 'install':
                    common.write(out / 'transaction.log', b'2026-10-22 00:00:00 trigproc man-db:amd64 2.12.0-4build2 <none>\n')
                common.write(directory / (label + '.stdout'), data)
                common.write(directory / (label + '.stderr'), b'')
                common.write(directory / (label + '.command.json'), common.encoded({'argv': argv}))
                common.write(directory / (label + '.exit.json'), common.encoded({'returncode': 0}))
                return data
            class Port(io.BytesIO):
                def close(self):
                    pass
            port = Port()
            observation = NativePolicy().observation()
            def archive_hash(path):
                if 'artifacts' in str(path):
                    return next(p['sha256'] for p in PINS['packages'] if str(path).endswith(p['url'].rsplit('/', 1)[-1]))
                return common.file_hash(path)
            with patch.object(guest, 'INPUT', inp), patch.object(guest, 'OUTPUT', out), patch.object(guest, 'verify_input', side_effect=verify), patch.object(guest, 'run', side_effect=run), patch.object(guest, 'file_hash', side_effect=archive_hash), patch.object(guest, 'native_identity'), patch.object(guest, 'native_files'), patch.object(guest, 'observe', return_value=observation), patch.object(guest.signal, 'alarm'), patch.object(guest.signal, 'signal'), patch('builtins.open', return_value=port):
                self.assertEqual(guest.main(), 1)
            result = host.validate_frame(port.getvalue(), manifest)
            self.assertEqual(result['status'], 'REFUSED')
            self.assertTrue(result['install_attempted'])
            self.assertEqual(result['phase'], 'installation')
            self.assertIn('Unexpected dpkg transaction package', result['failure'])
            self.assertNotIn('holds', labels)
            for label in ('after', 'final', 'audit-post', 'audit-final'):
                self.assertIn(label, labels)
            self.assertEqual((out / 'final.stdout').read_text(), after)
            self.assertIn('holds', result['not_reached'])

    def test_controller_failure_seals_only_allowlisted_public_outputs(self):
        from contextlib import ExitStack
        for seal_ok in (True, False):
            with self.subTest(seal_ok=seal_ok), tempfile.TemporaryDirectory() as name, ExitStack() as stack:
                root = Path(name)
                work = root / 'work'
                work.mkdir()
                source = {'sha': 'a' * 40, 'ref': 'refs/heads/test', 'run_id': '123', 'job': 'native-noble',
                          'workflow_sha256': 'b' * 64}
                key = 'ssh-ed25519 YWJj'
                stack.enter_context(patch.dict(os.environ, {'RUNNER_TEMP': str(root), 'R3_RECIPIENT': key,
                    'R3_RECIPIENT_SHA256': common.digest((key + '\n').encode())}, clear=True))
                stack.enter_context(patch.object(host, 'source_binding', return_value=source))
                stack.enter_context(patch.object(host.tempfile, 'mkdtemp', return_value=str(work)))
                stack.enter_context(patch.object(host, 'stage_age'))
                stack.enter_context(patch.object(host, 'run', side_effect=TimeoutError('runner tools')))
                stack.enter_context(patch.object(host.signal, 'signal'))
                def seal(_work, raw, publish, binding):
                    common.write(publish / 'fixture-evidence.tar.age', b'ciphertext')
                    if not seal_ok:
                        raise ValueError('seal failed')
                    self.assertTrue((raw / 'controller-failure.json').is_file())
                    return {'ciphertext_sha256': common.digest(b'ciphertext')}
                stack.enter_context(patch.object(host, 'seal', side_effect=seal))
                self.assertEqual(host.main(), 1)
                public = root / 'r3-noble-publish'
                self.assertEqual({p.name for p in public.iterdir()}, {'binding.json', 'summary.json'} | ({'fixture-evidence.tar.age'} if seal_ok else set()))
                summary = json.loads((public / 'summary.json').read_bytes())
                self.assertEqual(summary['status'], 'REFUSED')
                self.assertEqual(summary['sealed'], seal_ok)
                self.assertFalse(summary['target_qualified'])
                self.assertTrue((root / 'r3-noble-consumed-123').is_file())


if __name__ == '__main__':
    unittest.main()
