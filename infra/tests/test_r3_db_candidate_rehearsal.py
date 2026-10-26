#!/usr/bin/env python3
"""Tests for rehearsal.py (+ its live_ops argv and the attempt_entry --rehearse wiring). Fake ops only:
no Docker, DB or network. Proves the rehearsal uses the attempt's exact argv, never consumes an attempt,
never runs setup SQL / a probe password, reads only a measured log interval, writes only into a work dir
it verified fresh, and FAILS on any unmet check, residue, cleanup or secret-removal problem.
Run: python3 -I -B test_rehearsal.py -v"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'scripts', 'r3_db_candidate'))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


spec = importlib.util.spec_from_file_location('test_r3_db_candidate_executor', os.path.join(os.path.dirname(os.path.realpath(__file__)), 'test_r3_db_candidate_executor.py'))
T = importlib.util.module_from_spec(spec)
sys.modules['test_r3_db_candidate_executor'] = T
spec.loader.exec_module(T)   # realistic fixtures (maps, GUCs, ready)
rc, ex, ll, ve = T.rc, T.ex, T.ll, T.ve
rh = _load('rehearsal', 'rehearsal.py')
lo = _load('live_ops', 'live_ops.py')
ae = _load('attempt_entry', 'attempt_entry.py')
sha = T.sha
PORT, CID, IMAGE, CONFIG = T.PORT, T.CID, T.IMAGE, T.CONFIG
MANIFEST = {'rehearsal.py': '1' * 64, 'live_ops.py': '2' * 64}
MARKER_HEX, TOKEN_HEX = 'ab' * 16, 'cd' * 16
MARKER = 'r3-rehearsal-' + MARKER_HEX
SECRET = 'e' * 64
OBJECTS = (rc.CONTAINER_NAME, rc.NETWORK_NAME, rc.VOLUME_NAME, ex.CONFIG_VOLUME)


def good_approval(**over):
    a = {'purpose': rh.REHEARSAL_PURPOSE, 'source_manifest_sha256': sha(ex.js_canonical(MANIFEST).encode()),
         'issued_at_utc': '2026-10-26T10:00:00Z', 'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN',
         'consumes_attempt': False}
    a.update(over)
    return a


def good_config(**over):
    c = {'work_dir': '/w', 'approval': good_approval(), 'source_manifest': dict(MANIFEST), 'endpoint_port': PORT,
         'image': IMAGE, 'config_digest': CONFIG, 'role_setting_query': T.FIX['r'], 'preload_query': 'Q-PRELOAD',
         'supautils_query': 'Q-SUPAUTILS'}
    c.update(over)
    return c


def entry(ts, msg, *, sev='LOG', pid=77, **extra):
    e = {'timestamp': ts, 'pid': pid, 'error_severity': sev, 'message': msg}
    e.update(extra)
    return json.dumps(e)


def marker_log(*, extra=(), marker_ts='2026-10-26 10:00:30.123 UTC', marker_sev='LOG'):
    lines = [entry('2026-10-26 10:00:29.000 UTC', 'checkpoint starting: time', pid=9),
             entry(marker_ts, MARKER, sev=marker_sev)] + list(extra)
    return ('\n'.join(lines) + '\n').encode()


OWNERS = {'/run/postgresql': '100|101|3775|directory', ex.LOG_DIR: '100|101|700|directory',
          '/var/lib/postgresql/data': '100|101|750|directory', ex.CONFIG_DIR: '100|101|755|directory',
          ex.CONFIG_DIR + '/pgsodium_root.key': '100|101|644|regular file'}
RUNNING = {'restart_count': 0, 'oom_killed': False, 'started_at': 't0', 'running': True, 'exit_code': 0}


class FakeRehearsalOps:
    """Models Docker state: create adds, rm removes, `rm` of a container whose `stop` failed is refused."""
    def __init__(self, **faults):
        self.f = faults
        self.calls, self.argvs, self.written, self.removed, self.secrets = [], {}, {}, [], []
        self.exists, self.stop_failed = set(), False
        self.log_calls, self.state_calls, self.torn_down = 0, 0, False

    def bundle(self):
        o, f = self, self.f

        def run(argv, label):
            o.calls.append(('run', label))
            o.argvs[label] = list(argv)
            if ('run:' + label) in f:
                raise f['run:' + label]
            if label.startswith('create-'):
                o.exists.add({'create-network': rc.NETWORK_NAME, 'create-volume': rc.VOLUME_NAME,
                              'create-config-volume': ex.CONFIG_VOLUME}[label])
            if label == 'run-container':
                o.exists.add(rc.CONTAINER_NAME)
                return f.get('container_id', CID).encode() + b'\n'
            if label == 'teardown':
                o.torn_down = True
                target = argv[-1]
                if 'stop' in argv:
                    if 'stop_fails' in f:
                        o.stop_failed = True
                        raise f['stop_fails']
                elif 'rm' in argv:
                    if target == rc.CONTAINER_NAME and o.stop_failed:
                        raise RuntimeError('cannot remove a running container')
                    o.exists.discard(target)
                    if target in f.get('rm_fails', ()):
                        raise RuntimeError('rm reported an error')
            return {'inspect-image': json.dumps({'id': CONFIG, 'os': 'linux', 'architecture': 'amd64',
                                                 'repoDigests': [f.get('repo', IMAGE)]}).encode(),
                    'inspect-container': json.dumps(CONFIG).encode(),
                    'port': f.get('port_out', '127.0.0.1:%d\n' % PORT).encode()}.get(label, b'')

        def psql(sql, label):
            o.calls.append(('psql', label))
            expected = {'ready': ex.READY_QUERY, 'admin-log': ex.ADMIN_LOG_QUERY, 'role-settings': T.FIX['r'],
                        'preload-rehearsal': 'Q-PRELOAD', 'supautils-rehearsal': 'Q-SUPAUTILS',
                        'holder-pid': rh.HOLDER_QUERY}
            if label == 'marker':
                assert sql == "DO $$ BEGIN RAISE LOG '%s'; END $$;\n" % ('r3-rehearsal-' + f.get('marker_hex', MARKER_HEX)), sql
            else:
                assert sql == expected[label], label
            if ('psql:' + label) in f:
                raise f['psql:' + label]
            return {'ready': f.get('ready', T.READY_OUT), 'admin-log': f.get('admin_log', 'none|none|-1\n'),
                    'role-settings': f.get('role_settings', '0\n'), 'preload-rehearsal': f.get('preload', T.PRELOAD_TEXT),
                    'supautils-rehearsal': f.get('gucs', T.GUC_TEXT), 'marker': '',
                    'holder-pid': f.get('holder', '4242\n')}[label].encode()

        def exists(kind, name):
            o.calls.append(('exists', name))
            if o.torn_down and 'inspect_error_after' in f:
                raise f['inspect_error_after']
            if name in f.get('visible_before', ()):
                return True
            if name in f.get('invisible_after_create', ()):
                return False
            return name in o.exists

        def log_position():
            o.log_calls += 1
            log = f.get('log', marker_log())
            if o.log_calls == 1:
                return {'offset': 5000, 'inode': 7, 'stderr_size': f.get('stderr_before', 0),
                        'utc_before': '2026-10-26T10:00:20.000000Z', 'utc_after': '2026-10-26T10:00:20.500000Z'}
            return {'offset': 5000 + (0 if f.get('no_growth') else len(log)), 'inode': f.get('inode_after', 7),
                    'stderr_size': f.get('stderr_after', f.get('stderr_before', 0)),
                    'utc_before': '2026-10-26T10:00:40.000000Z', 'utc_after': '2026-10-26T10:00:41.000000Z'}

        def read_log(off, n):
            log = f.get('log', marker_log())
            assert off == 5000, off                      # never from 0: the init-phase log is never read
            assert n == len(log), (n, len(log))          # exactly the measured interval
            o.calls.append(('read_log', n))
            return log

        def observe(path):
            if path == ex.LIBRARY_PATH:
                st = 'regular file|%d|%d|%d' % (T.LIB_DEV, T.LIB_INO, T.LIB_SIZE)
                return st, '%s  %s' % (f.get('lib_sha', ll.EXPECTED_LIBRARY_SHA256), path), st
            st = 'regular file|%d|77|900' % T.LIB_DEV
            return st, '%s  %s' % (f.get('receipt_sha', ll.EXPECTED_RECEIPT_SHA256), path), st

        def stat_owner(path):
            o.calls.append(('stat', path))
            if ('stat:' + path) in f:
                raise f['stat:' + path]
            return f.get('owners', {}).get(path, OWNERS[path]) + '\n'

        def read_maps(pid):
            o.calls.append(('maps', pid))
            if pid == 1:
                if 'pid1_maps_error' in f:
                    raise f['pid1_maps_error']
                return 'postmaster-maps\n'
            return f.get('maps', T.MAPS)

        def proc1():
            if 'pid1_comm_error' in f:
                raise f['pid1_comm_error']
            return 'postgres'

        def fresh(path):
            o.calls.append(('fresh',))
            if 'fresh' in f:
                raise f['fresh']

        def remove_secret(path):
            o.removed.append(path)
            if 'remove_secret' in f:
                raise f['remove_secret']

        def host_lock():
            o.calls.append(('host_lock',))
            if 'host_lock' in f:
                raise f['host_lock']

        def seal(work, allow):
            o.calls.append(('seal', tuple(allow)))
            if 'seal' in f:
                raise f['seal']
            return {'sealed': True}

        def write(path, data):
            o.calls.append(('write', path))
            o.written[path] = data

        def write_secret(path, text):
            o.calls.append(('write_secret', path))
            o.secrets.append(path)
            o.written[path] = text.encode()

        def container_state():
            states = f.get('states', [RUNNING, RUNNING])
            value = dict(states[min(o.state_calls, len(states) - 1)])
            o.state_calls += 1
            return value

        markers = iter([f.get('marker_hex', MARKER_HEX), TOKEN_HEX])
        return {
            'host_lock': host_lock, 'run': run, 'psql_bootstrap': psql, 'docker_object_exists': exists,
            'log_position': log_position, 'read_log_interval': read_log, 'observe_library': observe,
            'stat_owner': stat_owner, 'read_maps': read_maps, 'start_holder': lambda: o.calls.append(('holder',)),
            'prompt_probe': lambda token: (o.calls.append(('prompt',)), f.get('prompt', token + '\n'))[1],
            'proc1_comm': proc1, 'container_state': container_state,
            'wait_ready': lambda: o.calls.append(('wait_ready',)),
            'ensure_image': lambda: o.calls.append(('ensure_image',)),
            'port_free': lambda port: f.get('port_free', True), 'assert_fresh_work_dir': fresh,
            'write_secret': write_secret, 'write': write, 'remove_secret': remove_secret,
            'gen_secret': lambda: SECRET, 'gen_marker': lambda: next(markers), 'sleep': lambda s: None,
            'sha256': sha, 'utc_now': lambda: f.get('now', '2026-10-26T10:05:00.000000Z'), 'seal': seal,
        }


def mods():
    return {'contract': rc, 'loaded_library': ll, 'crash_patterns': ve.CRASH_PATTERNS,
            'allowed_severities': ve.ALLOWED_SEVERITIES, 'text_fields': ve.TEXT_FIELDS}


def rehearse(config=None, **faults):
    ops = FakeRehearsalOps(**faults)
    report = rh.run_rehearsal(config or good_config(), ops.bundle(), mods())
    return report, ops


ALL_CHECKS = ('R1_approval', 'R2_preflight', 'R3_exact_attempt_argv', 'R4_docker_exists_wording', 'R5_identity',
              'R6_real_server_ready', 'R7_d8_ownership', 'R8_effective_config', 'R9_jsonlog_readable_as_observer',
              'R10_backend_maps_readable_and_supautils_loaded', 'R11_psql_prompt_reads_stdin', 'R12_pid1_recorded',
              'R13_container_stable', 'R14_no_residue')


class RehearsalHappyPathTests(unittest.TestCase):
    def test_passes_every_check_and_leaves_nothing(self):
        report, ops = rehearse()
        self.assertIsNone(report['failure'], report)
        self.assertEqual(report['status'], rh.PASSED)
        for check in ALL_CHECKS:
            self.assertIs(report['checks'].get(check), True, check)
        self.assertEqual((report['residue'], ops.exists), ([], set()))
        self.assertEqual((report['attempt_consumed'], report['historical_status'], report['r3_status']),
                         (False, 'NOT_REPRODUCED', 'OPEN'))
        self.assertEqual(ops.removed, ['/w/inputs/postgres.env'])
        self.assertEqual([c for c in ops.calls if c[0] == 'seal'], [('seal', ('rehearsal-report.json',))])
        self.assertIn('D8-postgres-owned-tmpfs', report['observed']['deviations'])
        self.assertEqual(report['observed']['maps']['postmaster_maps_supautils'], False)   # session preload
        self.assertEqual(report['observed']['log']['entries'], 2)
        self.assertEqual(report['observed']['ownership'][ex.CONFIG_DIR]['mode'], '755')

    def test_uses_exactly_the_attempt_argv(self):
        _, ops = rehearse()
        plan = ex.build_run_plan(rc, port=PORT, env_file='/w/inputs/postgres.env')
        for label, key in (('run-container', 'run_container'), ('create-network', 'create_network'),
                           ('create-volume', 'create_volume'), ('create-config-volume', 'create_config_volume')):
            self.assertEqual(ops.argvs[label], plan[key], label)

    def test_order_lock_first_and_fresh_before_any_write(self):
        _, ops = rehearse()
        kinds = [c[0] for c in ops.calls]
        self.assertEqual(kinds.index('host_lock'), 0)
        self.assertLess(kinds.index('fresh'), kinds.index('write_secret'))
        self.assertLess(kinds.index('fresh'), kinds.index('run'))

    def test_never_consumes_never_runs_setup_or_a_password(self):
        report, ops = rehearse()
        labels = [c[1] for c in ops.calls if c[0] == 'psql']
        for forbidden in ('setup', 'collision'):
            self.assertNotIn(forbidden, labels)
        written = json.dumps(report) + ''.join(d.decode('utf-8', 'replace') for p, d in ops.written.items()
                                              if p not in ops.secrets)
        self.assertNotIn(SECRET, written)
        src = open(os.path.join(HERE, 'rehearsal.py')).read().split('"""', 2)[2]
        for name in ('consume_attempt', 'set_probe_password', 'run_candidate', 'setup_script', 'collision_query'):
            self.assertNotIn(name, src, name)

    def test_recorded_only_observations_do_not_fail_the_rehearsal(self):
        report, _ = rehearse(pid1_maps_error=ex.ExecutorRefusal('COMMAND_FAILED:maps'),
                             pid1_comm_error=ex.ExecutorRefusal('COMMAND_FAILED:proc1'))
        self.assertEqual(report['status'], rh.PASSED, report['failure'])
        self.assertEqual(report['observed']['maps']['postmaster_maps_supautils'], 'unreadable:COMMAND_FAILED:maps')
        self.assertEqual(report['observed']['pid1_comm'], 'unreadable:COMMAND_FAILED:proc1')

    def test_absent_stderr_file_at_both_ends_is_quiet(self):
        report, _ = rehearse(stderr_before='absent')
        self.assertEqual(report['status'], rh.PASSED, report['failure'])


