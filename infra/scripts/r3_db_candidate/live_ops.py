#!/usr/bin/env python3
"""db-candidate05/live_ops.py — private offline preparation. NOT an execution authorization.

The REAL injected-operations bundle for runtime_executor.run_attempt: thin subprocess/filesystem
wrappers around Docker, the image's own psql (inside the container), the Node candidate and age. It is
inert unless `build_live_ops(config)` is called, and that refuses unless ALL hold:
  * config['execute'] is True (the owner's explicit single-attempt approval was given to the runner),
  * the host is Linux / x86_64 (never this macOS dev machine — Prisma's Linux engine and the 16 GB
    freeze protocol both require the disposable Linux/amd64 runner),
  * no ambient DOCKER_HOST / DOCKER_CONTEXT / DATABASE_URL / DIRECT_URL / PG* / PRISMA_* variables.
Secrets never enter argv: the bootstrap POSTGRES_PASSWORD reaches Docker only through a private 0600
--env-file, and the probe password reaches the image's psql `\\password` only through stdin. Every
command has a timeout and a bounded capture; failures raise ExecutorRefusal with a code, never stderr.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import platform
import re
import secrets
import signal
import stat
import subprocess
import time

from runtime_executor import ExecutorRefusal, LOG_FILE, STDERR_LOG_FILE, PROBE_ROLE, BOOTSTRAP_ROLE, SECRET_FILES, _check

CMD_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
FORBIDDEN_ENV = ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DATABASE_URL', 'DIRECT_URL', 'NODE_OPTIONS')
FORBIDDEN_ENV_PREFIX = ('PG', 'PRISMA_', 'LD_')
# Exactly entrypoint.mjs ENV_REQUIRED (+ HOME): the Node gate sanitizes the LIVE env, so this is all it gets.
NODE_ENV_REQUIRED = {'PATH': '/usr/lib/postgresql/17/bin:/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC'}
CAPTURE_LIMIT = 8 * 1024 * 1024
ATTEST_REQUEST_LIMIT = 4096
PSQL_FLAGS = ('-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '/var/run/postgresql', '-U', BOOTSTRAP_ROLE, '-d', 'postgres')


# ---------------------------------------------------------------------------------------------------
# Runner guard + pure argv builders (tested; no execution).
# ---------------------------------------------------------------------------------------------------
def require_runner(*, system, machine, env, execute):
    _check(execute is True, 'LIVE_NO_EXECUTE')
    _check(system == 'Linux' and machine in ('x86_64', 'amd64'), 'LIVE_NOT_LINUX_AMD64')
    for name in env:
        _check(name not in FORBIDDEN_ENV and not any(name.startswith(p) for p in FORBIDDEN_ENV_PREFIX), 'LIVE_ENV:' + name)
    return True


def psql_argv(docker, container):
    return list(docker) + ['exec', '-i', container, 'psql', *PSQL_FLAGS, '-f', '-']


def password_argv(docker, container):
    return list(docker) + ['exec', '-i', container, 'psql', *PSQL_FLAGS, '-c', '\\password ' + PROBE_ROLE]


def password_stdin(password):
    _check(isinstance(password, str) and re.fullmatch(r'[A-Za-z0-9_-]{24,128}', password) is not None, 'PASSWORD_FORMAT')
    return (password + '\n' + password + '\n').encode()


# N1: with --cap-drop ALL, root in the container has no DAC_OVERRIDE/SYS_PTRACE, so it can neither read the
# postgres-owned 0600 jsonlog nor /proc/<backend>/maps. The observers therefore run AS postgres: same uid
# as the server, which needs no capability and keeps the log at 0600.
OBSERVER_USER = 'postgres'


def maps_argv(docker, container, pid):
    _check(isinstance(pid, int) and pid > 0, 'MAPS_PID')
    return list(docker) + ['exec', '--user', OBSERVER_USER, container, 'cat', '/proc/%d/maps' % pid]


def file_observe_argvs(docker, container, path):
    _check(path.startswith('/nix/store/') and '..' not in path, 'OBSERVE_PATH')
    st = list(docker) + ['exec', '--user', OBSERVER_USER, container, 'stat', '-c', '%F|%d|%i|%s', path]
    return st, list(docker) + ['exec', '--user', OBSERVER_USER, container, 'sha256sum', path], st


def log_stat_argv(docker, container):
    return list(docker) + ['exec', '--user', OBSERVER_USER, container, 'stat', '-c', '%s|%i', LOG_FILE]


def log_tail_argv(docker, container, offset):
    _check(isinstance(offset, int) and offset >= 0, 'LOG_OFFSET')
    return list(docker) + ['exec', '--user', OBSERVER_USER, container, 'tail', '-c', '+%d' % (offset + 1), LOG_FILE]


def state_argv(docker, container):
    fmt = ('{"restart_count":{{.RestartCount}},"oom_killed":{{.State.OOMKilled}},'
           '"started_at":{{json .State.StartedAt}},"running":{{.State.Running}},"exit_code":{{.State.ExitCode}}}')
    return list(docker) + ['inspect', '--format', fmt, container]


def ready_argv(docker, container):
    # TCP inside the container: the init-time temporary server listens on the socket only.
    return list(docker) + ['exec', container, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '5432', '-U', BOOTSTRAP_ROLE,
                           '-d', 'postgres']


def stderr_stat_argv(docker, container):
    return list(docker) + ['exec', '--user', OBSERVER_USER, container, 'stat', '-c', '%s', STDERR_LOG_FILE]


def inspect_argv(docker, kind, name):
    _check(kind in ('container', 'network', 'volume'), 'INSPECT_KIND')
    return list(docker) + [kind, 'inspect', '--format', '{{json .Name}}', name]


def pull_argv(docker, image):
    _check(re.fullmatch(r'supabase/postgres@sha256:[a-f0-9]{64}', image) is not None, 'PULL_BY_DIGEST_ONLY')
    return list(docker) + ['pull', '--platform', 'linux/amd64', image]


def node_env(home):
    _check(isinstance(home, str) and home.startswith('/'), 'NODE_HOME')
    return dict(NODE_ENV_REQUIRED, HOME=home)


def normalized_recipient(text, expected_sha256):
    """Same rule as infra r3_noble_inputs.recipient: one ssh-rsa/ssh-ed25519 key, no comment."""
    parts = text.strip().split()
    _check(len(parts) == 2 and parts[0] in ('ssh-rsa', 'ssh-ed25519'), 'RECIPIENT_SHAPE')
    normalized = (' '.join(parts) + '\n').encode()
    _check(hashlib.sha256(normalized).hexdigest() == expected_sha256, 'RECIPIENT_PIN')
    return normalized


def select_seal_files(work, allowlist, exists):
    for name in allowlist:
        _check(name not in SECRET_FILES and '..' not in name and not name.startswith('/'), 'SEAL_ALLOWLIST:' + name)
    return [name for name in allowlist if exists(os.path.join(work, name))]


def utc_micros(now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return now.strftime('%Y-%m-%dT%H:%M:%S.%fZ')


# ---------------------------------------------------------------------------------------------------
# Filesystem primitives (exclusive, no-follow, 0600/0700, fsync).
# ---------------------------------------------------------------------------------------------------
def write_exclusive(path, data):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_bounded(path, limit=CAPTURE_LIMIT):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        _check(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'READ_BOUND')
        return os.read(fd, limit + 1)[:limit]
    finally:
        os.close(fd)


def hash_file(path, limit=64 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        _check(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'HASH_BOUND')
        digest, total = hashlib.sha256(), 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            _check(total <= limit, 'HASH_BOUND')
            digest.update(chunk)
        after = os.fstat(fd)
        _check((after.st_ino, after.st_size, after.st_mtime_ns) == (info.st_ino, info.st_size, info.st_mtime_ns), 'HASH_CHANGED')
        return digest.hexdigest(), total
    finally:
        os.close(fd)


def assert_fresh_work_dir(path):
    """The attempt's work tree must be new (absent) or an empty 0700 directory owned by us."""
    _check(isinstance(path, str) and path.startswith('/') and '..' not in path, 'WORK_DIR_PATH')
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        os.makedirs(path, mode=0o700)
        return True
    _check(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.getuid()
           and stat.S_IMODE(info.st_mode) == 0o700 and not os.listdir(path), 'WORK_DIR_NOT_FRESH')
    return True


