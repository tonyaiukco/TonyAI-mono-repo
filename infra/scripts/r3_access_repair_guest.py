"""Guest-side recovery gates; only a future separately approved executor may call main.

This is not a collection entry point. There is deliberately no standalone CLI.
Azure delivery, its extension effects, approval and encrypted export are separate
requirements; implementing these gates does not make a recovery packet ready.
"""
from contextlib import ExitStack
import json
import os
import re
import signal
import stat
import sys

from r3_access_repair import (MAX_KEYS, account, append_verified, bounded_read,
    private_record, public_line, require, same, sha256, IDENTITY_FIELDS)
from r3_policy_target import identity, IMDS_FIELDS

# Creating the private attempt child legitimately changes its parent's link
# count. Directory identity still binds inode, type/mode, owner and group.
DIRECTORY_FIELDS = tuple(name for name in IDENTITY_FIELDS if name != 'st_nlink')


class Deadline(BaseException):
    pass


def expired(_signum, _frame):
    raise Deadline()


def validate(proposal):
    require(isinstance(proposal, dict) and set(proposal) == {
        'format', 'purpose', 'packet_id', 'source', 'target_imds', 'public_key',
        'public_key_sha256', 'execution_authorized'}, 'PROPOSAL')
    require(type(proposal['format']) is int and proposal['format'] == 1 and
            proposal['purpose'] == 'R3_SSH_KEY_APPEND_ONLY', 'PURPOSE')
    require(isinstance(proposal['packet_id'], str) and
            re.fullmatch('[a-f0-9]{32}', proposal['packet_id']), 'PACKET_ID')
    # Proposal metadata is never owner authority. The external executor must
    # verify a separate exact approval; this module cannot manufacture one.
    require(proposal['execution_authorized'] is False, 'PROPOSAL_AUTHORITY_CLAIM')
    source = proposal['source']
    require(isinstance(source, dict) and set(source) == {'published_sha', 'files', 'sha256'}, 'SOURCE')
    require(isinstance(source['published_sha'], str) and
            re.fullmatch('[a-f0-9]{40}', source['published_sha']), 'UNPUBLISHED_SOURCE')
    files = source['files']
    require(isinstance(files, dict) and 1 <= len(files) <= 32 and
            all(isinstance(k, str) and re.fullmatch('infra/scripts/[a-z0-9_]+[.]py', k)
                and isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for k, v in files.items()), 'SOURCE_MAP')
    canonical = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
    require(sha256(canonical) == source['sha256'], 'SOURCE_MAP_HASH')
    target = proposal['target_imds']
    require(isinstance(target, dict) and set(target) == set(IMDS_FIELDS) and
            all(isinstance(v, str) and 0 < len(v) <= 2048 for v in target.values()), 'TARGET')
    require(isinstance(proposal['public_key'], str), 'PUBLIC_KEY')
    raw = proposal['public_key'].encode('ascii')
    public_line(raw, proposal['public_key_sha256'])
    return raw


class Directories:
    """Keep the verified chain open and revalidate its names before/after append.

    No advisory mechanism here can prevent an owner from renaming a directory.
    A detected race is partial evidence; it must not trigger rollback or retry.
    """
    def __init__(self, stack):
        self.stack = stack
        self.edges = []
        self.root = self.keep(os.open('/', os.O_RDONLY | os.O_DIRECTORY))
        self.check(self.root, 0, None)

    def keep(self, fd):
        self.stack.callback(os.close, fd)
        return fd

    @staticmethod
    def check(fd, uid, mode):
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid, 'DIRECTORY_OWNER')
        require(not stat.S_IMODE(info.st_mode) & 0o022, 'DIRECTORY_WRITABLE')
        if mode is not None:
            require(stat.S_IMODE(info.st_mode) == mode, 'DIRECTORY_MODE')
        return info

    def child(self, parent, name, uid=0, mode=None):
        fd = self.keep(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent))
        info = self.check(fd, uid, mode)
        same(info, os.stat(name, dir_fd=parent, follow_symlinks=False), DIRECTORY_FIELDS)
        self.edges.append((parent, name, fd, info))
        return fd

    def verify(self):
        for parent, name, fd, info in self.edges:
            same(info, os.fstat(fd), DIRECTORY_FIELDS)
            same(info, os.stat(name, dir_fd=parent, follow_symlinks=False), DIRECTORY_FIELDS)


