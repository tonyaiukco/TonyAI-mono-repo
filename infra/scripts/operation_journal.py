"""Durable nonsecret operation metadata; exclusive local lock, atomic fsync writes."""
import fcntl
import json
import os
from pathlib import Path
from pooler import SafeFailure


class Journal:
    def __init__(self, path, target):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = open(str(self.path) + '.lock', 'a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise SafeFailure('Another owner operation holds this journal.') from None
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {'target': target}
        if self.data.get('target') != target:
            self.lock.close()
            raise SafeFailure('Journal belongs to another target; refusing cross-environment reuse.')
        self.save()

    def save(self):
        temp = self.path.with_suffix('.tmp')
        with open(temp, 'w') as destination:
            os.chmod(temp, 0o600)
            json.dump(self.data, destination, indent=2)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temp, self.path)
        fd = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def set(self, **changes):
        self.data.update(changes)
        self.save()

    def close(self):
        self.lock.close()
