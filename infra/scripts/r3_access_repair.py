"""Narrow recovery primitive. No CLI or delivery/approval mechanism is provided.

Only a separately reviewed executor may call this library on a guest. The primitive
preserves an existing authorized_keys inode and appends one bound public key. It
does not configure SSH, accounts, sudo, services, packages or Azure resources.
"""
import base64
import fcntl
import hashlib
import json
import os
import re
import stat

MAX_KEYS = 256 * 1024
MAX_APPEND = 4096
IDENTITY_FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')
SNAPSHOT_FIELDS = (*IDENTITY_FIELDS, 'st_size', 'st_mtime_ns', 'st_ctime_ns')


def require(condition, code):
    if not condition:
        raise ValueError(code)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def wire_identity(blob, canonical=False):
    fields = []
    offset = 0
    while offset < len(blob):
        require(len(blob) - offset >= 4, 'KEY_WIRE_SIZE')
        size = int.from_bytes(blob[offset:offset + 4], 'big')
        offset += 4
        require(0 < size <= len(blob) - offset, 'KEY_WIRE_SIZE')
        fields.append(blob[offset:offset + size])
        offset += size
    require(fields and fields[0] in (b'ssh-rsa', b'ssh-ed25519'), 'KEY_WIRE_TYPE')
    if fields[0] == b'ssh-ed25519':
        require(len(fields) == 2 and len(fields[1]) == 32, 'KEY_WIRE_SIZE')
        return tuple(fields)
    require(len(fields) == 3, 'KEY_WIRE_SIZE')
    numbers = []
    for field in fields[1:]:
        require(field[0] < 128, 'KEY_NEGATIVE_MPINT')
        number = int.from_bytes(field, 'big')
        require(number > 0, 'KEY_ZERO_MPINT')
        minimal = number.to_bytes((number.bit_length() + 7) // 8, 'big')
        minimal = (b'\0' if minimal[0] >= 128 else b'') + minimal
        require(not canonical or field == minimal, 'KEY_NONCANONICAL_MPINT')
        numbers.append(number)
    return fields[0], *numbers


def public_line(raw, expected_hash):
    """Bind public bytes before removing an optional comment; never accept options."""
    require(isinstance(raw, bytes) and 0 < len(raw) < MAX_APPEND - 2, 'KEY_SIZE')
    require(sha256(raw) == expected_hash, 'KEY_HASH')
    text = raw.decode('ascii').rstrip('\n')
    require('\n' not in text and '\r' not in text and '\x00' not in text, 'KEY_LINE')
    parts = text.split()
    require(len(parts) >= 2 and parts[0] in ('ssh-rsa', 'ssh-ed25519'), 'KEY_TYPE')
    blob = base64.b64decode(parts[1], validate=True)
    require(base64.b64encode(blob).decode() == parts[1], 'KEY_NONCANONICAL_BASE64')
    key = wire_identity(blob, canonical=True)
    require(key[0] == parts[0].encode(), 'KEY_WIRE_TYPE')
    if key[0] == b'ssh-rsa':
        require(3 <= key[1] < 2**64 and key[1] % 2 == 1 and
                2048 <= key[2].bit_length() <= 8192, 'KEY_RSA_SIZE')
    line = (' '.join(parts[:2]) + '\n').encode('ascii')
    require(len(line) < MAX_APPEND, 'KEY_SIZE')
    return line, key


def refuse_existing_identity(before, key):
    """Conservative token scan includes options/comments; never widens a key.

    Compare decoded RSA integers, not base64 or noncanonical mpint encodings.
    A token that starts like the selected key type but cannot be parsed safely
    is refused. Unrelated key types remain byte-for-byte untouched.
    """
    prefix = len(key[0]).to_bytes(4, 'big') + key[0]
    for token in before.split():
        require(len(token) <= MAX_APPEND, 'EXISTING_TOKEN_SIZE')
        if not re.fullmatch(b'[A-Za-z0-9+/]+={0,}', token):
            continue
        token = token.rstrip(b'=')
        try:
            wire = base64.b64decode(token + b'=' * (-len(token) % 4), validate=True)
        except ValueError:
            continue
        if wire.startswith(prefix):
            require(wire_identity(wire) != key, 'KEY_ALREADY_PRESENT')


def account(raw, username='tonyaiops'):
    """Parse bounded local passwd bytes, without NSS lookups or account changes."""
    require(len(raw) <= MAX_KEYS and username == 'tonyaiops', 'ACCOUNT_SCOPE')
    rows = [line.split(':') for line in raw.decode('utf-8').splitlines()
            if line.split(':', 1)[0] == username]
    require(len(rows) == 1 and len(rows[0]) == 7, 'ACCOUNT_RECORD')
    row = rows[0]
    require(re.fullmatch('[0-9]+', row[2]) and re.fullmatch('[0-9]+', row[3]), 'ACCOUNT_IDS')
    uid, gid = int(row[2]), int(row[3])
    require(uid > 0 and gid > 0 and row[5] == '/home/tonyaiops', 'ACCOUNT_SCOPE')
    require(row[6] in ('/bin/bash', '/bin/sh'), 'ACCOUNT_SHELL')
    return uid, gid


def same(left, right, fields=SNAPSHOT_FIELDS):
    require(all(getattr(left, name) == getattr(right, name) for name in fields), 'CHANGED')


def bounded_read(fd, limit=MAX_KEYS):
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while len(data) <= limit:
        block = os.read(fd, min(65536, limit + 1 - len(data)))
        if not block:
            break
        data.extend(block)
    require(len(data) <= limit, 'FILE_SIZE')
    return bytes(data)


def regular(info, uid, gid):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'FILE_TYPE')
    require((info.st_uid, info.st_gid) == (uid, gid), 'FILE_OWNER')
    require(stat.S_IMODE(info.st_mode) in (0o600, 0o644), 'FILE_MODE')
    require(0 <= info.st_size <= MAX_KEYS, 'FILE_SIZE')


