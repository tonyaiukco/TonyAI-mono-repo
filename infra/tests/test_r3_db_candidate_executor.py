#!/usr/bin/env python3
"""Tests for runtime_executor.py — every gate positive + isolated mutation-style negatives, and the full
single attempt over FAKE ops. The happy path runs the REAL loaded-library validator, the REAL jsonlog
interval validator and the REAL assembly (a fake there hid a live-only REJECTED in an earlier draft).
No Docker, DB, network, or filesystem outside the in-memory fake. Run: python3 -I -B test_runtime_executor.py -v"""
import copy
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

HERE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'scripts', 'r3_db_candidate'))
NODE = os.path.realpath(os.environ.get('R3_TEST_NODE') or shutil.which('node') or '/nonexistent/node')   # Node 22
CUSTODY = os.path.expanduser('~/TonyAI-r3-evidence-custody/20261026/db-closure-evidence')


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


rc = _load('runtime_contract', 'runtime_contract.py')
ex = _load('runtime_executor', 'runtime_executor.py')
ll = _load('loaded_library', 'loaded-library.py')
ve = _load('validate_evidence', 'validate-evidence.py')

sha = lambda b: hashlib.sha256(b).hexdigest()
ATTEMPT, OWNER = 'a' * 32, 'b' * 64
CONFIG, IMAGE = rc.CONFIG_DIGEST, rc.IMAGE
PORT, CID = 54329, 'c' * 64
NONCES = ['1' * 32, '2' * 32, '3' * 32]                # A, B, C (driver order)
PIDS = {'A': 12, 'B': 11, 'C': 13}
POSTMASTER = '2026-10-26 10:00:00.123456+00'
NODE_PATH = '/opt/node-v22.23.3-linux-x64/bin/node'


def _fixture_constants():
    out = subprocess.run([NODE, '--input-type=module', '-e',
                          "const m = await import(new URL('./fixture-sql.mjs', 'file://' + process.argv[1] + '/').href);"
                          "process.stdout.write(JSON.stringify({s: m.SETUP_SCRIPT, c: m.COLLISION_QUERY, r: m.DB_ROLE_SETTING_QUERY}))",
                          HERE], capture_output=True, text=True, timeout=30, env={'PATH': '/usr/bin:/bin'})
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


FIX = _fixture_constants()
SETUP = FIX['s']

S_LIST = ('pg_stat_statements, pgaudit, plpgsql, plpgsql_check, pg_cron, pg_net, pgsodium, auto_explain, pg_tle, '
          'plan_filter, supabase_vault')
PRELOAD_TEXT = ('local_preload_libraries||default|\n'
                'session_preload_libraries|supautils|configuration file|/etc/postgresql/postgresql.conf\n'
                'shared_preload_libraries|%s|configuration file|/etc/postgresql/postgresql.conf\n' % S_LIST)
RES_MEMBERSHIPS = ('pg_read_server_files, pg_write_server_files, pg_execute_server_program, supabase_admin, '
                   'supabase_auth_admin, supabase_storage_admin, supabase_read_only_user, supabase_realtime_admin, '
                   'supabase_replication_admin, supabase_etl_admin, dashboard_user, pgbouncer, authenticator')
RES_ROLES = ('supabase_admin, supabase_auth_admin, supabase_storage_admin, supabase_read_only_user, '
             'supabase_realtime_admin, supabase_replication_admin, supabase_etl_admin, dashboard_user, pgbouncer, '
             'service_role*, authenticator*, authenticated*, anon*, supabase_privileged_role')
SU = '/etc/postgresql-custom/supautils.conf'
GUC_TEXT = ('supautils.privileged_extensions_superuser|supabase_admin|configuration file|%s\n'
            'supautils.privileged_role|supabase_privileged_role|configuration file|%s\n'
            'supautils.reserved_memberships|%s|configuration file|%s\n'
            'supautils.reserved_roles|%s|configuration file|%s\n') % (SU, SU, RES_MEMBERSHIPS, SU, RES_ROLES, SU)
READY_OUT = 't|%s|%s\n' % (ex.LOG_FILE, POSTMASTER)

SOURCE_MANIFEST = {'driver.mjs': '1' * 64, 'entrypoint.mjs': '2' * 64, 'run_candidate.mjs': '3' * 64}
ARTIFACT_BYTES = {
    '/bundle/client/index.js': ('module.exports={} ' + ex.CLIENT_VERSION_MARKER + ' ' + ex.ENGINE_VERSION_MARKER + ' '
                                + '"relativeEnvPaths": { ' + ex.ROOT_ENV_MARKER + ' }').encode(),
    '/bundle/client/package.json': b'{"name":"c"}',
    '/bundle/client/schema.prisma': b'datasource db {}',
    '/bundle/client/runtime/library.js': b'runtime',
    '/bundle/client/libquery_engine-debian-openssl-3.0.x.so.node': b'ELF',
    NODE_PATH: b'NODE',
}
CLIENT_ARTIFACTS = {p: {'sha256': sha(b), 'bytes': len(b)} for p, b in ARTIFACT_BYTES.items()}
ARTIFACTS_SHA = sha(ex.js_canonical({p: sha(b) for p, b in ARTIFACT_BYTES.items()}).encode())


def good_approval(**over):
    a = {'purpose': 'ONE_ISOLATED_DB_CANDIDATE', 'attempt_id': ATTEMPT, 'owner_decision_sha256': OWNER,
         'source_manifest_sha256': sha(ex.js_canonical(SOURCE_MANIFEST).encode()), 'client_artifacts_sha256': ARTIFACTS_SHA,
         'criterion': 'REPLACEMENT_REGRESSION_NOT_HISTORICAL', 'historical_status': 'NOT_REPRODUCED',
         'r3_status': 'OPEN', 'issued_at_utc': '2026-10-26T10:00:00Z', 'single_attempt': True}
    a.update(over)
    return a


def good_binding(**over):
    b = {'attempt_id': ATTEMPT, 'owner_decision_sha256': OWNER, 'config_digest': CONFIG, 'image': IMAGE,
         'client_artifacts_sha256': ARTIFACTS_SHA}
    b.update(over)
    return b


def good_closure_evidence(**over):
    s = {'oci_closure_status': 'OCI_CLOSURE_VERIFIED', 'config_digest': CONFIG,
         'facts_missing': ['shared_preload_libraries', 'supautils_gucs'],
         'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN'}
    s.update(over)
    return {'summary': s}


OFFLINE_FACTS = [f for f in rc.REQUIRED_CLOSURE_FACTS if f not in ex.CONTAINER_ONLY]
OFFLINE_BYTES = {'/custody/' + f: ('bytes-' + f).encode() for f in OFFLINE_FACTS}
FAKE_REFERENCE = {'postgresql_conf': sha(b'bytes-postgresql_conf'), 'supautils_conf': sha(b'bytes-supautils_conf')}


class UsesFakeReference(unittest.TestCase):
    """The fake custody bytes stand in for the real conf files; a separate test locks the real hashes."""
    def setUp(self):
        self._ref = ex.REFERENCE_CONF_SHA256
        ex.REFERENCE_CONF_SHA256 = dict(FAKE_REFERENCE)

    def tearDown(self):
        ex.REFERENCE_CONF_SHA256 = self._ref


def offline_index():
    idx = {f: {'path': '/custody/' + f, 'sha256': sha(OFFLINE_BYTES['/custody/' + f])} for f in OFFLINE_FACTS}
    idx['_oci_closure'] = {'status': 'OCI_CLOSURE_VERIFIED', 'config_digest': CONFIG}
    return idx


def good_config(**over):
    c = {'work_dir': '/w', 'approval': good_approval(), 'binding': good_binding(),
         'closure_evidence': good_closure_evidence(), 'execute': True, 'endpoint_port': PORT,
         'config_digest': CONFIG, 'image': IMAGE, 'collision_query': FIX['c'], 'role_setting_query': FIX['r'],
         'preload_query': 'Q-PRELOAD', 'supautils_query': 'Q-SUPAUTILS', 'setup_script': SETUP,
         'setup_sha256': ex.SETUP_SHA256, 'source_root': '/src', 'nonces': list(NONCES), 'correlation_id': '9' * 32,
         'source_manifest': dict(SOURCE_MANIFEST), 'client_artifacts': copy.deepcopy(CLIENT_ARTIFACTS),
         'node_path': NODE_PATH, 'closure_offline_index': offline_index()}
    c.update(over)
    return c


def _driver_ceiling():
    cases = []
    for (case_id, statement, sqlstate), rep in ve.CASE_ORDER:
        cases.append({'id': case_id, 'repetition': rep, 'statement_sha256': sha(statement.encode()),
                      'expected_sqlstate': sqlstate, 'observed_sqlstate': sqlstate, 'unexpected_success': False,
                      'recovery_failure': None, 'controls_passed': True})
    return {'status': ve.CEILING, 'historical_status': 'NOT_REPRODUCED', 'qualification': False,
            'installation_success': False, 'cases': cases, 'failure': None, 'cleanup_failures': [],
            'required_external_evidence': []}


DRIVER_CEILING = _driver_ceiling()
LANE_NONCE = {'A': NONCES[0], 'B': NONCES[1], 'C': NONCES[2]}


def lane_gucs():
    return [{'name': 'local_preload_libraries', 'setting': '', 'source': 'default', 'sourcefile': None,
             'sourceline': None, 'pending_restart': False},
            {'name': 'supautils.reserved_roles', 'setting': RES_ROLES, 'source': 'configuration file',
             'sourcefile': None, 'sourceline': None, 'pending_restart': False}]


