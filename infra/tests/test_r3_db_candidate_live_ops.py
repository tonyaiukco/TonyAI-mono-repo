#!/usr/bin/env python3
"""Tests for live_ops.py — the runner guard, every argv builder (no execution), secret handling, the
seal allowlist, exclusive writes / one-shot consumption on a private temp dir, and the attestation
service loop with a fake process. Nothing here runs Docker, psql, Node candidates, age or the network.
Run: python3 -I -B test_live_ops.py -v"""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'scripts', 'r3_db_candidate'))
sys.path.insert(0, HERE)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ex = _load('runtime_executor', 'runtime_executor.py')
lo = _load('live_ops', 'live_ops.py')
D = ['docker', '--host', 'unix:///var/run/docker.sock']
C = 'tonyai-r3-db-candidate'


class RunnerGuardTests(unittest.TestCase):
    def test_this_mac_and_ambient_env_are_refused(self):
        ok = dict(system='Linux', machine='x86_64', env={'PATH': '/usr/bin', 'HOME': '/h'}, execute=True)
        self.assertTrue(lo.require_runner(**ok))
        for over, code in (({'execute': False}, 'LIVE_NO_EXECUTE'), ({'execute': 'true'}, 'LIVE_NO_EXECUTE'),
                           ({'system': 'Darwin', 'machine': 'arm64'}, 'LIVE_NOT_LINUX_AMD64'),
                           ({'machine': 'aarch64'}, 'LIVE_NOT_LINUX_AMD64')):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                lo.require_runner(**{**ok, **over})
            self.assertEqual(ctx.exception.code, code)
        for name in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DATABASE_URL', 'DIRECT_URL', 'PGPASSWORD', 'PRISMA_QUERY_ENGINE_LIBRARY',
                     'LD_PRELOAD', 'NODE_OPTIONS'):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.require_runner(**{**ok, 'env': {'PATH': '/usr/bin', name: 'x'}})

    def test_build_live_ops_refuses_on_this_host(self):
        # This review/dev machine is macOS: the live bundle must never be constructible here.
        if os.uname().sysname == 'Linux':
            self.skipTest('only meaningful on a non-Linux dev host')
        with self.assertRaises(ex.ExecutorRefusal):
            lo.build_live_ops({'execute': True}, contract=None)


