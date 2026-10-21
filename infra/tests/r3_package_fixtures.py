"""Synthetic package traces; not captured Noble output or guest qualification."""
from r3_apt_observer import UNITS, PROPERTIES
from r3_package_state import FIELDS


def baseline():
    return {'base:amd64': {'name': 'base', 'architecture': 'amd64', 'version': '1.0',
            'status': 'install ok installed', 'essential': 'yes',
            'depends': 'libc6 (>= 2.38)', 'pre_depends': '', 'provides': ''}}


def installed(lock, held=False):
    rows = baseline()
    for pin in lock['packages']:
        rows[pin['name'] + ':amd64'] = {**dict.fromkeys(FIELDS, ''),
            **{k: pin[k] for k in ('name', 'version', 'architecture')},
            'status': 'hold ok installed' if held else 'install ok installed'}
    return rows


def render(rows):
    return ''.join('\t'.join(row[k] for k in FIELDS) + '\n' for _, row in sorted(rows.items()))


def trace(lock):
    records = ['startup archives unpack']
    for pin in lock['packages']:
        n, v = pin['name'] + ':amd64', pin['version']
        records.extend([f'install {n} <none> {v}', f'status unpacked {n} {v}'])
    records.append('startup packages configure')
    for pin in lock['packages']:
        n, v = pin['name'] + ':amd64', pin['version']
        records.extend([f'configure {n} {v} <none>', f'status installed {n} {v}'])
    return ''.join('2026-10-21 12:00:00 ' + record + '\n' for record in records)


def observation():
    units = {}
    for unit in UNITS:
        fields = {k: '0' for k in PROPERTIES}
        # systemd v255 show --property renders a zero Job ID as Job=.
        fields.update(Id=unit, LoadState='masked', ActiveState='inactive', SubState='dead', UnitFileState='masked', Job='')
        if unit.endswith('.service'):
            fields['MainPID'] = '0'
        units[unit] = fields
    return {'units': units, 'processes': [], 'locks_probed': True}