def local_account(dirs):
    etc = dirs.child(dirs.root, 'etc')
    fd = dirs.keep(os.open('passwd', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=etc))
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and
            not stat.S_IMODE(info.st_mode) & 0o022 and info.st_size <= MAX_KEYS, 'PASSWD_FILE')
    raw = bounded_read(fd)
    same(info, os.fstat(fd))
    same(info, os.stat('passwd', dir_fd=etc, follow_symlinks=False))
    return account(raw)


def attempt(dirs, packet_id):
    var = dirs.child(dirs.root, 'var')
    lib = dirs.child(var, 'lib')
    name = 'tonyai-r3-access-recovery-' + packet_id
    os.mkdir(name, mode=0o700, dir_fd=lib)  # Existing attempt is always refused.
    fd = dirs.child(lib, name, mode=0o700)
    os.fsync(lib)
    return fd


def main(proposal):
    """Cooperative 30-second payload budget, not a delivery/kernel cancellation proof."""
    result = {'status': 'REFUSED_REVIEW_REQUIRED', 'phase': 'validate', 'failure': None,
              'cleanup_errors': [], 'access_verified': False, 'qualification': False,
              'installation_success': False, 'identity_before': None, 'identity_after': None,
              'append': None, 'evidence_path': None}
    evidence_fd = None
    stack = ExitStack()
    old_handler = None
    pre_close_hash = None
    try:
        raw = validate(proposal)
        require(sys.platform == 'linux' and os.geteuid() == 0 and sys.dont_write_bytecode,
                'GUEST_RUNTIME')
        require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'EXISTING_TIMER')
        old_handler = signal.signal(signal.SIGALRM, expired)
        signal.alarm(30)
        result['phase'] = 'identity-before'
        result['identity_before'] = identity()
        require(result['identity_before']['imds'] == proposal['target_imds'], 'IMDS_MISMATCH')
        result['phase'] = 'paths'
        dirs = Directories(stack)
        uid, gid = local_account(dirs)
        home = dirs.child(dirs.root, 'home')
        user = dirs.child(home, 'tonyaiops', uid)
        ssh = dirs.child(user, '.ssh', uid, 0o700)
        evidence_fd = attempt(dirs, proposal['packet_id'])
        result['evidence_path'] = '/var/lib/tonyai-r3-access-recovery-' + proposal['packet_id']
        private_record(evidence_fd, 'invocation.json', json.dumps({
            'proposal_sha256': sha256(json.dumps(proposal, sort_keys=True, separators=(',', ':')).encode()),
            'identity_before': result['identity_before']}, sort_keys=True).encode())
        dirs.verify()
        result['phase'] = 'append'
        result['status'] = 'PARTIAL_REVIEW_REQUIRED'
        result['append'] = append_verified(ssh, evidence_fd, uid, gid, raw, proposal['public_key_sha256'])
        dirs.verify()
        result['phase'] = 'identity-after'
        result['identity_after'] = identity()
        require(result['identity_before'] == result['identity_after'], 'IDENTITY_CHANGED')
        result['phase'] = 'completed'
        result['status'] = 'KEY_APPENDED_REVIEW_REQUIRED'
    except (Exception, Deadline) as exc:
        result['failure'] = type(exc).__name__
        result['cleanup_errors'].extend(getattr(exc, 'cleanup_errors', []))
        if isinstance(exc, ValueError) and re.fullmatch('[A-Z_]+', str(exc)):
            result['refusal_code'] = str(exc)
    finally:
        # Final evidence gets a separate bounded grace period; neither alarm
        # establishes termination of an uninterruptible kernel/remote handler.
        if old_handler is not None:
            signal.alarm(5)
        try:
            if evidence_fd is not None:
                retained = json.dumps(result, sort_keys=True).encode()
                private_record(evidence_fd, 'pre-close-result.json', retained)
                os.fsync(evidence_fd)
                pre_close_hash = sha256(retained)
        except (Exception, Deadline) as exc:
            result['cleanup_errors'].append(type(exc).__name__)
            result['status'] = 'PARTIAL_REVIEW_REQUIRED'
        try:
            stack.close()
        except (Exception, Deadline) as exc:
            result['cleanup_errors'].append(type(exc).__name__)
            result['status'] = 'PARTIAL_REVIEW_REQUIRED'
        if old_handler is not None:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    # Hash the exact retained bytes, not an unretained post-close representation.
    result['pre_close_result_sha256'] = pre_close_hash
    return result


if __name__ == '__main__':
    raise SystemExit('No live entry point: delivery and exact execution approval are not supplied.')
