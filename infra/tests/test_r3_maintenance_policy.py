"""Synthetic policy/adversarial tests; never operate on a guest or host units."""
import base64
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_install_policy as policy
import r3_maintenance as maintenance
import r3_package_state as state
from r3_package_fixtures import baseline, trace, observation

LOCK_BYTES = (SCRIPTS.parent / 'selfhost/r3-toolchain.lock.json').read_bytes()
LOCK = json.loads(LOCK_BYTES)


def fixture():
    before = baseline()
    before['man-db:amd64'] = {**before['base:amd64'], 'name': 'man-db', 'version': '2.12.0-4build2'}
    files = {name: {'sha256': 'a' * 64, 'bytes': 1, 'uid': 0, 'gid': 0, 'mode': 0o644} for name in policy.FIXED}
    facts = {'files': files, 'directories': {n: [] for n in policy.DIRECTORIES}, 'packagekit_activation_possible': False}
    value = {'format': 1, 'purpose': policy.PURPOSE, 'toolchain_sha256': policy.digest(LOCK_BYTES),
             'inventory_sha256': policy.digest(policy.encoded(before)), 'apt_config_sha256': policy.digest(b'config'),
             'unit_config_sha256': policy.digest(b'units'), 'facts_sha256': policy.digest(policy.encoded(facts)),
             'cache_before_sha256': policy.digest(policy.encoded({})), 'review_sha256': 'b' * 64, 'triggers': [{'package': 'man-db:amd64', 'version': '2.12.0-4build2',
                                                   'effects_review_sha256': 'c' * 64, 'effects': {}}]}
    return value, before, facts


def trigger_trace():
    return ''.join('2026-10-23 00:00:00 ' + line + '\n' for line in (
        'status triggers-pending man-db:amd64 2.12.0-4build2',
        'trigproc man-db:amd64 2.12.0-4build2 <none>',
        'status half-configured man-db:amd64 2.12.0-4build2',
        'status installed man-db:amd64 2.12.0-4build2'))


