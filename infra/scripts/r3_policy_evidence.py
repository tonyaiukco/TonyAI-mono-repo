"""Shared A/B collection contract. Evidence only: never generates install policy."""
import json
from pathlib import Path
import tempfile
import time

from r3_apt_observer import UNITS
from r3_install_policy import FIXED, DIRECTORIES, unique
from r3_noble_common import digest, encoded, read, run
from r3_package_state import INVENTORY_ARGV
import r3_policy_capture as capture

PURPOSE = 'R3_POLICY_EVIDENCE_COLLECTION'
A_PURPOSE = 'FIXTURE_POLICY_COLLECTION_ONLY'
B_PURPOSE = 'TARGET_POLICY_COLLECTION_ONLY'
DOCUMENT_LIMIT = 24 * 1024 * 1024
COMMANDS = {'inventory': INVENTORY_ARGV, 'audit': ['dpkg', '--audit'],
            'apt-config': ['apt-config', 'dump'], 'unit-config': ['systemctl', 'cat', *UNITS],
            'architecture': ['dpkg', '--print-architecture'],
            'unit-paths': ['systemctl', 'show', '--property=Id,FragmentPath,DropInPaths,NeedDaemonReload', *UNITS],
            'unit-paths-after': ['systemctl', 'show', '--property=Id,FragmentPath,DropInPaths,NeedDaemonReload', *UNITS]}
SCOPES = ('apt-scope-before', 'apt-scope-after', 'unit-scope-before', 'unit-scope-after')
# Reviewed read scope, not accepted semantics. Unknown members remain explicit
# partial evidence; never read arbitrary credentials disguised as configuration.
DIRECTORY_NAMES = {
    '/etc/apt/apt.conf.d': ('01-vendor-ubuntu', '01autoremove', '10periodic', '15update-stamp', '20archive',
        '20apt-esm-hook.conf', '20auto-upgrades', '20packagekit', '20snapd.conf', '50appstream',
        '50command-not-found', '50unattended-upgrades', '70debconf', '99needrestart', '99update-notifier'),
    '/etc/dpkg/dpkg.cfg.d': ('excludes', 'needrestart'),
    '/var/lib/dpkg/triggers': ('File', 'Lock', 'Unincorp', 'ldconfig', 'update-ca-certificates',
        'update-ca-certificates-fresh', 'update-ca-certificates-java',
        'update-ca-certificates-java-fresh', 'update-initramfs', 'update-mime-database',
        'update-icon-caches', 'update-default-ispell', 'update-default-wordlist',
        'lib32', 'libo32', 'libx32', 'linux-update-6.8.0-147-generic', 'shim-kernel-check',
        'shim-secureboot-policy', 'twisted-plugins-cache', 'update-sgmlcatalog')}
REVIEW_SCRIPTS = ('/usr/lib/os-release', '/usr/lib/ubuntu-advantage/apt-esm-json-hook', '/usr/lib/cnf-update-db')
EXTRA_FILES = (*REVIEW_SCRIPTS, '/usr/bin/snap', '/usr/bin/appstreamcli', '/usr/bin/test')
BODIES = REVIEW_SCRIPTS + tuple(p for p in FIXED if p not in ('/usr/bin/mandb', '/usr/bin/setpriv',
    '/usr/bin/python3.12', '/usr/bin/gdbus', '/var/lib/dpkg/diversions', '/var/lib/dpkg/statoverride'))
ERRORS = ('TimeoutError', 'UnicodeError', 'OSError', 'ValueError', 'RuntimeError')


class CollectionDeadline(BaseException):
    """Escape per-section Exception handlers when the outer alarm expires."""


def deadline_alarm(_sig, _frame):
    raise CollectionDeadline()


def error_code(exc):
    if isinstance(exc, CollectionDeadline):
        return 'TimeoutError'
    import builtins
    return next((name for name in ERRORS if isinstance(exc, getattr(builtins, name))), 'RuntimeError')


def operation(function):
    try:
        return {'state': 'ok', 'value': function()}
    except Exception as exc:
        # Exception messages can contain private output. Never export them.
        return {'state': 'error', 'error': error_code(exc)}


