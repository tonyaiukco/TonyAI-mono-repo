#!/usr/bin/env python3
"""Owner-run Azure data-disk initialization; existing filesystems are never formatted."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from urllib.request import Request, build_opener, ProxyHandler

DISKS = ((0, 64, 'database'), (1, 32, 'objects'))
MOUNT_OPTIONS = 'defaults,nodev,nosuid,nofail,x-systemd.device-timeout=30s'


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def inspect_disk(lun, gib, name, initialize):
    link = Path('/dev/disk/azure/data/by-lun') / str(lun)
    device = str(link.resolve(strict=True))
    rows = json.loads(run('lsblk', '-J', '-b', '-o', 'PATH,SIZE,FSTYPE,MOUNTPOINTS,TYPE,LABEL,UUID', device))['blockdevices']
    if len(rows) != 1:
        raise ValueError('Unexpected disk topology.')
    row = rows[0]
    if row['type'] != 'disk' or int(row['size']) != gib * 1024**3 or row.get('children'):
        raise ValueError('Wrong data disk type, size or partition layout.')
    target = '/srv/tonyai/' + name
    mounts = [p for p in row.get('mountpoints', []) if p]
    if mounts and mounts != [target]:
        raise ValueError('Data disk is mounted at an unrelated location.')
    if row['fstype']:
        if row['fstype'] != 'ext4' or row['label'] != 'tonyai-' + name or not row['uuid']:
            raise ValueError('Existing data disk is not an owned ext4 filesystem.')
    else:
        if not initialize or mounts:
            raise ValueError('A fresh disk needs explicit owner initialization.')
        signatures = json.loads(run('wipefs', '--json', '--no-act', device))['signatures']
        if signatures:
            raise ValueError('Refusing to initialize a disk with existing signatures.')
    return device, target, row


def check_destination(target, row, original):
    path = Path(target)
    if path.is_symlink():
        raise ValueError('Refusing a symlink data mount.')
    mounted = os.path.ismount(path)
    if mounted:
        if not row['uuid'] or run('findmnt', '-n', '-o', 'UUID', '--mountpoint', target) != row['uuid']:
            raise ValueError('Data destination is occupied by another filesystem.')
    elif path.exists() and any(path.iterdir()):
        raise ValueError('Refusing to hide existing files underneath a data mount.')
    existing = [line for line in original.splitlines() if line.strip() and not line.lstrip().startswith('#') and len(line.split()) > 1 and line.split()[1] == target]
    expected = f"UUID={row['uuid']} {target} ext4 {MOUNT_OPTIONS} 0 2"
    legacy = f"UUID={row['uuid']} {target} ext4 defaults,nodev,nosuid 0 2"
    if existing and existing not in ([expected], [legacy]):
        raise ValueError('Existing fstab entry differs from the owned disk.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--resource-id', required=True)
    parser.add_argument('--initialize-empty-disks', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run as root on the intended Azure host.')
    request = Request('http://169.254.169.254/metadata/instance?api-version=2021-02-01', headers={'Metadata': 'true'})
    with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
        compute = json.load(response)['compute']
    if compute['resourceId'].lower() != args.resource_id.lower():
        raise ValueError('Azure instance identity differs from the reviewed target.')
    # Check both disks and destination directories before any formatting.
    checked = [(name, *inspect_disk(lun, gib, name, args.initialize_empty_disks)) for lun, gib, name in DISKS]
    if len({device for _, device, _, _ in checked}) != len(DISKS):
        raise ValueError('Data LUNs must reference distinct disks.')
    fstab = Path('/etc/fstab')
    original = fstab.read_text()
    for name, device, target, row in checked:
        check_destination(target, row, original)
    updated = original
    for name, device, target, row in checked:
        if not row['fstype']:
            subprocess.run(['mkfs.ext4', '-q', '-L', 'tonyai-' + name, device], check=True)
        disk_uuid = run('blkid', '-s', 'UUID', '-o', 'value', device)
        legacy = f'UUID={disk_uuid} {target} ext4 defaults,nodev,nosuid 0 2'
        line = f'UUID={disk_uuid} {target} ext4 {MOUNT_OPTIONS} 0 2'
        updated = '\n'.join(line if entry == legacy else entry for entry in updated.splitlines()) + '\n'
        if line not in updated.splitlines():
            updated = updated.rstrip() + '\n' + line + '\n'
        Path(target).mkdir(parents=True, exist_ok=True, mode=0o750)
    if updated != original:
        backup = Path('/etc/fstab.tonyai-before-data-mounts')
        if not backup.exists():
            backup.write_text(original)
        staging = Path('/etc/fstab.tonyai-new')
        staging.write_text(updated)
        staging.chmod(0o644)
        staging.replace(fstab)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
    for name, device, target, row in checked:
        if not os.path.ismount(target):
            subprocess.run(['mount', target], check=True)
        expected_uuid = run('blkid', '-s', 'UUID', '-o', 'value', device)
        if run('findmnt', '-n', '-o', 'UUID', '--target', target) != expected_uuid:
            raise ValueError('Mounted filesystem identity did not read back.')
        print(f'PASS: {name} disk mounted persistently at {target}.')


if __name__ == '__main__':
    main()
