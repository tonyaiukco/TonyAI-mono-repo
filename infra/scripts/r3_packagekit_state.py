"""Option C PackageKit state: observe -> normalize -> evaluate, one domain for every caller.

Read-only. `observe()` performs only no-follow reads plus exactly the three fixed
commands in `COMMANDS`. It never contacts org.freedesktop.PackageKit, opens or
connects a socket, or runs a D-Bus or service-control client. Its raw value has the
policy collector's section shape, so the installer, guest, controller and validator
all reach the predicate as `evaluate(normalize(raw))` over the same bytes.

`evaluate()` is the only PackageKit activation predicate. False means every
conjunct C1-C16 holds against the compile-time `REVIEWED` literals: a proof-bound
non-activation predicate, never a claim that activation is impossible. True means
the registration is present and a conjunct fails. None means a missing, erroring or
unreviewed input, an absent registration (NOT_C_BASELINE, owner decision D2), or a
proof obligation that is not discharged. Policies, facts and review hashes never
supply reviewed values; changing one requires a reviewed change of this module.
"""
import base64
import binascii
import hashlib
import os
from pathlib import PurePosixPath
import re
import stat
import subprocess
import time
import types

import r3_policy_capture as capture
from r3_noble_common import ENV, digest, encoded


def frozen(value):
    if isinstance(value, dict):
        return types.MappingProxyType({key: frozen(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(frozen(item) for item in value)
    return value


# Owner of every root-owned object. Tests on temporary trees patch this to the test
# user; production keeps root.
OWNER = (0, 0)
REGISTRATION = '/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'
MASK_PATH = '/etc/systemd/system/packagekit.service'
# The package's own fragment, at a root the /etc mask shadows (O14). C5 permits it only
# as a regular file; C13 binds its bytes to the reviewed packaged hash.
VENDOR_FRAGMENT = '/usr/lib/systemd/system/packagekit.service'
BUS = '/run/dbus/system_bus_socket'
PK_UNITS = ('packagekit.service', 'dbus.service', 'dbus.socket', 'packagekit-offline-update.service',
            'packagekit.socket', 'packagekit.path', 'packagekit.timer')
UNIT_PROPERTIES = ('Id', 'Names', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState', 'Job',
                   'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'InvocationID',
                   'InactiveExitTimestampMonotonic', 'ActiveEnterTimestampMonotonic',
                   'ActiveExitTimestampMonotonic', 'InactiveEnterTimestampMonotonic')
SERVICE_PROPERTIES = ('MainPID', 'NRestarts', 'ExecMainStartTimestamp')
ROW_FORMAT = '${binary:Package}\\t${Version}\\t${source:Package}\\t${source:Version}\\t${db:Status-Status}\\n'
# C12 code identity plus the kernel (security H2: O15/O16 are kernel semantics). polkitd
# authorizes PackageKit's methods and snapd ships the C9 include (PR-C1b, owner K5).
PACKAGES = ('dbus*', 'libdbus-1-3*', 'systemd', 'systemd-sysv', 'libsystemd-shared', 'libsystemd0*',
            'libglib2.0*', 'packagekit*', 'init-system-helpers', 'needrestart', 'polkitd',
            'libpolkit-gobject-1-0*', 'snapd', 'linux-image-*')
# The only commands this module runs (T-READONLY pins them).
COMMANDS = {
    'pk-units': ['systemctl', 'show', '--no-pager', '--timestamp=unix',
                 '--property=' + ','.join(UNIT_PROPERTIES + SERVICE_PROPERTIES), *PK_UNITS],
    'manager': ['systemctl', 'show', '--no-pager', '--property=UnitPath,Version'],
    'pk-package-metadata': ['dpkg-query', '-W', '-f=' + ROW_FORMAT, *PACKAGES]}
OUTPUT_LIMITS = {'pk-units': 128 * 1024, 'manager': 16 * 1024, 'pk-package-metadata': 128 * 1024}
COMMAND_TIMEOUT = 10

# O3 system unit-search roots in precedence order, PROVEN from systemd 255.4
# path-lookup.c:605-626 (o14 review). The live UnitPath must equal this list (C5).
UNIT_ROOTS = ('/etc/systemd/system.control', '/run/systemd/system.control', '/run/systemd/transient',
              '/run/systemd/generator.early', '/etc/systemd/system', '/etc/systemd/system.attached',
              '/run/systemd/system', '/run/systemd/system.attached', '/run/systemd/generator',
              '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/run/systemd/generator.late')
# root's user-manager search roots: C13 scan scope only (INFERRED; O12 user half open).
USER_ROOTS = ('/root/.config/systemd/user.control', '/run/user/0/systemd/user.control',
              '/run/user/0/systemd/transient', '/run/user/0/systemd/generator.early',
              '/root/.config/systemd/user', '/etc/systemd/user', '/etc/xdg/systemd/user',
              '/run/user/0/systemd/user', '/run/systemd/user', '/run/user/0/systemd/generator',
              '/root/.local/share/systemd/user', '/usr/local/share/systemd/user', '/usr/share/systemd/user',
              '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', '/var/lib/snapd/desktop/systemd/user',
              '/run/user/0/systemd/generator.late')
# O2 system service directories in dbus' proven order. /lib/dbus-1/system-services is
# reached through the recorded /lib alias, never by following it (C2). snapd's include
# declares one more `<servicedir>`; dbus appends an included servicedir after the
# standard ones and activation takes the first matching Name= in that order (o9-o12
# review: config-parser.c servicedir append, activation.c directory scan).
SNAPD_SERVICE_DIR = '/var/lib/snapd/dbus-1/system-services'
SERVICE_DIRS = ('/usr/local/share/dbus-1/system-services', '/usr/share/dbus-1/system-services',
                '/usr/lib/dbus-1/system-services', SNAPD_SERVICE_DIR)
SESSION_DIRS = ('/root/.local/share/dbus-1/services', '/usr/local/share/dbus-1/services',
                '/usr/share/dbus-1/services', '/var/lib/snapd/desktop/dbus-1/services', '/run/user/0/dbus-1/services')
# Parents of the C2/C9 paths: a file added or removed after dbus started changes their ctime (C15).
DBUS_PARENTS = ('/usr/share/dbus-1', '/etc/dbus-1', '/usr/local/share/dbus-1', '/usr/lib/dbus-1', '/var/lib/snapd/dbus-1')
# C9 chain (O2 PROVEN incl. system-local.conf); the SELinux contexts include is
# honoured only when SELinux is enabled, so its runtime state is recorded.
CONFIG_FILES = ('/usr/share/dbus-1/system.conf', '/etc/dbus-1/system.conf', '/etc/dbus-1/system-local.conf')
CONFIG_DIRS = ('/usr/share/dbus-1/system.d', '/etc/dbus-1/system.d')
# The one include allowed to declare a servicedir, and only SNAPD_SERVICE_DIR (C9).
SNAPD_INCLUDE = '/usr/share/dbus-1/system.d/snapd.system-services.conf'
SELINUX = '/sys/fs/selinux'
PK_FRAGMENTS = ('/usr/lib/systemd/system/dbus.service', '/usr/lib/systemd/system/dbus.socket',
                '/usr/lib/systemd/system/packagekit.service',
                '/usr/lib/systemd/system/packagekit-offline-update.service')
# C12 file identities. The two library paths are INFERRED until the step-2 .deb data
# members are reviewed; an absent or different file can only give None.
C12_FILES = ('/usr/libexec/packagekitd', '/usr/bin/dbus-daemon', '/usr/lib/dbus-1.0/dbus-daemon-launch-helper',
             '/usr/lib/systemd/systemd', '/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so',
             '/usr/lib/x86_64-linux-gnu/libgio-2.0.so.0.8000.0', '/usr/bin/gdbus')
# The alias's own drop-in directory and the `packagekit-` prefix drop-in, which systemd 255
# applies to packagekit-offline-update.service (QA M; the PR-C1 Explore note).
C5_NAMES = ('packagekit.service', 'packagekit.service.d', 'packagekit@.service', 'packagekit@.service.d',
            'dbus-org.freedesktop.PackageKit.service', 'dbus-org.freedesktop.PackageKit.service.d',
            'packagekit-.service.d')
C14_NAMES = ('packagekit.socket', 'packagekit.path', 'packagekit.timer', 'packagekit@.socket')
CANDIDATES = (*C5_NAMES, *C14_NAMES, 'dbus.service.d', 'dbus.socket.d', 'service.d', 'socket.d')
SYSTEM_UPDATE = ('/system-update', '/etc/system-update')
PK_PROCESSES = frozenset({'packagekitd', 'pk-offline-update', 'pk-offline-upda'})
LINKS = ('/etc/systemd/system/packagekit.service', '/var/run', '/lib')
# Evidence for the open O7, O11 and O12 obligations (PR-C1b): no conjunct reads their values
# yet, but each must be collected and well-formed (G7.evidence), so a gap gives None.
DSH_DIRS = ('/var/lib/systemd/deb-systemd-helper-enabled', '/var/lib/systemd/deb-systemd-helper-masked')
NEEDRESTART = '/etc/needrestart'
NEEDRESTART_FILES = ('/etc/needrestart/needrestart.conf', '/etc/needrestart/notify.conf', '/etc/needrestart/iucode.sh')
NEEDRESTART_DIRS = ('/etc/needrestart/conf.d', '/etc/needrestart/hook.d', '/etc/needrestart/notify.d',
                    '/etc/needrestart/restart.d')
SESSION_CONFIG_FILES = ('/usr/share/dbus-1/session.conf', '/etc/dbus-1/session.conf', '/etc/dbus-1/session-local.conf')
SESSION_CONFIG_DIRS = ('/usr/share/dbus-1/session.d', '/etc/dbus-1/session.d')
USER_MANAGER = ('/var/lib/systemd/linger', '/run/user/0', '/run/systemd/users')
EVIDENCE_SECTIONS = ('dsh-state', 'needrestart-config', 'dbus-session-config', 'user-manager')
SECTION_NAMES = ('pk-units', 'manager', 'pk-package-metadata', *('link:' + p for p in LINKS),
                 'dir-meta:/var', 'device:/dev/null', 'dbus-socket', 'unit-candidates', 'unit-universe',
                 'dpkg-md5sums', 'pk-fragments', 'dbus-service-dirs', 'dbus-config', 'dbus-daemon-proc',
                 'pk-binaries', 'pk-processes', *EVIDENCE_SECTIONS)
# Sections the collector re-reads for drift; dbus-daemon-proc compares only its
# process identity, its volatile values are continuity data. user-manager is runtime
# state that a login changes.
REREAD = tuple(n for n in SECTION_NAMES if n not in ('pk-units', 'manager', 'pk-package-metadata',
                                                      'dbus-socket', 'pk-processes', 'user-manager'))
# Each section's fixed item order. An error record names the failing item's index in it
# and the errno, never a path or a message (`locus`; owner K3).
ITEMS = {'unit-candidates': (*UNIT_ROOTS, *SYSTEM_UPDATE), 'unit-universe': (*UNIT_ROOTS, *USER_ROOTS),
         'pk-fragments': PK_FRAGMENTS, 'pk-binaries': C12_FILES, 'dbus-service-dirs': (*SERVICE_DIRS, *SESSION_DIRS),
         'dbus-config': (*CONFIG_FILES, *CONFIG_DIRS, *DBUS_PARENTS, SELINUX), 'dsh-state': DSH_DIRS,
         'needrestart-config': (*NEEDRESTART_FILES, *NEEDRESTART_DIRS, NEEDRESTART),
         'dbus-session-config': (*SESSION_CONFIG_FILES, *SESSION_CONFIG_DIRS), 'user-manager': USER_MANAGER}
# Discovery-mode md5sums (owner K4/U1): every package's list is read, and only the lines under a
# unit root (or its /lib spelling) are kept, as the input for a reviewed unit_index.
MD5SUMS_DIR = '/var/lib/dpkg/info'
MD5SUMS_PREFIXES = tuple(root + '/' for root in (*UNIT_ROOTS, *USER_ROOTS, '/lib/systemd/system', '/lib/systemd/user'))
MD5SUMS_DISCOVERY = {'files': 4096, 'bytes': 32 * 1024 * 1024, 'lines': 8192, 'names': 32768}
DBUS_EXE = '/usr/bin/dbus-daemon'
CTIME_MARGIN_NS = 2 * 1000 * 1000 * 1000
SO_ACCEPTCON = 0x10000
RISKY_TAGS = re.compile(rb'<\s*(servicedir|servicehelper|standard_system_servicedirs|standard_session_servicedirs'
                        rb'|include|includedir)\b', re.I)
ESCAPES = re.compile(rb'\\[xuU0-7]')
# C9.servicedirs reads a `<servicedir>` only in its one plain form. expat would decode
# character references and expand an internal entity into markup, so any other spelling,
# a reference in the value or an entity declaration is not established.
SERVICEDIR_OPEN = re.compile(rb'<\s*servicedir\b', re.I)
SERVICEDIR = re.compile(rb'<servicedir>([^<&]*)</servicedir>')
ENTITY_DECL = re.compile(rb'<!\s*ENTITY\b', re.I)
# Exec*= forms whose program is not literally readable: specifiers, variables, globs, shells.
INDIRECTION = re.compile(r'[%$*?\[`]|(^|\s)-[A-Za-z]*c[A-Za-z]*(\s|$)')
QUOTES = str.maketrans('', '', '"\'')  # systemd and shells drop quotes inside a word
VOLATILE_NAME = re.compile(r'snap[-.]')
ERRORS = ('TimeoutError', 'UnicodeError', 'OSError', 'ValueError', 'RuntimeError')
# Bumped by every change of the predicate's or format 3's semantics under the same proof (PR-C1 = 1,
# PR-C1b = 2), so a validator result names the module revision it was read against.
PREDICATE_REVISION = 2

# Compile-time reviewed values (design03 2.2, G2/N2). Integrity rests on this module's
# hash, which every approval binds. Source facts are global; everything derived from a
# host's packages is per target (QA M2): a host uses the ONE profile whose code identity
# (its dpkg rows without kernel images, and the manager Version) equals its own, and a
# host without a reviewed profile is collected as DISCOVERY_ONLY. None marks a value whose
# proof or evidence is not yet retained; every conjunct that needs it gives None, so this
# module cannot return False until a reviewed change fills it. PR-C1b ships no profile
# (owner K6): A's follows LIVE-A1b, whose discovery md5sums feed its unit_index.
REVIEWED = frozen({
    # Retained O1/O14 source reviews (o1-o14-findings01.json, SHA256).
    'proof_id': 'o1-o14-findings01:410717a7f1f417776bcb14fa4c7d78788613e3259519e6c6130f5054ae41ad13',
    # PROVEN identical on A02 and B04: the 123-byte registration body.
    'registration_sha256': '6fbf6a1c93cc31edf72431901fae7c3931fd5f52856d3298ce09ae69466e4022',
    'unit_roots': UNIT_ROOTS,
    'dev_null': (1, 3),
    'o10_ok': False,              # O10 PARTIAL: the gdbus half is open (erratum01)
    'o13_mode': 'ctime_rule',     # O13: reload_on_lookup FAILS for this dbus build (o1 review)
    # Caps for a host without a reviewed profile (names and metadata only).
    'discovery_caps': {'entries': 2048},
    # Per target: {'id', 'code': {'rows', 'manager_version', 'kernel', 'kernel_row', 'files'},
    #   'allow': {'lib_alias', 'service_members', 'config_files', 'config_members',
    #             'selinux_rule', 'masked_fragment_path', 'dbus_names', 'dbus_fragment',
    #             'var_run_target', 'unit_index', 'link_targets', 'caps'}}.
    # `service_members` has one key per SERVICE_DIRS entry; `code.files` one per C12_FILES
    # entry; a `link_targets` entry clears a link only when its target is an indexed file
    # this scan read (C13, owner K1).
    # A (systemd .18) and B (.17, equivalence not proven) are both pending.
    'profiles': (),
})
UNIVERSE_BODY_LIMIT = 64 * 1024
if REVIEWED['unit_roots'] != UNIT_ROOTS:  # ITEMS indexes UNIT_ROOTS while the readers walk this list
    raise RuntimeError('ITEMS and the reviewed unit roots differ')
PROFILE_CODE_KEYS = ('rows', 'manager_version', 'kernel', 'kernel_row', 'files')
PROFILE_ALLOW_KEYS = ('lib_alias', 'service_members', 'config_files', 'config_members', 'selinux_rule',
                      'masked_fragment_path', 'dbus_names', 'dbus_fragment', 'var_run_target', 'unit_index',
                      'link_targets', 'caps')


class Unavailable(Exception):
    """A section that is missing, not reached or in error."""


def need(condition):
    if not condition:
        raise ValueError('PACKAGEKIT_SCHEMA')


# The collector's error names, in the same subclass-first order.
ERROR_TYPES = ((TimeoutError, 'TimeoutError'), (UnicodeError, 'UnicodeError'), (OSError, 'OSError'),
               (ValueError, 'ValueError'), (RuntimeError, 'RuntimeError'))


def error_code(exc):
    return next((name for kind, name in ERROR_TYPES if isinstance(exc, kind)), 'RuntimeError')


class ItemError(Exception):
    """A failure inside one of a section's fixed ITEMS, carrying that item's index."""
    def __init__(self, index, cause):
        super().__init__(index)
        self.index, self.cause = index, cause


def each(paths, function):
    """{path: function(path)} in the section's fixed order; a failure names only the item's index."""
    result = {}
    for index, path in enumerate(paths):
        try:
            result[path] = function(path)
        except Exception as exc:
            raise ItemError(index, exc) from exc
    return result


def error_record(exc, code=error_code):
    """Exception text can carry private paths or output: never export it. An item failure adds
    its `locus`, the item's index in ITEMS and the errno (path-free, bounded; owner K3)."""
    if not isinstance(exc, ItemError):
        return {'state': 'error', 'error': code(exc)}
    errno = exc.cause.errno if isinstance(exc.cause, OSError) else None
    return {'state': 'error', 'error': code(exc.cause),
            'locus': {'item': exc.index, 'errno': errno if type(errno) is int and 1 <= errno <= 4095 else None}}


def operation(function):
    try:
        return {'state': 'ok', 'value': function()}
    except Exception as exc:
        return error_record(exc)


# ---------------------------------------------------------------- readers

def execute(argv, timeout):
    """The only subprocess call: fixed argv from COMMANDS, fixed environment, no stdin."""
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, env=ENV, timeout=timeout)
    return result.stdout, result.stderr, result.returncode


def command(name, runner=None, timeout=COMMAND_TIMEOUT):
    argv = COMMANDS[name]
    stdout, stderr, returncode = (runner or execute)(list(argv), max(0.1, min(COMMAND_TIMEOUT, timeout)))
    if len(stdout) > OUTPUT_LIMITS[name] or len(stderr) > OUTPUT_LIMITS[name]:
        raise ValueError('LIMIT')
    return {'argv': list(argv), 'stdout': capture.blob(stdout), 'stderr': capture.blob(stderr),
            'returncode': returncode, 'failure': None}


def lstat_at(name, fd):
    return os.stat(name, dir_fd=fd, follow_symlinks=False)


def kind(info):
    for test, name in ((stat.S_ISLNK, 'link'), (stat.S_ISREG, 'regular'), (stat.S_ISDIR, 'directory'),
                       (stat.S_ISCHR, 'char'), (stat.S_ISSOCK, 'socket')):
        if test(info.st_mode):
            return name
    return 'other'


def meta(info):
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def open_dir(path, root, parents=None):
    """No-follow directory chain below `root` (tests only; production is `/`)."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        if parents is not None:
            parents.append(meta(os.fstat(fd)))
        for part in PurePosixPath(path).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
            if parents is not None:
                parents.append(meta(os.fstat(fd)))
        return fd
    except BaseException:
        os.close(fd)
        raise


def scan(fd, maximum):
    names = []
    with os.scandir(fd) as entries:
        for item in entries:
            if len(names) >= maximum:
                raise ValueError('LIMIT')
            names.append(item.name)
    return sorted(names)


def readlink_at(name, fd):
    target = os.readlink(name, dir_fd=fd)
    if len(target) > 4096:
        raise ValueError('LIMIT')
    return target


def read_at(fd, name, cap):
    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > cap:
            raise ValueError('UNSAFE_FILE')
        data = bytearray()
        while len(data) <= cap:
            block = os.read(file_fd, min(65536, cap + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        capture.same(before, os.fstat(file_fd))
        capture.same(before, lstat_at(name, fd))
        if len(data) != before.st_size:
            raise ValueError('CHANGED')
        return bytes(data)
    finally:
        os.close(file_fd)


def read_proc(fd, name, cap):
    """/proc files report size 0; bound the read itself."""
    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        data = bytearray()
        while len(data) <= cap:
            block = os.read(file_fd, min(65536, cap + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > cap:
            raise ValueError('LIMIT')
        return bytes(data)
    finally:
        os.close(file_fd)


def entry(path, root='/'):
    """lstat one fixed path through a no-follow parent chain; the leaf is never followed."""
    pure, parents = PurePosixPath(path), []
    try:
        fd = open_dir(str(pure.parent), root, parents)
    except FileNotFoundError:
        return {'type': 'absent', 'parents': parents}
    try:
        try:
            info = lstat_at(pure.name, fd)
        except FileNotFoundError:
            return {'type': 'absent', 'parents': parents}
        value = {'type': kind(info), **meta(info), 'ctime_ns': info.st_ctime_ns,
                 'identity': [info.st_dev, info.st_ino], 'parents': parents}
        if value['type'] == 'link':
            value['target'] = readlink_at(pure.name, fd)
        elif value['type'] == 'regular':
            value.update(bytes=info.st_size, nlink=info.st_nlink)
        elif value['type'] == 'char':
            value['rdev'] = [os.major(info.st_rdev), os.minor(info.st_rdev)]
        return value
    finally:
        os.close(fd)


def member(fd, name, cap):
    info = lstat_at(name, fd)
    item = {'type': kind(info), **meta(info), 'ctime_ns': info.st_ctime_ns}
    if item['type'] == 'regular':
        item['body'] = capture.blob(read_at(fd, name, cap))
    elif item['type'] == 'link':
        item['target'] = readlink_at(name, fd)
    return item


def single(path, root, cap=128 * 1024):
    pure = PurePosixPath(path)
    try:
        fd = open_dir(str(pure.parent), root)
    except FileNotFoundError:
        return {'absent': True}
    try:
        try:
            return member(fd, pure.name, cap)
        except FileNotFoundError:
            return {'absent': True}
    finally:
        os.close(fd)


def listing(path, root, maximum=128, cap=128 * 1024):
    """Membership plus every member's body or link target; nothing is followed."""
    try:
        fd = open_dir(path, root)
    except FileNotFoundError:
        return {'absent': True}
    try:
        before = os.fstat(fd)
        members = {name: member(fd, name, cap) for name in scan(fd, maximum)}
        capture.same(before, os.fstat(fd))
        return {**meta(before), 'ctime_ns': before.st_ctime_ns, 'members': members}
    finally:
        os.close(fd)


def names_only(path, root, maximum=256):
    try:
        fd = open_dir(path, root)
    except FileNotFoundError:
        return {'absent': True}
    try:
        return {'names': scan(fd, maximum)}
    finally:
        os.close(fd)


def candidates(root='/'):
    def one(path):
        try:
            fd = open_dir(path, root)
        except FileNotFoundError:
            return {'absent': True}
        try:
            found = {}
            for name in CANDIDATES:
                try:
                    info = lstat_at(name, fd)
                except FileNotFoundError:
                    found[name] = {'type': 'absent'}
                    continue
                found[name] = {'type': kind(info), **({'target': readlink_at(name, fd)} if stat.S_ISLNK(info.st_mode) else {})}
            return {'entries': found}
        finally:
            os.close(fd)
    found = each(ITEMS['unit-candidates'],
                 lambda path: {'type': entry(path, root)['type']} if path in SYSTEM_UPDATE else one(path))
    return {'roots': {path: found[path] for path in REVIEWED['unit_roots']},
            'system_update': {path: found[path] for path in SYSTEM_UPDATE}}


def scope(sections):
    """(profile id, packaged index, caps) for the host's selected profile; a host without a
    reviewed profile or index is collected names-only (DISCOVERY_ONLY)."""
    profile = selected(sections)
    allow = profile['allow'] if profile is not None else None
    if allow is None or allow['unit_index'] is None:
        return (profile['id'] if profile is not None else None), None, REVIEWED['discovery_caps']
    return profile['id'], allow['unit_index'], allow['caps']


def root_link(path, root='/'):
    """The first symlink among `path`'s components, read without following it; None when there is none.

    A root such as /etc/xdg/systemd/user is packaged as a link to /etc/systemd/user (systemd 255.4
    src/core/meson.build; Ubuntu's systemd.install), so a no-follow open of it fails with ELOOP."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        current = PurePosixPath('/')
        for part in PurePosixPath(path).parts[1:]:
            current = current / part
            if stat.S_ISLNK(lstat_at(part, fd).st_mode):
                return {'link': str(current), 'target': readlink_at(part, fd)}
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return None
    finally:
        os.close(fd)


def universe(sections, root='/'):
    """C13 scope. Without a reviewed packaged index this is DISCOVERY_ONLY: names, types,
    sizes and link targets, never a body (design03 4.2, N4). A root reached through a symlink is
    recorded as that link, never followed; c13 decides whether another root covers it."""
    profile_id, index, caps = scope(sections)
    budget = {'bodies': 0, 'bytes': 0, 'packaged': 0}

    def one(path):
        try:
            link = root_link(path, root)
        except FileNotFoundError:
            return {'absent': True}
        if link is not None:
            return link
        try:
            fd = open_dir(path, root)
        except FileNotFoundError:
            return {'absent': True}
        try:
            before = os.fstat(fd)
            count = [0]
            value = {**meta(before), 'entries': universe_dir(fd, path, index, caps, budget, count, 0)}
            capture.same(before, os.fstat(fd))
            return value
        finally:
            os.close(fd)
    roots = each(ITEMS['unit-universe'], one)
    return {'mode': 'discovery' if index is None else 'full', 'profile': profile_id, 'roots': roots}


def universe_dir(fd, path, index, caps, budget, count, depth):
    result = {}
    for name in scan(fd, caps['entries']):
        count[0] += 1
        if count[0] > caps['entries']:
            raise ValueError('LIMIT')
        info, full = lstat_at(name, fd), path + '/' + name
        item = {'type': kind(info)}
        if item['type'] == 'link':
            item['target'] = readlink_at(name, fd)
        elif item['type'] == 'regular':
            item['bytes'] = info.st_size
            if index is not None:
                data = read_at(fd, name, caps['body'])
                if full in index:
                    budget['packaged'] += 1
                    if budget['packaged'] > caps['packaged']:
                        raise ValueError('LIMIT')
                    item.update(sha256=digest(data), md5=hashlib.md5(data, usedforsecurity=False).hexdigest())
                else:
                    budget['bodies'] += 1
                    budget['bytes'] += len(data)
                    if budget['bodies'] > caps['bodies'] or budget['bytes'] > caps['aggregate']:
                        raise ValueError('LIMIT')
                    item['body'] = capture.blob(data)
        elif item['type'] == 'directory' and depth == 0:
            sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                before = os.fstat(sub)
                item['entries'] = universe_dir(sub, full, index, caps, budget, count, 1)
                capture.same(before, os.fstat(sub))
            finally:
                os.close(sub)
        # A directory below depth 1 is recorded without members; normalize gives None.
        result[name] = item
    return result


def md5sums_discovery(root):
    """Every package's md5sums file: its SHA256, and its lines under a unit root (owner K4/U1).
    `digest` binds the complete (name, SHA256) list; checking it needs the host's own list."""
    limits = MD5SUMS_DISCOVERY
    try:
        fd = open_dir(MD5SUMS_DIR, root)
    except FileNotFoundError:
        return {'mode': 'discovery', 'files': {}, 'scanned': 0, 'bytes': 0, 'digest': digest(encoded([]))}
    try:
        names = [name for name in scan(fd, limits['names']) if name.endswith('.md5sums')]
        if len(names) > limits['files']:
            raise ValueError('LIMIT')
        files, every, total, kept = {}, [], 0, 0
        for name in names:
            if not stat.S_ISREG(lstat_at(name, fd).st_mode):
                raise ValueError('UNSAFE_FILE')  # never open a device or FIFO by that name
            data = read_at(fd, name, limits['bytes'] - total)
            total += len(data)
            every.append([name, digest(data)])
            lines = {}
            for line in data.decode('utf-8').splitlines():
                md5, separator, relative = line.partition('  ')
                if not separator or not re.fullmatch('[a-f0-9]{32}', md5):
                    raise ValueError('MALFORMED')
                path = '/' + relative
                if path.startswith(MD5SUMS_PREFIXES):
                    if path in lines:
                        raise ValueError('MALFORMED')
                    kept += 1
                    if kept > limits['lines']:
                        raise ValueError('LIMIT')
                    lines[path] = md5
            if lines:
                files[name] = {'sha256': every[-1][1], 'lines': lines}
        return {'mode': 'discovery', 'files': files, 'scanned': len(names), 'bytes': total, 'digest': digest(encoded(every))}
    finally:
        os.close(fd)


def md5sums(sections, root='/'):
    _profile, index, caps = scope(sections)
    if index is None:
        return md5sums_discovery(root)
    wanted = {}
    for item in index.values():
        if item['sha256'] is None:
            wanted.setdefault(item['md5sums'], set()).add(item['listed'])
    if len(wanted) > caps['md5sums_files']:
        raise ValueError('LIMIT')
    files, total = {}, 0
    if wanted:
        fd = open_dir('/var/lib/dpkg/info', root)
        try:
            for name in sorted(wanted):
                data = read_at(fd, name, caps['md5sums_bytes'] - total)
                total += len(data)
                lines = {}
                for line in data.decode('utf-8').splitlines():
                    value, separator, relative = line.partition('  ')
                    if not separator or not re.fullmatch('[a-f0-9]{32}', value):
                        raise ValueError('MALFORMED')
                    path = '/' + relative
                    if path in wanted[name]:
                        if path in lines:
                            raise ValueError('MALFORMED')
                        lines[path] = value
                files[name] = {'sha256': digest(data), 'lines': lines}
        finally:
            os.close(fd)
    return {'mode': 'full', 'files': files}


def unit_blocks(record):
    return parse_units(stdout(record))


def dbus_proc(sections, root='/'):
    """D4/D16 read scope: the dbus MainPID's cmdline, exe link, socket fd inodes, the
    bus-path listener rows of its network namespace, and the C15 time base."""
    pid = (unit_blocks(section_value(sections, 'pk-units'))['dbus.service']['MainPID'])
    if not re.fullmatch('[1-9][0-9]{0,9}', pid):
        raise ValueError('NO_DBUS_PROCESS')
    btime_first = boot_time(root)
    fd = open_dir('/proc/' + pid, root)
    try:
        cmdline = read_proc(fd, 'cmdline', 4096)
        exe = readlink_at('exe', fd)
        start = start_ticks(read_proc(fd, 'stat', 4096))
        inodes = socket_inodes(fd)
        net = os.open('net', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            listeners, total = unix_rows(read_proc(net, 'unix', 16 * 1024 * 1024))
        finally:
            os.close(net)
    finally:
        os.close(fd)
    kernel = open_dir('/proc/sys/kernel', root)
    try:
        osrelease = read_proc(kernel, 'osrelease', 256).decode('ascii').strip()
    finally:
        os.close(kernel)
    random = open_dir('/proc/sys/kernel/random', root)
    try:
        boot_id = read_proc(random, 'boot_id', 64).decode('ascii').strip()
    finally:
        os.close(random)
    socket = capture.socket_record(root, identity=True)
    return {'pid': int(pid), 'cmdline': capture.blob(cmdline), 'exe': exe, 'start_ticks': start,
            'socket_inodes': inodes, 'unix_rows': listeners, 'unix_path_rows': total,
            'btime': [btime_first, boot_time(root)], 'boot_id': boot_id, 'clk_tck': os.sysconf('SC_CLK_TCK'),
            'wall_ns': time.time_ns(), 'kernel': osrelease, 'socket_identity': socket.get('identity')}


def boot_time(root):
    fd = open_dir('/proc', root)
    try:
        lines = [line for line in read_proc(fd, 'stat', 1024 * 1024).decode('ascii').splitlines()
                 if line.startswith('btime ')]
    finally:
        os.close(fd)
    need(len(lines) == 1 and re.fullmatch(r'btime [0-9]{1,12}', lines[0]))
    return int(lines[0].split()[1])


def start_ticks(data):
    fields = data.decode('ascii').rsplit(') ', 1)[1].split()
    need(len(fields) > 19 and fields[19].isdigit())
    return int(fields[19])


def socket_inodes(fd):
    sub = os.open('fd', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        inodes = set()
        for name in scan(sub, 256):
            try:
                target = os.readlink(name, dir_fd=sub)
            except FileNotFoundError:
                continue  # closed since the listing; never the inherited listener
            match = re.fullmatch(r'socket:\[([0-9]{1,20})\]', target)
            if match:
                inodes.add(int(match.group(1)))
        return sorted(inodes)
    finally:
        os.close(sub)


def unix_rows(data):
    """Rows for the bus path that could be listeners (flag or state), plus the count of
    every bus-path row. INFERRED field semantics; O16."""
    lines = data.decode('ascii').splitlines()
    need(lines and lines[0].split()[:1] == ['Num'])
    rows, total = [], 0
    for line in lines[1:]:
        fields = line.split(None, 7)
        if len(fields) != 8 or fields[7] != BUS:
            continue
        total += 1
        flags, state = int(fields[3], 16), fields[5]
        if flags & SO_ACCEPTCON or state == '01':
            rows.append({'flags': fields[3], 'type': fields[4], 'state': state, 'inode': int(fields[6])})
            if len(rows) > 64:
                raise ValueError('LIMIT')
    return rows, total


def processes(root='/'):
    """The existing /proc scan filtered to PackageKit's daemons (MANAGERS unchanged)."""
    fd = open_dir('/proc', root)
    found = []
    try:
        for name in scan(fd, 1 << 20):
            if not name.isdigit():
                continue
            try:
                sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                continue
            try:
                comm = read_proc(sub, 'comm', 64).decode('utf-8', 'replace').strip()
                args = read_proc(sub, 'cmdline', 64 * 1024).split(b'\0')
                start = start_ticks(read_proc(sub, 'stat', 4096))
            except (FileNotFoundError, ProcessLookupError):
                continue  # exited during this sample, not proof of absence
            finally:
                os.close(sub)
            if comm in PK_PROCESSES or any(os.fsdecode(a).rsplit('/', 1)[-1] in PK_PROCESSES for a in args):
                found.append({'pid': int(name), 'comm': comm, 'start_ticks': start})
                if len(found) > 64:
                    raise ValueError('LIMIT')
    finally:
        os.close(fd)
    return found


def read(name, sections, root='/', runner=None, timeout=COMMAND_TIMEOUT):
    """One raw section by name. Raises on any failure; callers record the error."""
    if name in COMMANDS:
        return command(name, runner, timeout)
    if name.startswith('link:'):
        return entry(name[5:], root)
    if name == 'dir-meta:/var':
        return entry('/var', root)
    if name == 'device:/dev/null':
        return entry('/dev/null', root)
    if name == 'dbus-socket':
        return capture.socket_record(root)
    if name == 'unit-candidates':
        return candidates(root)
    if name == 'unit-universe':
        return universe(sections, root)
    if name == 'dpkg-md5sums':
        return md5sums(sections, root)
    if name == 'pk-fragments':
        return each(ITEMS[name], lambda path: capture.file_record(path, True, root))
    if name == 'dbus-service-dirs':
        found = each(ITEMS[name], lambda path: listing(path, root))
        return {'system': {path: found[path] for path in SERVICE_DIRS},
                'session': {path: found[path] for path in SESSION_DIRS}}
    if name == 'dbus-config':
        found = each(ITEMS[name], lambda path: single(path, root) if path in CONFIG_FILES else listing(path, root)
                     if path in CONFIG_DIRS else entry(path, root) if path in DBUS_PARENTS else names_only(path, root))
        return {'files': {path: found[path] for path in CONFIG_FILES},
                'dirs': {path: found[path] for path in CONFIG_DIRS},
                'parents': {path: found[path] for path in DBUS_PARENTS},
                'selinux': found[SELINUX]}
    if name == 'dbus-daemon-proc':
        return dbus_proc(sections, root)
    if name == 'pk-binaries':
        return each(ITEMS[name], lambda path: capture.file_record(path, False, root))
    if name == 'pk-processes':
        return processes(root)
    if name == 'dsh-state':
        return each(ITEMS[name], lambda path: tree(path, root))
    if name == 'needrestart-config':
        found = each(ITEMS[name], lambda path: single(path, root) if path in NEEDRESTART_FILES else
                     listing(path, root) if path in NEEDRESTART_DIRS else names_only(path, root))
        return {'files': {path: found[path] for path in NEEDRESTART_FILES},
                'dirs': {path: found[path] for path in NEEDRESTART_DIRS}, 'names': found[NEEDRESTART]}
    if name == 'dbus-session-config':
        found = each(ITEMS[name], lambda path: single(path, root) if path in SESSION_CONFIG_FILES else listing(path, root))
        return {'files': {path: found[path] for path in SESSION_CONFIG_FILES},
                'dirs': {path: found[path] for path in SESSION_CONFIG_DIRS}}
    if name == 'user-manager':
        linger, run_user, users = USER_MANAGER
        found = each(ITEMS[name], lambda path: entry(path, root) if path == run_user else names_only(path, root))
        return {'linger': found[linger], 'run_user_0': found[run_user], 'users': found[users]}
    raise KeyError(name)


def tree(path, root, maximum=1024):
    """Names, types, sizes and link targets to depth 1, never a body (deb-systemd-helper state)."""
    try:
        fd = open_dir(path, root)
    except FileNotFoundError:
        return {'absent': True}
    try:
        before = os.fstat(fd)
        entries = universe_dir(fd, path, None, {'entries': maximum}, None, [0], 0)
        capture.same(before, os.fstat(fd))
        return {**meta(before), 'entries': entries}
    finally:
        os.close(fd)


def observe(root='/', runner=None):
    """Raw sections in the collector's shape, read in the collector's order."""
    sections = {}
    for name in SECTION_NAMES:
        sections[name] = operation(lambda name=name: read(name, sections, root, runner))
    return sections


def raw_from_sections(sections):
    """The validator's raw view of a format-3 document: the same section records."""
    return {name: sections.get(name, {'state': 'not_reached'}) for name in SECTION_NAMES}


def discovery(raw):
    """True unless THIS module, from the document's own package and manager sections, selects a
    profile with an index, and both the universe and md5sums sections were collected for exactly
    that profile in full mode. A document's own `mode` is never trusted on its own: a document
    collected under another module version can never yield policy inputs (D18)."""
    profile_id, index, _caps = scope(raw)
    universe = raw.get('unit-universe', {}).get('value', {})
    sums = raw.get('dpkg-md5sums', {}).get('value', {})
    return (index is None or universe.get('mode') != 'full' or sums.get('mode') != 'full'
            or universe.get('profile') != profile_id)


def reread_projection(name, value):
    if name == 'dbus-daemon-proc':
        return {key: value[key] for key in ('pid', 'cmdline', 'exe')}
    return value


# ---------------------------------------------------------------- schemas

def is_int(value, low=0, high=2**64):
    return type(value) is int and low <= value <= high


def check_meta(value):
    need(isinstance(value, dict))
    need(all(is_int(value.get(key), 0, 2**32 - 1) for key in ('uid', 'gid')))
    need(is_int(value.get('mode'), 0, 0o7777))


def check_blob(value, cap):
    need(isinstance(value, dict) and set(value) == {'base64', 'bytes', 'sha256'})
    need(is_int(value['bytes'], 0, cap) and isinstance(value['base64'], str)
         and len(value['base64']) <= 4 * ((cap + 2) // 3))
    try:
        data = base64.b64decode(value['base64'], validate=True)
    except binascii.Error:
        raise ValueError('PACKAGEKIT_SCHEMA') from None
    need(len(data) == value['bytes'] and digest(data) == value['sha256'])
    return data


def check_text(value, limit=4096):
    need(isinstance(value, str) and 0 < len(value) <= limit and '\0' not in value)


def check_name(name):
    need(isinstance(name, str) and 0 < len(name) <= 255 and '/' not in name and '\0' not in name
         and name not in ('.', '..'))


TYPES = ('absent', 'link', 'regular', 'directory', 'char', 'socket', 'other')


def check_entry(value, path):
    """`parents` is the root plus every component of the parent path, all of them for a
    present entry: dropping one would silently drop an ownership check."""
    depth = len(PurePosixPath(path).parent.parts)
    need(isinstance(value, dict) and value.get('type') in TYPES and isinstance(value.get('parents'), list)
         and len(value['parents']) <= depth and (value['type'] == 'absent' or len(value['parents']) == depth))
    for item in value['parents']:
        need(isinstance(item, dict) and set(item) == {'uid', 'gid', 'mode'})
        check_meta(item)
    if value['type'] == 'absent':
        need(set(value) == {'type', 'parents'})
        return
    extra = {'link': {'target'}, 'regular': {'bytes', 'nlink'}, 'char': {'rdev'}}.get(value['type'], set())
    need(set(value) == {'type', 'uid', 'gid', 'mode', 'ctime_ns', 'identity', 'parents'} | extra)
    check_meta(value)
    need(is_int(value['ctime_ns'], 0, 2**63) and isinstance(value['identity'], list) and len(value['identity']) == 2
         and all(is_int(i) for i in value['identity']))
    if 'target' in value:
        check_text(value['target'])
    if 'bytes' in value:
        need(is_int(value['bytes']) and is_int(value['nlink'], 1, 2**32))
    if 'rdev' in value:
        need(isinstance(value['rdev'], list) and len(value['rdev']) == 2 and all(is_int(i, 0, 2**32) for i in value['rdev']))


def check_member(value, cap=128 * 1024):
    need(isinstance(value, dict) and value.get('type') in TYPES[1:])
    extra = {'regular': {'body'}, 'link': {'target'}}.get(value['type'], set())
    need(set(value) == {'type', 'uid', 'gid', 'mode', 'ctime_ns'} | extra)
    check_meta(value)
    need(is_int(value['ctime_ns'], 0, 2**63))
    if 'body' in value:
        check_blob(value['body'], cap)
    if 'target' in value:
        check_text(value['target'])


def check_listing(value, maximum=128):
    need(isinstance(value, dict))
    if set(value) == {'absent'}:
        need(value['absent'] is True)
        return
    need(set(value) == {'uid', 'gid', 'mode', 'ctime_ns', 'members'})
    check_meta(value)
    need(is_int(value['ctime_ns'], 0, 2**63) and isinstance(value['members'], dict) and len(value['members']) <= maximum)
    for name, item in value['members'].items():
        check_name(name)
        check_member(item)


def check_file_record(value, body):
    need(isinstance(value, dict))
    if set(value) == {'absent'}:
        need(value['absent'] is True)
        return
    need(set(value) == {'uid', 'gid', 'mode', 'bytes', 'sha256'} | ({'body'} if body else set()))
    check_meta(value)
    need(is_int(value['bytes'], 0, capture.LIMIT) and isinstance(value['sha256'], str)
         and re.fullmatch('[a-f0-9]{64}', value['sha256']))
    if body:
        data = check_blob(value['body'], capture.BODY_LIMIT)
        need(digest(data) == value['sha256'] and len(data) == value['bytes'])


def check_command(value, name):
    need(isinstance(value, dict) and set(value) == {'argv', 'stdout', 'stderr', 'returncode', 'failure'})
    need(value['argv'] == COMMANDS[name] and value['failure'] is None)
    need(value['returncode'] is None or type(value['returncode']) is int)
    check_blob(value['stdout'], OUTPUT_LIMITS[name])
    check_blob(value['stderr'], OUTPUT_LIMITS[name])


def check_universe_entries(entries, depth, mode):
    need(isinstance(entries, dict))
    for name, item in entries.items():
        check_name(name)
        need(isinstance(item, dict) and item.get('type') in TYPES[1:])
        keys = {'type'}
        if item['type'] == 'link':
            keys |= {'target'}
            check_text(item['target'])
        elif item['type'] == 'regular':
            keys |= {'bytes'} | ({'sha256', 'md5'} if 'sha256' in item else {'body'} if mode == 'full' else set())
            need(is_int(item['bytes']))
            if 'sha256' in item:
                need(isinstance(item['sha256'], str) and re.fullmatch('[a-f0-9]{64}', item['sha256'])
                     and isinstance(item['md5'], str) and re.fullmatch('[a-f0-9]{32}', item['md5']))
            if 'body' in item:
                need(len(check_blob(item['body'], UNIVERSE_BODY_LIMIT)) == item['bytes'])
        elif item['type'] == 'directory' and depth == 0:
            keys |= {'entries'}
            check_universe_entries(item['entries'], 1, mode)
        need(set(item) == keys)


def check_names(value):
    need(isinstance(value, dict) and (value == {'absent': True} or (
        set(value) == {'names'} and isinstance(value['names'], list) and len(value['names']) <= 256
        and all(check_name(n) is None for n in value['names']) and value['names'] == sorted(set(value['names'])))))


def check_files_and_dirs(value, files, dirs):
    need(isinstance(value['files'], dict) and set(value['files']) == set(files)
         and isinstance(value['dirs'], dict) and set(value['dirs']) == set(dirs))
    for item in value['files'].values():
        need(isinstance(item, dict))
        if set(item) == {'absent'}:
            need(item['absent'] is True)
        else:
            check_member(item)
    for item in value['dirs'].values():
        check_listing(item)


def check(name, value):
    """Strict schema of one raw section value; raises ValueError."""
    if name in COMMANDS:
        check_command(value, name)
    elif name.startswith('link:') or name in ('dir-meta:/var', 'device:/dev/null'):
        check_entry(value, name.split(':', 1)[1])
    elif name == 'dbus-socket':
        need(value in ({'exists': False, 'socket': False}, {'exists': True, 'socket': True})
             and all(type(i) is bool for i in value.values()))
    elif name == 'unit-candidates':
        need(isinstance(value, dict) and set(value) == {'roots', 'system_update'})
        need(isinstance(value['roots'], dict) and set(value['roots']) == set(REVIEWED['unit_roots']))
        for item in value['roots'].values():
            need(isinstance(item, dict))
            if set(item) == {'absent'}:
                need(item['absent'] is True)
                continue
            need(set(item) == {'entries'} and isinstance(item['entries'], dict) and set(item['entries']) == set(CANDIDATES))
            for found in item['entries'].values():
                need(isinstance(found, dict) and found.get('type') in TYPES)
                need(set(found) == ({'type', 'target'} if found['type'] == 'link' else {'type'}))
                if 'target' in found:
                    check_text(found['target'])
        need(isinstance(value['system_update'], dict) and set(value['system_update']) == set(SYSTEM_UPDATE)
             and all(isinstance(i, dict) and set(i) == {'type'} and i['type'] in TYPES for i in value['system_update'].values()))
    elif name == 'unit-universe':
        # Which mode a host should have is decided in normalize, never by refusing a document.
        need(isinstance(value, dict) and set(value) == {'mode', 'profile', 'roots'} and value['mode'] in ('discovery', 'full'))
        mode = value['mode']
        need(value['profile'] is None or (isinstance(value['profile'], str) and 0 < len(value['profile']) <= 128))
        need(isinstance(value['roots'], dict) and set(value['roots']) == {*REVIEWED['unit_roots'], *USER_ROOTS})
        for path, item in value['roots'].items():
            need(isinstance(item, dict))
            if set(item) == {'absent'}:
                need(item['absent'] is True)
                continue
            if set(item) == {'link', 'target'}:
                check_text(item['link'])
                check_text(item['target'])
                need(item['link'] == path or path.startswith(item['link'] + '/'))
                continue
            need(set(item) == {'uid', 'gid', 'mode', 'entries'})
            check_meta(item)
            check_universe_entries(item['entries'], 0, mode)
    elif name == 'dpkg-md5sums':
        need(isinstance(value, dict) and value.get('mode') in ('discovery', 'full'))
        discovery_mode = value['mode'] == 'discovery'
        need(set(value) == ({'mode', 'files', 'scanned', 'bytes', 'digest'} if discovery_mode else {'mode', 'files'})
             and isinstance(value['files'], dict))
        if discovery_mode:
            limits = MD5SUMS_DISCOVERY
            need(is_int(value['scanned'], 0, limits['files']) and is_int(value['bytes'], 0, limits['bytes'])
                 and len(value['files']) <= value['scanned'] and isinstance(value['digest'], str)
                 and re.fullmatch('[a-f0-9]{64}', value['digest']))
        for file_name, item in value['files'].items():
            check_name(file_name)
            need(not discovery_mode or file_name.endswith('.md5sums'))
            need(isinstance(item, dict) and set(item) == {'sha256', 'lines'} and isinstance(item['lines'], dict))
            need(isinstance(item['sha256'], str) and re.fullmatch('[a-f0-9]{64}', item['sha256']))
            need(not discovery_mode or item['lines'])
            for path, value_md5 in item['lines'].items():
                check_text(path)
                need(not discovery_mode or path.startswith(MD5SUMS_PREFIXES))
                need(isinstance(value_md5, str) and re.fullmatch('[a-f0-9]{32}', value_md5))
        need(not discovery_mode or sum(len(item['lines']) for item in value['files'].values())
             <= MD5SUMS_DISCOVERY['lines'])
    elif name == 'pk-fragments':
        need(isinstance(value, dict) and set(value) == set(PK_FRAGMENTS))
        for item in value.values():
            check_file_record(item, True)
    elif name == 'pk-binaries':
        need(isinstance(value, dict) and set(value) == set(C12_FILES))
        for item in value.values():
            check_file_record(item, False)
    elif name == 'dbus-service-dirs':
        need(isinstance(value, dict) and set(value) == {'system', 'session'})
        need(set(value['system']) == set(SERVICE_DIRS) and set(value['session']) == set(SESSION_DIRS))
        for item in (*value['system'].values(), *value['session'].values()):
            check_listing(item)
    elif name == 'dbus-config':
        need(isinstance(value, dict) and set(value) == {'files', 'dirs', 'parents', 'selinux'})
        need(isinstance(value['parents'], dict) and set(value['parents']) == set(DBUS_PARENTS))
        for path, item in value['parents'].items():
            check_entry(item, path)
        need(set(value['files']) == set(CONFIG_FILES) and set(value['dirs']) == set(CONFIG_DIRS))
        for item in value['files'].values():
            need(isinstance(item, dict))
            if set(item) == {'absent'}:
                need(item['absent'] is True)
            else:
                check_member(item)
        for item in value['dirs'].values():
            check_listing(item)
        selinux = value['selinux']
        need(isinstance(selinux, dict) and (selinux == {'absent': True} or (set(selinux) == {'names'} and isinstance(selinux['names'], list)
             and len(selinux['names']) <= 256 and all(check_name(n) is None for n in selinux['names']))))
    elif name == 'dbus-daemon-proc':
        need(isinstance(value, dict) and set(value) == {'pid', 'cmdline', 'exe', 'start_ticks', 'socket_inodes',
             'unix_rows', 'unix_path_rows', 'btime', 'boot_id', 'clk_tck', 'wall_ns', 'kernel', 'socket_identity'})
        need(is_int(value['pid'], 1, 2**32) and is_int(value['start_ticks']) and is_int(value['clk_tck'], 1, 10**6)
             and is_int(value['wall_ns'], 0, 2**63) and is_int(value['unix_path_rows']))
        check_blob(value['cmdline'], 4096)
        check_text(value['exe'])
        check_text(value['kernel'], 256)
        need(isinstance(value['boot_id'], str) and re.fullmatch('[0-9a-f-]{36}', value['boot_id']))
        need(isinstance(value['btime'], list) and len(value['btime']) == 2 and all(is_int(b) for b in value['btime']))
        need(isinstance(value['socket_inodes'], list) and len(value['socket_inodes']) <= 256
             and all(is_int(i) for i in value['socket_inodes']) and value['socket_inodes'] == sorted(set(value['socket_inodes'])))
        need(isinstance(value['unix_rows'], list) and len(value['unix_rows']) <= 64)
        for row in value['unix_rows']:
            need(isinstance(row, dict) and set(row) == {'flags', 'type', 'state', 'inode'} and is_int(row['inode'])
                 and all(isinstance(row[k], str) and re.fullmatch('[0-9A-Fa-f]{1,8}', row[k]) for k in ('flags', 'type', 'state')))
        need(value['socket_identity'] is None or (isinstance(value['socket_identity'], list) and len(value['socket_identity']) == 2
             and all(is_int(i) for i in value['socket_identity'])))
    elif name == 'pk-processes':
        need(isinstance(value, list) and len(value) <= 64)
        for item in value:
            need(isinstance(item, dict) and set(item) == {'pid', 'comm', 'start_ticks'} and is_int(item['pid'], 1, 2**32)
                 and is_int(item['start_ticks']) and isinstance(item['comm'], str) and len(item['comm']) <= 64)
    elif name == 'dsh-state':
        need(isinstance(value, dict) and set(value) == set(DSH_DIRS))
        for item in value.values():
            need(isinstance(item, dict))
            if set(item) == {'absent'}:
                need(item['absent'] is True)
                continue
            need(set(item) == {'uid', 'gid', 'mode', 'entries'})
            check_meta(item)
            check_universe_entries(item['entries'], 0, 'discovery')
            need(sum(1 + len(i.get('entries', ())) for i in item['entries'].values()) <= 1024)
    elif name == 'needrestart-config':
        need(isinstance(value, dict) and set(value) == {'files', 'dirs', 'names'})
        check_files_and_dirs(value, NEEDRESTART_FILES, NEEDRESTART_DIRS)
        check_names(value['names'])
    elif name == 'dbus-session-config':
        need(isinstance(value, dict) and set(value) == {'files', 'dirs'})
        check_files_and_dirs(value, SESSION_CONFIG_FILES, SESSION_CONFIG_DIRS)
    elif name == 'user-manager':
        need(isinstance(value, dict) and set(value) == {'linger', 'run_user_0', 'users'})
        check_names(value['linger'])
        check_names(value['users'])
        check_entry(value['run_user_0'], USER_MANAGER[1])
    else:
        raise ValueError('PACKAGEKIT_SCHEMA')


# ---------------------------------------------------------------- normalize

def section_value(raw, name):
    section = raw.get(name) if isinstance(raw, dict) else None
    if not isinstance(section, dict) or section.get('state') != 'ok' or set(section) != {'state', 'value'}:
        raise Unavailable(name)
    check(name, section['value'])
    return section['value']


def stdout(record):
    if record['returncode'] != 0 or record['failure'] is not None or record['stderr']['bytes'] != 0:
        raise Unavailable('command')
    return check_blob(record['stdout'], 1 << 30)


def parse_units(data):
    blocks, current = [], {}
    for line in data.decode('utf-8').split('\n'):
        if line == '':
            if current:
                blocks.append(current)
                current = {}
            continue
        key, separator, value = line.partition('=')
        need(separator and key in UNIT_PROPERTIES + SERVICE_PROPERTIES and key not in current)
        current[key] = value
    if current:
        blocks.append(current)
    units = {}
    for block in blocks:
        required = set(UNIT_PROPERTIES) | (set(SERVICE_PROPERTIES) if block.get('Id', '').endswith('.service') else set())
        need(required <= set(block) and block['Id'] in PK_UNITS and block['Id'] not in units)
        units[block['Id']] = block
    need(set(units) == set(PK_UNITS))
    return units


def parse_manager(data):
    fields = {}
    for line in data.decode('utf-8').splitlines():
        key, separator, value = line.partition('=')
        need(separator and key in ('UnitPath', 'Version') and key not in fields)
        fields[key] = value
    need(set(fields) == {'UnitPath', 'Version'})
    return {'unit_path': fields['UnitPath'].split(), 'version': fields['Version']}


def parse_packages(data):
    rows = []
    for line in data.decode('utf-8').splitlines():
        fields = line.split('\t')
        need(len(fields) == 5 and fields[0])
        if fields[4] != 'not-installed':
            rows.append(fields)
    need(len({row[0] for row in rows}) == len(rows))
    return sorted(rows)


def select_profile(rows, version):
    """The one reviewed profile whose code identity equals this host's: its dpkg rows without
    kernel images, and the manager Version. None for no match or an ambiguous one."""
    code_rows = [row for row in rows if not row[0].startswith('linux-image-')]
    matches = [profile for profile in REVIEWED['profiles'] if profile['code']['manager_version'] == version
               and [list(row) for row in profile['code']['rows']] == code_rows]
    return matches[0] if len(matches) == 1 else None


def selected(sections):
    try:
        rows = parse_packages(stdout(section_value(sections, 'pk-package-metadata')))
        version = parse_manager(stdout(section_value(sections, 'manager')))['version']
    except (Unavailable, ValueError, KeyError, TypeError, UnicodeError):
        return None
    return select_profile(rows, version)


def parse_service(data):
    """dbus desktop-file shape of one service file: groups, key counts, two values."""
    try:
        text = data.decode('utf-8')
    except UnicodeError:
        return None
    groups, counts, values, malformed = [], {}, {}, False
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('[') and line.endswith(']'):
            groups.append(line[1:-1])
            continue
        key, separator, value = line.partition('=')
        if not separator or not groups:
            malformed = True
            continue
        key = key.strip()
        counts[key] = counts.get(key, 0) + 1
        values.setdefault(key, value.strip())
    return {'groups': groups, 'keys': dict(sorted(counts.items())), 'malformed': malformed,
            'name': values.get('Name'), 'systemd_service': values.get('SystemdService')}


def part(function):
    """A normalized component, or None when any of its inputs is unavailable."""
    try:
        return function()
    except (Unavailable, ValueError, KeyError, TypeError, IndexError, AttributeError, UnicodeError):
        return None


def compact(value):
    """Boot-invariant view of an entry: no ctime or inode identity."""
    return {key: item for key, item in value.items() if key not in ('ctime_ns', 'identity')}


def scanned(item):
    if item['type'] != 'regular':
        return {'type': item['type']}
    data = check_blob(item['body'], 1 << 30)
    return {'type': 'regular', 'sha256': digest(data), 'declares': b'packagekit' in data.lower(),
            'risky': RISKY_TAGS.search(data) is not None}


def dir_view(value):
    if value.get('absent'):
        return {'absent': True}
    return {**{k: value[k] for k in ('uid', 'gid', 'mode')},
            'members': {name: scanned(item) for name, item in value['members'].items()}}


def ctimes(value):
    """Every C15 P path of a listing: the directory and each member."""
    if value.get('absent'):
        return []
    return [value['ctime_ns'], *(item['ctime_ns'] for item in value['members'].values())]


def config_servicedirs(config):
    """Every `<servicedir>` value in the C9 chain as sorted [file, value] pairs; ValueError when a
    body declares one in any other form or declares an entity."""
    bodies = [(path, item) for path, item in config['files'].items() if not item.get('absent')]
    bodies += [(directory + '/' + name, item) for directory, value in config['dirs'].items()
               if not value.get('absent') for name, item in value['members'].items()]
    found = []
    for path, item in bodies:
        if item['type'] != 'regular':
            continue  # not read by this rule; C9.file / C9.dir give None for it
        data = check_blob(item['body'], 1 << 30)
        # expat auto-detects UTF-16 (with or without a BOM) even under dbus' UTF-8 protocol encoding;
        # any such body has a NUL byte, and these byte patterns would not see its declarations.
        if b'\0' in data:
            raise ValueError('UNPARSED_SERVICEDIR')
        values = SERVICEDIR.findall(data)
        if len(SERVICEDIR_OPEN.findall(data)) != len(values) or ENTITY_DECL.search(data):
            raise ValueError('UNPARSED_SERVICEDIR')
        found += [[path, value.decode('utf-8')] for value in values]
    return sorted(found)


def servicedirs_ok(found):
    """C9.servicedirs: snapd's include is the only declaration, of exactly SNAPD_SERVICE_DIR. This
    holds whatever a profile pins: no reviewed hash can admit another servicedir."""
    if found is None:
        raise TypeError('not established')
    return all(path == SNAPD_INCLUDE and value in (SNAPD_SERVICE_DIR, SNAPD_SERVICE_DIR + '/') for path, value in found)


def registration(services):
    directory = services['system']['/usr/share/dbus-1/system-services']
    item = None if directory.get('absent') else directory['members'].get(PurePosixPath(REGISTRATION).name)
    if item is None:
        return {'present': False}
    if item['type'] != 'regular':
        return {'present': True, 'type': item['type']}
    data = check_blob(item['body'], 1 << 30)
    return {'present': True, 'type': 'regular', 'uid': item['uid'], 'gid': item['gid'], 'mode': item['mode'],
            'sha256': digest(data), 'parsed': parse_service(data)}


def listeners(rows):
    """The one listener definition (G4): ACCEPTCON set and state 01, for C10 and continuity."""
    return [row for row in rows if int(row['flags'], 16) & SO_ACCEPTCON and row['state'] == '01']


def proc_view(raw, units):
    proc = section_value(raw, 'dbus-daemon-proc')
    need(str(proc['pid']) == units['dbus.service']['MainPID'])
    argv = check_blob(proc['cmdline'], 4096).split(b'\0')
    bound = listeners(proc['unix_rows'])
    services, config = section_value(raw, 'dbus-service-dirs'), section_value(raw, 'dbus-config')
    stamps = [stamp for value in services['system'].values() for stamp in ctimes(value)]
    stamps += [item['ctime_ns'] for item in config['files'].values() if not item.get('absent')]
    stamps += [stamp for value in config['dirs'].values() for stamp in ctimes(value)]
    stamps += [item['ctime_ns'] for item in config['parents'].values() if item['type'] != 'absent']
    return {'argv_system': b'--system' in argv, 'argv_systemd_activation': b'--systemd-activation' in argv,
            'exe_reviewed': proc['exe'] == DBUS_EXE,
            'listener_is_dbus': (len(proc['unix_rows']) == 1 and len(bound) == 1
                                 and bound[0]['inode'] in proc['socket_inodes']),
            'cache_consistent': ctime_rule(proc, units['dbus.service'], stamps), 'kernel': proc['kernel'],
            'clk_tck': proc['clk_tck']}


def ctime_rule(proc, dbus, stamps):
    """C15 ctime rule (O13 ctime_rule, O15 time base, security H2). True only when every P
    ctime is at or before both dbus start times minus 2 s, no ctime lies in the future
    and btime did not step within this observation; anything else is not established."""
    first, second = proc['btime']
    if abs(first - second) > 1:
        return False
    start_ns = first * 10**9 + proc['start_ticks'] * 10**9 // proc['clk_tck']
    match = re.fullmatch('@([0-9]{1,12})', dbus['ExecMainStartTimestamp'])
    if match is None or not stamps:
        return False
    limit = min(start_ns, int(match.group(1)) * 10**9) - CTIME_MARGIN_NS
    return all(stamp <= limit and stamp <= proc['wall_ns'] for stamp in stamps)


def unit_view(block):
    keep = ('Id', 'Names', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState', 'FragmentPath',
            'DropInPaths', 'NeedDaemonReload')
    return {**{key: block[key] for key in keep}, 'job_empty': block['Job'] == '',
            'main_pid_zero': block['MainPID'] == '0' if 'MainPID' in block else None}


def normalize(raw):
    """Boot-invariant values plus derived booleans. Drops PIDs, invocation IDs, timestamps,
    start ticks and inode numbers (they are in `volatile`)."""
    blocks = part(lambda: parse_units(stdout(section_value(raw, 'pk-units'))))
    services = part(lambda: section_value(raw, 'dbus-service-dirs'))
    config = part(lambda: section_value(raw, 'dbus-config'))
    candidates_value = part(lambda: section_value(raw, 'unit-candidates'))
    core = {
        'registration': part(lambda: registration(services)),
        'lib': part(lambda: compact(section_value(raw, 'link:/lib'))),
        'service_dirs': part(lambda: {path: dir_view(value) for path, value in services['system'].items()}),
        'mask_link': part(lambda: compact(section_value(raw, 'link:' + MASK_PATH))),
        'dev_null': part(lambda: compact(section_value(raw, 'device:/dev/null'))),
        'candidates': part(lambda: candidates_value['roots']),
        'system_update': part(lambda: candidates_value['system_update']),
        'manager': part(lambda: parse_manager(stdout(section_value(raw, 'manager')))),
        'units': part(lambda: {name: unit_view(block) for name, block in blocks.items()}),
        'fragments': part(lambda: {path: fragment_view(value) for path, value in section_value(raw, 'pk-fragments').items()}),
        'config': part(lambda: {'files': {path: ({'absent': True} if item.get('absent') else scanned(item))
                                          for path, item in config['files'].items()},
                                'dirs': {path: dir_view(value) for path, value in config['dirs'].items()},
                                'selinux': config['selinux']}),
        'config_servicedirs': part(lambda: config_servicedirs(config)),
        'dbus_parents': part(lambda: {path: compact(item) for path, item in config['parents'].items()}),
        'evidence': part(lambda: all(section_value(raw, name) is not None for name in EVIDENCE_SECTIONS) or None),
        'dbus_proc': part(lambda: proc_view(raw, blocks)),
        'var': part(lambda: compact(section_value(raw, 'dir-meta:/var'))),
        'var_run': part(lambda: compact(section_value(raw, 'link:/var/run'))),
        'socket': part(lambda: section_value(raw, 'dbus-socket')),
        'pk_process_absent': part(lambda: section_value(raw, 'pk-processes') == []),
        'packages': part(lambda: parse_packages(stdout(section_value(raw, 'pk-package-metadata')))),
        'binaries': part(lambda: dict(section_value(raw, 'pk-binaries'))),
    }
    profile = selected(raw)
    core['profile_id'] = profile['id'] if profile is not None else None
    universe_value = part(lambda: section_value(raw, 'unit-universe'))
    verdict, digest_value = part(lambda: c13(universe_value, section_value(raw, 'dpkg-md5sums'), services,
                                             core['lib'], profile)) or (None, None)
    return {'proof_id': REVIEWED['proof_id'], 'pk_core': core, 'c13_verdict': verdict,
            'unit_universe_digest': digest_value, 'unit_universe': universe_value}


def fragment_view(value):
    if value.get('absent'):
        return {'absent': True}
    data = check_blob(value['body'], capture.BODY_LIMIT)
    starts = [line.strip()[len('ExecStart='):] for line in data.decode('utf-8').splitlines()
              if line.strip().startswith('ExecStart=')]
    return {**{k: value[k] for k in ('uid', 'gid', 'mode', 'sha256')},
            'exec_start_systemd_activation': bool(starts) and all('--systemd-activation' in s.split() for s in starts)}


def facts_view(norm):
    """What installer facts and the validator bind: never the full universe (QA M1)."""
    return {key: norm[key] for key in ('proof_id', 'pk_core', 'c13_verdict', 'unit_universe_digest')}


# ---------------------------------------------------------------- C13

def stable_projection(universe_value):
    """Digest scope (QA M1): admin and package roots only; /run roots, root's runtime
    dirs and snap-generated units differ between collection and install boots. The C13
    verdict still covers every root."""
    def project(item):
        value = {'type': item['type']}
        for key in ('target', 'bytes', 'sha256'):
            if key in item:
                value[key] = item[key]
        if 'body' in item:
            value['sha256'] = item['body']['sha256']
        if 'entries' in item:
            value['entries'] = {n: project(i) for n, i in item['entries'].items() if not VOLATILE_NAME.match(n)}
        return value
    return {root: ({'absent': True} if value.get('absent') else
                   {'link': value['link'], 'target': value['target']} if 'link' in value else
                   {'entries': {n: project(i) for n, i in value['entries'].items() if not VOLATILE_NAME.match(n)}})
            for root, value in universe_value['roots'].items() if not root.startswith('/run/')}


def root_covered(root, value, roots):
    """False when a root is itself a link whose target is another scanned, non-volatile root (that scan
    covers it); None otherwise. `..` is resolved only as a leading run, which climbs the link's own parent
    chain that root_link walked without following anything; a `..` after a named component would be
    resolved by the kernel through that component, possibly another link, so it is not classifiable."""
    if value['link'] != root:
        return None
    target = PurePosixPath(value['target'])
    parts = list(target.parts[1:] if target.is_absolute() else target.parts)  # pathlib drops '.' and '//'
    base = [] if target.is_absolute() else list(PurePosixPath(root).parent.parts[1:])
    while parts and parts[0] == '..':
        base, parts = base[:-1], parts[1:]
    if '..' in parts:
        return None
    resolved = '/' + '/'.join(base + parts)
    other = roots.get(resolved)
    if resolved.startswith('/run/') or other is None or 'entries' not in other:  # a link record has no entries
        return None
    if (root in USER_ROOTS) != (resolved in USER_ROOTS):
        return None  # another manager reads the target: a system unit is not cleared for root's user manager
    return False


def c13(universe_value, sums, services, lib, profile):
    """Other activators (O12, H1). True: a candidate activator; None: not classifiable."""
    digest_value = digest(encoded(stable_projection(universe_value)))
    if universe_value['mode'] == 'discovery':
        return None, digest_value
    allow = profile['allow'] if profile is not None else None
    if (allow is None or allow['unit_index'] is None or universe_value['profile'] != profile['id']
            or sums.get('mode') != 'full'):
        return None, digest_value  # collected for another profile than the one this host selects
    index = allow['unit_index']
    md5 = {path: value for item in sums['files'].values() for path, value in item['lines'].items()}
    known = set()
    for root, value in universe_value['roots'].items():
        if 'entries' in value:
            for name, item in value['entries'].items():
                known.add(root + '/' + name)
                for sub in item.get('entries', {}):
                    known.add(root + '/' + name + '/' + sub)
    results = []
    for root, value in universe_value['roots'].items():
        if value.get('absent'):
            continue
        if 'link' in value:
            results.append(root_covered(root, value, universe_value['roots']))
            continue
        for name, item in value['entries'].items():
            path = root + '/' + name
            if item['type'] == 'directory':
                if 'entries' not in item:
                    results.append(None)
                    continue
                for sub, child in item['entries'].items():
                    results.append(None if child['type'] == 'directory'
                                   else classify(path + '/' + sub, child, allow, md5, known, lib))
            else:
                results.append(classify(path, item, allow, md5, known, lib))
    for value in services['session'].values():
        if not value.get('absent'):
            for item in value['members'].values():
                results.append(scanned(item)['declares'] if item['type'] == 'regular' else None)
    if True in results:
        return True, digest_value
    return (None if None in results else False), digest_value


def classify(path, item, allow, md5, known, lib):
    """False: not an activator; True: a PackageKit activator; None: not classifiable."""
    if item['type'] == 'link':
        name = PurePosixPath(path).name
        target = item['target']
        if target == '/dev/null':
            return False
        resolved = resolve_link(path, target, allow, known, lib)
        # A reviewed link (owner K1, e.g. the packaged system-update.target.wants offline-update
        # link) is cleared only when its target is a file this scan read and the reviewed index
        # binds its bytes; any other value falls through to the rules below.
        # Never for a link carrying one of PackageKit's own unit names (security P3-2): those stay activators.
        if (allow['link_targets'].get(path) == target and resolved is not None and resolved in known
                and resolved in allow['unit_index'] and name not in C5_NAMES + C14_NAMES
                and not name.startswith('packagekit@')):
            return False
        if path != MASK_PATH and ('packagekit' in target.lower() or 'packagekit' in name.lower()):
            return True
        return False if resolved is not None and resolved in known else None
    if item['type'] != 'regular':
        return None
    index = allow['unit_index']
    if path in index:
        reviewed = index[path]
        if reviewed['sha256'] is not None:
            return False if item.get('sha256') == reviewed['sha256'] else None
        listed = md5.get(reviewed['listed'])
        return False if listed is not None and listed == item.get('md5') else None
    data = check_blob(item['body'], allow['caps']['body'])
    if ESCAPES.search(data):
        return None
    try:
        text = data.decode('utf-8')
    except UnicodeError:
        return None
    if 'packagekit' in text.lower().translate(QUOTES) or 'packagekit' in PurePosixPath(path).name.lower():
        return True
    for line in text.replace('\\\n', ' ').splitlines():
        key, separator, value = line.strip().partition('=')
        if separator and key.strip().startswith('Exec') and INDIRECTION.search(value):
            return None  # e.g. %i, $VAR from Environment=, globs or sh -c: not literally checkable
    return False


def resolve_link(path, target, allow, known, lib):
    """The scanned path a unit link names, or None. systemd resolves `..` after following links
    (chase); only `../<name>` from a directory this scan read without following anything cancels
    lexically. /lib/... is rewritten through the reviewed /lib alias only."""
    parts = PurePosixPath(target).parts
    if '..' in parts and not (not target.startswith('/') and len(parts) == 2 and parts[0] == '..'
                              and str(PurePosixPath(path).parent) in known):
        return None
    resolved = str(PurePosixPath(os.path.normpath(target if target.startswith('/')
                                                  else str(PurePosixPath(path).parent / target))))
    if lib is not None and lib.get('type') == 'link' and allow['lib_alias'] is not None \
            and lib.get('target') == allow['lib_alias'] and resolved.startswith('/lib/'):
        resolved = '/usr' + resolved
    return resolved


# ---------------------------------------------------------------- evaluate

def owner_ok(value):
    return (value['uid'], value['gid']) == OWNER


def safe_dir(value):
    return owner_ok(value) and not value['mode'] & 0o022


def checks(view):
    """Every sub-clause: True holds, False fails, None not established."""
    reviewed, core, result = REVIEWED, view['pk_core'], {}
    profile = select_profile(core['packages'], core['manager']['version']) \
        if core['packages'] is not None and core['manager'] is not None else None
    allow = profile['allow'] if profile is not None else None

    def put(name, function):
        try:
            value = function()
        except (KeyError, TypeError, ValueError, IndexError, AttributeError):
            value = None
        result[name] = value if type(value) is bool else None

    def known(value):
        if value is None:
            raise TypeError('unreviewed')
        return value

    reg = core['registration']
    parsed = (reg or {}).get('parsed')
    put('C1.regular', lambda: reg['type'] == 'regular' or None)
    put('C1.owner', lambda: owner_ok(reg) and reg['mode'] == 0o644)
    put('C1.parsed', lambda: parsed is not None or None)
    put('C1.one-group', lambda: parsed['groups'] == ['D-BUS Service'] and not parsed['malformed'])
    put('C1.keys', lambda: set(parsed['keys']) <= {'Name', 'Exec', 'User', 'SystemdService'}
        and all(count == 1 for count in parsed['keys'].values()))
    put('C1.name', lambda: parsed['keys'].get('Name') == 1 and parsed['name'] == 'org.freedesktop.PackageKit')
    put('C1.systemd-service', lambda: None if parsed['systemd_service'] == '' else
        parsed['keys'].get('SystemdService') == 1 and parsed['systemd_service'] == 'packagekit.service')
    put('C1.reviewed', lambda: reg['sha256'] == reviewed['registration_sha256'] or None)

    lib = core['lib']
    put('C2.lib-alias', lambda: True if lib['type'] == 'absent' else
        (lib['type'] == 'link' and lib['target'] == known(known(allow)['lib_alias'])) or None)
    for path in SERVICE_DIRS:
        def directory(path=path):
            return core['service_dirs'][path]
        put('C2.owner:' + path, lambda d=directory: True if d().get('absent') else safe_dir(d()))
        put('C2.members:' + path, lambda d=directory, p=path: True if d().get('absent') else
            set(d()['members']) <= set(known(known(allow)['service_members'])[p]) or None)
        put('C2.regular:' + path, lambda d=directory: True if d().get('absent') else
            all(item['type'] == 'regular' for item in d()['members'].values()) or None)
        put('C2.no-other-registration:' + path, lambda d=directory, p=path: True if d().get('absent') else
            not any(item.get('declares') for name, item in d()['members'].items() if p + '/' + name != REGISTRATION))
    # Every present service-directory parent (snapd's under /var/lib included) and its chain is root-owned
    # and not group- or world-writable: otherwise a member could be swapped after this read.
    put('C2.parents', lambda: parents_ok(core['dbus_parents'], core['service_dirs']))

    mask = core['mask_link']
    put('C3.link', lambda: mask['type'] == 'link')
    put('C3.target', lambda: mask['target'] == '/dev/null')
    put('C3.owner', lambda: owner_ok(mask))
    put('C3.parents', lambda: all(safe_dir(item) for item in mask['parents']))

    null = core['dev_null']
    put('C4.char', lambda: null['type'] == 'char')
    put('C4.rdev', lambda: tuple(null['rdev']) == tuple(reviewed['dev_null']))
    put('C4.owner', lambda: owner_ok(null) and null['mode'] == 0o666)
    put('C4.parents', lambda: all(safe_dir(item) for item in null['parents']))

    put('C5.unit-path', lambda: tuple(core['manager']['unit_path']) == tuple(reviewed['unit_roots']) or None)
    put('C5.no-override', lambda: all(value.get('absent') or all(
        value['entries'][name]['type'] == 'absent' or root + '/' + name == MASK_PATH
        or (root + '/' + name == VENDOR_FRAGMENT and value['entries'][name]['type'] == 'regular')
        for name in C5_NAMES) for root, value in core['candidates'].items()))

    unit = (core['units'] or {}).get('packagekit.service')
    for key, expected in (('Names', 'packagekit.service'), ('LoadState', 'masked'), ('UnitFileState', 'masked'),
                          ('ActiveState', 'inactive'), ('SubState', 'dead'), ('NeedDaemonReload', 'no'),
                          ('DropInPaths', '')):
        put('C6.' + key, lambda key=key, expected=expected: unit[key] == expected)
    put('C6.main-pid-zero', lambda: unit['main_pid_zero'] is True)
    put('C6.job-empty', lambda: unit['job_empty'] is True)
    put('C6.fragment', lambda: unit['FragmentPath'] == known(known(allow)['masked_fragment_path']))

    dbus = (core['units'] or {}).get('dbus.service')
    fragment = allow['dbus_fragment'] if allow is not None else None
    put('C7.names', lambda: dbus['Names'] == known(known(allow)['dbus_names']) or None)
    put('C7.no-broker', lambda: 'dbus-broker' not in dbus['Names'])
    for key, expected in (('LoadState', 'loaded'), ('ActiveState', 'active'), ('SubState', 'running'),
                          ('NeedDaemonReload', 'no'), ('DropInPaths', '')):
        put('C7.' + key, lambda key=key, expected=expected: dbus[key] == expected)
    put('C7.no-drop-in-dirs', lambda: all(value.get('absent') or (value['entries']['dbus.service.d']['type'] == 'absent')
                                          for value in core['candidates'].values()))
    put('C7.fragment-path', lambda: dbus['FragmentPath'] == known(fragment)['path'] or None)
    put('C7.fragment-hash', lambda: core['fragments'][known(fragment)['path']].get('sha256') == fragment['sha256'] or None)
    put('C7.systemd-activation', lambda: core['fragments'][known(fragment)['path']]['exec_start_systemd_activation'])

    proc = core['dbus_proc']
    put('C8.system', lambda: proc['argv_system'])
    put('C8.systemd-activation', lambda: proc['argv_systemd_activation'])
    put('C8.exe', lambda: proc['exe_reviewed'])

    cfg = core['config']
    # SELinux enabled would add the unreviewed contexts include (design04 notes 2): not established.
    put('C9.selinux', lambda: (cfg['selinux'].get('absent') is True or cfg['selinux'].get('names') == []) or None
        if known(known(allow)['selinux_rule']) == 'selinuxfs-absent-or-empty' else None)
    for path in CONFIG_FILES:
        put('C9.file:' + path, lambda path=path: config_file(cfg['files'][path], path, known(allow),
                                                            required=path == CONFIG_FILES[0]))
    for path in CONFIG_DIRS:
        put('C9.dir:' + path, lambda path=path: config_dir(cfg['dirs'][path], path, known(allow)))
    put('C9.servicedirs', lambda: servicedirs_ok(core['config_servicedirs']))

    put('C10.var', lambda: core['var']['type'] == 'directory' and safe_dir(core['var'])
        and all(safe_dir(item) for item in core['var']['parents']))
    put('C10.var-run', lambda: core['var_run']['type'] == 'link' and owner_ok(core['var_run'])
        and core['var_run']['target'] == known(known(allow)['var_run_target']))
    put('C10.socket', lambda: core['socket'] == {'exists': True, 'socket': True} or None)
    put('C10.listener', lambda: proc['listener_is_dbus'] or None)

    put('C11.no-process', lambda: core['pk_process_absent'])

    put('C12.code', lambda: code_reviewed(core, known(profile)) or None)

    put('C13.other-activators', lambda: {False: True, True: False}.get(view['c13_verdict']))

    put('C14.absent', lambda: all(value.get('absent') or all(value['entries'][name]['type'] == 'absent' for name in C14_NAMES)
                                  for value in core['candidates'].values()))
    put('C14.units', lambda: all(core['units'][name]['LoadState'] == 'not-found'
                                 for name in ('packagekit.socket', 'packagekit.path', 'packagekit.timer')))

    # Only the ctime rule: O13 proved reload_on_lookup fails for this dbus build.
    put('C15.cache', lambda: (proc['cache_consistent'] or None) if reviewed['o13_mode'] == 'ctime_rule' else None)

    put('C16.system-update', lambda: all(item['type'] == 'absent' for item in core['system_update'].values()))

    # The O7/O11/O12 evidence sections are collected and well-formed (no conjunct reads them yet).
    put('G7.evidence', lambda: core['evidence'] is True or None)
    return result


def parents_ok(parents, service_dirs):
    """C2.parents. Every recorded chain is safe, an absent parent's existing ancestors included (whoever can
    write there can create the directory later; QA P1); a present parent is a safe directory; an absent one is
    consistent only when no service directory below it was listed (security P3-5)."""
    if any(not all(safe_dir(i) for i in item['parents'])
           or item['type'] != 'absent' and not (item['type'] == 'directory' and safe_dir(item)) for item in parents.values()):
        return False
    return not any(item['type'] == 'absent' and any(not service_dirs[d].get('absent') for d in SERVICE_DIRS
                                                    if d.startswith(path + '/')) for path, item in parents.items())


def config_file(item, path, reviewed, required):
    if item.get('absent'):
        return None if required else True
    if item['type'] != 'regular':
        return None
    if reviewed['config_files'] is not None and reviewed['config_files'].get(path) == item['sha256']:
        return True
    # The main file declares the chain itself; only an optional file adding chain elements fails.
    return False if item['risky'] and not required else None


def config_dir(value, path, reviewed):
    if value.get('absent'):
        return True
    if not safe_dir(value):
        return False
    results = []
    for name, item in value['members'].items():
        expected = (reviewed['config_members'] or {}).get(path, {}).get(name)
        if item['type'] != 'regular':
            results.append(None)
        elif reviewed['config_members'] is not None and expected == item['sha256']:
            results.append(True)
        else:
            results.append(False if item['risky'] else None)
    if False in results:
        return False
    return None if None in results else True


def profile_errors(reviewed):
    """Shape rules a reviewed profile literal must meet (architect G1/G2, QA P3-A): exact key
    sets, the kernel row naming the kernel, and code identities that are pairwise distinct
    (one profile per code identity; targets sharing one merge their reviewed allowances)."""
    errors, seen = [], set()
    for profile in reviewed['profiles']:
        if set(profile) != {'id', 'code', 'allow'} or set(profile['code']) != set(PROFILE_CODE_KEYS) \
                or set(profile['allow']) != set(PROFILE_ALLOW_KEYS):
            errors.append((profile.get('id'), 'keys'))
            continue
        code = profile['code']
        if list(code['kernel_row'])[:1] != ['linux-image-' + code['kernel']] or set(code['files']) != set(C12_FILES):
            errors.append((profile['id'], 'code'))
        members = profile['allow']['service_members']
        if members is not None and set(members) != set(SERVICE_DIRS):
            errors.append((profile['id'], 'service_members'))
        identity = (code['manager_version'], tuple(tuple(row) for row in code['rows']))
        if identity in seen:
            errors.append((profile['id'], 'duplicate code identity'))
        seen.add(identity)
    return errors


def code_reviewed(core, profile):
    """C12 beyond the selection: the running kernel (security H2) and its package row, and
    every C12 file identity. Other installed kernel images are not code identity."""
    code, kernel = profile['code'], core['dbus_proc']['kernel']
    rows = {row[0]: row for row in core['packages']}
    return (kernel == code['kernel'] and rows.get('linux-image-' + kernel) == list(code['kernel_row'])
            and all(core['binaries'][path] == dict(code['files'][path]) for path in C12_FILES))


def evaluate(view):
    """The only predicate: False | True | None (see the module docstring)."""
    try:
        if view['proof_id'] != REVIEWED['proof_id'] or view['pk_core']['registration'] is None:
            return None
        if view['pk_core']['registration'].get('present') is not True:
            return None  # NOT_C_BASELINE (D2)
        if REVIEWED['o10_ok'] is not True or REVIEWED['o13_mode'] != 'ctime_rule':
            return None  # forced None on an undischarged obligation (G7)
        results = checks(view)
    except (KeyError, TypeError, AttributeError):
        return None
    if False in results.values():
        return True
    return None if None in results.values() else False


# ---------------------------------------------------------------- continuity and event binding

VOLATILE_UNIT = ('MainPID', 'Job', 'InvocationID', 'NRestarts', 'InactiveExitTimestampMonotonic',
                 'ActiveEnterTimestampMonotonic', 'ActiveExitTimestampMonotonic',
                 'InactiveEnterTimestampMonotonic', 'ExecMainStartTimestamp')


def volatile(raw):
    """Exactly the dropped values continuity needs (design03 2.6); raises when unavailable."""
    units = parse_units(stdout(section_value(raw, 'pk-units')))
    proc = section_value(raw, 'dbus-daemon-proc')
    return {'packagekit': {key: units['packagekit.service'][key] for key in VOLATILE_UNIT},
            'dbus_main_pid': units['dbus.service']['MainPID'],
            'listener_inodes': [row['inode'] for row in listeners(proc['unix_rows'])],
            'socket_identity': proc['socket_identity'], 'boot_id': proc['boot_id'], 'btime': proc['btime'][0],
            'dbus_start_ticks': proc['start_ticks']}


MASK_INVARIANTS_V1 = ('mask_link', 'dev_null', 'candidates', 'unit', 'trigger_units')
# v1's own literals (design03 2.2 N2): later edits of UNIT_ROOTS, CANDIDATES or the readers'
# output keys must never change the bytes of a recorded v1 projection.
V1_ROOTS = ('/etc/systemd/system.control', '/run/systemd/system.control', '/run/systemd/transient',
            '/run/systemd/generator.early', '/etc/systemd/system', '/etc/systemd/system.attached',
            '/run/systemd/system', '/run/systemd/system.attached', '/run/systemd/generator',
            '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/run/systemd/generator.late')
V1_NAMES = ('packagekit.service', 'packagekit.service.d', 'packagekit@.service', 'packagekit@.service.d',
            'dbus-org.freedesktop.PackageKit.service', 'packagekit.socket', 'packagekit.path', 'packagekit.timer',
            'packagekit@.socket')
V1_ENTRY_KEYS = ('type', 'uid', 'gid', 'mode', 'target', 'bytes', 'nlink', 'rdev', 'parents')
V1_PARENT_KEYS = ('uid', 'gid', 'mode')
MASK_UNIT_V1 = ('Id', 'Names', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState', 'main_pid_zero',
                'job_empty', 'NeedDaemonReload', 'DropInPaths', 'FragmentPath')
V1_TRIGGER_UNITS = ('packagekit.socket', 'packagekit.path', 'packagekit.timer')


def v1_entry(value):
    result = {key: value[key] for key in V1_ENTRY_KEYS if key in value and key != 'parents'}
    if 'parents' in value:
        result['parents'] = [{key: item[key] for key in V1_PARENT_KEYS} for item in value['parents']]
    return result


def mask_invariants_v1(view):
    """Frozen event-binding projection (design03 2.2 N2): C3, C4, C5, the C6 subset and
    C14, built only from v1's own literals. A later version adds `_v2`; this one never
    changes, and a record is checked by its own `mask_invariants_format` (MASK_INVARIANTS)."""
    core = view['pk_core']
    unit = core['units']['packagekit.service']
    roots = {}
    for root in V1_ROOTS:
        value = core['candidates'][root]
        roots[root] = ({'absent': True} if value.get('absent') else
                       {name: {k: value['entries'][name][k] for k in ('type', 'target') if k in value['entries'][name]}
                        for name in V1_NAMES})
    return {'mask_invariants_format': 1, 'mask_link': v1_entry(core['mask_link']),
            'dev_null': v1_entry(core['dev_null']), 'candidates': roots,
            'unit': {key: unit[key] for key in MASK_UNIT_V1},
            'trigger_units': {name: core['units'][name]['LoadState'] for name in V1_TRIGGER_UNITS}}


# A record names its projection version; dispatch on it, never on the newest function.
MASK_INVARIANTS = {1: mask_invariants_v1}
