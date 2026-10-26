#!/usr/bin/env python3
"""Tests for attempt_entry.py: the approval-rooted trust chain (packet -> approval -> manifest -> bytes ->
modules executed from exactly those bytes), the pinned fixture SQL, and the refusal paths. Uses real Node
only to read fixture-sql.mjs constants, and private temp dirs; no Docker, DB or network. On this macOS host
`--execute` must refuse inside live_ops before run_attempt, so nothing is consumed.
Run: python3 -I -B test_attempt_entry.py -v"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'scripts', 'r3_db_candidate'))
NODE = os.path.realpath(os.environ.get('R3_TEST_NODE') or shutil.which('node') or '/nonexistent/node')   # Node 22
PY = sys.executable


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ae = _load('attempt_entry', 'attempt_entry.py')
sha = lambda b: hashlib.sha256(b).hexdigest()
MANIFEST_FILES = list(ae.REQUIRED_FILES) + ['closure_adapter.py']


def real_manifest(root=HERE):
    return {n: sha(open(os.path.join(root, n), 'rb').read()) for n in MANIFEST_FILES}


class EntryBase(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='r3c05e-')
        os.chmod(self.d, 0o700)
        self.manifest = real_manifest()

    def tearDown(self):
        shutil.rmtree(self.d)

    def write(self, name, value):
        path = os.path.join(self.d, name)
        with open(path, 'w') as f:
            json.dump(value, f)
        return path

    def packet(self, source_root=HERE, manifest=None, approval_over=None, **over):
        manifest = self.manifest if manifest is None else manifest
        # A structurally valid attempt approval (validate_execution_authorization runs before anything executes).
        approval = {'purpose': 'ONE_ISOLATED_DB_CANDIDATE', 'attempt_id': 'a' * 32, 'owner_decision_sha256': 'b' * 64,
                    'source_manifest_sha256': sha(ae.js_canonical(manifest).encode()), 'client_artifacts_sha256': 'c' * 64,
                    'criterion': 'REPLACEMENT_REGRESSION_NOT_HISTORICAL', 'historical_status': 'NOT_REPRODUCED',
                    'r3_status': 'OPEN', 'issued_at_utc': '2026-01-01T00:00:00Z', 'single_attempt': True}
        approval.update(approval_over or {})
        p = {'work_dir': self.d + '/work', 'state_dir': self.d + '/state', 'source_root': source_root, 'node_path': NODE,
             'age_path': '/usr/bin/false', 'age_sha256': 'a' * 64, 'recipient_path': self.d + '/r.pub', 'recipient_sha256': 'b' * 64,
             'approval_path': self.write('approval.json', approval),
             'binding_path': self.write('binding.json', {'attempt_id': 'a' * 32, 'owner_decision_sha256': 'b' * 64,
                                                         'config_digest': 'sha256:' + 'c' * 64}),
             'binding05_path': self.write('binding05.json', {'node_source_manifest': manifest}),
             'closure_evidence_path': self.write('closure.json', {'summary': {
                 'oci_closure_status': 'OCI_CLOSURE_VERIFIED', 'config_digest': 'sha256:' + 'c' * 64,
                 'facts_missing': ['shared_preload_libraries', 'supautils_gucs'],
                 'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN'}}),
             'closure_index_path': self.write('index.json', {}),
             'client_artifacts_path': self.write('artifacts.json', {}), 'endpoint_port': 54329,
             'image': 'supabase/postgres@sha256:' + 'e' * 64, 'config_digest': 'sha256:' + 'c' * 64}
        p.update(over)
        return p

    def packet_file(self, **kw):
        return self.write('packet.json', self.packet(**kw))


class PacketAndManifestTests(EntryBase):
    def test_packet_checks(self):
        self.assertTrue(ae.check_packet(self.packet()))
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.check_packet({**self.packet(), 'extra': 1})
        self.assertEqual(ctx.exception.code, 'PACKET_SHAPE')
        for key, value in (('work_dir', 'relative'), ('state_dir', '/a/../b'), ('approval_path', '/x/../../etc/passwd'),
                           ('node_path', '/x\0y')):
            with self.assertRaises(ae.EntryRefusal) as ctx:
                ae.check_packet(self.packet(**{key: value}))
            self.assertEqual(ctx.exception.code, 'PACKET_PATH:' + key)
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.check_packet(self.packet(source_root=self.d))
        self.assertEqual(ctx.exception.code, 'SOURCE_ROOT_NOT_THIS_DIRECTORY')

    def test_manifest_must_be_the_approved_one_and_complete(self):
        approval = {'source_manifest_sha256': sha(ae.js_canonical(self.manifest).encode())}
        self.assertEqual(ae.approved_manifest(approval, {'node_source_manifest': self.manifest}), self.manifest)
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.approved_manifest({'source_manifest_sha256': 'f' * 64}, {'node_source_manifest': self.manifest})
        self.assertEqual(ctx.exception.code, 'MANIFEST_NOT_APPROVED')
        for required in ae.REQUIRED_FILES:
            partial = {k: v for k, v in self.manifest.items() if k != required}
            with self.assertRaises(ae.EntryRefusal) as ctx:
                ae.approved_manifest({'source_manifest_sha256': sha(ae.js_canonical(partial).encode())},
                                     {'node_source_manifest': partial})
            self.assertEqual(ctx.exception.code, 'MANIFEST_MISSING:' + required)

    def test_verify_files_and_execute_from_verified_bytes(self):
        verified = ae.verify_files(self.manifest)
        self.assertEqual(sorted(verified), sorted(self.manifest))
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.verify_files({**self.manifest, 'live_ops.py': '0' * 64})
        self.assertEqual(ctx.exception.code, 'PINNED_FILE:live_ops.py')
        with self.assertRaises(ae.EntryRefusal):
            ae.verify_files({'sub/x.py': '0' * 64})
        module = ae.load_verified('r3_bytes_only_probe', 'not_on_disk.py', {'not_on_disk.py': b'VALUE = 42\n'})
        self.assertEqual(module.VALUE, 42)                       # ran from the verified bytes, no second disk read
        self.assertFalse(os.path.exists(os.path.join(HERE, 'not_on_disk.py')))


class FixtureSqlTests(EntryBase):
    def test_constants_come_from_pinned_fixture(self):
        setup, collision, roles = ae.fixture_sql_constants(NODE, open(os.path.join(HERE, 'fixture-sql.mjs'), 'rb').read())
        self.assertEqual(sha(setup.encode()), ae.SETUP_SHA256)
        self.assertNotIn('PASSWORD', setup.upper())
        self.assertIn("rolname IN ('regress_r3_probe', 'regress_r3_target')", collision)
        self.assertIn('pg_db_role_setting', roles)
        self.assertTrue(collision.endswith(';\n') and roles.endswith(';\n'))

    def test_evaluated_from_verified_bytes_not_disk(self):
        self.assertIn("'data:text/javascript;base64,' + process.argv[1]", ae.FIXTURE_JS)
        self.assertNotIn('pathToFileURL', ae.FIXTURE_JS)
        with self.assertRaises(ae.EntryRefusal):
            ae.fixture_sql_constants(NODE, b'')

    def test_every_superuser_statement_is_pinned(self):
        src = open(os.path.join(HERE, 'fixture-sql.mjs')).read()
        for old, new, code in (('CONNECTION LIMIT 3', 'CONNECTION LIMIT 4', 'SETUP_PIN'),
                               ("WHERE datname = 'regress_r3_candidate')::int AS databases",
                                "WHERE datname = 'regress_r3_candidate' OR true)::int AS databases", 'COLLISION_PIN'),
                               ('OR (setrole = 0 AND setdatabase = 0)', 'OR false', 'ROLE_SETTING_PIN')):
            self.assertEqual(src.count(old), 1, old)
            with self.assertRaises(ae.EntryRefusal) as ctx:
                ae.fixture_sql_constants(NODE, src.replace(old, new).encode())
            self.assertEqual(ctx.exception.code, code)

    def test_node_is_verified_before_it_ever_runs(self):
        node_bytes = open(NODE, 'rb').read()
        good = {NODE: {'sha256': sha(node_bytes), 'bytes': len(node_bytes)}}
        hash_file = lambda p: (sha(open(p, 'rb').read()), os.path.getsize(p))
        self.assertTrue(ae.verify_node(NODE, good, hash_file))
        for artifacts, code in (({}, 'NODE_NOT_IN_ARTIFACTS'), ({NODE: {'sha256': '0' * 64, 'bytes': len(node_bytes)}}, 'NODE_BYTES'),
                                ({NODE: {'sha256': sha(node_bytes), 'bytes': 1}}, 'NODE_BYTES')):
            with self.assertRaises(ae.EntryRefusal) as ctx:
                ae.verify_node(NODE, artifacts, hash_file)
            self.assertEqual(ctx.exception.code, code)
        link = os.path.join(self.d, 'node-link'); os.symlink(NODE, link)
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.verify_node(link, {link: good[NODE]}, hash_file)
        self.assertEqual(ctx.exception.code, 'NODE_PATH_NOT_CANONICAL')


    def test_queries_name_every_required_setting(self):
        for name in ('privileged_extensions_superuser', 'privileged_role', 'reserved_memberships', 'reserved_roles', 'superuser'):
            self.assertIn("'supautils.%s'" % name, ae.SUPAUTILS_QUERY)
        self.assertNotIn('supautils.%', ae.SUPAUTILS_QUERY)        # no JSON-valued GUCs that could hold '|'
        for name in ('local_preload_libraries', 'session_preload_libraries', 'shared_preload_libraries'):
            self.assertIn("'%s'" % name, ae.PRELOAD_QUERY)


class MainTests(EntryBase):
    def test_dry_run_verifies_and_touches_nothing(self):
        self.assertEqual(ae.main([self.packet_file()]), 0)
        self.assertFalse(os.path.exists(self.d + '/state'))
        self.assertFalse(os.path.exists(self.d + '/work'))

    def test_dry_run_refuses_unapproved_manifest(self):
        with self.assertRaises(ae.EntryRefusal) as ctx:
            ae.main([self.packet_file(approval_over={'source_manifest_sha256': 'f' * 64})])
        self.assertEqual(ctx.exception.code, 'MANIFEST_NOT_APPROVED')

    def test_tampered_copy_is_refused_before_anything_runs(self):
        copy_dir = os.path.join(self.d, 'copy')
        shutil.copytree(HERE, copy_dir, ignore=shutil.ignore_patterns('*.log', '__pycache__'))
        with open(os.path.join(copy_dir, 'live_ops.py'), 'a') as f:
            f.write("\nraise SystemExit('TAMPERED_LIVE_OPS_IMPORTED')\n")
        packet = self.packet_file(source_root=os.path.realpath(copy_dir))      # approval binds the ORIGINAL bytes
        for args in ([packet], ['--execute', packet]):
            out = subprocess.run([PY, '-I', '-B', os.path.join(copy_dir, 'attempt_entry.py'), *args],
                                 capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 1, out.stderr)
            self.assertEqual(out.stderr.strip(), 'PINNED_FILE:live_ops.py')
            self.assertNotIn('TAMPERED', out.stdout + out.stderr)
        self.assertFalse(os.path.exists(self.d + '/state'))

    def test_execute_on_this_mac_refuses_before_anything_is_consumed(self):
        if os.uname().sysname == 'Linux':
            self.skipTest('only meaningful on the non-Linux dev host')
        out = subprocess.run([PY, '-I', '-B', os.path.join(HERE, 'attempt_entry.py'), '--execute', self.packet_file()],
                             capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'HOME': self.d})
        self.assertEqual(out.returncode, 1)
        self.assertEqual(out.stderr.strip(), 'LIVE_NOT_LINUX_AMD64')
        self.assertFalse(os.path.exists(self.d + '/state'))
        self.assertFalse(os.path.exists(self.d + '/work'))

    def test_invalid_attempt_approval_is_refused_before_the_guard(self):
        out = subprocess.run([PY, '-I', '-B', os.path.join(HERE, 'attempt_entry.py'), '--execute',
                              self.packet_file(approval_over={'purpose': 'R3_DB_REHEARSAL_NO_ATTEMPT'})],
                             capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'HOME': self.d})
        self.assertEqual((out.returncode, out.stderr.strip()), (1, 'APPROVAL_PURPOSE'))
        self.assertFalse(os.path.exists(self.d + '/state'))

    def test_execute_verifies_node_right_after_the_runner_guard(self):
        # Let the guard pass in-process (this host is not the runner) and prove main() checks the Node binary
        # before anything executes it: the packet's artifacts do not contain it, so it must stop right there.
        packet = self.packet_file()
        verified = ae.verify_files(self.manifest)
        ae.load_verified('runtime_executor', 'runtime_executor.py', verified)    # same order as main()
        live = ae.load_verified('live_ops', 'live_ops.py', verified)
        saved_guard, saved_fixture = live.require_runner, ae.fixture_sql_constants
        calls = []
        live.require_runner = lambda **kw: calls.append('guard') or True
        ae.fixture_sql_constants = lambda *a, **k: calls.append('node-ran') or ('', '', '')
        try:
            with self.assertRaises(ae.EntryRefusal) as ctx:
                ae.main(['--execute', packet])
            self.assertEqual(ctx.exception.code, 'NODE_NOT_IN_ARTIFACTS')
            self.assertEqual(calls, ['guard'])                  # the guard ran; Node never did
        finally:
            live.require_runner, ae.fixture_sql_constants = saved_guard, saved_fixture
        self.assertFalse(os.path.exists(self.d + '/state'))

    def test_exit_code_reflects_the_ceiling_only(self):
        self.assertEqual(ae.exit_code_for({'status': 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED'}), 0)
        for status in ('PARTIAL_REVIEW_REQUIRED', 'REJECTED_REVIEW_REQUIRED', None):
            self.assertEqual(ae.exit_code_for({'status': status}), 3)

    def test_sigterm_becomes_a_teardown_reaching_exception_and_later_signals_are_ignored(self):
        import signal
        saved = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
        try:
            with self.assertRaises(ae.TerminationRequested) as ctx:
                ae._on_sigterm(15, None)
            self.assertEqual(ctx.exception.code, 'SIGTERM')
            self.assertFalse(issubclass(ae.TerminationRequested, Exception))    # not swallowed by `except Exception`
            self.assertIs(signal.getsignal(signal.SIGTERM), signal.SIG_IGN)
            self.assertIs(signal.getsignal(signal.SIGINT), signal.SIG_IGN)
        finally:
            signal.signal(signal.SIGTERM, saved[0])
            signal.signal(signal.SIGINT, saved[1])

    def test_build_config_carries_every_query_and_this_directory(self):
        p = self.packet()
        cfg = ae.build_config(p, {'a': 1}, self.manifest, execute=True, setup_script='S', collision_query='Q',
                              role_setting_query='R', nonces=['1' * 32, '2' * 32, '3' * 32], correlation_id='9' * 32)
        self.assertEqual(cfg['source_root'], HERE)
        self.assertEqual(cfg['role_setting_query'], 'R')
        self.assertEqual(cfg['source_manifest'], self.manifest)
        self.assertTrue(cfg['execute'])
        self.assertFalse(ae.build_config(p, {}, self.manifest, execute='yes', setup_script='S', collision_query='Q',
                                         role_setting_query='R', nonces=[], correlation_id='')['execute'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
