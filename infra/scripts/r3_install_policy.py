"""Opt-in R3 maintenance policy. Hash binding is not qualification or approval.

Policy data must come from separately reviewed native/target evidence. This
module never learns an allowlist from the transaction it is asked to accept.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from datetime import datetime

PURPOSE = 'R3_MAINTENANCE_INSTALL'
DIRECTORIES = ('/etc/apt/apt.conf.d', '/etc/dpkg/dpkg.cfg.d', '/var/lib/dpkg/triggers')
FIXED = ('/etc/apt/apt.conf', '/etc/dpkg/dpkg.cfg', '/etc/manpath.config',
         '/var/lib/man-db/auto-update', '/var/lib/dpkg/info/man-db.postinst',
         '/var/lib/dpkg/info/man-db.triggers', '/usr/bin/mandb', '/usr/bin/setpriv',
         '/usr/bin/python3.12', '/usr/share/unattended-upgrades/unattended-upgrade-shutdown',
         '/usr/lib/systemd/system/unattended-upgrades.service',
         '/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service',
         '/usr/bin/gdbus', '/usr/lib/needrestart/apt-pinvoke',
         '/usr/lib/needrestart/dpkg-status', '/usr/lib/update-notifier/update-motd-updates-available',
         '/usr/sbin/dpkg-preconfigure', '/var/lib/dpkg/diversions', '/var/lib/dpkg/statoverride')
LIMIT = 8 * 1024 * 1024


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate policy key')
        value[key] = item
    return value


def load(data, expected):
    if len(data) > 65536 or digest(data) != expected:
        raise ValueError('Installation policy hash/size differs')
    policy = json.loads(data, object_pairs_hook=unique)
    validate(policy)
    return policy


def validate(policy):
    keys = {'format', 'purpose', 'toolchain_sha256', 'inventory_sha256', 'apt_config_sha256', 'unit_config_sha256',
            'facts_sha256', 'cache_before_sha256', 'review_sha256', 'triggers'}
    if (not isinstance(policy, dict) or set(policy) != keys or type(policy['format']) is not int
            or policy['format'] != 1 or policy['purpose'] != PURPOSE):
        raise ValueError('Unknown installation policy schema')
    for key in keys - {'format', 'purpose', 'triggers'}:
        if not isinstance(policy[key], str) or not re.fullmatch('[a-f0-9]{64}', policy[key]):
            raise ValueError('Invalid policy binding')
    # Only man-db's triggered branch is supported by this implementation. A
    # different trigger requires code review, not a more permissive JSON file.
    if not isinstance(policy['triggers'], list) or len(policy['triggers']) != 1:
        raise ValueError('Exactly one reviewed man-db trigger required')
    item = policy['triggers'][0]
    if (not isinstance(item, dict) or set(item) != {'package', 'version', 'effects_review_sha256', 'effects'}
            or item['package'] != 'man-db:amd64' or not isinstance(item['version'], str)
            or not re.fullmatch(r'[0-9][A-Za-z0-9.+:~\-]*', item['version'])
            or not isinstance(item['effects_review_sha256'], str)
            or not re.fullmatch('[a-f0-9]{64}', item['effects_review_sha256'])):
        raise ValueError('Unreviewed trigger identity/effects')
    if not isinstance(item['effects'], dict) or len(item['effects']) > 256:
        raise ValueError('Invalid trigger effect allowlist')
    for name, effect in item['effects'].items():
        if (not isinstance(name, str) or name == '.' or Path(name).is_absolute()
                or '..' in Path(name).parts or str(Path(name)) != name
                or not re.fullmatch(r'[A-Za-z0-9_./@+\-]+', name)
                or not isinstance(effect, dict)
                or set(effect) != {'action', 'kind', 'uid', 'gid', 'mode', 'max_bytes'}
                or effect['action'] not in ('added', 'changed', 'removed')
                or effect['kind'] not in ('file', 'directory')
                or any(type(effect[k]) is not int or effect[k] < 0 for k in ('uid', 'gid', 'mode', 'max_bytes'))
                or effect['mode'] not in ((0o755,) if effect['kind'] == 'directory' else (0o600, 0o640, 0o644))
                or effect['max_bytes'] > (0 if effect['kind'] == 'directory' else LIMIT)):
            raise ValueError('Unbounded/unsafe native trigger effect')


def regular_record(path, root='/'):
    """No symlink traversal, devices, unbounded reads or raw content export.
    `root` is only for tests on temporary trees; production reads `/`."""
    parts = Path(path).parts
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > LIMIT or before.st_nlink != 1:
                raise ValueError('Unsafe policy guard file')
            data = bytearray()
            while len(data) <= LIMIT:
                block = os.read(file_fd, min(65536, LIMIT + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            after = os.fstat(file_fd)
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_gid')
            if len(data) != before.st_size or any(getattr(before, k) != getattr(after, k) for k in fields):
                raise ValueError('Policy guard file changed/oversized')
            return {'sha256': digest(data), 'bytes': len(data), 'uid': before.st_uid,
                    'gid': before.st_gid, 'mode': stat.S_IMODE(before.st_mode)}
        finally:
            os.close(file_fd)
    except FileNotFoundError:
        return {'absent': True}
    finally:
        os.close(fd)


def directory_record(path, root='/'):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        info = os.fstat(fd)
        return {'directory': True, 'uid': info.st_uid, 'gid': info.st_gid,
                'mode': stat.S_IMODE(info.st_mode)}
    finally:
        os.close(fd)


def bus_socket(root='/'):
    """Whether the D-Bus system socket exists, with the collector's semantics
    (`r3_policy_capture.socket_record`): `/run/dbus` is opened without following
    links, the socket is lstat'd, never connected to, and anything but a socket
    there refuses."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in ('run', 'dbus'):
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                return False
            os.close(fd)
            fd = nxt
        try:
            info = os.stat('system_bus_socket', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if not stat.S_ISSOCK(info.st_mode):
            raise ValueError('Unsafe D-Bus system socket')
        return True
    finally:
        os.close(fd)


def facts(root='/'):
    files = {name: regular_record(name, root) for name in FIXED}
    directories = {}
    for directory in DIRECTORIES:
        directory_record(directory, root)
        names = sorted(p.name for p in (Path(root) / directory.lstrip('/')).iterdir())
        if len(names) > 256:
            raise ValueError('Native directory limit')
        directories[directory] = names
        for name in names:
            files[directory + '/' + name] = regular_record(directory + '/' + name, root)
    # Do not read the D-Bus socket. Native PackageKit hooks can activate a foreign
    # writer. Until separately designed, refuse the activation predicate rather
    # than disable the hook or exempt packagekitd from the writer guard. The socket
    # is checked even without the registration, so an unsafe one always refuses.
    socket = bus_socket(root)
    packagekit = (not files['/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'].get('absent')
                  and socket)
    return {'files': files, 'directories': directories, 'packagekit_activation_possible': packagekit}


def preflight(policy, lock_bytes, before, apt_config, observed, unit_config, cache_before):
    validate(policy)
    if (digest(lock_bytes) != policy['toolchain_sha256']
            or digest(encoded(before)) != policy['inventory_sha256']
            or digest(apt_config) != policy['apt_config_sha256']
            or digest(unit_config) != policy['unit_config_sha256']
            or digest(encoded(cache_before)) != policy['cache_before_sha256']
            or digest(encoded(observed)) != policy['facts_sha256']):
        raise ValueError('Installation policy baseline/configuration differs')
    if observed.get('packagekit_activation_possible') is not False:
        raise ValueError('Unqualified native PackageKit activation predicate')
    for name in ('/usr/bin/mandb', '/usr/bin/setpriv', '/etc/manpath.config',
                 '/var/lib/dpkg/info/man-db.postinst', '/var/lib/dpkg/info/man-db.triggers'):
        if observed['files'][name].get('absent'):
            raise ValueError('Missing native trigger guard')
    for item in policy['triggers']:
        row = before.get(item['package'], {})
        if row.get('version') != item['version'] or row.get('status') != 'install ok installed':
            raise ValueError('Trigger is not the approved existing installed package')


def cache_snapshot(root=Path('/var/cache/man')):
    """Bounded cache evidence, NOT a claim of global filesystem confinement."""
    directory_record(root)
    result, total = {}, 0
    from itertools import chain
    for path in chain([root], root.rglob('*')):
        if len(result) >= 4096 or path.is_symlink():
            raise ValueError('Unsafe/oversized man cache')
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            value = directory_record(path)
        else:
            value = regular_record(str(path))
            total += value.get('bytes', 0)
        if total > 32 * 1024 * 1024:
            raise ValueError('Man cache byte limit')
        result[str(path.relative_to(root))] = value
    return result


def cache_effects(before, after, policy=None):
    for snapshot in (before, after):
        if not isinstance(snapshot, dict) or '.' not in snapshot or len(snapshot) > 4096:
            raise ValueError('Invalid cache evidence')
        total = 0
        for name, value in snapshot.items():
            if (name != '.' and (Path(name).is_absolute() or '..' in Path(name).parts
                                or str(Path(name)) != name)):
                raise ValueError('Unsafe cache evidence path')
            directory = value.get('directory') is True
            keys = {'directory', 'uid', 'gid', 'mode'} if directory else {'sha256', 'bytes', 'uid', 'gid', 'mode'}
            if set(value) != keys or any(type(value[k]) is not int or value[k] < 0 for k in ('uid', 'gid', 'mode')):
                raise ValueError('Invalid cache metadata')
            if value['mode'] & (0o7000 | 0o022) or value['mode'] > 0o777:
                raise ValueError('Unsafe cache permissions')
            if not directory:
                if (type(value['bytes']) is not int or not 0 <= value['bytes'] <= LIMIT
                        or not isinstance(value['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', value['sha256'])):
                    raise ValueError('Invalid cache content evidence')
                total += value['bytes']
        if total > 32 * 1024 * 1024 or snapshot['.'].get('directory') is not True:
            raise ValueError('Oversized/non-directory cache root')
    for name, value in before.items():
        if value.get('directory') is True and after.get(name) != value:
            raise ValueError('Native cache directory metadata changed')
    for value in after.values():
        if (value['uid'], value['gid']) != (before['.']['uid'], before['.']['gid']):
            raise ValueError('Native cache owner differs')
    result = {'before_sha256': digest(encoded(before)), 'after_sha256': digest(encoded(after)),
            'added': sorted(set(after) - set(before)), 'removed': sorted(set(before) - set(after)),
            'changed': sorted(n for n in before.keys() & after.keys() if before[n] != after[n]),
            'scope': '/var/cache/man only; other filesystem effects require independent review'}
    if policy is not None:
        validate(policy)
        actual = {name: action for action in ('added', 'removed', 'changed') for name in result[action]}
        expected = policy['triggers'][0]['effects']
        if set(actual) != set(expected):
            raise ValueError('Unreviewed or missing native cache effect')
        for name, effect in expected.items():
            value = before[name] if actual[name] == 'removed' else after[name]
            if (actual[name] != effect['action'] or ('directory' if value.get('directory') else 'file') != effect['kind']
                    or any(value[k] != effect[k] for k in ('uid', 'gid', 'mode'))
                    or value.get('bytes', 0) > effect['max_bytes']):
                raise ValueError('Native cache effect differs from policy')
    return result


def trigger_transaction(text, lock, policy):
    """One complete pending -> processing -> configured -> installed lifecycle."""
    from r3_package_state import transaction
    validate(policy)
    item = policy['triggers'][0]
    package, version = item['package'], item['version']
    expected = [f'status triggers-pending {package} {version}',
                f'trigproc {package} {version} <none>',
                f'status half-configured {package} {version}',
                f'status installed {package} {version}']
    ordinary, seen, configured = [], [], set()
    unpack_started, first_install, configure_started, previous_time = False, False, False, None
    for line in text.splitlines(keepends=True):
        match = re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (.+)\n', line)
        if match is None:
            raise ValueError('Malformed dpkg transaction record')
        timestamp = datetime.strptime(line[:19], '%Y-%m-%d %H:%M:%S')
        if previous_time is not None and timestamp < previous_time:
            raise ValueError('Dpkg transaction time moved backwards')
        previous_time = timestamp
        words = match[1].split(' ')
        name = words[2] if words[0] == 'status' and len(words) > 2 else words[1] if len(words) > 1 else ''
        if name in (package, 'man-db'):
            if len(seen) >= len(expected) or match[1] != expected[len(seen)]:
                raise ValueError('Unexpected native trigger lifecycle')
            if not unpack_started or not first_install:
                raise ValueError('Trigger precedes package installation')
            if len(seen) == 1 and (not configure_started or configured != {p['name'] + ':amd64' for p in lock['packages']}):
                raise ValueError('Trigger processing precedes complete pin configuration')
            seen.append(match[1])
        else:
            if words == ['startup', 'archives', 'unpack']:
                if unpack_started or seen:
                    raise ValueError('Repeated/reordered dpkg unpack')
                unpack_started = True
            elif words == ['startup', 'packages', 'configure']:
                if not unpack_started or configure_started:
                    raise ValueError('Repeated/reordered dpkg configure')
                configure_started = True
            elif words[0] == 'install':
                if not unpack_started or configure_started or len(seen) > 1:
                    raise ValueError('Pin installation outside unpack phase')
                first_install = True
            elif words[0] == 'configure':
                if not configure_started or len(seen) > 1:
                    raise ValueError('Pin configuration outside configure phase')
                configured.add(name)
            ordinary.append(line)
    if seen != expected:
        raise ValueError('Incomplete native trigger lifecycle')
    return {**transaction(''.join(ordinary), lock), 'native_triggers': seen,
            'policy_sha256': digest(encoded(policy)),
            'effects_limit': 'Cache observations and reviewed script/configuration; not global write confinement.'}