class RehearsalNegativeTests(unittest.TestCase):
    def failed(self, code, config=None, **faults):
        report, ops = rehearse(config, **faults)
        self.assertEqual(report['status'], rh.FAILED, code)
        self.assertEqual(report['failure']['code'], code, report['failure'])
        self.assertFalse(report['attempt_consumed'])
        return report, ops

    def nothing_written(self, ops, report):
        self.assertEqual([c for c in ops.calls if c[0] in ('write', 'write_secret', 'seal')], [])
        self.assertEqual(report['seal'], {'sealed': False, 'skipped': 'WORK_DIR_NOT_VERIFIED'})

    def test_approval_refusals_start_nothing_and_write_nothing(self):
        cases = ((good_approval(purpose='ONE_ISOLATED_DB_CANDIDATE'), 'REHEARSAL_APPROVAL_PURPOSE'),
                 (good_approval(consumes_attempt=True), 'REHEARSAL_APPROVAL_CONSUMES'),
                 (good_approval(historical_status='REPRODUCED'), 'REHEARSAL_APPROVAL_STATUS'),
                 (good_approval(r3_status='CLOSED'), 'REHEARSAL_APPROVAL_STATUS'),
                 (good_approval(issued_at_utc='2026-10-27T00:00:00Z'), 'REHEARSAL_APPROVAL_FUTURE'),
                 (good_approval(issued_at_utc='2026-02-30T00:00:00Z'), 'REHEARSAL_APPROVAL_ISSUED'),
                 (good_approval(source_manifest_sha256='0' * 64), 'REHEARSAL_APPROVAL_MANIFEST'),
                 ({**good_approval(), 'attempt_id': 'a' * 32}, 'REHEARSAL_APPROVAL_SHAPE'))
        for approval, code in cases:
            report, ops = self.failed(code, good_config(approval=approval))
            self.assertEqual([c for c in ops.calls if c[0] in ('run', 'psql', 'host_lock')], [], code)
            self.nothing_written(ops, report)

    def test_busy_host_lock(self):
        report, ops = self.failed('HOST_LOCK_BUSY', host_lock=ex.ExecutorRefusal('HOST_LOCK_BUSY'))
        self.assertEqual([c for c in ops.calls if c[0] in ('run', 'exists', 'fresh')], [])
        self.assertIsNone(report['residue'])                          # another run's objects are not "residue"
        self.nothing_written(ops, report)

    def test_preflight_refusals_create_and_write_nothing(self):
        for config, faults, code in ((good_config(image='supabase/postgres@sha256:' + '0' * 64), {}, 'IMAGE_PIN'),
                                     (good_config(endpoint_port=80), {}, 'PORT_RANGE'),
                                     (None, {'port_free': False}, 'PORT_IN_USE'),
                                     (None, {'visible_before': (ex.CONFIG_VOLUME,)}, 'DOCKER_OBJECT_EXISTS:' + ex.CONFIG_VOLUME),
                                     (None, {'fresh': ex.ExecutorRefusal('WORK_DIR_NOT_FRESH')}, 'WORK_DIR_NOT_FRESH')):
            report, ops = self.failed(code, config, **faults)
            self.assertEqual([c for c in ops.calls if c[0] == 'run'], [], code)
            self.nothing_written(ops, report)

    def test_compose_and_identity(self):
        self.failed('CONTAINER_ID', container_id='not-an-id')
        self.failed('R4_OBJECT_NOT_VISIBLE:' + rc.VOLUME_NAME, invisible_after_create=(rc.VOLUME_NAME,))
        self.failed('IMAGE_REPO_DIGEST', repo='supabase/postgres@sha256:' + '0' * 64)
        self.failed('PORT_MAPPING', port_out='0.0.0.0:%d\n' % PORT)

    def test_readiness(self):
        self.failed('READY_TEMP_SERVER', ready='f|%s|x\n' % ex.LOG_FILE)
        self.failed('READY_JSONLOG_FILE', ready='t|%s.json|x\n' % ex.LOG_FILE)

    def test_ownership(self):
        for path, value, code in (('/run/postgresql', '0|0|1777|directory', 'R7_SOCKET_DIR'),
                                  ('/run/postgresql', '100|101|755|directory', 'R7_SOCKET_DIR'),
                                  (ex.LOG_DIR, '100|101|1777|directory', 'R7_LOG_DIR'),
                                  ('/var/lib/postgresql/data', '0|0|700|directory', 'R7_PGDATA'),
                                  ('/var/lib/postgresql/data', '100|101|755|directory', 'R7_PGDATA'),
                                  (ex.CONFIG_DIR, '0|0|755|directory', 'R7_CONFIG_DIR'),
                                  (ex.CONFIG_DIR, '100|101|555|directory', 'R7_CONFIG_DIR'),
                                  (ex.CONFIG_DIR + '/pgsodium_root.key', '100|101|644|directory', 'R7_PGSODIUM_KEY'),
                                  (ex.CONFIG_DIR + '/pgsodium_root.key', '100|101|444|regular file', 'R7_PGSODIUM_KEY')):
            self.failed(code, owners={path: value})
        self.assertEqual(rehearse(owners={ex.CONFIG_DIR: '100|101|775|directory'})[0]['status'], rh.PASSED)
        self.failed('COMMAND_FAILED:stat-owner', **{'stat:' + ex.CONFIG_DIR + '/pgsodium_root.key': ex.ExecutorRefusal('COMMAND_FAILED:stat-owner')})

    def test_effective_config(self):
        self.failed('EFFECTIVE_DRIFT:supautils.reserved_roles', gucs=T.GUC_TEXT.replace('anon*, ', ''))
        self.failed('ADMIN_LOG_STATEMENT_NOT_NONE', admin_log='ddl|none|-1\n')
        self.failed('ROLE_SETTINGS_REHEARSAL', role_settings='1\n')

    def test_log_path(self):
        late = '2026-10-26 10:00:31.000 UTC'
        self.failed('R9_MARKER_FORMAT', marker_hex='nothex')
        self.failed('R9_LOG_DID_NOT_GROW', no_growth=True)
        self.failed('R9_LOG_DID_NOT_GROW', inode_after=8)
        self.failed('R9_MARKER_COUNT', log=(entry('2026-10-26 10:00:30.000 UTC', 'other') + '\n').encode())
        self.failed('R9_MARKER_COUNT', log=marker_log(extra=[entry(late, MARKER, pid=1)]))
        self.failed('R9_MARKER_SEVERITY', log=marker_log(marker_sev='NOTICE'))
        self.failed('R9_LOG_TIMESTAMP_FORMAT', log=marker_log(marker_ts='2026-10-26T10:00:30Z'))
        self.failed('R9_LOG_TIMESTAMP_FORMAT', log=marker_log(marker_ts='2026-10-26 10:00:30.12 UTC'))
        self.failed('R9_LOG_OUTSIDE_BRACKET', log=marker_log(marker_ts='2026-10-26 10:00:10.000 UTC'))
        self.failed('R9_LOG_OUTSIDE_BRACKET', log=marker_log(marker_ts='2026-10-26 10:00:59.000 UTC'))
        self.failed('R9_LOG_TIME_ORDER', log=marker_log(extra=[entry('2026-10-26 10:00:29.500 UTC', 'later but earlier')]))
        self.failed('R9_LOG_ENTRY_SHAPE', log=marker_log(extra=[entry(late, 'x', pid='77')]))
        self.failed('R9_LOG_SEVERITY:WARNING', log=marker_log(extra=[entry(late, 'x', sev='WARNING')]))
        self.failed('R9_LOG_SEVERITY:FATAL', log=marker_log(extra=[entry(late, 'x', sev='FATAL')]))
        self.failed('R9_LOG_CRASH_PATTERN', log=marker_log(extra=[entry(late, 'server process (PID 4242) was terminated by signal 11: Segmentation fault')]))
        self.failed('R9_LOG_CRASH_PATTERN', log=marker_log(extra=[entry(late, 'x', detail='terminating any other active server processes')]))
        self.failed('R9_LOG_CRASH_PATTERN', log=marker_log(extra=[entry(late, 'x', internal_query='... crash ...')]))
        self.failed('R9_SECRET_IN_INTERVAL', log=marker_log(extra=[entry(late, "create role postgres superuser login password '%s'" % SECRET)]))
        self.failed('R9_LOG_INCOMPLETE', log=marker_log()[:-1])
        self.failed('R9_STDERR_LOG_GREW', stderr_after=10)
        self.failed('R9_STDERR_LOG_GREW', stderr_before='absent', stderr_after=10)

    def test_maps(self):
        self.failed('R10_NO_HOLDER_BACKEND', holder='\n')
        self.failed('LIBRARY_NOT_MAPPED', maps='7f0000000000-7f0000010000 r-xp 00000000 fd:01 9 /usr/lib/other.so\n')
        self.failed('LIBRARY_HASH_MISMATCH', lib_sha='0' * 64)
        self.failed('RECEIPT_HASH_MISMATCH', receipt_sha='0' * 64)

    def test_prompt(self):
        self.failed('R11_PROMPT_NOT_FROM_STDIN', prompt='\n')

    def test_container_stability_each_condition(self):
        for after in (dict(RUNNING, running=False, exit_code=137), dict(RUNNING, restart_count=1),
                      dict(RUNNING, started_at='t1'), dict(RUNNING, oom_killed=True)):
            self.failed('R13_CONTAINER_CHANGED', states=[RUNNING, after])

    def test_interrupt_still_tears_down_and_checks_residue(self):
        class Term(BaseException):
            code = 'SIGTERM'
        report, ops = self.failed('SIGTERM', **{'psql:marker': Term()})
        self.assertEqual(report['residue'], [])
        self.assertEqual(ops.removed, ['/w/inputs/postgres.env'])
        self.assertTrue(any(c[0] == 'seal' for c in ops.calls))


