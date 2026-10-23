"""Declared five-unit maintenance phase; never restore automatically on failure."""
import base64
import os
from pathlib import Path
import time
import hashlib

from r3_apt_observer import UNITS, observe, validate
from r3_install_policy import encoded
from r3_noble_common import write
from r3_noble_identity import process_record

TIMERS = UNITS[:2]
SERVICES = UNITS[2:]
HELPER_ARGV = b'/usr/bin/python3\0/usr/share/unattended-upgrades/unattended-upgrade-shutdown\0--wait-for-signal\0'


def helper_identity(item, unit, record):
    """Identity permits only normal stop here, never a transaction exemption."""
    if (str(item['pid']) != unit.get('MainPID') or item.get('comm') != 'unattended-upgr'
            or record.get('identity_matches_observation') is not True
            or record.get('before') != record.get('after')
            or record.get('before', {}).get('ppid') != 1):
        raise ValueError('Uncertain shutdown-helper identity')
    for key in ('pid', 'pgrp', 'start_ticks'):
        if type(item.get(key)) is not int or item[key] <= 0 or record['before'].get(key) != item[key]:
            raise ValueError('Shutdown-helper identity correspondence differs')
    for name, expected in (
            ('cmdline', HELPER_ARGV), ('exe_link', b'/usr/bin/python3.12'),
            ('cgroup', b'0::/system.slice/unattended-upgrades.service\n')):
        value = record.get(name, {})
        data = base64.b64decode(value.get('base64', ''), validate=True)
        if (value.get('truncated') is not False or 'error' in value
                or data != expected or value.get('bytes') != len(data)
                or value.get('sha256') != hashlib.sha256(data).hexdigest()):
            raise ValueError('Shutdown-helper executable/argv/cgroup differs')
        if name != 'exe_link' and value.get('metadata_equal') is not True:
            raise ValueError('Shutdown-helper observation changed')


def eligible(value, inspect=process_record):
    if set(value['units']) != set(UNITS) or value.get('locks_probed') is not True:
        raise ValueError('Incomplete maintenance baseline')
    for name, fields in value['units'].items():
        if fields['Id'] != name or fields['Job'] != '':
            raise ValueError('Pending maintenance unit job')
        if name in SERVICES[:2] and (fields['ActiveState'], fields['SubState'], fields['MainPID']) != ('inactive', 'dead', '0'):
            raise ValueError('Active package work refuses maintenance')
    found = value['processes']
    if len(found) > 1:
        raise ValueError('Foreign package writer before maintenance')
    unit = value['units']['unattended-upgrades.service']
    if found:
        if (unit['ActiveState'], unit['SubState']) != ('active', 'running'):
            raise ValueError('Shutdown-helper unit differs')
        record = inspect(found[0])
        helper_identity(found[0], unit, record)
        return record
    if (unit['ActiveState'], unit['SubState'], unit['MainPID']) != ('inactive', 'dead', '0'):
        raise ValueError('Missing shutdown-helper observation')
    return None


def isolate(directory, before, inventory_read, command, deadline, observer=observe):
    """Call only after exact policy preflight and exclusive operation approval.

    All subprocess output is retained by the supplied bounded command runner.
    A timeout may leave systemd's stop job pending: never claim cancellation or
    release the persistent masks in cleanup. Only a verified post-state passes.
    """
    directory = Path(directory)
    def remaining():
        value = deadline - time.monotonic()
        if value <= 5:
            raise TimeoutError('Maintenance deadline')
        return value - 5
    remaining()
    baseline = observer()
    identity = eligible(baseline)
    remaining()
    write(directory / 'maintenance-intent.json', encoded({
        'format': 1, 'units': list(UNITS), 'original': baseline, 'helper': identity,
        'restoration_authorized': False, 'failure_action': 'RETAIN_MASKS_AND_JOURNAL'}))
    # Prevent new timer activation before stopping any currently idle service.
    # No --force, runtime mask, lock deletion, kill or broad unit glob is used.
    for argv, label in ((['systemctl', 'mask', *UNITS], 'maintenance-mask'),
                        (['systemctl', 'stop', *TIMERS], 'maintenance-stop-timers'),
                        (['systemctl', 'stop', *SERVICES], 'maintenance-stop-services')):
        if label == 'maintenance-stop-services':
            remaining()
            value = observer()
            record = eligible(value)
            remaining()
            write(directory / 'maintenance-pre-stop.json', encoded({'observation': value, 'helper': record}))
            if inventory_read('pre-stop', remaining()) != before:
                raise ValueError('Inventory changed before service stop')
        command(argv, label, timeout=min(45, remaining()))
        remaining()
    final = observer()
    remaining()
    write(directory / 'maintenance-final.json', encoded(final))
    validate(final)
    if final.get('locks_probed') is not True:
        raise ValueError('Missing final maintenance lock evidence')
    for name in UNITS:
        path = Path('/etc/systemd/system') / name
        if not path.is_symlink() or os.readlink(path) != '/dev/null':
            raise ValueError('Persistent maintenance mask missing')
    if inventory_read('post-stop', remaining()) != before:
        raise ValueError('Inventory changed during maintenance isolation')
    remaining()
    write(directory / 'maintenance-complete.json', encoded({'units': list(UNITS),
          'inventory_unchanged': True, 'release_authorized': False}))
    return final


def validate_evidence(intent, final, complete):
    if (intent.get('format') != 1 or intent.get('units') != list(UNITS)
            or intent.get('restoration_authorized') is not False
            or intent.get('failure_action') != 'RETAIN_MASKS_AND_JOURNAL'):
        raise ValueError('Maintenance intent differs')
    eligible(intent['original'], inspect=lambda _item: intent['helper'])
    validate(final)
    if final.get('locks_probed') is not True:
        raise ValueError('Missing final maintenance lock evidence')
    if complete != {'units': list(UNITS), 'inventory_unchanged': True, 'release_authorized': False}:
        raise ValueError('Maintenance completion differs')