def port_free(port):
    import socket
    _check(isinstance(port, int) and 1024 <= port <= 65535, 'PORT_RANGE')
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


# ---------------------------------------------------------------------------------------------------
# Rehearsal-only argv (read-only observations; no role, no fixture, no probe). See rehearsal.py.
# ---------------------------------------------------------------------------------------------------
HOLDER_APP = 'r3_rehearsal_holder'
STAT_ALLOWED = ('/run/postgresql', '/var/log/postgresql-r3', '/var/lib/postgresql/data', '/etc/postgresql-custom',
                '/etc/postgresql-custom/pgsodium_root.key')


def holder_argv(docker, container, seconds=30):
    """A detached supabase_admin session (local socket, trust) that just sleeps, so one session-preloaded
    backend stays alive while its /proc maps are read. It creates and changes nothing."""
    _check(isinstance(seconds, int) and 5 <= seconds <= 120, 'HOLDER_SECONDS')
    return list(docker) + ['exec', '--detach', '--env', 'PGAPPNAME=' + HOLDER_APP, container, 'psql', '-X', '-q',
                           '-h', '/var/run/postgresql', '-U', BOOTSTRAP_ROLE, '-d', 'postgres',
                           '-c', 'SELECT pg_sleep(%d);' % seconds]


def stat_owner_argv(docker, container, path):
    _check(path in STAT_ALLOWED, 'STAT_PATH')
    return list(docker) + ['exec', '--user', OBSERVER_USER, container, 'stat', '-c', '%u|%g|%a|%F', path]