class RehearsalPassRuleTests(unittest.TestCase):
    """Each leg of the PASS rule on its own: everything else passes, one leg fails -> FAILED."""
    def test_failed_stop_leaves_the_container_and_fails(self):
        report, ops = rehearse(stop_fails=RuntimeError('stop timed out'))
        self.assertIn(rc.CONTAINER_NAME, report['residue'])
        self.assertTrue(report['cleanup']['failures'])
        self.assertEqual(report['status'], rh.FAILED)
        self.assertNotIn('R14_no_residue', report['checks'])

    def test_cleanup_failure_without_residue_is_still_a_failure(self):
        report, ops = rehearse(rm_fails=(rc.NETWORK_NAME,))     # rm errors although the object went away
        self.assertEqual(report['residue'], [])
        self.assertIn(rc.NETWORK_NAME, report['cleanup']['failures'])
        self.assertIs(report['checks'].get('R14_no_residue'), True)
        self.assertEqual(report['status'], rh.FAILED)

    def test_secret_removal_failure_fails(self):
        report, _ = rehearse(remove_secret=OSError('busy'))
        self.assertEqual(report['secret_removal_failures'], ['postgres.env'])
        self.assertIsNone(report['failure'])
        self.assertEqual(report['status'], rh.FAILED)

    def test_inspect_error_during_r14_counts_as_residue(self):
        report, _ = rehearse(inspect_error_after=ex.ExecutorRefusal('DOCKER_DAEMON_UNREACHABLE'))
        self.assertEqual(sorted(report['residue']), sorted(OBJECTS))
        self.assertEqual(report['status'], rh.FAILED)

    def test_seal_failure_fails(self):
        report, _ = rehearse(seal=ex.ExecutorRefusal('SEAL_FAILED'))
        self.assertEqual(report['seal'], {'sealed': False, 'failure': 'SEAL_FAILED'})
        self.assertEqual(report['status'], rh.FAILED)


