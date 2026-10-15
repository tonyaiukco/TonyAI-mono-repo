"""Private, durable files for one explicitly approved dashboard rotation."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat


def digest(data):
    return hashlib.sha256(data).hexdigest()


def secure_path(path, uid=0, private=False, anchor=Path("/")):
    path = Path(path)
    if not path.is_relative_to(anchor):
        raise ValueError("Path escapes trusted root.")
    for parent in reversed([p for p in path.parents if p.is_relative_to(anchor)]):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise ValueError('Unsafe parent.')
    info = path.lstat()
    if info.st_uid != uid or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise ValueError('Unsafe owner or permissions.')
    if private and stat.S_IMODE(info.st_mode) != (0o700 if stat.S_ISDIR(info.st_mode) else 0o600):
        raise ValueError('Private permissions required.')
    return info


def read(path, uid=0, private=False, anchor=Path("/")):
    before = secure_path(path, uid, private, anchor)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 65536:
        raise ValueError('Unsafe file.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError('File changed while opening.')
        data = os.read(fd, 65537)
        if len(data) > 65536:
            raise ValueError('Oversize file.')
        return data
    finally:
        os.close(fd)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(Path(path).parent)


class Store:
    def __init__(self, runtime, directory, marker, uid=0, anchor=Path("/")):
        self.runtime, self.directory, self.marker = map(Path, (runtime, directory, marker))
        self.uid, self.anchor = uid, anchor
        self.env = self.runtime / '.env'

    def read(self, name):
        return read(self.directory / name, self.uid, private=True, anchor=self.anchor)

    def environment(self):
        return read(self.env, self.uid, private=True, anchor=self.anchor)

    def escrow(self):
        return json.loads(read(self.marker, self.uid, private=True, anchor=self.anchor))

    def journal(self):
        return json.loads(self.read('journal.json'))

    def write_journal(self, value):
        target = self.directory / 'journal.json'
        # A leftover temporary journal is deliberately not silently overwritten.
        if target.exists():
            read(target, self.uid, private=True, anchor=self.anchor)
        pending = self.directory / 'journal.next'
        create(pending, json.dumps(value, sort_keys=True).encode())
        os.replace(pending, target)
        sync_dir(self.directory)

    def install(self, expected_hash):
        if digest(self.environment()) != expected_hash:
            raise ValueError('Runtime changed before installation.')
        pending = self.directory / 'next.env'
        data = self.read('next.env')
        # Staging may be on another filesystem; replace atomically in runtime.
        temporary = self.runtime / '.dashboard-next.env'
        create(temporary, data)
        if digest(self.environment()) != expected_hash:
            raise ValueError('Runtime changed before replacement.')
        os.replace(temporary, self.env)
        sync_dir(self.runtime)

    @contextmanager
    def locked(self):
        secure_path(self.runtime, self.uid, anchor=self.anchor)
        secure_path(self.directory.parent, self.uid, anchor=self.anchor)
        if not self.directory.exists():
            self.directory.mkdir(mode=0o700)
            sync_dir(self.directory.parent)
        secure_path(self.directory, self.uid, private=True, anchor=self.anchor)
        lock = self.directory / 'lock'
        if not lock.exists():
            try:
                create(lock, b'')
            except FileExistsError:
                pass
        read(lock, self.uid, private=True, anchor=self.anchor)
        fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)
