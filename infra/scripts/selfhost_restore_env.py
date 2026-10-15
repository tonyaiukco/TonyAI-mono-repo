#!/usr/bin/env python3
"""Restore only into an empty runtime environment, never rotate initialized database secrets."""
import os
from pathlib import Path
import sys


def main():
    if os.geteuid() != 0 or not all(os.path.ismount('/srv/tonyai/' + name) for name in ('database', 'objects')):
        raise ValueError('Root and both recovery disks are required.')
    root = Path('/opt/tonyai/supabase')
    for path in (Path('/opt'), root.parent, root):
        stat = path.lstat()
        if path.is_symlink() or not path.is_dir() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise ValueError('Unsafe recovery destination.')
    target = root / '.env'
    if target.exists() or target.is_symlink():
        raise ValueError('Refusing to overwrite existing credentials.')
    data = sys.stdin.buffer.read(25 * 1024 + 1)
    if not data or len(data) > 25 * 1024 or b"POSTGRES_PASSWORD='" not in data:
        raise ValueError('Invalid recovery payload.')
    # O_EXCL fails closed even if another process creates the destination after the check.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: recovery refused or interrupted; inspect the destination privately before resuming.')
