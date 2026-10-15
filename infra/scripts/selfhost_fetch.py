#!/usr/bin/env python3
"""Fetch the reviewed Supabase source snapshot with per-file digest verification."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import urlopen


def fetch_file(target, name, digest, commit):
    path = target / name
    if (not name or Path(name).is_absolute() or '..' in Path(name).parts
            or not path.resolve().is_relative_to(target.resolve())
            or not re.fullmatch('[a-f0-9]{64}', digest)):
        raise ValueError('Invalid source path or digest.')
    components = [target.joinpath(*Path(name).parts[:index]) for index in range(1, len(Path(name).parts) + 1)]
    if any(component.is_symlink() for component in components):
        raise ValueError('Source paths must not contain symlinks.')
    if path.exists():
        data = path.read_bytes()
    else:
        url = f"https://raw.githubusercontent.com/supabase/supabase/{commit}/docker/{name}"
        with urlopen(url, timeout=60) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Source content differs from the reviewed lock.')
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with path.open('xb') as stream:
            stream.write(data)
    # These verified upstream files contain no runtime secrets. Container users
    # must read bind-mounted SQL/config even though the host runtime root is private.
    for directory in components[:-1]:
        directory.chmod(0o755)
    path.chmod(0o644)


def main():
    lock = json.loads(Path(sys.argv[1]).read_text())
    target = Path(sys.argv[2])
    if os.geteuid() != 0 or target != Path('/opt/tonyai/supabase'):
        raise ValueError('Run as root with the fixed runtime directory.')
    os.umask(0o077)
    for parent in (Path('/opt'), Path('/opt/tonyai'), target):
        if not parent.exists():
            parent.mkdir(mode=0o700)
        stat = parent.lstat()
        if parent.is_symlink() or not parent.is_dir() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise ValueError('Runtime directory chain must be root-owned and not writable by others.')
    if not re.fullmatch('[a-f0-9]{40}', lock['commit']):
        raise ValueError('Invalid source commit.')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, digest in lock['files'].items():
        fetch_file(target, name, digest, lock['commit'])
    print('PASS: immutable Supabase source matches all reviewed digests.')


if __name__ == '__main__':
    main()