class PolicyTests(unittest.TestCase):
    def test_binding_and_duplicate_key_refusal(self):
        value, before, facts = fixture()
        data = policy.encoded(value)
        self.assertEqual(policy.load(data, policy.digest(data)), value)
        policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})
        with self.assertRaises(ValueError): policy.load(data, '0' * 64)
        duplicate = data[:-1] + b',"format":1}'
        with self.assertRaisesRegex(ValueError, 'Duplicate'): policy.load(duplicate, policy.digest(duplicate))
        for key in ('format', 'purpose', 'review_sha256', 'facts_sha256'):
            bad = {**value, key: True}
            with self.subTest(key=key), self.assertRaises(ValueError): policy.validate(bad)
        for triggers in ([], value['triggers'] * 2, [{**value['triggers'][0], 'package': 'libc-bin:amd64'}]):
            with self.assertRaises(ValueError): policy.validate({**value, 'triggers': triggers})

    def test_every_environment_binding_and_hook_predicate_refuses(self):
        value, before, facts = fixture()
        args = [LOCK_BYTES, before, b'config', facts, b'units', {}]
        for index in range(len(args)):
            changed = copy.deepcopy(args)
            changed[index] = b'drift' if isinstance(changed[index], bytes) else {**changed[index], 'drift': True}
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, 'differs'):
                policy.preflight(value, *changed)
        facts['packagekit_activation_possible'] = True
        value['facts_sha256'] = policy.digest(policy.encoded(facts))
        with self.assertRaisesRegex(ValueError, 'PackageKit'):
            policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})
        value, before, facts = fixture()
        before['man-db:amd64']['version'] = '9'
        value['inventory_sha256'] = policy.digest(policy.encoded(before))
        with self.assertRaisesRegex(ValueError, 'existing installed'):
            policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})

    def test_no_implicit_trigger_broadening_and_complete_lifecycle(self):
        value, _, _ = fixture()
        text = trace(LOCK) + trigger_trace()
        with self.assertRaisesRegex(ValueError, 'Unexpected dpkg'):
            state.transaction(text, LOCK)
        result = policy.trigger_transaction(text, LOCK, value)
        self.assertEqual(len(result['install']), 5)
        self.assertEqual(len(result['native_triggers']), 4)
        rows = trigger_trace().splitlines(True)
        faults = [trace(LOCK), text + trigger_trace(), text[:-1], trigger_trace() + trace(LOCK),
                  text.replace('trigproc man-db', 'configure man-db'),
                  text.replace('man-db:amd64', 'man-db'), text.replace('man-db:amd64', 'man-db:arm64'),
                  text.replace('2.12.0-4build2', '9'), text.replace('status half-configured man-db', 'status unpacked man-db'),
                  text + '2026-10-23 00:00:00 trigproc libc-bin:amd64 2.39 <none>\n',
                  text.replace('install containerd.io:amd64', 'upgrade containerd.io:amd64')]
        faults += [trace(LOCK) + ''.join(rows[:i] + rows[i + 1:]) for i in range(4)]
        faults += [trace(LOCK) + ''.join(reversed(rows))]
        for bad in faults:
            with self.subTest(tail=bad[-120:]), self.assertRaises(ValueError):
                policy.trigger_transaction(bad, LOCK, value)

    def test_private_file_safety_and_cache_effect_scope(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve(); path = root / 'content'; path.write_bytes(b'abc')
            self.assertEqual(policy.regular_record(str(path))['sha256'], policy.digest(b'abc'))
            (root / 'link').symlink_to(path)
            with self.assertRaises(OSError): policy.regular_record(str(root / 'link'))
            cache = root / 'cache'; cache.mkdir(mode=0o755)
            (root / 'parent-link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(OSError): policy.cache_snapshot(root / 'parent-link/cache')
            before = policy.cache_snapshot(cache)
            (cache / 'index.db').write_bytes(b'cache'); (cache / 'index.db').chmod(0o644)
            after = policy.cache_snapshot(cache)
            self.assertEqual(policy.cache_effects(before, after)['added'], ['index.db'])
            approved, _, _ = fixture()
            with self.assertRaisesRegex(ValueError, 'cache effect'): policy.cache_effects(before, after, approved)
            approved['triggers'][0]['effects'] = {'index.db': {'action': 'added', 'kind': 'file',
                'uid': after['index.db']['uid'], 'gid': after['index.db']['gid'], 'mode': 0o644, 'max_bytes': 5}}
            policy.cache_effects(before, after, approved)
            for change in ({'mode': 0o755}, {'max_bytes': 1}, {'action': 'removed'}):
                bad = copy.deepcopy(approved); bad['triggers'][0]['effects']['index.db'].update(change)
                with self.assertRaises(ValueError): policy.cache_effects(before, after, bad)
            for bad in ({**after, '../escape': after['index.db']},
                        {**after, 'index.db': {**after['index.db'], 'mode': 0o666}},
                        {**after, 'index.db': {**after['index.db'], 'uid': 999999}}):
                with self.assertRaises(ValueError): policy.cache_effects(before, bad)


class MaintenanceTests(unittest.TestCase):
    def test_only_identified_helper_may_be_normally_stopped(self):
        value = observation(); item = {'pid': 879, 'pgrp': 879, 'start_ticks': 22954, 'comm': 'unattended-upgr'}
        unit = value['units']['unattended-upgrades.service']
        unit.update(ActiveState='active', SubState='running', MainPID='879')
        value['processes'] = [item]
        identity = {k: item[k] for k in ('pid', 'pgrp', 'start_ticks')}; identity['ppid'] = 1
        record = {'before': identity, 'after': identity, 'identity_matches_observation': True}
        for name, data in (('cmdline', maintenance.HELPER_ARGV), ('exe_link', b'/usr/bin/python3.12'),
                           ('cgroup', b'0::/system.slice/unattended-upgrades.service\n')):
            record[name] = {'base64': base64.b64encode(data).decode(), 'truncated': False, 'metadata_equal': True,
                            'bytes': len(data), 'sha256': policy.digest(data)}
        self.assertEqual(maintenance.eligible(value, inspect=lambda _: record), record)
        for key in ('pid', 'pgrp', 'start_ticks'):
            bad = copy.deepcopy(record); bad['before'][key] = bad['after'][key] = 999
            with self.assertRaises(ValueError): maintenance.eligible(value, inspect=lambda _: bad)
        for key in ('bytes', 'sha256'):
            bad = copy.deepcopy(record); bad['cmdline'][key] = None
            with self.assertRaises(ValueError): maintenance.eligible(value, inspect=lambda _: bad)
        from r3_noble_guest import fixture_observation
        with self.assertRaisesRegex(ValueError, 'Foreign'): fixture_observation(value)
        for key in ('cmdline', 'exe_link', 'cgroup'):
            bad = copy.deepcopy(record); bad[key]['base64'] = base64.b64encode(b'other').decode()
            with self.assertRaises(ValueError): maintenance.eligible(value, inspect=lambda _: bad)
        for mutate in (lambda x: x['processes'].append(item),
                       lambda x: x['units']['apt-daily.timer'].update(Job='42'),
                       lambda x: x['units']['apt-daily.service'].update(ActiveState='active')):
            bad = copy.deepcopy(value); mutate(bad)
            with self.assertRaises(ValueError): maintenance.eligible(bad, inspect=lambda _: record)

    def test_exclusive_attempt_order_and_no_failure_restoration(self):
        for fault in (None, 'timeout', 'writer', 'drift', 'mask'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as name:
                directory = Path(name); calls = []
                final = observation()
                if fault == 'writer': final['processes'] = [{'pid': 4, 'pgrp': 4}]
                def command(argv, label, **kwargs):
                    calls.append(argv)
                    if fault == 'timeout': raise TimeoutError('stop')
                obs = Mock(side_effect=[observation(), observation(), final])
                with patch.object(Path, 'is_symlink', return_value=fault != 'mask'), patch.object(maintenance.os, 'readlink', return_value='/dev/null'):
                    call = lambda: maintenance.isolate(directory, {'same': True},
                        lambda _phase, _timeout: {'same': fault != 'drift'}, command, time.monotonic() + 120, observer=obs)
                    if fault:
                        with self.assertRaises((ValueError, TimeoutError)): call()
                        self.assertFalse((directory / 'maintenance-complete.json').exists())
                    else:
                        call()
                        maintenance.validate_evidence(*(json.loads((directory / (n + '.json')).read_bytes())
                            for n in ('maintenance-intent', 'maintenance-final', 'maintenance-complete')))
                self.assertTrue((directory / 'maintenance-intent.json').exists())
                self.assertEqual(calls[0], ['systemctl', 'mask', *maintenance.UNITS])
                self.assertFalse(any('unmask' in c or 'kill' in c or '--force' in c for c in calls))
                with self.assertRaises(FileExistsError):
                    maintenance.isolate(directory, {}, lambda _phase, _timeout: {}, command, time.monotonic() + 120, observer=lambda: observation())

    def test_writer_starting_during_timer_quiescence_is_never_stopped(self):
        busy = observation(); busy['units']['apt-daily.service'].update(ActiveState='active', SubState='running', MainPID='42')
        with tempfile.TemporaryDirectory() as name:
            command = Mock()
            with self.assertRaisesRegex(ValueError, 'Active package work'):
                maintenance.isolate(Path(name), {}, lambda _phase, _timeout: {}, command, time.monotonic() + 120,
                                    observer=Mock(side_effect=[observation(), busy]))
            self.assertEqual(command.call_count, 2)
            self.assertFalse(any(call.args[0] == ['systemctl', 'stop', *maintenance.SERVICES] for call in command.call_args_list))

    def test_final_inventory_cannot_reset_or_overrun_deadline_and_complete(self):
        now = [0]
        def inventory_read(phase, timeout):
            self.assertLessEqual(timeout, 115)
            if phase == 'post-stop': now[0] = 121
            return {}
        with tempfile.TemporaryDirectory() as name, patch.object(maintenance.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(Path, 'is_symlink', return_value=True), patch.object(maintenance.os, 'readlink', return_value='/dev/null'):
            with self.assertRaises(TimeoutError):
                maintenance.isolate(Path(name), {}, inventory_read, Mock(), 120, observer=lambda: observation())
            self.assertFalse((Path(name) / 'maintenance-complete.json').exists())


if __name__ == '__main__':
    unittest.main()
