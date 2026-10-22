"""Private, bounded identity context after a decided fixture baseline refusal.

This module never classifies a process as safe or changes the refusal policy.
"""
import base64
import os
from pathlib import Path
import signal
import stat
import tempfile
import time

from r3_noble_common import digest, encoded, read, run, write

SNAPSHOT = 'baseline-refusal-identity.json'
SNAPSHOT_LIMIT = 2 * 1024 * 1024
PROCESS_LIMIT = 16
FIXED_FILES = (
    ('/usr/share/unattended-upgrades/unattended-upgrade-shutdown', 1024 * 1024),
    ('/usr/bin/unattended-upgrade', 1024 * 1024),
    ('/usr/lib/systemd/system/unattended-upgrades.service', 128 * 1024),
)
UNIT_ARGV = ['systemctl', 'show', 'unattended-upgrades.service', '--no-pager',
             '--property=MainPID,ControlGroup,InvocationID,ExecStart,FragmentPath,DropInPaths']


class IdentityDeadline(BaseException):
    """Do not let per-field error handling swallow the one-shot deadline."""


def error(exc):
    # Exception messages may contain uncontrolled path or command output.
    return {'error': type(exc).__name__}


def metadata(info):
    return {name: getattr(info, 'st_' + name) for name in
            ('dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtime_ns', 'ctime_ns')}


def open_parent(path):
    """Do not follow even intermediate symlinks in the fixed/proc path."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid identity path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def bounded_file(path, limit, proc=False):
    parent = open_parent(path)
    try:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or (not proc and before.st_size > limit):
            raise ValueError('Unsafe or oversized identity file')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        return bytes(data[:limit]), {
            'before': metadata(before), 'after': metadata(after),
            'metadata_equal': metadata(before) == metadata(after),
            'truncated': len(data) > limit,
        }
    finally:
        os.close(fd)


def byte_record(data):
    return {'base64': base64.b64encode(data).decode('ascii'), 'bytes': len(data), 'sha256': digest(data)}


def proc_identity(path):
    data, meta = bounded_file(path / 'stat', 4096, proc=True)
    if meta['truncated']:
        raise ValueError('Oversized process identity')
    head, fields = data.rsplit(b') ', 1)
    fields = fields.split()
    pid = int(head.split(b' (', 1)[0])
    if pid != int(path.name):
        raise ValueError('Process identity differs')
    return {'pid': pid, 'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'start_ticks': int(fields[19])}


def process_record(original):
    expected = {key: original[key] for key in ('pid', 'pgrp', 'start_ticks')}
    if any(type(value) is not int or value < 0 for value in expected.values()) or expected['pid'] == 0:
        raise ValueError('Invalid recorded process identity')
    path = Path('/proc') / str(expected['pid'])
    record = {'observed_identity': expected}
    try:
        record['before'] = proc_identity(path)
        if any(record['before'][key] != value for key, value in expected.items()):
            record['identity_matches_observation'] = False
            return record  # Do not inspect a reused PID's argv or link.
        for name, limit in (('cmdline', 4096), ('cgroup', 16384)):
            try:
                data, meta = bounded_file(path / name, limit, proc=True)
                record[name] = {**byte_record(data), **meta}
            except Exception as exc:
                record[name] = error(exc)
        try:
            parent = open_parent(path / 'exe')
            try:
                # Read the link itself; never read/hash its dynamic target.
                target = os.fsencode(os.readlink('exe', dir_fd=parent))
                record['exe_link'] = {**byte_record(target[:4096]), 'truncated': len(target) > 4096}
            finally:
                os.close(parent)
        except Exception as exc:
            record['exe_link'] = error(exc)
        record['after'] = proc_identity(path)
        record['identity_matches_observation'] = all(record['after'][key] == value for key, value in expected.items())
    except Exception as exc:
        record.update(error(exc))
        record['identity_matches_observation'] = False
    return record


def unit_record(directory, deadline):
    # common.run can spend up to five seconds reaping its own query process.
    # Leave that budget plus scheduling slack inside the overall ten seconds.
    if deadline - time.monotonic() < 8:
        return {'argv': UNIT_ARGV, 'error': 'InsufficientBudget'}
    result = {'argv': UNIT_ARGV}
    try:
        run(UNIT_ARGV, directory, 'unit', timeout=2, limit=16384)
    except Exception as exc:
        result.update(error(exc))
    for suffix, limit in (('stdout', 16384), ('stderr', 16384), ('command.json', 4096), ('exit.json', 4096)):
        try:
            result[suffix] = byte_record(read(directory / ('unit.' + suffix), limit))
        except Exception as exc:
            result[suffix] = error(exc)
    return result


def collect(observation, directory, deadline):
    processes = observation['processes']
    value = {'format': 1, 'purpose': 'REFUSAL_CONTEXT_ONLY', 'identity_proves_inactivity': False,
             'observed_process_count': len(processes), 'process_limit': PROCESS_LIMIT,
             'omitted_process_count': max(0, len(processes) - PROCESS_LIMIT),
             'original_observation': 'observations.json:0', 'processes': [], 'fixed_files': {}}
    value['unit'] = unit_record(directory, deadline)
    for original in processes[:PROCESS_LIMIT]:
        value['processes'].append(process_record(original))
    # Bound base64 expansion plus process/unit metadata below the serialized cap.
    remaining = 1024 * 1024
    for path, limit in FIXED_FILES:
        try:
            data, meta = bounded_file(path, min(limit, remaining))
            remaining -= len(data)
            value['fixed_files'][path] = {**byte_record(data), **meta}
        except Exception as exc:
            value['fixed_files'][path] = error(exc)
    return value


def retain(output, observation, command_deadline):
    """Best effort within the existing failure budget; never changes acceptance."""
    started = time.monotonic()
    budget = min(10, command_deadline - started)
    if budget <= 0:
        return {'error': 'InsufficientBudget'}
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_timer[0]:
        budget = min(budget, previous_timer[0])
    def expired(_signal, _frame):
        raise IdentityDeadline('Refusal identity deadline')
    try:
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, budget)
        # A failed/interrupted scratch cleanup must not poison the archive's
        # strict top-level member allowlist. Scratch stays in a private sibling.
        with tempfile.TemporaryDirectory(prefix='.identity-', dir=output.parent) as name:
            directory = Path(name)
            value = collect(observation, directory, started + budget)
            value['elapsed_seconds'] = time.monotonic() - started
            data = encoded(value)
            if len(data) > SNAPSHOT_LIMIT:
                raise ValueError('Identity snapshot size limit')
            write(directory / SNAPSHOT, data)
            # Atomic, no overwrite; a partial write can never enter the archive.
            os.link(directory / SNAPSHOT, output / SNAPSHOT)
        return {'file': SNAPSHOT, 'sha256': digest(data)}
    except BaseException as exc:
        return error(exc)  # Even interruption preserves the already-decided refusal.
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])
