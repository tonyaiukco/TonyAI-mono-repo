#!/usr/bin/env python3
"""Restore exact r02 custody bytes on the same bound VM/disks; never rebind or overwrite."""
import json
from pathlib import Path
import sys
import subprocess
sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_host import check, safe_path
from replacement_custody import ENV, SODIUM, unpack, verify_marker
from replacement_bundle import write_new, encoded, private_read


def main():
    if sys.argv[1:]:
        raise ValueError('Recovery payload must use the private stdin pipe.')
    contract=check()
    running=subprocess.run(['docker','ps','--filter','label=com.docker.compose.project=supabase',
        '--format','{{.ID}}'],capture_output=True,check=True,timeout=15)
    if running.stdout.strip():
        raise ValueError('Stop the generation runtime under separate approval before recovery.')
    payload=json.loads(sys.stdin.buffer.read(30001))
    if set(payload) != {'envelope','record'}:
        raise ValueError('Exact immutable envelope and record required.')
    files=unpack(payload['envelope'],contract,'intrinsic')
    verify_marker(payload['record'],contract,'intrinsic',files)
    verify_marker(json.loads(safe_path('/etc/tonyai/escrow-r02-environment.json').read_bytes()),
                  contract,'environment',{ENV:files[ENV]})
    target=Path(ENV)
    if target.exists() or target.is_symlink():
        raise ValueError('Never overwrite initialized credentials.')
    safe_path(target.parent,directory=True)
    # Intrinsic material must still match the retained database configuration.
    # Missing/different pgsodium is a separate DB+byte recovery operation.
    from replacement_custody_host import collect
    key=Path(SODIUM)
    info=key.lstat(); parent=key.parent.lstat()
    import stat
    if not stat.S_ISDIR(parent.st_mode) or parent.st_mode & 0o022 or not stat.S_ISREG(info.st_mode) or info.st_uid != parent.st_uid or info.st_mode & 0o077 or info.st_nlink != 1 or key.read_bytes()!=files[SODIUM]:
        raise ValueError('Original generation intrinsic key is required; no reconstruction.')
    safe_path(key.parent.parent,directory=True)
    marker=Path('/etc/tonyai/escrow-r02-intrinsic.json')
    retained = marker.exists() or marker.is_symlink()
    if retained:
        safe_path(marker)
        if private_read(marker) != encoded(payload['record']):
            raise ValueError('Retained custody evidence differs; preserve it unchanged.')
    write_new(target,files[ENV])
    verify_marker(payload['record'],contract,'intrinsic',collect('intrinsic'))
    if not retained:
        write_new(marker,encoded(payload['record']))
    print('PASS: exact generation environment recovered; runtime remains stopped.')


if __name__ == '__main__':
    try:main()
    except Exception:sys.exit('FAIL: r02 recovery refused/interrupted; no fallback or automatic retry.')
