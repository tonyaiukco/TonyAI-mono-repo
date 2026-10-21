"""Execute the installer against a rebased temporary filesystem; no privileged commands run."""
from contextlib import ExitStack, redirect_stdout
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch, Mock

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from r3_artifacts import sha
from r3_toolchain import install_argv
from r3_package_state import INVENTORY_ARGV
import r3_apt_observer as observer
from r3_package_fixtures import baseline, installed, render, trace, observation


class Harness:
    def __init__(self, root, fault=None):
        root = root.resolve()
        self.root, self.fault, self.calls = root, fault, []
        self.inventory_calls = 0
        self.observation_calls = 0
        self.bundle = root / 'var/lib/tonyai-r3/r3'; self.helpers = self.bundle / 'helpers'
        for name in ('etc/tonyai', 'etc/systemd/system', 'run/systemd/system', 'usr/sbin', 'usr/bin', 'opt'):
            (root / name).mkdir(parents=True)
        self.helpers.mkdir(parents=True)
        for name in ('r3_toolchain.py', 'r3_artifacts.py', 'r3_package_state.py', 'r3_apt_observer.py', 'replacement_host.py', 'replacement_bundle.py', 'replacement-source-layout.json'):
            shutil.copyfile(SCRIPTS / name, self.helpers / name)
        source = (SCRIPTS / 'r3_install.py').read_text()
        source = re.sub(r"'/(etc|usr|opt|var|run)/", lambda m: "'" + str(root) + '/' + m.group(1) + '/', source)
        self.source = self.helpers / 'r3_install.py'; self.source.write_text(source)
        self.module = types.ModuleType('rebased_install'); self.module.__file__ = str(self.source)
        exec(compile(source, str(self.source), 'exec'), self.module.__dict__)
        self.lock = json.loads((SCRIPTS.parent / 'selfhost/r3-toolchain.lock.json').read_bytes())
        (self.bundle / 'artifacts').mkdir()
        self.node = self.bundle / 'artifacts' / self.lock['node']['url'].rsplit('/', 1)[1]
        self.archive(fault)
        (self.bundle / 'r3-toolchain.lock.json').write_text(json.dumps(self.lock))
        (self.bundle / 'manifest.json').write_text('{"fixture": true}')
        self.contract = root / 'contract.json'; self.contract.write_text('{"fixture": true}'); self.contract.chmod(0o600)
        h = lambda name: sha((self.helpers / name).read_bytes())
        self.approval = {'format': 2, 'action': 'r02-offline-toolchain-install', 'contract_sha256': sha(self.contract.read_bytes()),
            'manifest_sha256': sha((self.bundle / 'manifest.json').read_bytes()), 'installer_sha256': h('r3_install.py'),
            'package_state_sha256': h('r3_package_state.py'), 'apt_observer_sha256': h('r3_apt_observer.py'),
            'toolchain_verifier_sha256': h('r3_toolchain.py'), 'artifact_verifier_sha256': h('r3_artifacts.py'),
            'toolchain_lock_sha256': sha((self.bundle / 'r3-toolchain.lock.json').read_bytes()),
            'host_guard_sha256': h('replacement_host.py'), 'bundle_helper_sha256': h('replacement_bundle.py'),
            'layout_sha256': h('replacement-source-layout.json')}
        if fault and fault.startswith('binding:'): self.approval[fault.split(':', 1)[1]] = 'tampered'
        self.approval_path = root / 'approval.json'; self.approval_path.write_text(json.dumps(self.approval)); self.approval_path.chmod(0o600)
        self.approved = sha(self.approval_path.read_bytes())
        self.paths = [str(self.bundle / 'artifacts' / p['url'].rsplit('/', 1)[1]) for p in self.lock['packages']]
        if fault and fault.startswith('existing:'):
            path = root / fault.split(':', 1)[1]; path.parent.mkdir(parents=True, exist_ok=True); path.touch()
        if fault == 'broken-mask': (root / 'run/systemd/system/docker.socket').symlink_to('/absent')
        if fault == 'helper-location': self.module.__file__ = str(root / 'other/r3_install.py'); shutil.copytree(self.helpers, root / 'other')

    def archive(self, fault):
        root = 'node-v22.23.3-linux-x64'
        with tarfile.open(self.node, 'w:xz') as archive:
            def add(name, kind=tarfile.REGTYPE, link='', mode=0o755):
                member = tarfile.TarInfo(name); member.type = kind; member.linkname = link; member.mode = mode
                data = b'fixture executable' if kind == tarfile.REGTYPE else b''; member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if fault != 'files-only':
                add(root + '/', tarfile.DIRTYPE); add(root + '/bin/', tarfile.DIRTYPE)
            add(root + '/bin/node')
            add(root + '/bin/npm', tarfile.SYMTYPE, '../lib/npm.js')
            if fault == 'foreign-root': add('foreign/entry')
            if fault == 'absolute': add('/outside')
            if fault == 'traversal': add(root + '/../outside')
            if fault == 'symlink': add(root + '/escape', tarfile.SYMTYPE, '../../outside')
            if fault == 'hardlink': add(root + '/escape', tarfile.LNKTYPE, 'outside')
            if fault == 'fifo': add(root + '/pipe', tarfile.FIFOTYPE)
            if fault == 'file-root': add(root)

    def safe_path(self, path, directory=False):
        self.calls.append(('safe', str(path), directory))
        if self.fault == 'unsafe-root' or self.fault == 'unsafe-entry' and Path(path) == self.node:
            raise ValueError('Unsafe root-owned path chain.')
        return Path(path)

    def capture(self, argv):
        self.calls.append(tuple(argv))
        if argv == INVENTORY_ARGV:
            self.inventory_calls += 1
            n = self.inventory_calls
            rows = baseline() if n <= 2 else installed(self.lock, held=n >= 4)
            if self.fault == 'man-db-trigger':
                rows['man-db:amd64'] = {**rows['base:amd64'], 'name': 'man-db', 'version': '2.12.0-4build2', 'essential': ''}
            if self.fault == 'pre-inventory-change' and n == 2: rows['base:amd64']['version'] = '2'
            if self.fault == 'unrelated-inventory' and n == 3: rows['base:amd64']['depends'] = 'different'
            if self.fault == 'final-inventory' and n == 4: rows['base:amd64']['status'] = 'hold ok installed'
            if self.fault == 'pin-metadata-change' and n == 4: rows[self.lock['packages'][0]['name'] + ':amd64']['depends'] = 'different'
            if self.fault == 'missing-hold' and n == 4: rows = installed(self.lock)
            return render(rows)
        if argv == ['dpkg', '--audit']:
            return 'pending package' if self.fault == 'pending-package' else ''
        if argv[:2] == ['systemctl', 'mask']:
            if self.fault != 'mask-missing':
                for service in argv[2:]:
                    directory = 'run' if '--runtime' in argv else 'etc'
                    (self.root / directory / 'systemd/system' / service).symlink_to('/dev/null')
            return ''
        if argv[0] == 'dpkg-query':
            item = next(p for p in self.lock['packages'] if p['name'] == argv[-1])
            fields = [item['name'], item['version'], 'amd64', 'installed']
            if self.fault in ('version', 'arch', 'status'): fields[{'version': 1, 'arch': 2, 'status': 3}[self.fault]] = 'wrong'
            return '\n'.join(fields)
        if argv[0].endswith('/bin/node'):
            if not Path(argv[0]).is_file(): raise ValueError('No Node executable')
            return 'v0' if self.fault == 'node-version' else 'v22.23.3'
        if argv[:2] == ['apt-mark', 'hold']:
            if self.fault == 'hold-failure': raise ValueError('Hold failed')
            return ''
        raise AssertionError(argv)

    def popen(self, argv, **kwargs):
        self.calls.append(('apt', tuple(argv)))
        assert json.loads((self.root / 'etc/tonyai/r3-install-attempt.json').read_bytes()) == self.approval
        assert (self.root / 'usr/sbin/policy-rc.d').read_bytes() == b'#!/bin/sh\nexit 101\n'
        assert (self.root / 'usr/sbin/policy-rc.d').stat().st_mode & 0o777 == 0o755
        for service in self.module.SERVICES: assert os.readlink(self.root / 'etc/systemd/system' / service) == '/dev/null'
        log = self.root / 'etc/tonyai/r3-install.dpkg.log'
        assert log.read_bytes() == b''
        assert argv == install_argv(self.paths, transaction_log=log)
        assert argv == ['apt-get', '-o', 'DPkg::Lock::Timeout=60', '-o', 'Dpkg::Use-Pty=0', '--no-download', '--no-remove', '--no-install-recommends', '-o', 'Dpkg::Options::=--log=' + str(log), '--yes', 'install', *self.paths]
        data = trace(self.lock)
        if self.fault == 'dpkg-extra': data += '2026-10-21 12:00:00 remove base:amd64 1.0 <none>\n'
        if self.fault == 'man-db-trigger': data += '2026-10-21 12:00:00 trigproc man-db:amd64 2.12.0-4build2 <none>\n'
        log.write_text(data if self.fault != 'dpkg-empty' else '')
        kwargs['stdout'].write(b'fixture stdout\n'); kwargs['stderr'].write(b'fixture stderr\n')
        assert kwargs['stdin'] == subprocess.DEVNULL and kwargs['start_new_session'] is True
        if self.fault == 'mask-lost': (self.root / 'etc/systemd/system/docker.service').unlink()
        waits = []
        def wait(timeout):
            assert timeout == 0.25
            if self.fault == 'wrapper-interrupt':
                raise KeyboardInterrupt()
            if not waits:
                waits.append(True)
                raise subprocess.TimeoutExpired(argv, timeout)
        return types.SimpleNamespace(returncode=100 if self.fault == 'apt-lock-failure' else
                                     1 if self.fault == 'apt-failure' else 0, wait=wait, pid=4242)

    def observe(self, check_locks=True):
        self.observation_calls += 1
        state = observation(); state['locks_probed'] = check_locks
        if not check_locks:
            # Source-derived non-PTY shape; the executed argv is asserted above.
            state['processes'] = [{'pid': 4242, 'pgrp': 4242, 'start_ticks': 1, 'comm': 'apt-get'},
                                  {'pid': 4250, 'pgrp': 4242, 'start_ticks': 2, 'comm': 'dpkg'}]
        if self.fault == 'units-active' or self.fault == 'units-changed' and self.observation_calls == 4:
            state['units']['apt-daily.timer']['ActiveState'] = 'active'
        if self.fault == 'observer-error' and self.observation_calls == 4:
            raise ValueError('Observation unavailable')
        if self.fault == 'foreign-process' and self.observation_calls == 4:
            state['processes'] = [{'pid': 5000, 'pgrp': 5000, 'start_ticks': 1, 'comm': 'apt'}]
        return state

    def run(self):
        m = self.module
        with ExitStack() as stack:
            def mock(obj, name, **kwargs): return stack.enter_context(patch.object(obj, name, **kwargs))
            env = {self.fault.split(':', 1)[1]: 'bad'} if self.fault and self.fault.startswith('env:') else {}
            stack.enter_context(patch.dict(os.environ, env, clear=True))
            previous_umask = os.umask(0o077); stack.callback(os.umask, previous_umask)
            mock(m.os, 'geteuid', return_value=501 if self.fault == 'uid' else 0)
            mock(m.platform, 'machine', return_value='arm64' if self.fault == 'platform' else 'x86_64')
            mock(m.platform, 'freedesktop_os_release', return_value={'ID': 'debian' if self.fault == 'os' else 'ubuntu', 'VERSION_ID': '22.04' if self.fault == 'os-version' else '24.04'})
            mock(m, 'safe_path', side_effect=self.safe_path)
            contract = mock(m, 'validate_contract', side_effect=ValueError('contract') if self.fault == 'contract' else lambda data: data)
            identity = mock(m, 'validate_identity', side_effect=ValueError('identity') if self.fault == 'identity' else None)
            opener = Mock(); opener.open.return_value = io.BytesIO(b'{"compute": {"vmId": "fixture"}}')
            mock(m, 'build_opener', return_value=opener)
            verifier = mock(m, 'verify_toolchain', side_effect=ValueError('verification') if self.fault == 'verification' else None,
                            return_value=(self.lock, self.paths))
            def simulate(lock, paths, diagnostics):
                if self.fault == 'closure': raise ValueError('closure')
                diagnostics.update(stdout=b'fixture exact offline plan\n', stderr=b'fixture simulation stderr\n', returncode=0)
                return 'fixture exact offline plan\n'
            plan = mock(m, 'dependency_plan', side_effect=simulate)
            mock(m, 'observe', side_effect=self.observe)
            child_identity = {'pid': 4242, 'pgrp': 4242, 'start_ticks': 1}
            mock(m, 'process_identity', return_value=child_identity)
            mock(observer, 'process_identity', return_value=child_identity)
            probe = mock(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0 if self.fault == 'installed' else 1))
            mock(m.subprocess, 'Popen', side_effect=self.popen)
            mock(m, 'capture', side_effect=self.capture)
            original_write = m.write_new
            def checked_write(path, data):
                path = Path(path)
                if path.name == 'r3-install-complete.json':
                    assert (path.parent / 'r3-installed-receipt.json').is_file()
                if path.name == 'r3-installed-receipt.json' and self.fault == 'receipt-write':
                    raise ValueError('Receipt write failed')
                return original_write(path, data)
            mock(m, 'write_new', side_effect=checked_write)
            filter_call = mock(m.tarfile, 'data_filter', wraps=tarfile.data_filter)
            extract = tarfile.TarFile.extractall
            def extract_checked(archive, *args, **kwargs):
                assert kwargs.get('filter') == 'data'
                return extract(archive, *args, **kwargs)
            mock(m.tarfile.TarFile, 'extractall', new=extract_checked)
            stack.enter_context(redirect_stdout(io.StringIO()))
            m.install(self.bundle, self.contract, self.approval_path, 'f' * 64 if self.fault == 'approval-hash' else self.approved)
            verifier.assert_called_once_with(self.bundle, self.approval['toolchain_lock_sha256'])
            self.assert_plan(plan)
            contract.assert_called_once_with({'fixture': True}); identity.assert_called_once_with({'fixture': True}, {'vmId': 'fixture'})
            self.request = opener.open.call_args.args[0]
            assert self.request.full_url == 'http://169.254.169.254/metadata/instance?api-version=2021-02-01'
            assert self.request.get_header('Metadata') == 'true'
            assert probe.call_count == 5
            assert filter_call.call_count >= 2

    def assert_plan(self, plan):
        assert plan.call_count == 1
        assert plan.call_args.args[:2] == (self.lock, self.paths)
        assert plan.call_args.args[2]['returncode'] == 0