class RehearsalUnitTests(unittest.TestCase):
    def test_interpret_owner_and_holder(self):
        self.assertEqual(rh.interpret_owner('100|101|3775|directory\n', kind='directory', modes=('3775',), code='X')['mode'], '3775')
        self.assertEqual(rh.interpret_owner('100|101|2775|directory\n', kind='directory', modes=None, code='X')['mode'], '2775')
        for text, modes in (('100|101|3775|directory\n100|101|3775|directory\n', ('3775',)), ('100|101|3775', ('3775',)),
                            ('0|101|3775|directory', ('3775',)), ('100|101|555|directory', None), ('100|101|9x|directory', None)):
            with self.assertRaises(ex.ExecutorRefusal):
                rh.interpret_owner(text, kind='directory', modes=modes, code='X')
        self.assertEqual(rh.interpret_holder_pid('4242\n'), 4242)
        for text in ('', '1\n', '12\n13\n', 'x\n'):
            self.assertIsNone(rh.interpret_holder_pid(text))

    def test_holder_query_scoped_to_an_active_holder(self):
        for needle in ("application_name = '%s'" % lo.HOLDER_APP, "backend_type = 'client backend'", "state = 'active'"):
            self.assertIn(needle, rh.HOLDER_QUERY)


class RehearsalArgvTests(unittest.TestCase):
    D, C = rc.DOCKER, rc.CONTAINER_NAME

    def test_holder_only_sleeps_as_admin_over_the_socket(self):
        a = lo.holder_argv(self.D, self.C)
        self.assertIn('--detach', a)
        self.assertEqual(a[a.index('--env') + 1], 'PGAPPNAME=' + lo.HOLDER_APP)
        self.assertEqual(a[a.index('-h') + 1], '/var/run/postgresql')
        self.assertEqual(a[a.index('-U') + 1], 'supabase_admin')
        self.assertEqual(a[-1], 'SELECT pg_sleep(30);')
        for bad in (1, 500, '30'):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.holder_argv(self.D, self.C, bad)

    def test_stat_and_proc_as_postgres_with_allowlist(self):
        a = lo.stat_owner_argv(self.D, self.C, '/run/postgresql')
        self.assertEqual(a[a.index('--user') + 1], 'postgres')
        self.assertNotIn('-L', a)
        with self.assertRaises(ex.ExecutorRefusal):
            lo.stat_owner_argv(self.D, self.C, '/etc/shadow')
        p = lo.proc1_comm_argv(self.D, self.C)
        self.assertEqual(p[p.index('--user') + 1], 'postgres')

    def test_prompt_probe_reads_stdin_without_a_role(self):
        a = lo.prompt_probe_argv(self.D, self.C)
        docker_part = a[:a.index('psql')]                              # psql's own -t is "tuples only"
        self.assertIn('-i', docker_part)
        self.assertFalse(any(x in ('-t', '--tty', '-it', '-ti') for x in docker_part))
        self.assertEqual(a[-4:], ['-c', "\\prompt 'r3: ' r3v", '-c', '\\echo :r3v'])
        self.assertFalse(any('password' in x.lower() for x in a))


class RehearsalEntryTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='r3reh-')
        os.chmod(self.d, 0o700)
        names = list(ae.REQUIRED_FILES) + ['closure_adapter.py']
        self.manifest = {n: sha(open(os.path.join(HERE, n), 'rb').read()) for n in names}

    def tearDown(self):
        shutil.rmtree(self.d)

    def write(self, name, value):
        path = os.path.join(self.d, name)
        with open(path, 'w') as f:
            json.dump(value, f)
        return path

    def approval(self, **over):
        a = {'purpose': rh.REHEARSAL_PURPOSE, 'source_manifest_sha256': sha(ae.js_canonical(self.manifest).encode()),
             'issued_at_utc': '2026-01-01T00:00:00Z', 'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN',
             'consumes_attempt': False}
        a.update(over)
        return a

    def packet(self, approval=None, **over):
        p = {'work_dir': self.d + '/work', 'source_root': HERE, 'node_path': T.NODE, 'age_path': '/usr/bin/false',
             'age_sha256': 'a' * 64, 'recipient_path': self.d + '/r.pub', 'recipient_sha256': 'b' * 64,
             'approval_path': self.write('approval.json', approval or self.approval()),
             'binding05_path': self.write('binding05.json', {'node_source_manifest': self.manifest}),
             'client_artifacts_path': self.write('artifacts.json', {}), 'endpoint_port': PORT,
             'image': IMAGE, 'config_digest': CONFIG}
        p.update(over)
        return self.write('packet.json', p)

    def patched(self, *, run_status='REHEARSAL_PASSED'):
        """Load the verified modules as rehearse() will, then stub the host-bound steps and record order."""
        verified = ae.verify_files(self.manifest)
        mods = {name: ae.load_verified(name, filename, verified) for name, filename in ae.PYTHON_MODULES}
        calls, captured = [], {}
        saved = (mods['live_ops'].require_runner, mods['live_ops'].build_live_ops, mods['rehearsal'].run_rehearsal,
                 ae.verify_node, ae.fixture_sql_constants)
        mods['live_ops'].require_runner = lambda **kw: calls.append('guard') or True
        mods['live_ops'].build_live_ops = lambda config, contract: calls.append('build') or {
            'consume_attempt': 1, 'run_candidate': 2, 'set_probe_password': 3, 'make_empty_private_dir': 4, 'run': 5}

        def fake_run(config, ops, m):
            captured['ops'] = ops
            calls.append('rehearse')
            return {'status': run_status}
        mods['rehearsal'].run_rehearsal = fake_run
        ae.verify_node = lambda *a: calls.append('verify_node') or True
        ae.fixture_sql_constants = lambda *a: calls.append('node') or ('', '', 'R')

        def restore():
            (mods['live_ops'].require_runner, mods['live_ops'].build_live_ops, mods['rehearsal'].run_rehearsal,
             ae.verify_node, ae.fixture_sql_constants) = saved
        self.addCleanup(restore)
        return calls, captured

    def test_rehearse_order_trims_ops_and_maps_exit_codes(self):
        calls, captured = self.patched()
        self.assertEqual(ae.main(['--rehearse', self.packet()]), 0)
        self.assertEqual(calls, ['guard', 'verify_node', 'node', 'build', 'rehearse'])
        self.assertEqual(captured['ops'], {'run': 5})                 # rehearsal_ops really applied

    def test_failed_rehearsal_exit_code(self):
        self.patched(run_status='REHEARSAL_FAILED')
        self.assertEqual(ae.main(['--rehearse', self.packet()]), 3)

    def test_wrong_approval_kind_is_refused_before_anything_runs(self):
        calls, _ = self.patched()
        attempt_like = {'purpose': 'ONE_ISOLATED_DB_CANDIDATE', 'attempt_id': 'a' * 32,
                        'source_manifest_sha256': sha(ae.js_canonical(self.manifest).encode())}
        with self.assertRaises(Exception) as ctx:                     # modules run from verified bytes
            ae.main(['--rehearse', self.packet(approval=attempt_like)])
        self.assertEqual((type(ctx.exception).__name__, ctx.exception.code), ('ExecutorRefusal', 'REHEARSAL_APPROVAL_SHAPE'))
        self.assertEqual(calls, [])                                   # no guard, no Node, nothing built

    def test_rehearsal_approval_cannot_drive_execute(self):
        calls, _ = self.patched()
        packet = {'work_dir': self.d + '/w2', 'state_dir': self.d + '/s', 'source_root': HERE, 'node_path': T.NODE,
                  'age_path': '/usr/bin/false', 'age_sha256': 'a' * 64, 'recipient_path': self.d + '/r.pub',
                  'recipient_sha256': 'b' * 64, 'approval_path': self.write('approval.json', self.approval()),
                  'binding_path': self.write('binding.json', {}),
                  'binding05_path': self.write('binding05.json', {'node_source_manifest': self.manifest}),
                  'closure_evidence_path': self.write('closure.json', {}), 'closure_index_path': self.write('index.json', {}),
                  'client_artifacts_path': self.write('artifacts.json', {}), 'endpoint_port': PORT, 'image': IMAGE,
                  'config_digest': CONFIG}
        self.assertEqual(sorted(packet), sorted(ae.PACKET_KEYS))
        with self.assertRaises(Exception) as ctx:
            ae.main(['--execute', self.write('p.json', packet)])
        self.assertEqual((type(ctx.exception).__name__, ctx.exception.code), ('ExecutorRefusal', 'APPROVAL_SHAPE'))
        self.assertEqual(calls, [])

    def test_rehearse_on_this_mac_refuses_before_anything(self):
        if os.uname().sysname == 'Linux':
            self.skipTest('only meaningful on the non-Linux dev host')
        out = subprocess.run([sys.executable, '-I', '-B', os.path.join(HERE, 'attempt_entry.py'), '--rehearse', self.packet()],
                             capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'HOME': self.d})
        self.assertEqual(out.returncode, 1, out.stderr)
        self.assertEqual(out.stderr.strip(), 'LIVE_NOT_LINUX_AMD64')
        self.assertFalse(os.path.exists(self.d + '/work'))

    def test_rehearsal_packet_shape_and_flag_mixing(self):
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.main(['--rehearse', self.packet(state_dir='/x')])
        self.assertEqual(ctx.exception.code, 'PACKET_SHAPE')
        with self.assertRaises(ae.EntryRefusal):
            ae.main(['--execute', '--rehearse', self.packet()])
        with self.assertRaises(ae.EntryRefusal):
            ae.main(['--rehearse'])

    def test_rehearsal_approval_must_bind_the_manifest(self):
        self.manifest['rehearsal.py'] = '0' * 64
        packet = self.packet()
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.main(['--rehearse', packet])
        self.assertEqual(ctx.exception.code, 'PINNED_FILE:rehearsal.py')

    def test_summary_reports_cleanup_and_secret_removal(self):
        src = open(os.path.join(HERE, 'attempt_entry.py')).read()
        self.assertGreaterEqual(src.count("'secret_removal_failures'"), 2)
        self.assertGreaterEqual(src.count("'cleanup'"), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