class ArgvTests(unittest.TestCase):
    def test_psql_and_password_route(self):
        argv = lo.psql_argv(D, C)
        self.assertEqual(argv[argv.index('-U') + 1], 'supabase_admin')
        self.assertEqual(argv[argv.index('-h') + 1], '/var/run/postgresql')   # local socket (trust), not TCP
        self.assertEqual(argv[-2:], ['-f', '-'])
        pw = 'a' * 64
        pa = lo.password_argv(D, C)
        self.assertEqual(pa[-1], '\\password regress_r3_probe')
        self.assertFalse(any(pw in a for a in pa))                             # secret never in argv
        self.assertEqual(lo.password_stdin(pw), (pw + '\n' + pw + '\n').encode())
        for bad in ('short', 'x' * 23, 'has space' * 4, "q'uote" * 5, 7):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.password_stdin(bad)

    def test_readiness_and_probe_argvs(self):
        r = lo.ready_argv(D, C)
        self.assertEqual(r[r.index('-h') + 1], '127.0.0.1')               # TCP: the init-time server has no listener
        self.assertEqual(r[r.index('-p') + 1], '5432')
        self.assertNotIn('/var/run/postgresql', r)
        self.assertEqual(lo.stderr_stat_argv(D, C)[-1], ex.STDERR_LOG_FILE)
        for kind in ('container', 'network', 'volume'):
            a = lo.inspect_argv(D, kind, 'n')
            self.assertEqual(a[len(D):len(D) + 2], [kind, 'inspect'])
        with self.assertRaises(ex.ExecutorRefusal):
            lo.inspect_argv(D, 'image', 'n')

    def test_observer_argvs(self):
        m = lo.maps_argv(D, C, 42)
        self.assertEqual(m[-1], '/proc/42/maps')
        # N1: same uid as the backends; root with --cap-drop ALL could read neither /proc maps nor the 0600 log.
        for argv in (m, lo.log_stat_argv(D, C), lo.log_tail_argv(D, C, 0), lo.stderr_stat_argv(D, C),
                     *lo.file_observe_argvs(D, C, ex.LIBRARY_PATH)):
            self.assertEqual(argv[argv.index('--user') + 1], 'postgres', argv)
        self.assertEqual(lo.OBSERVER_USER, 'postgres')
        for pid in (0, -1, '42', 4.2):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.maps_argv(D, C, pid)
        st, sh, st2 = lo.file_observe_argvs(D, C, ex.LIBRARY_PATH)
        self.assertIn('%F|%d|%i|%s', st)
        self.assertNotIn('-L', st)                                             # nofollow: a symlink must show as one
        self.assertEqual(sh[-2:], ['sha256sum', ex.LIBRARY_PATH])
        for bad in ('/etc/shadow', '/nix/store/../../etc/shadow'):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.file_observe_argvs(D, C, bad)

    def test_docker_missing_object_wording(self):
        for kind, name, err in (('container', 'tonyai-r3-db-candidate', b'Error: No such container: tonyai-r3-db-candidate'),
                                ('volume', 'tonyai-r3-db-candidate-data', b'Error response from daemon: get tonyai-r3-db-candidate-data: no such volume'),
                                ('network', 'tonyai-r3-db-candidate-net', b'Error response from daemon: network tonyai-r3-db-candidate-net not found'),
                                ('network', 'tonyai-r3-db-candidate-net', b'Error: No such network: tonyai-r3-db-candidate-net')):
            self.assertIs(lo.interpret_inspect(kind, 1, err, name), False, kind)
        self.assertIs(lo.interpret_inspect('volume', 0, b''), True)
        # D2: an unreachable daemon must never read as "absent" (that would let the attempt be consumed).
        for err in (b'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
                    b'error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/volumes/x": dial unix /var/run/docker.sock: connect: no such file or directory',
                    b'permission denied while trying to connect to the Docker daemon socket', b''):
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                lo.interpret_inspect('volume', 1, err, 'x')
            expected = 'DOCKER_DAEMON_UNREACHABLE' if err else 'DOCKER_INSPECT_FAILED:volume'
            self.assertEqual(ctx.exception.code, expected, err)
        # A daemon error that happens to mention the kind's phrase is still a daemon error, not "absent".
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            lo.interpret_inspect('volume', 1, b'error during connect: no such volume plugin socket: connect: no such file or directory', 'x')
        self.assertEqual(ctx.exception.code, 'DOCKER_DAEMON_UNREACHABLE')
        for kind, err in (('container', b'get x: no such volume'), ('volume', b'Error: No such container: x'),
                          ('network', b'network other-net not found')):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.interpret_inspect(kind, 1, err, 'tonyai-r3-db-candidate-net')

    def test_stderr_stat_tristate(self):
        self.assertEqual(lo.interpret_stderr_stat(0, b'128\n', b''), 128)
        self.assertEqual(lo.interpret_stderr_stat(1, b'', b"stat: cannot statx '/var/log/postgresql-r3/r3.log': No such file or directory"), 'absent')
        for rc_, out, err in ((1, b'', b'Permission denied'), (0, b'x', b''), (1, b'', b'')):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.interpret_stderr_stat(rc_, out, err)

    def test_host_lock_is_exclusive(self):
        directory = tempfile.TemporaryDirectory(prefix='r3lock-')
        self.addCleanup(directory.cleanup)
        path = os.path.join(directory.name, 'lock')
        fd = lo.acquire_host_lock(path)
        try:
            with self.assertRaises(ex.ExecutorRefusal) as ctx:
                lo.acquire_host_lock(path)
            self.assertEqual(ctx.exception.code, 'HOST_LOCK_BUSY')
        finally:
            os.close(fd)
        os.close(lo.acquire_host_lock(path))                          # free again once released
        self.assertEqual(lo.HOST_LOCK_PATH, '/var/tmp/tonyai-r3-db-candidate.lock')

    def test_port_free(self):
        import socket
        holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        holder.bind(('127.0.0.1', 0))
        holder.listen(1)
        busy = holder.getsockname()[1]
        try:
            self.assertIs(lo.port_free(busy), False)
        finally:
            holder.close()
        for bad in (80, 70000, '5432'):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.port_free(bad)

    def test_log_and_misc_argvs(self):
        self.assertEqual(lo.log_tail_argv(D, C, 0)[-3:], ['-c', '+1', ex.LOG_FILE])
        self.assertEqual(lo.log_tail_argv(D, C, 4096)[-2], '+4097')
        with self.assertRaises(ex.ExecutorRefusal):
            lo.log_tail_argv(D, C, -1)
        self.assertEqual(lo.log_stat_argv(D, C)[-1], ex.LOG_FILE)
        self.assertIn('--format', lo.state_argv(D, C))
        self.assertEqual(lo.pull_argv(D, ex_image())[-3:], ['--platform', 'linux/amd64', ex_image()])
        for bad in ('supabase/postgres:17.11.0.004', 'supabase/postgres:latest@sha256:' + 'a' * 64, 'evil/postgres@sha256:' + 'a' * 64):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.pull_argv(D, bad)

    def test_node_env_matches_entrypoint_required_set(self):
        env = lo.node_env('/w/home')
        entry = open(os.path.join(HERE, 'entrypoint.mjs')).read()
        for name, value in lo.NODE_ENV_REQUIRED.items():
            self.assertIn("%s: '%s'" % (name, value), entry.replace('PATH: ', 'PATH: ').replace('\n', ' '))
        self.assertEqual(set(env), {'PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME'})
        with self.assertRaises(ex.ExecutorRefusal):
            lo.node_env('relative')