class InstallGuards(unittest.TestCase):
    def test_man_db_trigger_is_still_a_post_apt_guest_blocker(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(Path(tmp), 'man-db-trigger')
            with self.assertRaisesRegex(ValueError, 'Unexpected dpkg transaction package'):
                h.run()
            self.assertEqual(sum(call[0] == 'apt' for call in h.calls), 1)
            evidence = h.root / 'etc/tonyai/r3-package-evidence'
            self.assertTrue((evidence / 'inventory-after.txt').is_file())
            self.assertTrue((h.root / 'etc/tonyai/r3-install-attempt.json').is_file())
            self.assertFalse((h.root / 'etc/tonyai/r3-installed-receipt.json').exists())
            self.assertFalse((h.root / 'etc/tonyai/r3-install-complete.json').exists())
            self.assertFalse(any(call[:2] == ('apt-mark', 'hold') for call in h.calls))

    def test_wrapper_interrupt_preserves_masks_and_never_claims_child_termination(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = Harness(Path(tmp), 'wrapper-interrupt')
            with self.assertRaises(KeyboardInterrupt):
                h.run()
            self.assertTrue((h.root / 'etc/tonyai/r3-install-attempt.json').exists())
            self.assertTrue((h.root / 'usr/sbin/policy-rc.d').exists())
            for service in h.module.SERVICES:
                self.assertEqual(os.readlink(h.root / 'etc/systemd/system' / service), '/dev/null')
            self.assertFalse((h.root / 'etc/tonyai/r3-install-complete.json').exists())
            self.assertFalse((h.root / 'etc/tonyai/r3-installed-receipt.json').exists())

    def test_complete_real_directory_archive_and_files_only(self):
        for style in (None, 'files-only'):
            with self.subTest(style=style), tempfile.TemporaryDirectory() as tmp:
                h = Harness(Path(tmp), style); h.run()
                self.assertEqual(json.loads((h.root / 'etc/tonyai/r3-install-complete.json').read_bytes()), h.approval)
                receipt = json.loads((h.root / 'etc/tonyai/r3-installed-receipt.json').read_bytes())
                self.assertEqual(receipt['approval_sha256'], h.approved)
                self.assertEqual(receipt['node']['sha256'], sha(b'fixture executable'))
                self.assertEqual(receipt['node']['mode'], '0o755')
                self.assertEqual(receipt['packages'], [
                    {**{k: p[k] for k in ('name', 'version', 'architecture')}, 'status': 'installed'}
                    for p in h.lock['packages']])
                self.assertEqual((h.root / 'etc/tonyai/r3-install-plan.txt').read_bytes(), b'fixture exact offline plan\n')
                self.assertEqual(receipt['apt_plan_sha256'], sha(b'fixture exact offline plan\n'))
                self.assertIs(receipt['activation_authorized'], False)
                tx = receipt['package_transaction']
                self.assertEqual(receipt['format'], 2)
                self.assertEqual(tx['stdout_sha256'], sha(b'fixture stdout\n'))
                self.assertEqual(tx['stderr_sha256'], sha(b'fixture stderr\n'))
                self.assertEqual(tx['dpkg_log_sha256'], sha(trace(h.lock).encode()))
                self.assertEqual(tx['returncode'], 0)
                self.assertIn('added', tx['inventory_diff'])
                self.assertEqual(tx['inventory_diff']['added'], sorted(p['name'] + ':amd64' for p in h.lock['packages']))
                self.assertIs(tx['held'], True)
                evidence = h.root / 'etc/tonyai/r3-package-evidence'
                self.assertEqual(tx['evidence_sha256'], {f.name: sha(f.read_bytes()) for f in evidence.iterdir()})
                self.assertEqual(tx['evidence_sha256']['simulation.stderr.log'], sha(b'fixture simulation stderr\n'))
                self.assertEqual(h.inventory_calls, 4)
                self.assertEqual(h.observation_calls, 7)
                daemon = json.loads((h.root / 'etc/docker/daemon.json').read_bytes()); self.assertIs(daemon['live-restore'], False)
                self.assertIn(('apt-mark', 'hold', *[p['name'] for p in h.lock['packages']]), h.calls)
                self.assertIn(('systemctl', 'mask', *h.module.SERVICES), h.calls)
                for path in ('opt/tonyai-tools', 'opt/tonyai-tools/node-v22.23.3-linux-x64', 'opt/tonyai-tools/node-v22.23.3-linux-x64/bin', 'etc/docker'):
                    self.assertEqual((h.root / path).stat().st_mode & 0o777, 0o755)
                safe = {entry[1] for entry in h.calls if entry[0] == 'safe'}
                self.assertTrue({str(h.bundle), *map(str, h.bundle.rglob('*'))} <= safe)
                with self.assertRaises(ValueError): h.run()  # Consumed attempt can never retry.

    def test_every_prewrite_guard(self):
        bindings = ['format', 'action', 'contract_sha256', 'manifest_sha256', 'installer_sha256', 'toolchain_verifier_sha256',
                    'artifact_verifier_sha256', 'toolchain_lock_sha256', 'host_guard_sha256', 'bundle_helper_sha256', 'layout_sha256',
                    'package_state_sha256', 'apt_observer_sha256']
        paths = ['usr/bin/docker', 'usr/bin/containerd', 'etc/docker/daemon.json', 'usr/sbin/policy-rc.d',
                 'opt/tonyai-tools', 'var/lib/docker', 'var/lib/containerd', 'etc/tonyai/r3-install-attempt.json']
        paths += ['etc/tonyai/' + name for name in ('r3-installed-receipt.json', 'r3-install-complete.json',
                  'r3-install-plan.txt', 'r3-install.stdout.log', 'r3-install.stderr.log', 'docker-packages.txt',
                  'r3-package-evidence', 'r3-install.dpkg.log')]
        paths += [root + '/' + s for root in ('etc/systemd/system', 'run/systemd/system') for s in ('docker.service', 'docker.socket', 'containerd.service')]
        faults = ['uid', 'platform', 'os', 'os-version', 'unsafe-root', 'unsafe-entry', 'approval-hash', 'helper-location',
                  'contract', 'identity', 'verification', 'installed', 'closure', 'broken-mask', 'pending-package',
                  'foreign-root', 'absolute', 'traversal', 'symlink', 'hardlink', 'fifo', 'file-root', 'units-active']
        faults += ['env:' + v for v in ('APT_CONFIG', 'DPKG_ROOT', 'LD_PRELOAD', 'PYTHONPATH', 'PYTHONHOME', 'DEBIAN_FRONTEND')]
        faults += ['binding:' + key for key in bindings] + ['existing:' + path for path in paths]
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                h = Harness(Path(tmp), fault)
                before = {str(p): p.read_bytes() for p in h.root.rglob('*') if p.is_file()}
                with self.assertRaises(ValueError): h.run()
                self.assertFalse(any(call[0] == 'apt' for call in h.calls))
                after = {str(p): p.read_bytes() for p in h.root.rglob('*') if p.is_file()}
                self.assertEqual(before, after)

    def test_postwrite_failures_preserve_attempt_and_refuse_completion(self):
        for fault in ('mask-missing', 'apt-failure', 'apt-lock-failure', 'version', 'arch', 'status', 'mask-lost', 'node-version', 'hold-failure', 'receipt-write',
                      'pre-inventory-change', 'unrelated-inventory', 'final-inventory', 'missing-hold', 'pin-metadata-change',
                      'dpkg-extra', 'dpkg-empty', 'units-changed', 'observer-error', 'foreign-process'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                h = Harness(Path(tmp), fault)
                with self.assertRaises(ValueError): h.run()
                self.assertTrue((h.root / 'etc/tonyai/r3-install-attempt.json').is_file())
                self.assertTrue((h.root / 'usr/sbin/policy-rc.d').is_file())
                self.assertFalse((h.root / 'etc/tonyai/r3-install-complete.json').exists())
                if fault == 'mask-missing': self.assertFalse(any(call[0] == 'apt' for call in h.calls))
                if fault == 'mask-lost':
                    self.assertFalse((h.root / 'opt/tonyai-tools').exists())
                    self.assertFalse(any(call[0].endswith('/bin/node') for call in h.calls))
                self.assertFalse(any('unmask' in c or 'start' in c or '--runtime' in c for c in h.calls))


if __name__ == '__main__': unittest.main()
