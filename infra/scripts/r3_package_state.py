"""Strict package inventory and dpkg transaction evidence; no host mutations."""
import re

FIELDS = ('name', 'architecture', 'version', 'status', 'essential', 'depends', 'pre_depends', 'provides')
INVENTORY_FORMAT = '${Package}\t${Architecture}\t${Version}\t${Status}\t${Essential}\t${Depends}\t${Pre-Depends}\t${Provides}\n'
INVENTORY_ARGV = ['dpkg-query', '-W', '-f=' + INVENTORY_FORMAT]


def inventory(text):
    if not text or not text.endswith('\n'):
        raise ValueError('Incomplete package inventory.')
    result = {}
    for line in text.splitlines():
        values = line.split('\t')
        if len(values) != len(FIELDS):
            raise ValueError('Malformed package inventory.')
        row = dict(zip(FIELDS, values))
        if (not re.fullmatch('[a-z0-9][a-z0-9+.-]+', row['name'])
                or not re.fullmatch('[a-z0-9][a-z0-9-]*', row['architecture'])
                or not row['version'] or any(c.isspace() for c in row['version'])
                or not re.fullmatch('(unknown|install|hold|deinstall|purge) (ok|reinstreq) '
                                    '(not-installed|config-files|half-installed|unpacked|half-configured|'
                                    'triggers-awaited|triggers-pending|installed)', row['status'])
                or row['essential'] not in ('', 'yes', 'no')):
            raise ValueError('Invalid package inventory identity/state.')
        key = row['name'] + ':' + row['architecture']
        if key in result:
            raise ValueError('Duplicate package inventory identity.')
        result[key] = row
    return result


def require_absent(before, lock):
    targets = {p['name'] for p in lock['packages']}
    if any(row['name'] in targets for row in before.values()):
        raise ValueError('Existing pinned package inventory refused.')


def inventory_diff(before, after, lock, held=False):
    require_absent(before, lock)
    pins = {p['name'] + ':amd64': p for p in lock['packages']}
    if len(pins) != 5 or set(after) != set(before) | set(pins):
        raise ValueError('Package inventory additions/removals differ from five pins.')
    if any(after[key] != row for key, row in before.items()):
        raise ValueError('Unrelated package inventory changed.')
    for key, pin in pins.items():
        row = after[key]
        if (row['name'], row['architecture'], row['version'], row['status']) != (
                pin['name'], 'amd64', pin['version'], 'hold ok installed' if held else 'install ok installed'):
            raise ValueError('Pinned package inventory differs.')
    return {'added': sorted(pins), 'removed': [], 'changed_existing': [], 'held': held}


def held_inventory(installed, final, lock):
    expected = {key: dict(row) for key, row in installed.items()}
    for pin in lock['packages']:
        expected[pin['name'] + ':amd64']['status'] = 'hold ok installed'
    if final != expected:
        raise ValueError('Inventory changed beyond the five hold transitions.')


def transaction(text, lock):
    """Bounded dpkg --log grammar, not an allowlist for human APT prose.

    Real Noble triggers/output still need separate qualification. Unknown records
    refuse even when a plausible package lifecycle could explain them.
    """
    if not text or not text.endswith('\n'):
        raise ValueError('Incomplete dpkg transaction log.')
    pins = {p['name']: p['version'] for p in lock['packages']}
    actions = {'install': {}, 'configure': {}}
    states = {}
    startups = []
    for line in text.splitlines():
        match = re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (.+)', line)
        if not match:
            raise ValueError('Malformed dpkg transaction record.')
        words = match[1].split(' ')
        if words[0] == 'startup':
            if words not in (['startup', 'archives', 'unpack'], ['startup', 'packages', 'configure']):
                raise ValueError('Unreviewed dpkg startup action.')
            startups.append(words[1:])
            continue
        status = words[0] == 'status'
        if len(words) != 4:
            raise ValueError('Unreviewed dpkg transaction record.')
        name = words[2] if status else words[1]
        if name.endswith(':amd64'):
            name = name[:-6]
        if name not in pins:
            raise ValueError('Unexpected dpkg transaction package.')
        if status:
            if (words[1] not in ('half-installed', 'unpacked', 'half-configured', 'installed',
                                 'triggers-pending', 'triggers-awaited') or words[3] != pins[name]):
                raise ValueError('Unexpected dpkg package status/version.')
            states[name] = words[1]
            continue
        action, _, old, new = words
        if action not in actions or name in actions[action]:
            raise ValueError('Unexpected or repeated dpkg action.')
        if (old, new) != (('<none>', pins[name]) if action == 'install' else (pins[name], '<none>')):
            raise ValueError('Dpkg action versions differ from simulation pins.')
        if action == 'configure' and name not in actions['install']:
            raise ValueError('Dpkg configure precedes install.')
        actions[action][name] = pins[name]
    if (set(actions['install']) != set(pins) or set(actions['configure']) != set(pins)
            or states != {name: 'installed' for name in pins}
            or ['archives', 'unpack'] not in startups or ['packages', 'configure'] not in startups):
        raise ValueError('Dpkg transaction is not the complete five-pin plan.')
    return {'install': actions['install'], 'configure': actions['configure'], 'terminal_status': states}