def build_events(driver_result, *, nonce=None, pid=None, postmaster=None, gucs=None, drop_lane=None):
    events, seq = [], 0

    def emit(kind, data):
        nonlocal seq
        seq += 1
        events.append({'sequence': seq, 'kind': kind, 'data': data})
    for lane in ('B', 'A', 'C'):
        if lane == drop_lane:
            continue
        identity = {'pid': (pid or {}).get(lane, PIDS[lane]), 'backend_start': 'x', 'postmaster_start': postmaster or POSTMASTER,
                    'current_user': 'regress_r3_probe', 'session_user': 'regress_r3_probe',
                    'database_name': 'regress_r3_candidate', 'server_version_num': '170011',
                    'transaction_read_only': 'off', 'nonce': (nonce or {}).get(lane, LANE_NONCE[lane]), 'positive': 1}
        emit('attestation-' + lane, {'lane': lane, 'phase': {'A': 'baseline-A', 'B': 'baseline-B', 'C': 'fresh-C'}[lane],
                                     'identity': identity, 'gucs': gucs if gucs is not None else lane_gucs()})
    emit('result', driver_result)
    return ('\n'.join(json.dumps(e) for e in events) + '\n').encode()


def jsonlog_interval():
    # Two LOG lines sit inside the stat brackets (10:00:00-10:00:01 at the start, 10:00:59-10:01:00 at the end),
    # so the interval must use the OUTER stamps (utc_before at the start, utc_after at the end).
    lines = [json.dumps({'timestamp': '2026-10-26 10:00:00.500 UTC', 'pid': 99, 'error_severity': 'LOG',
                         'message': 'checkpoint starting: time'})]
    for i, ((case_id, statement, sqlstate), rep) in enumerate(ve.CASE_ORDER):
        lines.append(json.dumps({'timestamp': '2026-10-26 10:00:%02d.000 UTC' % (20 + i), 'pid': PIDS['A'],
                                 'error_severity': 'ERROR', 'state_code': sqlstate, 'user': 'regress_r3_probe',
                                 'dbname': 'regress_r3_candidate', 'statement': statement,
                                 'application_name': 'r3_candidate_a', 'message': 'permission denied'}))
    lines.append(json.dumps({'timestamp': '2026-10-26 10:00:59.500 UTC', 'pid': 99, 'error_severity': 'LOG',
                             'message': 'checkpoint complete'}))
    return ('\n'.join(lines) + '\n').encode()


LIB_DEV, LIB_INO, LIB_SIZE = 0xfd01, 4242, 300000
MAPS = ('7f0000000000-7f0000010000 r--p 00000000 fd:01 %d %s\n'
        '7f0000010000-7f0000040000 r-xp 00010000 fd:01 %d %s\n') % (LIB_INO, ex.LIBRARY_PATH, LIB_INO, ex.LIBRARY_PATH)


class FakeOps:
    def __init__(self, config=None, **faults):
        self.config = config or good_config()
        self.faults = faults
        self.fs = dict(OFFLINE_BYTES)
        self.fs.update(ARTIFACT_BYTES)
        self.fs.update(faults.get('artifact_bytes', {}))
        self.calls, self.secrets, self.written_plain, self.consumed, self.removed = [], [], [], [], []
        self.log_calls = 0

    def _fault(self, name):
        if name in self.faults:
            raise self.faults[name]

    def bundle(self):
        o = self

        def run(argv, label):
            o.calls.append(('run', label))
            o._fault('run:' + label)
            return {'run-container': CID.encode() + b'\n',
                    'inspect-image': json.dumps({'id': CONFIG, 'os': 'linux', 'architecture': 'amd64',
                                                 'repoDigests': [o.faults.get('repo', IMAGE)]}).encode(),
                    'inspect-container': json.dumps(CONFIG).encode(),
                    'port': o.faults.get('port_out', '127.0.0.1:%d\n' % PORT).encode()}.get(label, b'')

        def psql(sql, label):
            o.calls.append(('psql', label))
            expected = {'ready': ex.READY_QUERY, 'admin-log': ex.ADMIN_LOG_QUERY, 'collision': o.config['collision_query'],
                        'setup': o.config['setup_script'], 'role-settings-before': o.config['role_setting_query'],
                        'role-settings-after': o.config['role_setting_query'], 'preload-before': o.config['preload_query'],
                        'preload-after': o.config['preload_query'], 'supautils-before': o.config['supautils_query'],
                        'supautils-after': o.config['supautils_query']}[label]
            assert sql == expected, 'wrong SQL sent for ' + label        # the query->parser contract is exercised
            o._fault('psql:' + label)
            out = {'ready': o.faults.get('ready', READY_OUT), 'admin-log': o.faults.get('admin_log', 'none|none|-1\n'),
                   'role-settings-before': '0\n', 'role-settings-after': o.faults.get('role_after', '0\n'),
                   'collision': '0|0\n', 'preload-before': o.faults.get('preload', PRELOAD_TEXT),
                   'preload-after': o.faults.get('preload_after', o.faults.get('preload', PRELOAD_TEXT)),
                   'supautils-before': o.faults.get('gucs', GUC_TEXT),
                   'supautils-after': o.faults.get('gucs_after', o.faults.get('gucs', GUC_TEXT))}.get(label, '')
            return out.encode()

        def write(path, data):
            o.calls.append(('write', path))
            o.written_plain.append((path, data))
            o.fs[path] = data

        def write_secret(path, text):
            o.calls.append(('write_secret', path))
            o.secrets.append(path)
            o.fs[path] = text.encode()

        def run_candidate(descriptor_path, servicer):
            o.calls.append(('run_candidate', descriptor_path))
            o._fault('run_candidate')
            lanes = []
            for lane in ('B', 'A', 'C'):
                if lane in o.faults.get('drop_lanes', ()):
                    continue
                nonce = o.faults.get('lane_nonce', {}).get(lane, LANE_NONCE[lane])
                lanes.append(servicer(lane, {'lane': lane, 'pid': PIDS[lane], 'nonce': nonce}, {'read_maps': lambda p: MAPS}))
            result = copy.deepcopy(o.faults.get('driver_result', DRIVER_CEILING))
            o.fs['/w/candidate/candidate-result.json'] = json.dumps(result).encode()
            o.fs['/w/candidate/candidate-events.jsonl'] = o.faults.get('events', build_events(result))
            return lanes

        def seal(work, allowlist):
            o.calls.append(('seal', tuple(allowlist)))
            o._fault('seal')
            return {'sealed': True}

        def log_position():
            o.log_calls += 1
            first = o.log_calls == 1
            return {'offset': 1000 if first else 1000 + len(jsonlog_interval()), 'inode': 7,
                    'stderr_size': 0 if first else o.faults.get('stderr_after', 0),
                    'utc_before': '2026-10-26T10:00:00.000000Z' if first else '2026-10-26T10:00:59.000000Z',
                    'utc_after': '2026-10-26T10:00:01.000000Z' if first else '2026-10-26T10:01:00.000000Z'}

        def observe(path):
            if path == ex.LIBRARY_PATH:
                st = 'regular file|%d|%d|%d' % (LIB_DEV, LIB_INO, LIB_SIZE)
                return st, '%s  %s' % (ll.EXPECTED_LIBRARY_SHA256, path), st
            st = 'regular file|%d|77|900' % LIB_DEV
            return st, '%s  %s' % (ll.EXPECTED_RECEIPT_SHA256, path), st

        def hash_file(path):
            o.calls.append(('hash_file', path))
            data = o.fs[path]
            return sha(data), len(data)

        counter = iter(range(1, 100))
        states = list(o.faults.get('states', [o.faults.get('state', {'restart_count': 0, 'oom_killed': False,
                                                                     'started_at': 't0', 'running': True, 'exit_code': 0})] * 2))

        def read_log_interval(off, n):
            assert off == 1000 and n == len(o.faults.get('log_bytes', jsonlog_interval())), (off, n)   # the measured interval
            return o.faults.get('log_bytes', jsonlog_interval())
        return {
            'host_lock': lambda: (o.calls.append(('host_lock',)), o._fault('host_lock')),
            'run': run, 'psql_bootstrap': psql, 'write': write, 'write_secret': write_secret,
            'read_bytes': lambda p: o.fs[p], 'sha256': sha, 'hash_file': hash_file,
            'realpath': lambda p: o.faults.get('realpath', p),
            'docker_object_exists': lambda kind, name: (o.calls.append(('exists', name)), name in o.faults.get('existing', ()))[1],
            'assert_fresh_work_dir': lambda p: (o.calls.append(('fresh', p)), o._fault('fresh')),
            'remove_secret': lambda p: (o.removed.append(p), o._fault('remove_secret')),
            'gen_secret': lambda: 'f' * 60 + str(next(counter)).zfill(4),
            'consume_attempt': lambda a: (o.calls.append(('consume', a)), o._fault('consume'), o.consumed.append(a)),
            'ensure_image': lambda: o.calls.append(('ensure_image',)),
            'wait_ready': lambda: o.calls.append(('wait_ready',)),
            'container_state': lambda: dict(states.pop(0)),
            'log_position': log_position,
            'set_probe_password': lambda pw: (o.calls.append(('set_probe_password',)), o.fs.__setitem__('__pw', pw)),
            'utc_now': lambda: o.faults.get('now', '2026-10-26T10:05:00.000000Z'),
            'port_free': lambda port: (o.calls.append(('port_free', port)), o.faults.get('port_free', True))[1],
            'make_empty_private_dir': lambda p: o.calls.append(('mkdir', p)),
            'run_candidate': run_candidate,
            'observe_library': observe,
            'read_log_interval': read_log_interval,
            'seal': seal,
        }


def real_mods(**over):
    m = {'contract': rc, 'read_closure': rc.read_startup_closure, 'loaded_library': ll.validate_loaded_library,
         'validate_log': ve.validate_log_interval, 'assemble': ve.assemble_result}
    m.update(over)
    return m


class _Open:
    def __init__(self, missing=('pg_hba_conf',)):
        self.status = 'OPEN_UNRESOLVED'
        self.missing = list(missing)
        self.oci_closure = {'status': 'OCI_CLOSURE_VERIFIED', 'config_digest': CONFIG}

    def to_json(self):
        return {'status': self.status, 'missing': self.missing}


