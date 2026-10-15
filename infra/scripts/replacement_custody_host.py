#!/usr/bin/env python3
"""Private SSH pipe endpoint for r02 escrow. Never invoke export in a transcript."""
import json
import os
from pathlib import Path
import sys

# Installed reviewed siblings are root-owned; isolated Python omits script dir.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_host import check, safe_path
from replacement_custody import ENV, SODIUM, envelope, verify_marker
from replacement_bundle import encoded, write_new


def collect(stage):
    paths = [ENV] if stage == 'environment' else [ENV, SODIUM]
    files = {}
    for path in paths:
        if path == ENV:
            file = safe_path(path)
            info = file.lstat()
            if info.st_mode & 0o077 or info.st_nlink != 1:
                raise ValueError('Environment must be private and unlinked.')
            files[path] = file.read_bytes()
        else:
            # The image owns db-config and its intrinsic key, not the operator.
            parent = Path(path).parent
            safe_path(parent.parent, directory=True)
            info = parent.lstat(); leaf = Path(path).lstat()
            import stat
            if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022 or not stat.S_ISREG(leaf.st_mode) or leaf.st_uid != info.st_uid or leaf.st_mode & 0o077 or leaf.st_nlink != 1:
                raise ValueError('Unsafe intrinsic key custody.')
            files[path] = Path(path).read_bytes()
    return files


def main():
    action, stage = sys.argv[1:]
    if action not in ('export', 'mark', 'verify') or stage not in ('environment', 'intrinsic'):
        raise ValueError('Unsupported custody operation.')
    contract = check()
    files = collect(stage)
    if stage == 'intrinsic':
        verify_marker(json.loads(safe_path('/etc/tonyai/escrow-r02-environment.json').read_bytes()),
                      contract, 'environment', {ENV: files[ENV]})
    record_path = Path('/etc/tonyai/escrow-r02-' + stage + '.json')
    if action == 'export':
        sys.stdout.buffer.write(encoded(envelope(contract, stage, files)))
        return
    record = json.loads(sys.stdin.buffer.read(8193)) if action == 'mark' else json.loads(safe_path(record_path).read_bytes())
    verify_marker(record, contract, stage, files)
    if action == 'mark':
        write_new(record_path, encoded(record))
    print('PASS: exact generation custody verified.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: generation custody refused; diagnostics withheld.')
