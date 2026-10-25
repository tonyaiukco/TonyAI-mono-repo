"""Bounded fixture I/O. No entry point, package policy or production receipt."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import time

ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
       'LANG': 'C', 'LC_ALL': 'C', 'SYSTEMD_PAGER': 'cat', 'PYTHONDONTWRITEBYTECODE': '1'}
FILE_LIMIT = 8 * 1024 * 1024
STREAM_LIMIT = 64 * 1024 * 1024


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)


def read(path, limit=FILE_LIMIT):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('Unsafe or oversized fixture file')
        data = bytearray()
        while len(data) < before.st_size:
            part = os.read(fd, min(65536, before.st_size - len(data)))
            if not part:
                raise ValueError('Short fixture read')
            data.extend(part)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError('Fixture file changed')
        return bytes(data)
    finally:
        os.close(fd)


def reaped_group_gone(child):
    """Darwin refuses killpg with EPERM when no member can take the signal: an
    exiting or zombie leader alone in its group. Reap that leader (bounded), then
    accept the refusal only when the group no longer exists; a leader that does
    not exit, or a member still present, stays refused."""
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return False
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def kill_group(child, privileged=False):
    if privileged:
        # Runner APT executes as root. Never claim unprivileged killpg contains it.
        cleanup = subprocess.run(['sudo', '-n', '/bin/kill', '-KILL', '--', '-' + str(child.pid)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=ENV, timeout=5)
        if cleanup.returncode not in (0, 1):
            raise ValueError('Privileged runner cleanup failed')
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        if not privileged and not reaped_group_gone(child):
            raise
    child.wait(timeout=5)
    if privileged:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return
        except PermissionError as exc:
            raise ValueError('Privileged runner group still exists') from exc
        raise ValueError('Privileged runner group still exists')


def run(argv, directory, label, timeout=120, sample=None, limit=FILE_LIMIT, privileged=False):
    """Bound both captured streams, without restricting installed payload sizes.

    Raw output stays in private files. Every launched child has a process group;
    on refusal/deadline the group is killed and the leader reaped. Detached
    children are a retained qualification question, not claimed contained here.
    """
    directory = Path(directory)
    stdout, stderr = directory / (label + '.stdout'), directory / (label + '.stderr')
    started, failure, child = time.monotonic(), None, None
    with stdout.open('xb') as out, stderr.open('xb') as err, selectors.DefaultSelector() as selector:
        try:
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env=ENV, start_new_session=True)
            identity = {'pid': child.pid, 'pgrp': child.pid}
            if Path('/proc').is_dir():
                try:
                    fields = (Path('/proc') / str(child.pid) / 'stat').read_text().rsplit(') ', 1)[1].split()
                    identity['start_ticks'] = int(fields[19])
                except FileNotFoundError:
                    pass
            write(directory / (label + '.command.json'), encoded({'argv': argv, 'child': identity}))
            for stream, target in ((child.stdout, out), (child.stderr, err)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, [target, 0])
            next_sample = started
            while selector.get_map() or child.poll() is None:
                now = time.monotonic()
                if now - started >= timeout:
                    raise TimeoutError('Fixture command deadline')
                if sample and now >= next_sample:
                    sample(identity)
                    next_sample = time.monotonic() + 1
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    target, count = key.data
                    if count + len(chunk) > limit:
                        target.write(chunk[:max(0, limit - count)])
                        raise ValueError('Fixture output limit')
                    target.write(chunk)
                    key.data[1] += len(chunk)
            if sample:
                sample(identity)
        except BaseException as exc:
            failure = exc
        finally:
            if child is not None:
                try:
                    kill_group(child, privileged=privileged)
                except Exception as exc:
                    failure = exc
                child.stdout.close()
                child.stderr.close()
    result = {'returncode': None if child is None else child.returncode,
              'elapsed_seconds': time.monotonic() - started,
              'failure_type': None if failure is None else type(failure).__name__,
              'stdout_sha256': file_hash(stdout), 'stderr_sha256': file_hash(stderr)}
    write(directory / (label + '.exit.json'), encoded(result))
    if failure is not None:
        raise failure
    if child.returncode != 0:
        raise ValueError('Fixture command refused')
    return read(stdout, limit)