# ---------------------------------------------------------------------------------------------------
class AuthorizationTests(unittest.TestCase):
    def ok(self, **kw):
        return ex.validate_execution_authorization(kw.get('approval', good_approval()), kw.get('binding', good_binding()),
                                                   kw.get('closure', good_closure_evidence()), execute_flag=kw.get('flag', True))

    def refuse(self, code, **kw):
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            self.ok(**kw)
        self.assertEqual(ctx.exception.code, code)

    def test_positive(self):
        self.assertEqual(self.ok(), ATTEMPT)

    def test_negatives(self):
        self.refuse('NO_EXECUTE_FLAG', flag=False)
        self.refuse('NO_EXECUTE_FLAG', flag='yes')
        self.refuse('NO_EXECUTE_FLAG', flag=1)
        self.refuse('APPROVAL_SHAPE', approval={**good_approval(), 'extra': 1})
        self.refuse('APPROVAL_PURPOSE', approval=good_approval(purpose='OTHER'))
        self.refuse('APPROVAL_CRITERION', approval=good_approval(criterion='HISTORICAL'))
        self.refuse('APPROVAL_HISTORICAL', approval=good_approval(historical_status='REPRODUCED'))
        self.refuse('APPROVAL_R3', approval=good_approval(r3_status='CLOSED'))
        self.refuse('APPROVAL_SINGLE_ATTEMPT', approval=good_approval(single_attempt=1))
        self.refuse('APPROVAL_ATTEMPT', approval=good_approval(attempt_id='A' * 32), binding=good_binding(attempt_id='A' * 32))
        self.refuse('BINDING_ATTEMPT', binding=good_binding(attempt_id='f' * 32))
        self.refuse('OWNER_DECISION', binding=good_binding(owner_decision_sha256='9' * 64))
        self.refuse('CLOSURE_OCI', closure=good_closure_evidence(oci_closure_status='OCI_EVIDENCE_INCOMPLETE'))
        self.refuse('CLOSURE_CONFIG', closure=good_closure_evidence(config_digest='sha256:' + '0' * 64))
        self.refuse('CLOSURE_MISSING_SET', closure=good_closure_evidence(facts_missing=['supautils_gucs']))
        self.refuse('CLOSURE_STATUS', closure=good_closure_evidence(r3_status='CLOSED'))


class RunPlanTests(unittest.TestCase):
    def plan(self):
        return ex.build_run_plan(rc, port=PORT, env_file='/w/inputs/postgres.env')

    def test_deviations_applied(self):
        p = self.plan()
        self.assertNotIn('--internal', p['create_network'])
        run = p['run_container']
        self.assertIn(ex.CONFIG_VOLUME + ':' + ex.CONFIG_DIR, run)
        i = run.index(IMAGE)
        self.assertEqual(tuple(run[i + 1:i + 4]), ex.IMAGE_CMD)
        self.assertEqual(tuple(run[i + 4:]), ex.LOG_INSTRUMENTATION)
        self.assertIn('log_filename=r3.log', run)                   # B2: jsonlog then writes r3.json
        self.assertTrue(ex.LOG_FILE.endswith('/r3.json') and ex.STDERR_LOG_FILE.endswith('/r3.log'))
        self.assertEqual(run[run.index('--publish') + 1], '127.0.0.1:%d:5432' % PORT)
        self.assertEqual(run[run.index('--env-file') + 1], '/w/inputs/postgres.env')
        self.assertIn('--read-only', run)
        # D8: the socket dir (canonical /run/postgresql; /var/run -> ../run in the image) and the log dir
        # belong to postgres (uid 100/gid 101) so the root entrypoint never needs CAP_CHOWN.
        self.assertIn('/run/postgresql:rw,nosuid,nodev,size=16m,uid=100,gid=101,mode=3775', run)
        self.assertNotIn('/var/run/postgresql:rw,nosuid,nodev,size=16m', run)
        self.assertIn(ex.LOG_DIR + ':rw,nosuid,nodev,noexec,size=32m,uid=100,gid=101,mode=0700', run)
        self.assertIn('D8-postgres-owned-tmpfs', p['deviations'])
        self.assertEqual([c[-1] for c in p['teardown']],
                         [rc.CONTAINER_NAME, rc.CONTAINER_NAME, rc.NETWORK_NAME, rc.VOLUME_NAME, ex.CONFIG_VOLUME])

    def test_input_refusals(self):
        for port in (80, 70000, '54329'):
            with self.assertRaises(ex.ExecutorRefusal):
                ex.build_run_plan(rc, port=port, env_file='/w/e')
        with self.assertRaises(ex.ExecutorRefusal):
            ex.build_run_plan(rc, port=PORT, env_file='relative/e')

    def _fake_contract(self, run_mutator=None, net=None):
        class C:
            DOCKER = rc.DOCKER; IMAGE = rc.IMAGE; CONTAINER_NAME = rc.CONTAINER_NAME
            NETWORK_NAME = rc.NETWORK_NAME; VOLUME_NAME = rc.VOLUME_NAME
            plan_create_volume = staticmethod(rc.plan_create_volume)
            plan_create_network = staticmethod(lambda: net if net is not None else rc.plan_create_network())
            plan_run_container = staticmethod(lambda: run_mutator(rc.plan_run_container()) if run_mutator else rc.plan_run_container())
        return C

    def test_hardening_mutants_refused(self):
        def host_net(argv):
            argv = list(argv); argv[argv.index('--network') + 1] = 'host'; return argv
        def sock_volume(argv):
            argv = list(argv); argv[-1:-1] = ['--volume', '/var/run/docker.sock:/var/run/docker.sock']; return argv
        def sock_v(argv):
            argv = list(argv); argv[-1:-1] = ['-v', '/var/run/docker.sock:/s']; return argv
        def sock_mount(argv):
            argv = list(argv); argv[-1:-1] = ['--mount', 'type=bind,src=/var/run/docker.sock,dst=/s']; return argv
        def priv(argv):
            argv = list(argv); argv[-1:-1] = ['--privileged']; return argv
        def placeholder(argv):
            argv = list(argv); argv[-1:-1] = ['--label', '<LEFTOVER>']; return argv
        def wrong_image(argv):
            return list(argv[:-1]) + ['supabase/postgres:latest']
        def flag_forms(extra):
            def mut(argv):
                argv = list(argv); argv[-1:-1] = list(extra); return argv
            mut.__name__ = 'flag:' + ' '.join(extra)
            return mut
        def socket_changed(argv):
            return [a.replace('size=16m', 'size=8m') if a.startswith('/var/run/postgresql') else a for a in argv]
        for mut, code in ((host_net, 'RUN_NOT_HARDENED'), (sock_volume, 'RUN_NOT_HARDENED'), (sock_v, 'RUN_NOT_HARDENED'),
                          (sock_mount, 'RUN_NOT_HARDENED'), (priv, 'RUN_NOT_HARDENED'),
                          (placeholder, 'PLACEHOLDER_LEFT'), (wrong_image, 'BASE_RUN_IMAGE'),
                          (socket_changed, 'SOCKET_TMPFS_NOT_OWNED'),
                          (flag_forms(['--privileged=true']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--network=host']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--net', 'host']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--volume=/var/run/docker.sock:/s']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--mount=type=bind,src=/var/run/docker.sock,dst=/s']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['-v/var/run/docker.sock:/s']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--pid=host']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--pid', 'host']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--ipc=host']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--userns=host']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--device=/dev/mem']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--cap-add=ALL']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--cap-add', 'SYS_ADMIN']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--security-opt', 'seccomp=unconfined']), 'RUN_NOT_HARDENED'),
                          (flag_forms(['--security-opt=apparmor=unconfined']), 'RUN_NOT_HARDENED')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.build_run_plan(self._fake_contract(mut), port=PORT, env_file='/w/e')
            self.assertEqual(ctx.exception.code, code, mut.__name__)
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ex.build_run_plan(self._fake_contract(net=['docker', 'network', 'create', 'x']), port=PORT, env_file='/w/e')
        self.assertEqual(ctx.exception.code, 'BASE_NETWORK_SHAPE')

    def test_publish_not_loopback_refused(self):
        for bind in ('0.0.0.0:54329:5432', '54329:5432', '[::]:54329:5432'):
            def wide(argv, bind=bind):
                argv = list(argv); argv[argv.index('--publish') + 1] = bind; return argv
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.build_run_plan(self._fake_contract(wide), port=PORT, env_file='/w/e')
            self.assertEqual(ctx.exception.code, 'PUBLISH_NOT_LOOPBACK', bind)