def prompt_probe_argv(docker, container):
    """psql's \\prompt reads through the same simple_prompt() that \\password uses; under `docker exec -i`
    (no tty) it must fall back to stdin. Proves the \\password route without creating any role."""
    return list(docker) + ['exec', '-i', container, 'psql', *PSQL_FLAGS, '-c', "\\prompt 'r3: ' r3v", '-c', '\\echo :r3v']


def proc1_comm_argv(docker, container):
    return list(docker) + ['exec', '--user', OBSERVER_USER, container, 'cat', '/proc/1/comm']


# F1: one host-wide lock shared by the attempt and the rehearsal, so they can never run at once (their
# Docker objects share names; one's teardown must never touch the other's).
HOST_LOCK_PATH = '/var/tmp/tonyai-r3-db-candidate.lock'


def acquire_host_lock(path=HOST_LOCK_PATH):
    """Non-blocking exclusive flock held until this process exits; refuses if another run holds it."""
    import fcntl
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise ExecutorRefusal('HOST_LOCK_BUSY')
    return fd                                  # deliberately never closed: released when the process ends


def interpret_stderr_stat(returncode, stdout, stderr):
    """F3: 'absent' (no such file) is a fact; an unreadable file is not 0 bytes."""
    if returncode == 0:
        text = (stdout or b'').decode().strip()
        _check(text.isdigit(), 'STDERR_STAT_SHAPE')
        return int(text)
    _check(b'no such file' in (stderr or b'').lower(), 'STDERR_STAT_FAILED')
    return 'absent'


def interpret_inspect(kind, returncode, stderr, name=''):
    """`docker <kind> inspect` outcome -> exists? Only the kind-specific "missing" wording counts as absent
    ("No such container: x", "get x: no such volume", "network x not found" / "No such network: x").
    Anything else — notably a missing daemon socket ("... connect: no such file or directory") — refuses,
    so an unreachable daemon can never look like a clean host and let the attempt be consumed."""
    if returncode == 0:
        return True
    lowered = (stderr or b'').lower()
    daemon_errors = (b'no such file', b'cannot connect', b'connect:', b'error during connect', b'docker daemon',
                     b'permission denied')
    _check(not any(marker in lowered for marker in daemon_errors), 'DOCKER_DAEMON_UNREACHABLE')
    phrases = {'container': (b'no such container',), 'volume': (b'no such volume',),
               'network': (b'no such network', b'network ' + name.lower().encode() + b' not found')}
    _check(kind in phrases and any(p in lowered for p in phrases[kind]), 'DOCKER_INSPECT_FAILED:' + kind)
    return False