def ex_image():
    return 'supabase/postgres@sha256:e85bc10ac5b141223b289e1e8dc8d448cf3df92501917149db0366b9c5aaf053'


class RecipientAndSealTests(unittest.TestCase):
    PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAMyF5U6PVGxLSVVL/kf/drb9CHdke4gtpdj5/HKk6zi\n'   # synthetic test key
    PUB_SHA256 = hashlib.sha256(PUB.encode()).hexdigest()

    def test_recipient_pin_reuses_the_approved_key(self):
        out = lo.normalized_recipient(self.PUB, self.PUB_SHA256)
        self.assertTrue(out.endswith(b'\n'))
        with self.assertRaises(ex.ExecutorRefusal):
            lo.normalized_recipient(self.PUB, 'f' * 64)
        with self.assertRaises(ex.ExecutorRefusal):
            lo.normalized_recipient(self.PUB.strip() + ' comment', self.PUB_SHA256)

    def test_seal_selection_refuses_secrets_and_escapes(self):
        names = lo.select_seal_files('/w', list(ex.EVIDENCE_ALLOWLIST), lambda p: not p.endswith('closure.json'))
        self.assertNotIn('closure.json', names)
        for secret in ex.SECRET_FILES:
            self.assertNotIn(secret, ex.EVIDENCE_ALLOWLIST)
            with self.assertRaises(ex.ExecutorRefusal):
                lo.select_seal_files('/w', list(ex.EVIDENCE_ALLOWLIST) + [secret], lambda p: True)
        for bad in ('../etc/passwd', '/etc/passwd'):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.select_seal_files('/w', [bad], lambda p: True)

    def test_utc_micros_format_matches_validator(self):
        self.assertRegex(lo.utc_micros(), r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$')


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='r3c05-')
        os.chmod(self.d, 0o700)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.d)                    # does not follow symlinks

    def test_exclusive_private_writes(self):
        p = os.path.join(self.d, 'inputs', 'credential.json')
        lo.write_exclusive(p, b'{}')
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(os.path.dirname(p)).st_mode & 0o777, 0o700)
        with self.assertRaises(FileExistsError):
            lo.write_exclusive(p, b'{}')
        link = os.path.join(self.d, 'link')
        os.symlink(p, link)
        with self.assertRaises(OSError):
            lo.read_bounded(link)
        with self.assertRaises(ex.ExecutorRefusal):
            lo.read_bounded(p, limit=1)

    def test_hash_file_streams_bounded_and_no_follow(self):
        p = os.path.join(self.d, 'engine.node')
        data = os.urandom(3 * 1024 * 1024 + 7)
        with open(p, 'wb') as f:
            f.write(data)
        import hashlib
        self.assertEqual(lo.hash_file(p), (hashlib.sha256(data).hexdigest(), len(data)))
        with self.assertRaises(ex.ExecutorRefusal):
            lo.hash_file(p, limit=1024)
        link = os.path.join(self.d, 'engine-link')
        os.symlink(p, link)
        with self.assertRaises(OSError):
            lo.hash_file(link)

    def test_fresh_work_dir(self):
        target = os.path.join(self.d, 'work')
        self.assertTrue(lo.assert_fresh_work_dir(target))                 # absent -> created 0700
        self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)
        self.assertTrue(lo.assert_fresh_work_dir(target))                 # empty 0700 owned -> fine
        open(os.path.join(target, 'x'), 'w').close()
        with self.assertRaises(ex.ExecutorRefusal):
            lo.assert_fresh_work_dir(target)
        loose = os.path.join(self.d, 'loose'); os.mkdir(loose, 0o755); os.chmod(loose, 0o755)
        with self.assertRaises(ex.ExecutorRefusal):
            lo.assert_fresh_work_dir(loose)
        link = os.path.join(self.d, 'wl'); os.symlink(loose, link)
        with self.assertRaises(ex.ExecutorRefusal):
            lo.assert_fresh_work_dir(link)
        for bad in ('relative', '/a/../b'):
            with self.assertRaises(ex.ExecutorRefusal):
                lo.assert_fresh_work_dir(bad)

    def test_attempt_is_consumed_exactly_once(self):
        lo.consume_attempt(self.d, 'a' * 32)
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            lo.consume_attempt(self.d, 'a' * 32)
        self.assertEqual(ctx.exception.code, 'ATTEMPT_ALREADY_CONSUMED')
        with self.assertRaises(ex.ExecutorRefusal):
            lo.consume_attempt(self.d, '../x')

    def test_service_loop_answers_each_lane_once_then_returns(self):
        cand = os.path.join(self.d, 'candidate'); os.mkdir(cand, 0o700)
        script = [('B', 11), ('A', 12), ('C', 13)]

        class Proc:
            pid = 999999
            def __init__(self):
                self.ticks = 0
            def poll(self):
                self.ticks += 1
                if script:
                    lane, pid = script.pop(0)
                    with open(os.path.join(cand, 'attest-%s.request.json' % lane), 'w') as f:
                        json.dump({'lane': lane, 'pid': pid, 'nonce': {'A': '1', 'B': '2', 'C': '3'}[lane] * 32}, f)
                    return None
                return 0
        lanes = lo.service_loop(Proc(), cand, ex.service_one_attestation, lambda pid: 'maps-%d' % pid,
                                deadline_s=60, sleep=lambda s: None, kill=lambda p: self.fail('must not kill'))
        self.assertEqual([r['lane'] for r in lanes], ['B', 'A', 'C'])
        for lane in 'ABC':
            self.assertTrue(os.path.exists(os.path.join(cand, 'attest-%s.ack' % lane)))

    def test_service_loop_nonzero_exit_and_deadline(self):
        cand = os.path.join(self.d, 'c2'); os.mkdir(cand, 0o700)

        class Dead:
            pid = 1
            def poll(self):
                return 3
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            lo.service_loop(Dead(), cand, ex.service_one_attestation, str, deadline_s=60, sleep=lambda s: None,
                            kill=lambda p: self.fail('must not kill an exited process'))
        self.assertEqual(ctx.exception.code, 'CANDIDATE_EXIT:3')

        class Hung:
            pid = 1
            def poll(self):
                return None
        clock = iter([0, 0, 200])
        killed = []
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            lo.service_loop(Hung(), cand, ex.service_one_attestation, str, deadline_s=120,
                            now=lambda: next(clock), sleep=lambda s: None, kill=killed.append)
        self.assertEqual(ctx.exception.code, 'CANDIDATE_DEADLINE')
        self.assertEqual(len(killed), 1)

        def gone(p):
            raise ProcessLookupError()
        clock = iter([0, 0, 200])
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            lo.service_loop(Hung(), cand, ex.service_one_attestation, str, deadline_s=120,
                            now=lambda: next(clock), sleep=lambda s: None, kill=gone)
        self.assertEqual(ctx.exception.code, 'CANDIDATE_DEADLINE')

    def test_child_is_killed_on_any_failure_path(self):
        cand = os.path.join(self.d, 'c4'); os.mkdir(cand, 0o700)
        with open(os.path.join(cand, 'attest-B.request.json'), 'w') as f:
            json.dump({'lane': 'B', 'pid': 7, 'nonce': '2' * 32}, f)

        class Running:
            pid = 1
            def poll(self):
                return None
        killed = []

        def boom(lane, request, ops):
            raise RuntimeError('servicer failed')
        with self.assertRaises(RuntimeError):
            lo.service_loop(Running(), cand, boom, str, deadline_s=60, sleep=lambda s: None, kill=killed.append)
        self.assertEqual(len(killed), 1)

        class Finished:
            pid = 1
            def poll(self):
                return 0
        killed.clear()
        os.unlink(os.path.join(cand, 'attest-B.request.json'))
        self.assertEqual(lo.service_loop(Finished(), cand, boom, str, deadline_s=60, sleep=lambda s: None, kill=killed.append), [])
        self.assertEqual(killed, [])                                      # never kill a process that already exited

    def test_oversized_or_malformed_attest_request_fails_closed(self):
        cand = os.path.join(self.d, 'c3'); os.mkdir(cand, 0o700)
        # Otherwise-valid request padded past the 4 KiB bound: only the read bound can refuse it.
        with open(os.path.join(cand, 'attest-B.request.json'), 'w') as f:
            json.dump({'lane': 'B', 'pid': 1, 'nonce': '2' * 32, 'pad': 'x' * 5000}, f)

        class P:
            pid = 1
            def poll(self):
                return None
        killed = []
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            lo.service_loop(P(), cand, ex.service_one_attestation, lambda pid: 'maps', deadline_s=60,
                            sleep=lambda s: None, kill=killed.append)
        self.assertEqual(ctx.exception.code, 'READ_BOUND')
        self.assertEqual(len(killed), 1)
        with open(os.path.join(cand, 'attest-A.request.json'), 'w') as f:
            f.write('{not json')
        os.unlink(os.path.join(cand, 'attest-B.request.json'))
        with self.assertRaises(ValueError):
            lo.service_loop(P(), cand, ex.service_one_attestation, lambda pid: 'maps', deadline_s=60,
                            sleep=lambda s: None, kill=killed.append)