class SmallGateTests(unittest.TestCase):
    def test_port_mapping(self):
        self.assertTrue(ex.verify_port_mapping('127.0.0.1:%d\n' % PORT, PORT))
        for bad in ('0.0.0.0:%d\n' % PORT, '127.0.0.1:%d\n[::]:%d\n' % (PORT, PORT), '127.0.0.1:1\n', ''):
            with self.assertRaises(ex.ExecutorRefusal):
                ex.verify_port_mapping(bad, PORT)

    def test_image_identity(self):
        good = {'id': CONFIG, 'os': 'linux', 'architecture': 'amd64', 'repoDigests': [IMAGE]}
        self.assertTrue(ex.verify_image_identity(good, CONFIG, expect_config_digest=CONFIG, expect_image_ref=IMAGE))
        for mutated, cimg, code in (({**good, 'id': 'sha256:' + '0' * 64}, CONFIG, 'IMAGE_ID'),
                                    ({**good, 'architecture': 'arm64'}, CONFIG, 'IMAGE_PLATFORM'),
                                    ({**good, 'repoDigests': ['supabase/postgres@sha256:' + '1' * 64]}, CONFIG, 'IMAGE_REPO_DIGEST'),
                                    (good, 'sha256:' + '2' * 64, 'CONTAINER_IMAGE')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.verify_image_identity(mutated, cimg, expect_config_digest=CONFIG, expect_image_ref=IMAGE)
            self.assertEqual(ctx.exception.code, code)

    def test_collision(self):
        self.assertTrue(ex.interpret_collision('0|0\n'))
        for bad, code in (('1|0\n', 'COLLISION_PRESENT'), ('0|1\n', 'COLLISION_PRESENT'), ('0\n', 'COLLISION_SHAPE'),
                          ('0|0\n0|0\n', 'COLLISION_CARDINALITY'), ('x|0', 'COLLISION_SHAPE')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.interpret_collision(bad)
            self.assertEqual(ctx.exception.code, code)

    def test_setup_script(self):
        self.assertTrue(ex.check_setup_script(SETUP, ex.SETUP_SHA256, hasher=sha))
        self.assertEqual(sha(SETUP.encode()), ex.SETUP_SHA256)        # the pin is the real fixture-sql script
        with self.assertRaises(ex.ExecutorRefusal):
            ex.check_setup_script(SETUP, 'f' * 64, hasher=sha)
        bad = SETUP + "ALTER ROLE regress_r3_probe PASSWORD 'x';\n"
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ex.check_setup_script(bad, sha(bad.encode()), hasher=sha)
        self.assertEqual(ctx.exception.code, 'SETUP_CARRIES_PASSWORD')

    def test_safe_code_never_carries_a_message(self):
        self.assertEqual(ex.safe_code(ex.ExecutorRefusal('PORT_MAPPING')), 'PORT_MAPPING')
        for exc in (RuntimeError('postgresql://u:hunter2@h/db'), ValueError('x'), KeyError('password')):
            self.assertEqual(ex.safe_code(exc), 'UNEXPECTED_' + type(exc).__name__)
        self.assertEqual(ex.safe_code(ex.ExecutorRefusal('has space and :// url')), 'UNEXPECTED_ExecutorRefusal')
        self.assertEqual(ex.safe_code(ex.ExecutorRefusal('A' * 97)), 'UNEXPECTED_ExecutorRefusal')


class ReadyAndLiveCheckTests(unittest.TestCase):
    def test_ready_proves_real_server_and_log_file(self):
        self.assertEqual(ex.interpret_ready(READY_OUT), {'postmaster_start': POSTMASTER})
        for text, code in (('f|%s|%s\n' % (ex.LOG_FILE, POSTMASTER), 'READY_TEMP_SERVER'),
                           ('t|%s.json|%s\n' % (ex.LOG_FILE, POSTMASTER), 'READY_JSONLOG_FILE'),
                           ('t||%s\n' % POSTMASTER, 'READY_JSONLOG_FILE'),
                           ('t|%s|\n' % ex.LOG_FILE, 'READY_POSTMASTER_START'),
                           (READY_OUT + READY_OUT, 'READY_CARDINALITY'), ('t|x\n', 'READY_SHAPE')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.interpret_ready(text)
            self.assertEqual(ctx.exception.code, code)
        self.assertIn("SET TIME ZONE 'UTC'", ex.READY_QUERY)
        self.assertIn("pg_current_logfile('jsonlog')", ex.READY_QUERY)
        self.assertIn("current_setting('listen_addresses') <> ''", ex.READY_QUERY)

    def test_admin_log_and_role_settings(self):
        self.assertTrue(ex.interpret_admin_log('none|none|-1\n'))
        self.assertTrue(ex.interpret_admin_log('none||-1\n'))                    # pgaudit.log unset
        for bad, code in (('ddl|none|-1\n', 'ADMIN_LOG_STATEMENT_NOT_NONE'), ('all|none|-1\n', 'ADMIN_LOG_STATEMENT_NOT_NONE'),
                          ('none|ddl|-1\n', 'ADMIN_PGAUDIT_LOGS'), ('none|all|-1\n', 'ADMIN_PGAUDIT_LOGS'),
                          ('none|none|0\n', 'ADMIN_DURATION_LOGS_STATEMENTS'), ('none|none|250ms\n', 'ADMIN_DURATION_LOGS_STATEMENTS'),
                          ('', 'ADMIN_LOG_SHAPE'), ('none|none\n', 'ADMIN_LOG_SHAPE'), ('none|none|-1\nx|y|z\n', 'ADMIN_LOG_SHAPE')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.interpret_admin_log(bad)
            self.assertEqual(ctx.exception.code, code)
        for needle in ("current_setting('log_statement')", "current_setting('pgaudit.log', true)",
                       "current_setting('log_min_duration_statement')"):
            self.assertIn(needle, ex.ADMIN_LOG_QUERY)
        self.assertTrue(ex.interpret_role_settings('0\n', 'BEFORE'))
        for bad in ('1\n', '', '0\n0\n'):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.interpret_role_settings(bad, 'AFTER')
            self.assertEqual(ctx.exception.code, 'ROLE_SETTINGS_AFTER')

    def test_container_state_normalized_for_the_validator(self):
        running = ex.normalize_container_state({'restart_count': 0, 'oom_killed': False, 'started_at': 't', 'running': True, 'exit_code': 0})
        self.assertIsNone(running['exit_code'])
        stopped = ex.normalize_container_state({'restart_count': 0, 'oom_killed': False, 'started_at': 't', 'running': False, 'exit_code': 137})
        self.assertEqual(stopped['exit_code'], 137)
        for bad in ({'running': True}, {'restart_count': '0', 'oom_killed': False, 'started_at': 't', 'running': True, 'exit_code': 0}):
            with self.assertRaises(ex.ExecutorRefusal):
                ex.normalize_container_state(bad)


class PreloadAndGucTests(unittest.TestCase):
    def test_captured_shape_passes_with_session_preload(self):
        rows = ex.parse_preload_rows(PRELOAD_TEXT)
        self.assertEqual(rows['session_preload_libraries']['list'], ['supautils'])
        self.assertNotIn('supautils', rows['shared_preload_libraries']['list'])

    def test_supautils_only_in_shared_is_refused(self):
        text = PRELOAD_TEXT.replace('session_preload_libraries|supautils|', 'session_preload_libraries||') \
                           .replace('supabase_vault|', 'supabase_vault, supautils|')
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ex.parse_preload_rows(text)
        self.assertEqual(ctx.exception.code, 'SUPAUTILS_NOT_SESSION_PRELOADED_ONCE')

    def test_preload_negatives(self):
        twice = PRELOAD_TEXT.replace('session_preload_libraries|supautils|', 'session_preload_libraries|supautils, supautils|')
        missing_row = '\n'.join(PRELOAD_TEXT.splitlines()[1:])
        dup = PRELOAD_TEXT + PRELOAD_TEXT.splitlines()[0] + '\n'
        bad_name = PRELOAD_TEXT + 'dynamic_library_path|$libdir|default|\n'
        for text, code in ((twice, 'SUPAUTILS_NOT_SESSION_PRELOADED_ONCE'), (missing_row, 'PRELOAD_SET'),
                           (dup, 'PRELOAD_DUPLICATE'), (bad_name, 'PRELOAD_NAME'), ('a|b\n', 'PRELOAD_FIELDS')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.parse_preload_rows(text)
            self.assertEqual(ctx.exception.code, code)

    def test_prefix_wildcard_and_every_scanned_setting(self):
        gucs = ex.parse_supautils_gucs(GUC_TEXT)
        self.assertTrue(ex.assert_fixture_not_reserved(gucs))
        for key, value in (('supautils.reserved_roles', RES_ROLES + ', regress*'),
                           ('supautils.reserved_memberships', RES_MEMBERSHIPS + ', regress_r3_probe'),
                           ('supautils.privileged_role', 'regress_r3_target'),
                           ('supautils.privileged_extensions_superuser', 'regress_r3_probe')):
            mutated = dict(gucs); mutated[key] = dict(gucs[key], setting=value)
            with self.assertRaises(ex.ExecutorRefusal, msg=key):
                ex.assert_fixture_not_reserved(mutated)
        su = dict(gucs); su['supautils.superuser'] = {'setting': 'regress_r3_target', 'source': 'configuration file', 'sourcefile': SU}
        with self.assertRaises(ex.ExecutorRefusal):
            ex.assert_fixture_not_reserved(su)
        self.assertFalse(ex.role_matches('service_role*', 'regress_r3_probe'))
        self.assertFalse(ex.role_matches('regress_r3', 'regress_r3_probe'))

    def test_expected_effective_values_pinned(self):
        preload, gucs = ex.parse_preload_rows(PRELOAD_TEXT), ex.parse_supautils_gucs(GUC_TEXT)
        self.assertIn('supautils.reserved_roles', ex.check_expected_effective(preload, gucs))
        cases = (
            (PRELOAD_TEXT, GUC_TEXT.replace('anon*, ', ''), 'EFFECTIVE_DRIFT:supautils.reserved_roles'),
            (PRELOAD_TEXT, GUC_TEXT.replace('supabase_privileged_role|configuration file', 'supabase_privileged_role|command line'),
             'EFFECTIVE_DRIFT:supautils.privileged_role'),
            (PRELOAD_TEXT.replace('session_preload_libraries|supautils|configuration file|/etc/postgresql/postgresql.conf',
                                  'session_preload_libraries|supautils|command line|'), GUC_TEXT,
             'EFFECTIVE_DRIFT:session_preload_libraries'),
            (PRELOAD_TEXT.replace(', supabase_vault', ''), GUC_TEXT, 'EFFECTIVE_DRIFT:shared_preload_libraries'),
            (PRELOAD_TEXT, '\n'.join(l for l in GUC_TEXT.splitlines() if 'privileged_extensions' not in l) + '\n',
             'EFFECTIVE_MISSING:supautils.privileged_extensions_superuser'),
        )
        for p_text, g_text, code in cases:
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.check_expected_effective(ex.parse_preload_rows(p_text), ex.parse_supautils_gucs(g_text))
            self.assertEqual(ctx.exception.code, code)
        for alias_setting in ('someone_else', ''):                  # '' would trip the JS SUPERUSER_ALIAS_MISMATCH
            alias_bad = dict(gucs); alias_bad['supautils.superuser'] = {'setting': alias_setting, 'source': 'configuration file', 'sourcefile': SU}
            with self.assertRaises(ex.ExecutorRefusal):
                ex.check_expected_effective(preload, alias_bad)
        moved = dict(gucs); moved['supautils.reserved_roles'] = dict(gucs['supautils.reserved_roles'], sourcefile='/etc/postgresql-custom/conf.d/x.conf')
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ex.check_expected_effective(preload, moved)
        self.assertEqual(ctx.exception.code, 'EFFECTIVE_DRIFT:supautils.reserved_roles')
        alias_ok = dict(gucs); alias_ok['supautils.superuser'] = {'setting': 'supabase_admin', 'source': 'configuration file', 'sourcefile': SU}
        self.assertTrue(ex.check_expected_effective(preload, alias_ok))

    def test_reference_hashes_match_the_custody_bytes(self):
        conf = {'postgresql_conf': os.path.join(CUSTODY, 'rootfs/etc/postgresql/postgresql.conf'),
                'supautils_conf': os.path.join(CUSTODY, 'rootfs/etc/postgresql-custom/supautils.conf')}
        if not all(os.path.exists(p) for p in conf.values()):
            self.skipTest('custody evidence not on this host')
        for fact, path in conf.items():
            self.assertEqual(sha(open(path, 'rb').read()), ex.REFERENCE_CONF_SHA256[fact], fact)
        text = open(conf['supautils_conf']).read()
        for name in ('reserved_roles', 'reserved_memberships', 'privileged_role', 'privileged_extensions_superuser'):
            line = re.search(r"^supautils\.%s\s*=\s*'([^']*)'" % name, text, re.M).group(1)
            self.assertEqual([p.strip() for p in line.split(',') if p.strip()], ex.EXPECTED_EFFECTIVE['supautils.' + name][0], name)
        pg = open(conf['postgresql_conf']).read()
        self.assertEqual(re.search(r"^session_preload_libraries\s*=\s*'([^']*)'", pg, re.M).group(1), 'supautils')
        shared = re.search(r"^shared_preload_libraries\s*=\s*'([^']*)'", pg, re.M).group(1)
        self.assertEqual([p.strip() for p in shared.split(',')], ex.EXPECTED_EFFECTIVE['shared_preload_libraries'][0])


class LaneEventTests(unittest.TestCase):
    def bootstrap(self):
        return ex.check_expected_effective(ex.parse_preload_rows(PRELOAD_TEXT), ex.parse_supautils_gucs(GUC_TEXT))

    def lanes(self, nonce=None):
        return [{'lane': l, 'phase': 'x', 'pid': PIDS[l], 'nonce': (nonce or {}).get(l, LANE_NONCE[l]), 'maps': MAPS} for l in 'BAC']

    def check(self, events, lanes=None, driver=DRIVER_CEILING):
        return ex.check_lane_events(ex.parse_events(events), lanes or self.lanes(), self.bootstrap(), POSTMASTER, NONCES, driver)

    def test_positive(self):
        self.assertTrue(self.check(build_events(DRIVER_CEILING)))

    def test_negatives(self):
        foreign = {'A': 'f' * 32}
        cases = (
            (build_events(DRIVER_CEILING, nonce=foreign), self.lanes(nonce=foreign), 'ATTEST_EVENT_NONCE'),
            (build_events(DRIVER_CEILING, pid={'B': 99}), None, 'ATTEST_EVENT_PID'),
            (build_events(DRIVER_CEILING, postmaster='2026-10-26 10:09:00+00'), None, 'POSTMASTER_CHANGED'),
            (build_events(DRIVER_CEILING, drop_lane='C'), None, 'ATTEST_EVENT_SET'),
            (build_events(DRIVER_CEILING, gucs=[lane_gucs()[0], dict(lane_gucs()[1], setting='supabase_admin')]), None,
             'LANE_GUC_OVERRIDE:supautils.reserved_roles'),
            (build_events(DRIVER_CEILING, gucs=[lane_gucs()[0], {'name': 'supautils.privileged_role_allowed_configs', 'setting': 'x',
                                                                 'source': 'session', 'sourcefile': None}]), None,
             'LANE_GUC_SOURCE:supautils.privileged_role_allowed_configs'),
            (build_events(DRIVER_CEILING, gucs=[]), None, 'LANE_GUCS_NOT_READ'),
            (build_events(DRIVER_CEILING, gucs=[lane_gucs()[1]]), None, 'LANE_GUCS_NOT_READ'),
            (build_events(DRIVER_CEILING, gucs=[dict(lane_gucs()[0], sourcefile='/etc/x')]), None, 'LANE_GUC_SOURCEFILE'),
        )
        for events, lanes, code in cases:
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                self.check(events, lanes)
            self.assertEqual(ctx.exception.code, code)
        partial = copy.deepcopy(DRIVER_CEILING); partial['status'] = ve.PARTIAL
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            self.check(build_events(DRIVER_CEILING), driver=partial)
        self.assertEqual(ctx.exception.code, 'RESULT_EVENT')
        gap = build_events(DRIVER_CEILING).replace(b'"sequence": 2', b'"sequence": 5')
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            self.check(gap)
        self.assertEqual(ctx.exception.code, 'EVENT_SEQUENCE')


class LibraryRecordTests(unittest.TestCase):
    def test_record_accepted_by_loaded_library(self):
        rec = ex.library_record_from_exec('regular file|64769|1234|500000', '%s  %s' % (ll.EXPECTED_LIBRARY_SHA256, ex.LIBRARY_PATH),
                                          'regular file|64769|1234|500000', path=ex.LIBRARY_PATH, expected_size_cap=16 * 1024 * 1024)
        self.assertEqual(ll.validate_library_record(rec)['inode'], 1234)

    def test_record_negatives(self):
        good = ('regular file|1|2|10', '%s  %s' % ('a' * 64, ex.LIBRARY_PATH), 'regular file|1|2|10')
        for args, code in ((('symbolic link|1|2|10',) + good[1:], 'LIB_NOT_REGULAR'),
                           ((good[0], '%s  /other/path' % ('a' * 64), good[2]), 'LIB_SHA_SHAPE'),
                           ((good[0], 'zz  ' + ex.LIBRARY_PATH, good[2]), 'LIB_SHA_SHAPE'),
                           (('regular file|x|2|10',) + good[1:], 'LIB_STAT_NUMBERS'),
                           (('regular file|1|2',) + good[1:], 'LIB_STAT_SHAPE')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                ex.library_record_from_exec(*args, path=ex.LIBRARY_PATH, expected_size_cap=100)
            self.assertEqual(ctx.exception.code, code)
        with self.assertRaises(ex.ExecutorRefusal):
            ex.library_record_from_exec(*good, path=ex.LIBRARY_PATH, expected_size_cap=5)


class AttestationReceiptDescriptorTests(unittest.TestCase):
    def test_attestation(self):
        ops = {'read_maps': lambda pid: MAPS}
        rec = ex.service_one_attestation('B', {'lane': 'B', 'pid': 42, 'nonce': '1' * 32}, ops)
        self.assertEqual((rec['lane'], rec['phase'], rec['pid']), ('B', 'baseline-B', 42))
        for lane, req in (('A', {'lane': 'B', 'pid': 1, 'nonce': '1' * 32}), ('A', {'lane': 'A', 'pid': 0, 'nonce': '1' * 32}),
                          ('A', {'lane': 'A', 'pid': 1, 'nonce': 'X' * 32}), ('D', {'lane': 'D', 'pid': 1, 'nonce': '1' * 32})):
            with self.assertRaises(ex.ExecutorRefusal):
                ex.service_one_attestation(lane, req, ops)
        with self.assertRaises(ex.ExecutorRefusal):
            ex.service_one_attestation('A', {'lane': 'A', 'pid': 1, 'nonce': '1' * 32}, {'read_maps': lambda pid: ''})

    def test_receipt_matches_entrypoint_contract(self):
        r = ex.build_receipt(attempt=ATTEMPT, image=IMAGE, config_digest=CONFIG, container_id=CID, port=PORT,
                             closure_status='CLOSED_FROM_RETAINED_EVIDENCE', prepared_at_utc='2026-10-26T10:05:00Z')
        self.assertEqual(sorted(r), sorted(ex.RECEIPT_KEYS))
        self.assertEqual(r['endpoint_host'], '127.0.0.1')
        entry = open(os.path.join(HERE, 'entrypoint.mjs')).read()
        js_keys = re.search(r"const RECEIPT_KEYS = \[(.*?)\];", entry, re.S).group(1)
        self.assertEqual(sorted(re.findall(r"'([a-z_]+)'", js_keys)), sorted(ex.RECEIPT_KEYS))
        for kw in ({'closure_status': 'OPEN_UNRESOLVED'}, {'container_id': 'abc'}):
            args = dict(attempt=ATTEMPT, image=IMAGE, config_digest=CONFIG, container_id=CID, port=PORT,
                        closure_status='CLOSED_FROM_RETAINED_EVIDENCE', prepared_at_utc='x')
            args.update(kw)
            with self.assertRaises(ex.ExecutorRefusal):
                ex.build_receipt(**args)

    def test_descriptor_matches_harness_contract(self):
        d = ex.build_descriptor('/w', '/src', list(NONCES))
        harness = open(os.path.join(HERE, 'run_candidate.mjs')).read()
        js = re.search(r"const DESCRIPTOR_KEYS = \[(.*?)\];", harness, re.S).group(1)
        self.assertEqual(sorted(d), sorted(re.findall(r"'([A-Za-z]+)'", js)))
        self.assertEqual(d['outputDir'], '/w/candidate')
        with self.assertRaises(ex.ExecutorRefusal):
            ex.build_descriptor('/w', '/src', ['1' * 32, '1' * 32, '3' * 32])


class LogMetaTests(unittest.TestCase):
    def meta(self, **over):
        kw = dict(correlation_id='9' * 32, start_utc='2026-10-26T10:00:00.000000Z', end_utc='2026-10-26T10:01:00.000000Z',
                  offset_start=4096, offset_end=8192, inode_start=77, inode_end=77,
                  container_before={'restart_count': 0, 'oom_killed': False, 'started_at': 's', 'running': True, 'exit_code': None},
                  container_after={'restart_count': 0, 'oom_killed': False, 'started_at': 's', 'running': True, 'exit_code': None})
        kw.update(over)
        return ex.build_log_meta(**kw)

    def test_meta_shape_accepted_by_validator(self):
        m = self.meta()
        ve._validate_meta(m)
        self.assertEqual((m['captured_bytes'], m['truncated'], m['rotations']), (4096, False, 0))

    def test_truncation_rotation_and_utc(self):
        m = self.meta(offset_start=0, offset_end=ex.LOG_CAP_BYTES + 1, inode_end=78)
        self.assertTrue(m['truncated'])
        self.assertEqual(m['captured_bytes'], ex.LOG_CAP_BYTES)
        self.assertEqual(m['rotations'], 1)
        self.assertFalse(self.meta(offset_start=0, offset_end=ex.LOG_CAP_BYTES)['truncated'])
        with self.assertRaises(ex.ExecutorRefusal):
            self.meta(offset_start=10, offset_end=5)
        for over, code in (({'start_utc': '2026-10-26T10:00:00Z'}, 'LOG_UTC_FORMAT'),
                           ({'end_utc': '2026-10-26 10:01:00.000000'}, 'LOG_UTC_FORMAT'),
                           ({'start_utc': '2026-10-26T10:02:00.000000Z'}, 'LOG_UTC_ORDER')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                self.meta(**over)
            self.assertEqual(ctx.exception.code, code)


class PreflightBindingTests(unittest.TestCase):
    def pf(self, approval=None, binding=None, manifest=None):
        return ex.preflight_bindings(approval or good_approval(), binding or good_binding(),
                                     SOURCE_MANIFEST if manifest is None else manifest,
                                     image=IMAGE, config_digest=CONFIG, hasher=sha)

    def test_positive_and_negatives(self):
        self.assertTrue(self.pf())
        cases = (
            (dict(binding={k: v for k, v in good_binding().items() if k != 'client_artifacts_sha256'}), 'BINDING_KEY:client_artifacts_sha256'),
            (dict(binding=good_binding(image='supabase/postgres@sha256:' + '0' * 64)), 'BINDING_IMAGE'),
            (dict(binding=good_binding(config_digest='sha256:' + '0' * 64)), 'BINDING_IMAGE'),
            (dict(manifest={}), 'SOURCE_MANIFEST_SHAPE'),
            (dict(manifest={'sub/driver.mjs': '1' * 64}), 'SOURCE_MANIFEST_SHAPE'),
            (dict(manifest={'ü.mjs': '1' * 64}), 'SOURCE_MANIFEST_SHAPE'),
            (dict(manifest={**SOURCE_MANIFEST, 'extra.mjs': '5' * 64}), 'APPROVAL_SOURCE_MANIFEST'),
            (dict(approval=good_approval(client_artifacts_sha256='f' * 64)), 'APPROVAL_CLIENT_ARTIFACTS'),
        )
        for kw, code in cases:
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                self.pf(**kw)
            self.assertEqual(ctx.exception.code, code)

    def test_js_canonical_matches_entrypoint_hash_byte_for_byte(self):
        manifest = {'test_b-1.mjs': sha(b'x'), 'A.mjs': sha(b'y'), 'z.q.py': sha(b'z'), '0first': sha(b'w')}
        files = {'test_b-1.mjs': 'x', 'A.mjs': 'y', 'z.q.py': 'z', '0first': 'w'}
        script = ("const m = await import(new URL('./entrypoint.mjs', 'file://' + process.argv[1] + '/').href);"
                  "const files = JSON.parse(process.argv[2]);"
                  "process.stdout.write(m.validateSourceManifest(JSON.parse(process.argv[3]), { readBytes: n => Buffer.from(files[n]) }));")
        out = subprocess.run([NODE, '--input-type=module', '-e', script, HERE, json.dumps(files), json.dumps(manifest)],
                             capture_output=True, text=True, timeout=30, env={'PATH': '/usr/bin:/bin'})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), sha(ex.js_canonical(manifest).encode()))


# ---------------------------------------------------------------------------------------------------
class RunAttemptTests(UsesFakeReference):
    def run_it(self, config=None, mods=None, **faults):
        config = config or good_config()
        ops = FakeOps(config, **faults)
        result = ex.run_attempt(config, ops.bundle(), mods or real_mods())
        return result, ops

    def labels(self, ops, kind):
        return [c[1] for c in ops.calls if c[0] == kind]

    def kinds(self, ops):
        return [c[0] if c[0] not in ('run', 'psql') else c[0] + ':' + c[1] for c in ops.calls]

    def test_happy_path_reaches_ceiling_with_real_validators(self):
        result, ops = self.run_it()
        self.assertIsNone(result['failure'], result)
        self.assertEqual(result['status'], 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED', result['findings'])
        self.assertEqual((result['historical_status'], result['r3_status'], result['qualification']), ('NOT_REPRODUCED', 'OPEN', False))
        self.assertEqual(result['closure_status'], 'CLOSED_FROM_RETAINED_EVIDENCE')
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 5)
        for name in ('/w/closure.json', '/w/loaded-library.json', '/w/server-log.bounded', '/w/log-interval-meta.json'):
            self.assertIn(name, ops.fs, name)
        self.assertEqual(json.loads(ops.fs['/w/executor-result.json'])['status'], result['status'])
        self.assertEqual(sorted(ops.removed), ['/w/inputs/credential.json', '/w/inputs/postgres.env'])

    def test_unnormalized_running_exit_code_would_have_been_rejected(self):
        state0 = {'restart_count': 0, 'oom_killed': False, 'started_at': 't', 'running': True, 'exit_code': 0}
        meta = ex.build_log_meta(correlation_id='9' * 32, start_utc='2026-10-26T10:00:00.000000Z',
                                 end_utc='2026-10-26T10:01:00.000000Z', offset_start=0, offset_end=len(jsonlog_interval()),
                                 inode_start=7, inode_end=7, container_before=state0, container_after=state0)
        out = ve.validate_log_interval(jsonlog_interval(), meta, {'pids': PIDS, 'application_names': ex.APPLICATION_NAMES})
        self.assertEqual(out['status'], ve.REJECTED)
        normalized = ex.normalize_container_state(state0)
        meta = ex.build_log_meta(correlation_id='9' * 32, start_utc='2026-10-26T10:00:00.000000Z',
                                 end_utc='2026-10-26T10:01:00.000000Z', offset_start=0, offset_end=len(jsonlog_interval()),
                                 inode_start=7, inode_end=7, container_before=normalized, container_after=normalized)
        out = ve.validate_log_interval(jsonlog_interval(), meta, {'pids': PIDS, 'application_names': ex.APPLICATION_NAMES})
        self.assertEqual(out['status'], ve.LOG_CONSISTENT)

    def test_stopped_container_is_rejected_end_to_end(self):
        result, _ = self.run_it(state={'restart_count': 0, 'oom_killed': False, 'started_at': 't0', 'running': False, 'exit_code': 139})
        self.assertEqual(result['status'], 'REJECTED_REVIEW_REQUIRED')

    def test_ordering(self):
        _, ops = self.run_it()
        k = self.kinds(ops)
        first_mutation = min(i for i, x in enumerate(k) if x.startswith('run:') or x.startswith('psql:')
                             or x in ('ensure_image', 'write_secret'))
        self.assertLess(k.index('consume'), first_mutation)
        for name in (rc.CONTAINER_NAME, rc.NETWORK_NAME, rc.VOLUME_NAME, ex.CONFIG_VOLUME):
            self.assertLess(ops.calls.index(('exists', name)), k.index('consume'))
        self.assertLess(k.index('fresh'), k.index('consume'))
        self.assertLess(k.index('host_lock'), min(ops.calls.index(('exists', n)) for n in (rc.CONTAINER_NAME,)))
        self.assertLess(k.index('host_lock'), k.index('fresh'))
        self.assertLess(k.index('port_free'), k.index('consume'))
        self.assertLess(k.index('hash_file'), k.index('consume'))
        self.assertLess(k.index('run:port'), k.index('psql:ready'))
        self.assertLess(k.index('wait_ready'), k.index('psql:ready'))
        self.assertLess(k.index('psql:ready'), k.index('psql:admin-log'))
        self.assertLess(k.index('psql:admin-log'), k.index('psql:setup'))
        self.assertLess(k.index('psql:preload-before'), k.index('psql:setup'))
        self.assertLess(k.index('psql:setup'), k.index('set_probe_password'))
        cred = ops.calls.index(('write_secret', '/w/inputs/credential.json'))
        self.assertGreater(cred, ops.calls.index(('write', '/w/closure.json')))
        self.assertLess(cred, k.index('run_candidate'))
        self.assertGreater(k.index('psql:preload-after'), k.index('run_candidate'))

    def test_closure_not_closed_after_capture_stops_before_credential(self):
        calls = {'n': 0}

        def reader(idx, rb):
            calls['n'] += 1
            return rc.read_startup_closure(idx, rb) if calls['n'] == 1 else _Open(missing=[])
        result, ops = self.run_it(mods=real_mods(read_closure=reader))
        self.assertEqual(result['failure']['code'], 'CLOSURE_NOT_CLOSED')
        self.assertNotIn(('write_secret', '/w/inputs/credential.json'), ops.calls)
        self.assertNotIn('run_candidate', [c[0] for c in ops.calls])

    def test_preflight_refusals_consume_nothing(self):
        bad_artifacts = copy.deepcopy(CLIENT_ARTIFACTS); bad_artifacts['/bundle/client/index.js']['sha256'] = '0' * 64
        no_engine = {k: v for k, v in CLIENT_ARTIFACTS.items() if 'libquery_engine' not in k}
        cases = (
            (dict(config=good_config(endpoint_port=80)), {}, 'PORT_RANGE'),
            (dict(config=good_config(approval=good_approval(issued_at_utc='yesterday'))), {}, 'APPROVAL_ISSUED'),
            (dict(config=good_config(approval=good_approval(issued_at_utc='2026-02-30T25:61:61Z'))), {}, 'APPROVAL_ISSUED'),
            (dict(config=good_config(approval=good_approval(issued_at_utc='2026-10-26T10:00:00+99:99'))), {}, 'APPROVAL_ISSUED'),
            (dict(config=good_config(approval=good_approval(issued_at_utc='2026-10-27T00:00:00Z'))), {}, 'APPROVAL_FROM_THE_FUTURE'),
            (dict(config=good_config(approval=good_approval(issued_at_utc='2026-10-26T13:00:00+03:00'))), {'now': '2026-10-26T09:59:59.000000Z'},
             'APPROVAL_FROM_THE_FUTURE'),
            (dict(), {'port_free': False}, 'PORT_IN_USE'),
            (dict(config=good_config(image='supabase/postgres@sha256:' + '0' * 64,
                                     binding=good_binding(image='supabase/postgres@sha256:' + '0' * 64))), {}, 'IMAGE_PIN'),
            (dict(config=good_config(setup_sha256='0' * 64)), {}, 'SETUP_PIN'),
            (dict(config=good_config(setup_script=SETUP + '-- tampered\n')), {}, 'SETUP_SHA'),
            (dict(config=good_config(nonces=[NONCES[0], NONCES[0], NONCES[2]])), {}, 'NONCES'),
            (dict(config=good_config(correlation_id='nothex')), {}, 'CORRELATION_ID'),
            (dict(config=good_config(closure_offline_index={**offline_index(), 'supautils_gucs': {'path': '/x', 'sha256': 'a' * 64}})),
             {}, 'CLOSURE_INDEX_OVERLAP'),
            (dict(config=good_config(closure_offline_index={k: v for k, v in offline_index().items() if k != 'pg_hba_conf'})),
             {}, 'OFFLINE_CLOSURE_SET'),
            (dict(config=good_config(closure_offline_index={**offline_index(), '_oci_closure': {'status': 'OCI_CLOSURE_VERIFIED',
                                                                                              'config_digest': 'sha256:' + '0' * 64}})),
             {}, 'OFFLINE_CLOSURE_OCI'),
            (dict(config=good_config(client_artifacts=bad_artifacts)), {}, 'ARTIFACTS_BYTES:index.js'),
            (dict(config=good_config(client_artifacts=no_engine)), {}, 'ARTIFACTS_MISSING:libquery_engine-debian-openssl-3.0.x.so.node'),
            (dict(config=good_config(node_path='/other/node')), {}, 'ARTIFACTS_NODE_PATH'),
            (dict(config=good_config(binding=good_binding(client_artifacts_sha256='e' * 64),
                                     approval=good_approval(client_artifacts_sha256='e' * 64))), {}, 'ARTIFACTS_BINDING'),
            (dict(), {'realpath': '/real/node'}, 'NODE_PATH_NOT_CANONICAL'),
            (dict(), {'fresh': ex.ExecutorRefusal('WORK_DIR_NOT_FRESH')}, 'WORK_DIR_NOT_FRESH'),
            (dict(), {'existing': (ex.CONFIG_VOLUME,)}, 'DOCKER_OBJECT_EXISTS:' + ex.CONFIG_VOLUME),
            (dict(), {'existing': (rc.VOLUME_NAME,)}, 'DOCKER_OBJECT_EXISTS:' + rc.VOLUME_NAME),
            (dict(), {'existing': (rc.NETWORK_NAME,)}, 'DOCKER_OBJECT_EXISTS:' + rc.NETWORK_NAME),
            (dict(), {'existing': (rc.CONTAINER_NAME,)}, 'DOCKER_OBJECT_EXISTS:' + rc.CONTAINER_NAME),
            (dict(), {'consume': ex.ExecutorRefusal('ATTEMPT_ALREADY_CONSUMED')}, 'ATTEMPT_ALREADY_CONSUMED'),
        )
        for kw, faults, code in cases:
            result, ops = self.run_it(**kw, **faults)
            self.assertEqual(result['failure']['code'], code, code)
            self.assertEqual(ops.consumed, [], code)
            self.assertEqual(self.labels(ops, 'run'), [], code)
            self.assertEqual(self.labels(ops, 'psql'), [], code)
            self.assertTrue(result['cleanup']['skipped'], code)

    def test_offset_approval_in_the_past_is_accepted(self):
        result, ops = self.run_it(config=good_config(approval=good_approval(issued_at_utc='2026-10-26T12:00:00+03:00')))
        self.assertIsNone(result['failure'], result)                 # 09:00Z <= 10:05Z

    def test_ambiguous_index_and_relative_env_marker(self):
        extra = dict(ARTIFACT_BYTES); extra['/bundle/other/index.js'] = b'x'
        arts = {p: {'sha256': sha(b), 'bytes': len(b)} for p, b in extra.items()}
        asha = sha(ex.js_canonical({p: sha(b) for p, b in extra.items()}).encode())
        cfg = good_config(client_artifacts=arts, binding=good_binding(client_artifacts_sha256=asha),
                          approval=good_approval(client_artifacts_sha256=asha))
        result, ops = self.run_it(config=cfg, artifact_bytes=extra)
        self.assertEqual(result['failure']['code'], 'ARTIFACTS_INDEX_AMBIGUOUS')
        self.assertEqual(ops.consumed, [])
        idx = dict(ARTIFACT_BYTES)
        idx['/bundle/client/index.js'] = ('x ' + ex.CLIENT_VERSION_MARKER + ' ' + ex.ENGINE_VERSION_MARKER + ' ' + ex.ROOT_ENV_MARKER).encode()
        arts = {p: {'sha256': sha(b), 'bytes': len(b)} for p, b in idx.items()}
        asha = sha(ex.js_canonical({p: sha(b) for p, b in idx.items()}).encode())
        cfg = good_config(client_artifacts=arts, binding=good_binding(client_artifacts_sha256=asha),
                          approval=good_approval(client_artifacts_sha256=asha))
        result, ops = self.run_it(config=cfg, artifact_bytes=idx)
        self.assertEqual(result['failure']['code'], 'ARTIFACTS_ENV_PATHS')

    def test_second_interrupt_during_teardown_does_not_stop_teardown_secrets_or_seal(self):
        class Term(BaseException):
            code = 'SIGTERM'
        ops = FakeOps(None, run_candidate=Term(), **{'run:teardown': Term()})
        result = ex.run_attempt(good_config(), ops.bundle(), real_mods())
        self.assertEqual(result['failure']['code'], 'SIGTERM')
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 5)     # every step attempted despite interrupts
        self.assertEqual(len(result['cleanup']['failures']), 5)
        self.assertEqual(sorted(ops.removed), ['/w/inputs/credential.json', '/w/inputs/postgres.env'])
        self.assertTrue(any(c[0] == 'seal' for c in ops.calls))
        ops = FakeOps(None, seal=Term())
        result = ex.run_attempt(good_config(), ops.bundle(), real_mods())
        self.assertEqual(result['seal']['failure'], 'SIGTERM')
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_container_restart_between_baseline_and_end_is_rejected(self):
        before = {'restart_count': 0, 'oom_killed': False, 'started_at': 't0', 'running': True, 'exit_code': 0}
        after = dict(before, restart_count=1, started_at='t1')
        result, _ = self.run_it(states=[before, after])
        self.assertEqual(result['status'], 'REJECTED_REVIEW_REQUIRED')

    def test_stderr_growth_never_softens_a_rejection(self):
        stopped = {'restart_count': 0, 'oom_killed': False, 'started_at': 't0', 'running': False, 'exit_code': 139}
        result, _ = self.run_it(state=stopped, stderr_after=4096)
        self.assertEqual(result['status'], 'REJECTED_REVIEW_REQUIRED')
        self.assertIn('STDERR_LOG_GREW', result['findings'])

    def test_reference_conf_mismatch_refuses_before_consumption(self):
        cfg = good_config()
        cfg['closure_offline_index']['postgresql_conf'] = {'path': '/custody/alt-postgresql_conf', 'sha256': sha(b'other conf')}
        ops = FakeOps(cfg); ops.fs['/custody/alt-postgresql_conf'] = b'other conf'
        result = ex.run_attempt(cfg, ops.bundle(), real_mods())
        self.assertEqual(result['failure']['code'], 'REFERENCE_CONF:postgresql_conf')
        self.assertEqual(ops.consumed, [])

    def test_role_settings_before_must_be_zero(self):
        cfg = good_config()
        ops = FakeOps(cfg)
        bundle = ops.bundle()
        real = bundle['psql_bootstrap']
        bundle['psql_bootstrap'] = lambda sql, label: b'1\n' if label == 'role-settings-before' else real(sql, label)
        result = ex.run_attempt(cfg, bundle, real_mods())
        self.assertEqual(result['failure']['code'], 'ROLE_SETTINGS_BEFORE')
        self.assertNotIn('setup', self.labels(ops, 'psql'))

    def test_artifact_mirror_negatives(self):
        def cfg_for(idx, arts=None):
            arts = arts or {p: {'sha256': sha(b), 'bytes': len(b)} for p, b in idx.items()}
            asha = sha(ex.js_canonical({p: v['sha256'] for p, v in arts.items()}).encode())
            return good_config(client_artifacts=arts, binding=good_binding(client_artifacts_sha256=asha),
                               approval=good_approval(client_artifacts_sha256=asha))
        dup = dict(ARTIFACT_BYTES); dup['/other/client/package.json'] = b'{}'
        no_ver = dict(ARTIFACT_BYTES)
        no_ver['/bundle/client/index.js'] = (ex.ENGINE_VERSION_MARKER + ' "relativeEnvPaths": { ' + ex.ROOT_ENV_MARKER + ' }').encode()
        zero = {p: {'sha256': sha(b), 'bytes': len(b)} for p, b in ARTIFACT_BYTES.items()}
        zero['/bundle/client/package.json']['bytes'] = 0
        odd = dict(ARTIFACT_BYTES); odd['/bundle/client/ünicode.bin'] = odd.pop('/bundle/client/schema.prisma')
        for idx, arts, code in ((dup, None, 'ARTIFACTS_MISSING:package.json'), (no_ver, None, 'ARTIFACTS_CLIENT_VERSION'),
                                (ARTIFACT_BYTES, zero, 'ARTIFACTS_META'), (odd, None, 'ARTIFACTS_PATH')):
            result, ops = self.run_it(config=cfg_for(idx, arts), artifact_bytes=idx)
            self.assertEqual(result['failure']['code'], code)
            self.assertEqual(ops.consumed, [])

    def test_index_marker_mirror_refuses_before_consumption(self):
        idx = dict(ARTIFACT_BYTES)
        idx['/bundle/client/index.js'] = ('module.exports={} ' + ex.CLIENT_VERSION_MARKER + ' ' + ex.ENGINE_VERSION_MARKER).encode()
        arts = {p: {'sha256': sha(b), 'bytes': len(b)} for p, b in idx.items()}
        asha = sha(ex.js_canonical({p: sha(b) for p, b in idx.items()}).encode())
        cfg = good_config(client_artifacts=arts, binding=good_binding(client_artifacts_sha256=asha),
                          approval=good_approval(client_artifacts_sha256=asha))
        result, ops = self.run_it(config=cfg, artifact_bytes=idx)
        self.assertEqual(result['failure']['code'], 'ARTIFACTS_ENV_PATHS')
        self.assertEqual(ops.consumed, [])

    def test_busy_host_lock_runs_nothing_and_writes_nothing(self):
        result, ops = self.run_it(host_lock=ex.ExecutorRefusal('HOST_LOCK_BUSY'))
        self.assertEqual(result['failure']['code'], 'HOST_LOCK_BUSY')
        self.assertEqual(ops.consumed, [])
        self.assertEqual([c for c in ops.calls if c[0] in ('run', 'psql', 'exists', 'fresh', 'write', 'seal')], [])
        self.assertEqual(result['seal'], {'sealed': False, 'skipped': 'WORK_DIR_NOT_VERIFIED'})

    def test_refusal_before_the_work_dir_is_verified_writes_and_seals_nothing(self):
        for faults in ({'port_free': False}, {'fresh': ex.ExecutorRefusal('WORK_DIR_NOT_FRESH')}):
            result, ops = self.run_it(**faults)
            self.assertEqual([c for c in ops.calls if c[0] in ('write', 'write_secret', 'seal')], [], faults)
            self.assertEqual(result['seal'], {'sealed': False, 'skipped': 'WORK_DIR_NOT_VERIFIED'})
        # A refusal AFTER this run verified (and created) its own fresh work dir records there: that is its dir.
        result, ops = self.run_it(existing=(rc.VOLUME_NAME,))
        self.assertLess(ops.calls.index(('fresh', '/w')), ops.calls.index(('write', '/w/executor-result.json')))
        self.assertEqual(result['seal'], {'sealed': True})
        result, ops = self.run_it(config=good_config(approval=good_approval(purpose='X')))
        self.assertEqual([c for c in ops.calls if c[0] in ('write', 'seal', 'host_lock')], [])

    def test_unauthorized_touches_nothing(self):
        for flag in (False, 'true'):
            result, ops = self.run_it(config=good_config(execute=flag))
            self.assertEqual(result['failure']['code'], 'NO_EXECUTE_FLAG')
            self.assertEqual(ops.consumed, [])
            self.assertEqual(self.labels(ops, 'run'), [])

    def test_temp_server_or_wrong_log_file_stops_before_any_sql(self):
        for ready, code in (('f|%s|%s\n' % (ex.LOG_FILE, POSTMASTER), 'READY_TEMP_SERVER'),
                            ('t|%s.json|%s\n' % (ex.LOG_FILE, POSTMASTER), 'READY_JSONLOG_FILE')):
            result, ops = self.run_it(ready=ready)
            self.assertEqual(result['failure'], {'phase': 'ready', 'code': code})
            self.assertNotIn('setup', self.labels(ops, 'psql'))
            self.assertEqual(self.labels(ops, 'run').count('teardown'), 5)

    def test_admin_statement_logging_stops_before_setup_and_password(self):
        result, ops = self.run_it(admin_log='ddl|none|-1\n')
        self.assertEqual(result['failure']['code'], 'ADMIN_LOG_STATEMENT_NOT_NONE')
        self.assertNotIn('setup', self.labels(ops, 'psql'))
        self.assertNotIn(('set_probe_password',), ops.calls)

    def test_effective_value_drift_and_post_run_drift(self):
        result, ops = self.run_it(gucs=GUC_TEXT.replace('anon*, ', ''))
        self.assertEqual(result['failure']['code'], 'EFFECTIVE_DRIFT:supautils.reserved_roles')
        self.assertNotIn('setup', self.labels(ops, 'psql'))
        result, _ = self.run_it(role_after='1\n')
        self.assertEqual(result['failure']['code'], 'ROLE_SETTINGS_AFTER')
        result, _ = self.run_it(gucs_after=GUC_TEXT.replace('pgbouncer, service_role*', 'service_role*'))
        self.assertEqual(result['failure']['code'], 'EFFECTIVE_DRIFT:supautils.reserved_roles')
        # Still within the pinned expectation (the alias may appear) but different from before: only GUC_DRIFT bites.
        alias = 'supautils.superuser|supabase_admin|configuration file|%s\n' % SU
        result, _ = self.run_it(gucs_after=GUC_TEXT + alias)
        self.assertEqual(result['failure']['code'], 'GUC_DRIFT')

    def test_foreign_lane_nonce_is_refused(self):
        foreign = {'A': 'e' * 32}
        result, _ = self.run_it(lane_nonce=foreign, events=build_events(DRIVER_CEILING, nonce=foreign))
        self.assertEqual(result['failure']['code'], 'ATTEST_EVENT_NONCE')

    def test_stderr_growth_downgrades(self):
        result, _ = self.run_it(stderr_after=12)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertIn('STDERR_LOG_GREW', result['findings'])

    def test_port_mapping_failure_tears_down_everything_created(self):
        result, ops = self.run_it(port_out='0.0.0.0:%d\n' % PORT)
        self.assertEqual(result['failure'], {'phase': 'identity', 'code': 'PORT_MAPPING'})
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 5)

    def test_half_created_objects_are_torn_down_and_nothing_else(self):
        result, ops = self.run_it(**{'run:create-config-volume': ex.ExecutorRefusal('BOOM')})
        self.assertEqual(result['failure']['code'], 'BOOM')
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 3)    # network + data volume + config volume
        result, ops = self.run_it(**{'run:run-container': ex.ExecutorRefusal('START_FAILED')})
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 5)    # container created but not started
        result, ops = self.run_it(**{'run:create-network': ex.ExecutorRefusal('NET')})
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 1)    # only the network it tried to create

    def test_secret_bearing_exception_message_never_surfaces(self):
        result, _ = self.run_it(**{'psql:setup': RuntimeError('postgresql://regress_r3_probe:hunter2@127.0.0.1/x')})
        self.assertEqual(result['failure']['code'], 'UNEXPECTED_RuntimeError')
        self.assertNotIn('hunter2', json.dumps(result))

    def test_sigterm_like_interrupt_still_tears_down_and_removes_secrets(self):
        class Term(BaseException):
            code = 'SIGTERM'
        result, ops = self.run_it(run_candidate=Term())
        self.assertEqual(result['failure']['code'], 'SIGTERM')
        self.assertEqual(self.labels(ops, 'run').count('teardown'), 5)
        self.assertEqual(sorted(ops.removed), ['/w/inputs/credential.json', '/w/inputs/postgres.env'])

    def test_password_never_written_in_plain_and_never_sealed(self):
        _, ops = self.run_it()
        pw = ops.fs['__pw']
        self.assertTrue(all(pw.encode() not in d for _, d in ops.written_plain))
        sealed = [c[1] for c in ops.calls if c[0] == 'seal'][0]
        for secret in ex.SECRET_FILES:
            self.assertNotIn(secret, sealed)
        self.assertIn('candidate/candidate-failure.json', sealed)

    def test_secret_removal_failure_is_partial(self):
        result, _ = self.run_it(remove_secret=OSError('busy'))
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertTrue(result['secret_removal_failures'])

    def test_hostile_assemble_is_clamped_before_it_is_persisted(self):
        evil = lambda d, c: {'status': 'QUALIFIED', 'historical_status': 'REPRODUCED', 'r3_status': 'CLOSED', 'findings': []}
        result, ops = self.run_it(mods=real_mods(assemble=evil))
        self.assertEqual((result['status'], result['historical_status'], result['r3_status']),
                         ('PARTIAL_REVIEW_REQUIRED', 'NOT_REPRODUCED', 'OPEN'))
        self.assertEqual(json.loads(ops.fs['/w/executor-result.json'])['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_teardown_and_seal_failures_are_partial(self):
        result, _ = self.run_it(**{'run:teardown': RuntimeError('x')})
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        result, _ = self.run_it(seal=ex.ExecutorRefusal('SEAL_FAILED'))
        self.assertEqual((result['status'], result['seal']['failure']), ('PARTIAL_REVIEW_REQUIRED', 'SEAL_FAILED'))

    def test_missing_lane_and_tampered_driver_history(self):
        result, _ = self.run_it(drop_lanes=('C',))
        self.assertEqual(result['failure']['code'], 'LANE_SET')
        bad = copy.deepcopy(DRIVER_CEILING); bad['historical_status'] = 'REPRODUCED'
        result, _ = self.run_it(driver_result=bad)
        self.assertEqual(result['failure']['code'], 'DRIVER_HISTORICAL')


if __name__ == '__main__':
    unittest.main(verbosity=2)
