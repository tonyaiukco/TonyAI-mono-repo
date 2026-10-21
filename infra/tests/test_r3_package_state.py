"""Discriminating inventory/transaction/isolation negatives with synthetic fixtures."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_apt_observer as observer
import r3_package_state as state
from r3_package_fixtures import baseline, installed, render, trace, observation

LOCK = json.loads((SCRIPTS.parent / 'selfhost/r3-toolchain.lock.json').read_bytes())


class InventoryTests(unittest.TestCase):
    def test_all_rows_and_metadata_retained_order_independent(self):
        rows = installed(LOCK)
        text = render(rows)
        self.assertEqual(state.inventory(text), rows)
        self.assertEqual(state.inventory('\n'.join(reversed(text.splitlines())) + '\n'), rows)
        diff = state.inventory_diff(baseline(), rows, LOCK)
        self.assertEqual(diff['added'], sorted(set(rows) - set(baseline())))
        state.held_inventory(rows, installed(LOCK, held=True), LOCK)
        state.inventory_diff(baseline(), installed(LOCK, held=True), LOCK, held=True)

    def test_unrelated_add_remove_and_every_field_change_refused(self):
        for fault in ('add', 'remove', *state.FIELDS):
            with self.subTest(fault=fault):
                rows = installed(LOCK)
                if fault == 'add': rows['extra:amd64'] = {**rows['base:amd64'], 'name': 'extra'}
                elif fault == 'remove': del rows['base:amd64']
                else: rows['base:amd64'][fault] += 'changed'
                with self.assertRaises(Exception) as refused:
                    state.inventory_diff(baseline(), rows, LOCK)
                self.assertIsInstance(refused.exception, ValueError)
                self.assertRegex(str(refused.exception), 'inventory')

    def test_pin_collision_any_architecture_and_exact_post_identity(self):
        pin = LOCK['packages'][0]
        for arch in ('amd64', 'arm64'):
            before = baseline(); before[pin['name'] + ':' + arch] = {**before['base:amd64'], 'name': pin['name'], 'architecture': arch}
            with self.assertRaisesRegex(ValueError, 'Existing pinned'):
                state.require_absent(before, LOCK)
        for field in ('name', 'version', 'architecture', 'status'):
            rows = installed(LOCK); rows[pin['name'] + ':amd64'][field] = 'wrong'
            with self.assertRaisesRegex(ValueError, 'Pinned package'):
                state.inventory_diff(baseline(), rows, LOCK)
        with self.assertRaisesRegex(ValueError, 'Pinned package'):
            state.inventory_diff(baseline(), installed(LOCK), LOCK, held=True)

    def test_hold_cannot_hide_metadata_or_unrelated_changes(self):
        for key in ('base:amd64', LOCK['packages'][0]['name'] + ':amd64'):
            rows = installed(LOCK, held=True); rows[key]['depends'] = 'changed'
            with self.assertRaisesRegex(ValueError, 'hold transitions'):
                state.held_inventory(installed(LOCK), rows, LOCK)

    def test_incomplete_duplicate_and_invalid_inventory_refused(self):
        text = render(baseline())
        faults = ['', text.rstrip('\n'), text + text, text.replace('base\t', '../bad\t'),
                  text.replace('amd64', ''), text.replace('1.0', ''), text.replace('install ok installed', 'install ok broken'),
                  text.replace('\tyes\t', '\tmaybe\t'), text.replace('\t', '\n', 1)]
        for data in faults:
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, 'inventory'):
                state.inventory(data)


class TransactionTests(unittest.TestCase):
    def test_exact_five_install_configure_and_versions(self):
        got = state.transaction(trace(LOCK), LOCK)
        self.assertEqual(got['install'], {p['name']: p['version'] for p in LOCK['packages']})
        self.assertEqual(got['configure'], got['install'])
        self.assertEqual(got['terminal_status'], {p['name']: 'installed' for p in LOCK['packages']})

    def test_actions_versions_missing_extra_and_terminal_faults(self):
        text = trace(LOCK); pin = LOCK['packages'][0]; name = pin['name'] + ':amd64'; version = pin['version']
        install = f'install {name} <none> {version}'
        configure = f'configure {name} {version} <none>'
        faults = ['', text[:-1], text.replace('2026-10-21 ', 'garbage ', 1),
                  text.replace(install, f'upgrade {name} 1 {version}'), text.replace(install, f'remove {name} 1 <none>'),
                  text.replace(install, f'purge {name} 1 <none>'), text.replace(install, f'install {name} 1 {version}'),
                  text.replace(install, f'install {name} <none> wrong'), text.replace(configure, f'configure {name} wrong <none>'),
                  text.replace(configure, f'configure {name} {version} wrong'), text.replace(name, pin['name'] + ':arm64'),
                  text.replace('startup packages configure', 'startup packages purge'),
                  text.replace(f'status installed {name} {version}', f'status unpacked {name} {version}'),
                  text.replace(f'status installed {name} {version}', f'status installed {name} wrong'),
                  text + f'2026-10-21 12:00:00 {install}\n',
                  text + '2026-10-21 12:00:00 trigproc libc-bin:amd64 2.39 <none>\n']
        for record in (install, configure, 'startup archives unpack', 'startup packages configure'):
            faults.append('\n'.join(line for line in text.splitlines() if not line.endswith(record)) + '\n')
        faults.append(f'2026-10-21 12:00:00 {configure}\n' + text)
        # Move, rather than duplicate, the action so the duplicate guard cannot
        # conceal a missing configure-before-install refusal.
        faults.append(f'2026-10-21 12:00:00 {configure}\n' +
                      '\n'.join(line for line in text.splitlines() if not line.endswith(configure)) + '\n')
        for data in faults:
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, '[Dd]pkg'):
                state.transaction(data, LOCK)


class ObserverTests(unittest.TestCase):
    def test_systemd_explicit_no_job_rendering_and_pending_job_refusal(self):
        # Source-derived systemd v255 shape, not output captured from a guest.
        # Explicit --property renders the absent (uo) Job as an empty value.
        def show(argv, **kwargs):
            fields = {**observation()['units'][argv[2]], 'Job': ''}
            return subprocess.CompletedProcess(argv, 0, ''.join(k + '=' + v + '\n' for k, v in fields.items()).encode())
        with patch.object(observer.subprocess, 'run', side_effect=show), \
                patch.object(observer, 'processes', return_value=[]), patch.object(observer, 'probe_locks'):
            result = observer.observe()
        self.assertTrue(all(fields['Job'] == '' for fields in result['units'].values()))
        observer.validate(result)
        for bad in ('0', '42', ' ', '42 /org/freedesktop/systemd1/job/42'):
            row = copy.deepcopy(result); row['units']['apt-daily.timer']['Job'] = bad
            with self.subTest(job=bad), self.assertRaisesRegex(ValueError, 'masked and inactive'):
                observer.validate(row)
        def missing_job(argv, **kwargs):
            result = show(argv, **kwargs)
            return subprocess.CompletedProcess(argv, 0, result.stdout.replace(b'Job=\n', b''))
        with patch.object(observer.subprocess, 'run', side_effect=missing_job):
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                observer.observe()

    def test_isolation_properties_and_activity_transitions(self):
        original = observation(); observer.validate(original)
        for unit in observer.UNITS:
            for key, bad in [('Id', 'alias'), ('LoadState', 'not-found'), ('UnitFileState', 'masked-runtime'),
                             ('ActiveState', 'active'), ('SubState', 'running'), ('Job', '42')]:
                row = copy.deepcopy(original); row['units'][unit][key] = bad
                with self.subTest(unit=unit, key=key), self.assertRaisesRegex(ValueError, 'masked and inactive'):
                    observer.validate(row)
            for key in observer.PROPERTIES:
                if key.endswith('Monotonic'):
                    row = copy.deepcopy(original); row['units'][unit][key] = '1'
                    with self.assertRaisesRegex(ValueError, 'state changed'):
                        observer.validate(row, original)
        row = copy.deepcopy(original); row['units']['apt-daily.service']['MainPID'] = '4'
        with self.assertRaisesRegex(ValueError, 'masked and inactive'): observer.validate(row)
        row = copy.deepcopy(original); del row['units']['apt-daily.timer']
        with self.assertRaisesRegex(ValueError, 'unit set'): observer.validate(row)

    def test_foreign_and_reused_child_processes_refused(self):
        child = {'pid': 42, 'pgrp': 42, 'start_ticks': 100}
        # APT 2.7.14 with the required Dpkg::Use-Pty=0 retains this group.
        row = observation(); row['processes'] = [{'pid': 43, 'pgrp': 42, 'start_ticks': 101, 'comm': 'dpkg'},
                                                {**child, 'comm': 'apt-get'}]
        with self.assertRaisesRegex(ValueError, 'Foreign'): observer.validate(row)
        with patch.object(observer, 'process_identity', return_value=child): observer.validate(row, child=child)
        with patch.object(observer, 'process_identity', return_value={**child, 'start_ticks': 200}):
            with self.assertRaisesRegex(ValueError, 'identity changed'): observer.validate(row, child=child)
        with patch.object(observer, 'process_identity', side_effect=FileNotFoundError):
            with self.assertRaisesRegex(ValueError, 'identity lost'): observer.validate(row, child=child)
        # The default PTY/session shape remains forbidden; argv must disable it.
        row['processes'][0]['pgrp'] = 43
        with self.assertRaisesRegex(ValueError, 'Foreign'): observer.validate(row, child=child)

    def test_observe_exact_unit_properties_and_lock_probes(self):
        row = observation()
        def command(argv, **kwargs):
            self.assertEqual(argv[:2], ['systemctl', 'show'])
            fields = row['units'][argv[2]]
            self.assertEqual(set(argv[-1].removeprefix('--property=').split(',')), set(fields))
            self.assertTrue(kwargs['check']); self.assertEqual(kwargs['timeout'], 15)
            return subprocess.CompletedProcess(argv, 0, '\n'.join(k+'='+v for k,v in fields.items()).encode())
        with patch.object(observer.subprocess, 'run', side_effect=command) as run, \
                patch.object(observer, 'processes', return_value=[]) as processes, \
                patch.object(observer, 'probe_locks') as locks:
            self.assertEqual(observer.observe(), row)
            self.assertEqual(run.call_count, 5); processes.assert_called_once(); locks.assert_called_once()
            locks.reset_mock(); self.assertFalse(observer.observe(check_locks=False)['locks_probed']); locks.assert_not_called()
        for output in (b'Id=x\nId=x\n', b'Id=x\n'):
            with patch.object(observer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output)):
                with self.assertRaisesRegex(ValueError, 'systemd|observation'): observer.observe()

    def test_proc_command_line_detects_python_unattended_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); proc = root/'42'; proc.mkdir()
            (proc/'comm').write_text('python3\n'); (proc/'cmdline').write_bytes(b'/usr/bin/python3\0/usr/bin/unattended-upgrade\0')
            fields = ['S', '1', '42'] + ['0'] * 16 + ['100']
            (proc/'stat').write_text('42 (python worker) ' + ' '.join(fields))
            got = observer.processes(root)
            self.assertEqual(got, [{'pid': 42, 'pgrp': 42, 'start_ticks': 100, 'comm': 'python3'}])
            (proc/'cmdline').write_bytes(b'/usr/bin/python3\0ordinary.py\0')
            self.assertEqual(observer.processes(root), [])

    def test_lock_contention_propagates_without_bypass_or_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'lock'; path.touch()
            real_stat = os.fstat
            def owned(fd):
                value = list(real_stat(fd)); value[4] = 0
                return os.stat_result(value)
            def lock(fd, operation):
                if operation != observer.fcntl.LOCK_UN:
                    raise BlockingIOError('Contended acquisition')
            with patch.object(observer, 'LOCKS', (str(path),)), patch.object(observer.os, 'fstat', side_effect=owned), \
                    patch.object(observer.fcntl, 'lockf', side_effect=lock):
                with self.assertRaises(BlockingIOError): observer.probe_locks()
                self.assertTrue(path.is_file())
            path.unlink(); path.symlink_to('/absent')
            with patch.object(observer, 'LOCKS', (str(path),)):
                with self.assertRaises(OSError): observer.probe_locks()


if __name__ == '__main__':
    unittest.main()