def consume_attempt(state_dir, attempt):
    """Durable one-shot record. A second call for the same attempt (any process) refuses."""
    _check(re.fullmatch(r'[a-f0-9]{32}', attempt) is not None, 'CONSUME_ATTEMPT_FORMAT')
    path = os.path.join(state_dir, 'consumed-' + attempt)
    try:
        write_exclusive(path, utc_micros().encode())
    except FileExistsError:
        raise ExecutorRefusal('ATTEMPT_ALREADY_CONSUMED')
    dfd = os.open(state_dir, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


# ---------------------------------------------------------------------------------------------------
# Attestation service loop (pure-ish: process + clock + sleep injected; tested with a fake process).
# ---------------------------------------------------------------------------------------------------
def service_loop(proc, candidate_dir, servicer, read_maps, *, deadline_s, now=time.monotonic, sleep=time.sleep,
                 kill=None):
    """While the Node candidate runs, answer each attest-<lane>.request.json once (read /proc maps while
    the lane transaction is open), then drop attest-<lane>.ack. Kills the process group at the deadline."""
    start, lanes, served = now(), [], set()
    raw_kill = kill or _default_kill
    killed = []

    def killer(p):                         # at most once per run
        if not killed:
            killed.append(True)
            raw_kill(p)
    try:
        return _service(proc, candidate_dir, servicer, read_maps, deadline_s, now, sleep, killer, start, lanes, served)
    finally:
        if not killed and proc.poll() is None:   # failure on any path: the candidate must not outlive us
            try:
                killer(proc)
            except ProcessLookupError:
                pass


def _default_kill(proc):
    # Never signal process group 0/1 (that would be this session or init); real Popen children are > 1.
    if isinstance(proc.pid, int) and proc.pid > 1:
        os.killpg(proc.pid, signal.SIGKILL)


def _service(proc, candidate_dir, servicer, read_maps, deadline_s, now, sleep, killer, start, lanes, served):
    while True:
        for lane in ('B', 'A', 'C'):
            req_path = os.path.join(candidate_dir, 'attest-%s.request.json' % lane)
            if lane in served or not os.path.exists(req_path):
                continue
            request = json.loads(read_bounded(req_path, ATTEST_REQUEST_LIMIT).decode())
            lanes.append(servicer(lane, request, {'read_maps': read_maps}))
            write_exclusive(os.path.join(candidate_dir, 'attest-%s.ack' % lane), b'1')
            served.add(lane)
        code = proc.poll()
        if code is not None:
            _check(code == 0, 'CANDIDATE_EXIT:%d' % code)
            return lanes
        if now() - start > deadline_s:
            try:
                killer(proc)
            except ProcessLookupError:
                pass  # it exited between poll() and kill; the deadline still decides the outcome (cf. PR #231)
            raise ExecutorRefusal('CANDIDATE_DEADLINE')
        sleep(0.05)


# ---------------------------------------------------------------------------------------------------
# The live bundle.
# ---------------------------------------------------------------------------------------------------
def build_live_ops(config, *, contract):
    require_runner(system=platform.system(), machine=platform.machine(), env=dict(os.environ),
                   execute=config.get('execute'))
    recipient = normalized_recipient(read_bounded(config['recipient_path'], 16384).decode(), config['recipient_sha256'])
    _check(hashlib.sha256(read_bounded(config['age_path'], 32 * 1024 * 1024)).hexdigest() == config['age_sha256'], 'AGE_PIN')
    return _make_ops(config, contract, recipient)


def _make_ops(config, contract, recipient, *, sp=subprocess, clock=time, utc=None):
    """The operations themselves, with subprocess/clock injectable so they are testable on any host.
    Only build_live_ops (behind the runner guard) constructs them for a real attempt."""
    utc = utc or utc_micros
    docker, container = list(contract.DOCKER), contract.CONTAINER_NAME

    def run(argv, label, stdin=None, timeout=300, limit=CAPTURE_LIMIT):
        try:
            done = sp.run(argv, input=stdin, capture_output=True, timeout=timeout, env=CMD_ENV,
                                  stdin=None if stdin is not None else sp.DEVNULL, start_new_session=True)
        except sp.TimeoutExpired:
            raise ExecutorRefusal('COMMAND_TIMEOUT:' + label)
        _check(done.returncode == 0, 'COMMAND_FAILED:' + label)
        _check(len(done.stdout) <= limit, 'COMMAND_OUTPUT_BOUND:' + label)
        return done.stdout

    def quiet_probe(argv):
        return sp.run(argv, env=CMD_ENV, capture_output=True, timeout=10, stdin=sp.DEVNULL)

    def log_size():
        done = quiet_probe(log_stat_argv(docker, container))
        return done.stdout.decode().strip() if done.returncode == 0 else None

    def wait_ready():
        deadline = clock.monotonic() + 240
        while clock.monotonic() < deadline:
            # TCP readiness inside the container: the init-time temporary server never listens on TCP.
            if quiet_probe(ready_argv(docker, container)).returncode == 0:
                stable, last = 0, log_size()
                while stable < 3 and clock.monotonic() < deadline:     # log quiet for 3 consecutive seconds
                    clock.sleep(1)
                    current = log_size()
                    stable = stable + 1 if (current is not None and current == last) else 0
                    last = current
                if stable >= 3:
                    return True
            clock.sleep(1)
        raise ExecutorRefusal('READY_TIMEOUT')

    def log_position():
        before = utc()                       # bracket the stat: [before, after] contains the offset's instant
        size, inode = run(log_stat_argv(docker, container), 'log-stat').decode().strip().split('|')
        err = quiet_probe(stderr_stat_argv(docker, container))
        stderr_size = interpret_stderr_stat(err.returncode, err.stdout, err.stderr)
        after = utc()
        return {'offset': int(size), 'inode': int(inode), 'stderr_size': stderr_size, 'utc_before': before, 'utc_after': after}

    def docker_object_exists(kind, name):
        done = quiet_probe(inspect_argv(docker, kind, name))
        return interpret_inspect(kind, done.returncode, done.stderr, name)

    def remove_secret(path):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    def read_log_interval(offset, n):
        # Exactly the bytes [offset, offset+n) that were measured; a failed or short read (EACCES, a
        # vanished file) refuses instead of returning an empty "clean" interval.
        proc = sp.Popen(log_tail_argv(docker, container, offset), stdout=sp.PIPE,
                        stderr=sp.DEVNULL, stdin=sp.DEVNULL, env=CMD_ENV, start_new_session=True)
        chunks, total = [], 0
        try:
            while total < n:
                chunk = proc.stdout.read(min(65536, n - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
        finally:
            proc.kill()
            proc.wait(timeout=10)
        data = b''.join(chunks)
        _check(len(data) == n, 'LOG_READ_SHORT')
        return data

    def run_candidate(descriptor_path, servicer):
        work = os.path.dirname(os.path.dirname(descriptor_path))
        os.mkdir(work + '/home', 0o700)
        proc = sp.Popen([config['node_path'], os.path.join(config['source_root'], 'run_candidate.mjs'),
                                 descriptor_path], env=node_env(work + '/home'), cwd=work + '/home',
                                stdin=sp.DEVNULL, stdout=sp.DEVNULL, stderr=sp.DEVNULL,
                                start_new_session=True)
        return service_loop(proc, work + '/candidate', servicer,
                            lambda pid: run(maps_argv(docker, container, pid), 'maps', limit=1024 * 1024).decode(),
                            deadline_s=config.get('candidate_timeout_s', 120))

    def seal(work, allowlist):
        names = select_seal_files(work, allowlist, os.path.exists)
        tar_path, out = work + '/private-evidence.tar', work + '/publish/db-candidate-evidence.tar.age'
        run(['tar', '--create', '--file', tar_path, '--directory', work, '--no-recursion', '--', *names], 'tar')
        write_exclusive(work + '/publish/recipient.pub', recipient)
        run([config['age_path'], '-R', work + '/publish/recipient.pub', '-o', out, tar_path], 'age-encrypt')
        return {'sealed': True, 'files': names, 'ciphertext_sha256': hashlib.sha256(read_bounded(out, 64 * 1024 * 1024)).hexdigest()}

    def make_dir(path):
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        os.mkdir(path, 0o700)

    return {
        'run': run,
        'psql_bootstrap': lambda sql, label: run(psql_argv(docker, container), 'psql-' + label, stdin=sql.encode()),
        'set_probe_password': lambda pw: run(password_argv(docker, container), 'probe-password', stdin=password_stdin(pw)),
        'write': lambda path, data: write_exclusive(path, data),
        'write_secret': lambda path, text: write_exclusive(path, text.encode()),
        'read_bytes': lambda path: read_bounded(path),
        'sha256': lambda data: hashlib.sha256(data).hexdigest(),
        'hash_file': hash_file,
        'port_free': port_free,
        'realpath': os.path.realpath,
        'docker_object_exists': docker_object_exists,
        'assert_fresh_work_dir': assert_fresh_work_dir,
        'remove_secret': remove_secret,
        'gen_secret': lambda: secrets.token_hex(32),
        'consume_attempt': lambda attempt: consume_attempt(config['state_dir'], attempt),
        'ensure_image': lambda: run(pull_argv(docker, config['image']), 'pull', timeout=1800),
        'wait_ready': wait_ready,
        'container_state': lambda: json.loads(run(state_argv(docker, container), 'state').decode()),
        'log_position': log_position,
        'utc_now': utc,
        'make_empty_private_dir': make_dir,
        'run_candidate': run_candidate,
        'observe_library': lambda path: tuple(run(a, 'observe').decode() for a in file_observe_argvs(docker, container, path)),
        'read_log_interval': read_log_interval,
        'host_lock': lambda: acquire_host_lock(),
        'start_holder': lambda: run(holder_argv(docker, container), 'holder'),
        'read_maps': lambda pid: run(maps_argv(docker, container, pid), 'maps', limit=1024 * 1024).decode(),
        'gen_marker': lambda: secrets.token_hex(16),
        'stat_owner': lambda path: run(stat_owner_argv(docker, container, path), 'stat-owner').decode(),
        'prompt_probe': lambda token: run(prompt_probe_argv(docker, container), 'prompt-probe',
                                          stdin=(token + '\n').encode()).decode(),
        'proc1_comm': lambda: run(proc1_comm_argv(docker, container), 'proc1').decode().strip(),
        'sleep': clock.sleep,
        'seal': seal,
    }