def command(name, deadline):
    with tempfile.TemporaryDirectory(prefix='r3-policy-command-') as temp:
        failure = None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Deadline')
            run(COMMANDS[name], temp, name, timeout=min(30, remaining), limit=2 * 1024 * 1024)
        except Exception as exc:
            failure = error_code(exc)
        root = Path(temp)
        def output(suffix):
            path = root / (name + suffix)
            return capture.blob(read(path, 2 * 1024 * 1024)) if path.exists() else capture.blob(b'')
        exit_path = root / (name + '.exit.json')
        exit_value = json.loads(read(exit_path)) if exit_path.exists() else {}
        return {'argv': COMMANDS[name], 'stdout': output('.stdout'), 'stderr': output('.stderr'),
                'returncode': exit_value.get('returncode'), 'failure': failure}


def member_record(path):
    value = capture.file_record(path, True)
    if value.get('absent'):
        raise ValueError('CHANGED')
    return value


def collect(binding, checkpoint=lambda _value: None):
    """Checkpoint every section before any completeness decision. No eligibility."""
    deadline = time.monotonic() + 240
    sections = {name: {'state': 'not_reached'} for name in (*COMMANDS,
        *('file:' + p for p in (*FIXED, *EXTRA_FILES)), *('directory:' + p for p in DIRECTORIES), *SCOPES, 'dbus-socket', 'cache')}
    value = {'format': 1, 'purpose': PURPOSE, 'binding': binding, 'sections': sections,
             'qualification': False, 'installation_success': False, 'policy_generated': False}
    def take(name, function):
        sections[name] = ({'state': 'not_reached'} if time.monotonic() >= deadline else operation(function))
        checkpoint(value)
    for name in ('inventory', 'audit', 'architecture'):
        take(name, lambda name=name: command(name, deadline))
    for path in (*FIXED, *EXTRA_FILES):
        take('file:' + path, lambda path=path: capture.file_record(path, path in BODIES))
    for path in DIRECTORIES:
        take('directory:' + path, lambda path=path: capture.membership(path))
        section = sections['directory:' + path]
        names = section.get('value', {}).get('names', [])
        for name in names:
            full = path + '/' + name
            if name not in DIRECTORY_NAMES[path]:
                sections['file:' + full] = {'state': 'error', 'error': 'UNREVIEWED_PATH'}
                checkpoint(value)
            else:
                take('file:' + full, lambda full=full: member_record(full))
    from r3_policy_scope import apt_scope, unit_scope
    take('apt-scope-before', apt_scope)
    if sections['apt-scope-before']['state'] == 'ok':
        take('apt-config', lambda: command('apt-config', deadline))
        take('apt-scope-after', apt_scope)
    take('unit-paths', lambda: command('unit-paths', deadline))
    def paths(name):
        import base64
        value = sections[name]['value']
        if value['returncode'] != 0 or value['failure'] is not None or value['stderr']['bytes'] != 0:
            raise ValueError('Unit path command failed')
        return base64.b64decode(value['stdout']['base64'], validate=True)
    take('unit-scope-before', lambda: unit_scope(paths('unit-paths')))
    if sections['unit-scope-before']['state'] == 'ok':
        take('unit-config', lambda: command('unit-config', deadline))
        take('unit-paths-after', lambda: command('unit-paths-after', deadline))
        take('unit-scope-after', lambda: unit_scope(paths('unit-paths-after')))
    take('dbus-socket', capture.socket_record)
    take('cache', capture.cache)
    # A second read detects observed drift; this remains a sampling limit.
    for name, section in list(sections.items()):
        if not name.startswith(('file:', 'directory:')) or section['state'] != 'ok':
            continue
        if time.monotonic() >= deadline:
            sections[name] = {'state': 'error', 'error': 'TimeoutError', 'prior': section['value']}
            checkpoint(value)
            continue
        path = name.split(':', 1)[1]
        again = operation(lambda: capture.membership(path) if name.startswith('directory:')
                          else capture.file_record(path, 'body' in section['value']))
        if time.monotonic() >= deadline:
            sections[name] = {'state': 'error', 'error': 'TimeoutError', 'prior': section['value']}
            checkpoint(value)
        elif again != section:
            sections[name] = {'state': 'error', 'error': 'CHANGED', 'prior': section['value']}
            checkpoint(value)
    return value


def load(data):
    if len(data) > DOCUMENT_LIMIT:
        raise ValueError('Policy evidence size limit')
    return json.loads(data, object_pairs_hook=unique)