class TempHygieneTests(unittest.TestCase):
    def test_the_host_lock_test_leaves_no_directory(self):
        with tempfile.TemporaryDirectory(prefix='r3tmp-') as scratch:
            saved, tempfile.tempdir = tempfile.tempdir, scratch
            try:
                result = unittest.TestResult()
                unittest.defaultTestLoader.loadTestsFromName('test_host_lock_is_exclusive', ArgvTests).run(result)
            finally:
                tempfile.tempdir = saved
            self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
            self.assertEqual(os.listdir(scratch), [])


class DefaultKillTests(unittest.TestCase):
    def test_default_kill_never_signals_group_0_or_1(self):
        calls = []
        real = lo.os.killpg
        lo.os.killpg = lambda pid, sig: calls.append(pid)   # never send a real signal from a test
        try:
            class P:
                def __init__(self, pid):
                    self.pid = pid
            for pid in (0, 1, -1, None):
                lo._default_kill(P(pid))
            self.assertEqual(calls, [])
            lo._default_kill(P(4242))
            self.assertEqual(calls, [4242])
        finally:
            lo.os.killpg = real


# ---------------------------------------------------------------------------------------------------
# The operations themselves (_make_ops), with a fake subprocess module and clock: no host guard needed.
# ---------------------------------------------------------------------------------------------------
class _Done:
    def __init__(self, returncode=0, stdout=b'', stderr=b''):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class FakeSp:
    DEVNULL = PIPE = object()

    class TimeoutExpired(Exception):
        pass

    def __init__(self, script):
        self.script, self.calls = script, []

    def run(self, argv, **kw):
        self.calls.append(list(argv))
        return self.script(list(argv))

    def Popen(self, argv, **kw):
        self.calls.append(list(argv))
        data = self.script(list(argv)).stdout

        class P:
            def __init__(self):
                import io
                self.stdout = io.BytesIO(data)
            def kill(self):
                pass
            def wait(self, timeout=None):
                return 0
        return P()


