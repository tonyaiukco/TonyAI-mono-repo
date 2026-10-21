"""Observe already-established package-manager isolation; never alter units."""
import fcntl
import os
from pathlib import Path
import stat
import subprocess

UNITS = ('apt-daily.timer', 'apt-daily-upgrade.timer', 'apt-daily.service',
         'apt-daily-upgrade.service', 'unattended-upgrades.service')
PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'Job',
              'InactiveExitTimestampMonotonic', 'ActiveEnterTimestampMonotonic',
              'ActiveExitTimestampMonotonic', 'InactiveEnterTimestampMonotonic')
LOCKS = ('/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock', '/var/cache/apt/archives/lock')
MANAGERS = {'apt', 'apt-get', 'dpkg', 'unattended-upgrade', 'unattended-upgrades',
            'unattended-upgr', 'apt.systemd.daily', 'apt.systemd.dai', 'packagekitd', 'aptd', 'synaptic'}


def process_identity(path):
    fields = (path / 'stat').read_text().rsplit(') ', 1)[1].split()
    return {'pid': int(path.name), 'pgrp': int(fields[2]), 'start_ticks': int(fields[19])}


def processes(proc=Path('/proc')):
    result = []
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            comm = (path / 'comm').read_text().strip()
            args = (path / 'cmdline').read_bytes().split(b'\0')
            if comm not in MANAGERS and not any(os.fsdecode(a).rsplit('/', 1)[-1] in MANAGERS for a in args):
                continue
            result.append({**process_identity(path), 'comm': comm})
        except FileNotFoundError:
            continue  # Exited during this sample, not proof of continuous absence.
    return sorted(result, key=lambda item: item['pid'])


def probe_locks():
    """Test existing lock inodes briefly; never delete/create/bypass native locks."""
    for name in LOCKS:
        fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                raise ValueError('Unsafe package-manager lock inode.')
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.lockf(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def observe(check_locks=True):
    units = {}
    for unit in UNITS:
        properties = (*PROPERTIES, 'MainPID') if unit.endswith('.service') else PROPERTIES
        result = subprocess.run(['systemctl', 'show', unit, '--no-pager',
                                 '--property=' + ','.join(properties)],
                                capture_output=True, timeout=15, check=True)
        fields = {}
        for line in result.stdout.decode().splitlines():
            key, value = line.split('=', 1)
            if key in fields:
                raise ValueError('Duplicate systemd property.')
            fields[key] = value
        if set(fields) != set(properties):
            raise ValueError('Incomplete package-manager unit observation.')
        units[unit] = fields
    found = processes()
    if check_locks:
        probe_locks()
    return {'units': units, 'processes': found, 'locks_probed': check_locks}


def validate(observation, baseline=None, child=None):
    if set(observation['units']) != set(UNITS):
        raise ValueError('Incomplete package-manager unit set.')
    for unit, fields in observation['units'].items():
        if (fields['Id'] != unit or fields['LoadState'] != 'masked'
                or fields['UnitFileState'] != 'masked' or fields['ActiveState'] != 'inactive'
                or fields['SubState'] != 'dead' or fields['Job'] != ''
                or fields.get('MainPID', '0') != '0'
                or any(not fields[key].isdigit() for key in PROPERTIES if key.endswith('Monotonic'))):
            raise ValueError('Package-manager units must already be persistently masked and inactive.')
    if baseline is not None and observation['units'] != baseline['units']:
        raise ValueError('Package-manager unit state changed during installation.')
    for item in observation['processes']:
        if child is None or item['pgrp'] != child['pid']:
            raise ValueError('Foreign package-manager activity observed.')
    if child is not None:
        try:
            current = process_identity(Path('/proc') / str(child['pid']))
        except FileNotFoundError:
            if observation['processes']:
                raise ValueError('Package-manager child identity lost.')
        else:
            if current != child or current['pgrp'] != child['pid']:
                raise ValueError('Package-manager child identity changed.')
