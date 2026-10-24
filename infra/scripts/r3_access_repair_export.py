"""Guest read-only evidence export, separately approved from repair. No CLI."""
import base64
from contextlib import ExitStack
import os
import signal
import stat
import sys

from r3_access_repair import MAX_KEYS, bounded_read, require, same, sha256
from r3_access_repair_guest import Directories, Deadline, expired, validate
from r3_policy_target import identity

FILES = {'invocation.json': 16384, 'authorized_keys.before': MAX_KEYS,
         'prepared.json': 16384, 'pre-close-result.json': 32768}


def export(proposal):
    validate(proposal)
    require(sys.platform == 'linux' and os.geteuid() == 0 and sys.dont_write_bytecode, 'GUEST_RUNTIME')
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'EXISTING_TIMER')
    result = {'format': 1, 'purpose': 'R3_REPAIR_PRIVATE_EXPORT', 'packet_id': proposal['packet_id'],
              'identity_before': None, 'identity_after': None, 'files': {},
              'status': 'PARTIAL_REVIEW_REQUIRED', 'failure': None, 'cleanup_errors': []}
    old = signal.signal(signal.SIGALRM, expired)
    signal.alarm(30)
    try:
        result['identity_before'] = identity()
        require(result['identity_before']['imds'] == proposal['target_imds'], 'IMDS_MISMATCH')
        with ExitStack() as stack:
            dirs = Directories(stack)
            var = dirs.child(dirs.root, 'var')
            lib = dirs.child(var, 'lib')
            evidence = dirs.child(lib, 'tonyai-r3-access-recovery-' + proposal['packet_id'], mode=0o700)
            for name, cap in FILES.items():
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=evidence)
                    try:
                        info = os.fstat(fd)
                        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and
                                stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= cap, 'EVIDENCE_FILE')
                        raw = bounded_read(fd, cap)
                        same(info, os.fstat(fd))
                        same(info, os.stat(name, dir_fd=evidence, follow_symlinks=False))
                        result['files'][name] = {'bytes': len(raw), 'sha256': sha256(raw),
                                                'base64': base64.b64encode(raw).decode()}
                    finally:
                        os.close(fd)
                except FileNotFoundError:
                    result['files'][name] = {'absent': True}
            dirs.verify()
        result['identity_after'] = identity()
        require(result['identity_before'] == result['identity_after'], 'IDENTITY_CHANGED')
        result['status'] = 'EXPORTED_REVIEW_REQUIRED'
    except (Exception, Deadline) as exc:
        result['failure'] = type(exc).__name__
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)
    return result


if __name__ == '__main__':
    raise SystemExit('No standalone entry point; separately approved source-bound fetch required.')