def private_record(directory_fd, name, data):
    """Exclusive private evidence; no overwrite, retries, shell or cleanup deletion."""
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory_fd)
    try:
        require(os.write(fd, data) == len(data), 'SHORT_EVIDENCE_WRITE')
        os.fsync(fd)
    finally:
        os.close(fd)


def append_verified(ssh_fd, evidence_fd, uid, gid, raw_key, key_hash):
    """Append to a verified inode; caller owns path/target/deadline/approval gates.

    A short write, concurrent change or failed readback is partial, never retried
    or rolled back. An advisory lock does not exclude uncooperative writers.
    Parent-directory renames cannot be prevented by this primitive; the caller
    must retain/revalidate its descriptor chain and report any ambiguity.
    """
    line, key = public_line(raw_key, key_hash)
    for fd, owner in ((ssh_fd, uid), (evidence_fd, os.geteuid())):
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner, 'DIRECTORY_OWNER')
        require(stat.S_IMODE(info.st_mode) == 0o700, 'DIRECTORY_MODE')
    require((os.fstat(ssh_fd).st_dev, os.fstat(ssh_fd).st_ino) !=
            (os.fstat(evidence_fd).st_dev, os.fstat(evidence_fd).st_ino), 'EVIDENCE_SEPARATION')
    flags = os.O_RDWR | os.O_APPEND | os.O_NONBLOCK | os.O_NOFOLLOW
    fd = os.open('authorized_keys', flags, dir_fd=ssh_fd)
    primary = None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before_stat = os.fstat(fd)
        regular(before_stat, uid, gid)
        before = bounded_read(fd)
        require(len(before) == before_stat.st_size, 'FILE_SIZE')
        same(before_stat, os.fstat(fd))
        same(before_stat, os.stat('authorized_keys', dir_fd=ssh_fd, follow_symlinks=False))
        # An existing restricted/options-bearing entry must not be widened by
        # adding another unrestricted copy. False-positive refusal is safe.
        refuse_existing_identity(before, key)
        suffix = (b'\n' if before and not before.endswith(b'\n') else b'') + line
        require(len(suffix) <= MAX_APPEND, 'APPEND_SIZE')
        private_record(evidence_fd, 'authorized_keys.before', before)
        prepared = {'before_sha256': sha256(before), 'before_bytes': len(before),
                    'append_sha256': sha256(suffix), 'append_bytes': len(suffix),
                    'public_key_sha256': key_hash, 'uid': uid, 'gid': gid,
                    'mode': stat.S_IMODE(before_stat.st_mode),
                    'device': before_stat.st_dev, 'inode': before_stat.st_ino}
        private_record(evidence_fd, 'prepared.json', json.dumps(prepared, sort_keys=True).encode())
        os.fsync(evidence_fd)
        same(before_stat, os.fstat(fd))
        same(before_stat, os.stat('authorized_keys', dir_fd=ssh_fd, follow_symlinks=False))
        # Exactly one append syscall. A partial result is evidence, not retry authority.
        count = os.write(fd, suffix)
        require(count == len(suffix), 'PARTIAL_APPEND')
        os.fsync(fd)
        read_stat = os.fstat(fd)
        same(before_stat, read_stat, IDENTITY_FIELDS)
        require(read_stat.st_size == len(before) + len(suffix), 'APPEND_SIZE')
        after = bounded_read(fd, MAX_KEYS + MAX_APPEND)
        require(after == before + suffix, 'APPEND_READBACK')
        after_stat = os.fstat(fd)
        same(read_stat, after_stat)
        same(after_stat, os.stat('authorized_keys', dir_fd=ssh_fd, follow_symlinks=False))
        return {**prepared, 'after_sha256': sha256(after), 'after_bytes': len(after),
                'status': 'KEY_APPENDED_REVIEW_REQUIRED', 'access_verified': False,
                'installation_success': False, 'qualification': False}
    except BaseException as exc:
        primary = exc
        raise
    finally:
        try:
            os.close(fd)
        except OSError as exc:
            if primary is None:
                raise
            primary.cleanup_errors = [type(exc).__name__]


if __name__ == '__main__':
    raise SystemExit('No live entry point: a reviewed recovery executor and exact approval are required.')