class FakeClock:
    def __init__(self):
        self.t = 0.0
    def monotonic(self):
        return self.t
    def sleep(self, seconds):
        self.t += seconds


class _Contract:
    DOCKER = D
    CONTAINER_NAME = C


def make(script, clock=None, utc=None):
    sp = FakeSp(script)
    ops = lo._make_ops({'image': 'supabase/postgres@sha256:' + 'e' * 64}, _Contract, b'ssh-rsa AAAA\n', sp=sp,
                       clock=clock or FakeClock(), utc=utc)
    return ops, sp


def _load_rehearsal():
    spec = importlib.util.spec_from_file_location('rehearsal', os.path.join(HERE, 'rehearsal.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules['rehearsal'] = mod
    spec.loader.exec_module(mod)
    return mod


class MakeOpsTests(unittest.TestCase):
    def test_docker_object_exists_is_not_inverted(self):
        ops, _ = make(lambda argv: _Done(1, stderr=b'Error response from daemon: get x: no such volume'))
        self.assertIs(ops['docker_object_exists']('volume', 'x'), False)
        ops, _ = make(lambda argv: _Done(0, stdout=b'"x"'))
        self.assertIs(ops['docker_object_exists']('volume', 'x'), True)
        ops, _ = make(lambda argv: _Done(1, stderr=b'Cannot connect to the Docker daemon'))
        with self.assertRaises(ex.ExecutorRefusal):
            ops['docker_object_exists']('volume', 'x')

    def test_wait_ready_needs_tcp_then_a_quiet_log(self):
        sizes = iter(['10|7', '20|7', '20|7', '20|7', '20|7'])
        def script(argv):
            if 'pg_isready' in argv:
                return _Done(0 if argv[argv.index('-h') + 1] == '127.0.0.1' else 1)
            if LOG_STAT in ' '.join(argv):
                return _Done(0, stdout=next(sizes).encode())
            return _Done(1)
        LOG_STAT = ex.LOG_FILE
        clock = FakeClock()
        ops, sp = make(script, clock)
        self.assertTrue(ops['wait_ready']())
        ready_calls = [c for c in sp.calls if 'pg_isready' in c]
        self.assertTrue(ready_calls and all(c[c.index('-h') + 1] == '127.0.0.1' for c in ready_calls))
        self.assertGreaterEqual(clock.t, 3)                            # waited for 3 quiet seconds

    def test_wait_ready_times_out_when_only_the_socket_server_exists(self):
        ops, _ = make(lambda argv: _Done(1 if 'pg_isready' in argv else 0, stdout=b'1|1'))
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ops['wait_ready']()
        self.assertEqual(ctx.exception.code, 'READY_TIMEOUT')

    def test_wait_ready_never_settles_on_a_growing_log(self):
        counter = iter(range(10 ** 6))
        def script(argv):
            if 'pg_isready' in argv:
                return _Done(0)
            return _Done(0, stdout=('%d|7' % next(counter)).encode())
        ops, _ = make(script)
        with self.assertRaises(ex.ExecutorRefusal):
            ops['wait_ready']()

    def test_log_position_brackets_the_stat(self):
        order = []
        stamps = iter(['T1', 'T2'])
        def utc():
            order.append('utc')
            return next(stamps)
        def script(argv):
            order.append('stat')
            return _Done(0, stdout=b'4096|77' if ex.LOG_FILE in argv else b'0')
        ops, _ = make(script, utc=utc)
        pos = ops['log_position']()
        self.assertEqual(order, ['utc', 'stat', 'stat', 'utc'])
        self.assertEqual((pos['offset'], pos['inode'], pos['utc_before'], pos['utc_after']), (4096, 77, 'T1', 'T2'))

    def test_read_log_interval_is_exact_or_refuses(self):
        ops, sp = make(lambda argv: _Done(0, stdout=b'0123456789'))
        self.assertEqual(ops['read_log_interval'](100, 10), b'0123456789')
        self.assertEqual(sp.calls[-1][-3:], ['-c', '+101', ex.LOG_FILE])
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ops['read_log_interval'](100, 11)                           # short (EACCES / vanished): never "clean"
        self.assertEqual(ctx.exception.code, 'LOG_READ_SHORT')
        ops, _ = make(lambda argv: _Done(1, stdout=b''))
        with self.assertRaises(ex.ExecutorRefusal):
            ops['read_log_interval'](0, 5)

    def test_rehearsal_ops_issue_the_reviewed_argv(self):
        ops, sp = make(lambda argv: _Done(0, stdout=b'100|101|3775|directory\n'))
        self.assertEqual(ops['stat_owner']('/run/postgresql').strip(), '100|101|3775|directory')
        self.assertEqual(sp.calls[-1], lo.stat_owner_argv(D, C, '/run/postgresql'))
        ops['start_holder']()
        self.assertEqual(sp.calls[-1], lo.holder_argv(D, C))
        ops['proc1_comm']()
        self.assertEqual(sp.calls[-1], lo.proc1_comm_argv(D, C))
        ops['read_maps'](42)
        self.assertEqual(sp.calls[-1], lo.maps_argv(D, C, 42))
        self.assertRegex(ops['gen_marker'](), r'^[a-f0-9]{32}$')
        self.assertIn('host_lock', ops)
        seen = {}
        def script(argv):
            return _Done(0, stdout=b'tok123\n')
        sp2 = FakeSp(script)
        ops2 = lo._make_ops({'image': 'x'}, _Contract, b'r', sp=sp2, clock=FakeClock())
        real_run = sp2.run
        def run(argv, **kw):
            seen['stdin'] = kw.get('input')
            return real_run(argv, **kw)
        sp2.run = run
        self.assertEqual(ops2['prompt_probe']('tok123').strip(), 'tok123')
        self.assertEqual(seen['stdin'], b'tok123\n')                 # the token travels on stdin, never argv
        self.assertNotIn('tok123', ' '.join(sp2.calls[-1]))

    def test_holder_app_matches_the_pid_query(self):
        import importlib
        rh = sys.modules.get('rehearsal') or _load_rehearsal()
        self.assertIn("application_name = '%s'" % lo.HOLDER_APP, rh.HOLDER_QUERY)

    def test_run_refuses_on_failure_and_never_returns_stderr(self):
        ops, _ = make(lambda argv: _Done(1, stdout=b'', stderr=b'postgresql://u:hunter2@h'))
        with self.assertRaises(ex.ExecutorRefusal) as ctx:
            ops['run'](['docker', 'x'], 'probe')
        self.assertEqual(ctx.exception.code, 'COMMAND_FAILED:probe')
        self.assertNotIn('hunter2', str(ctx.exception))


if __name__ == '__main__':
    unittest.main(verbosity=2)

