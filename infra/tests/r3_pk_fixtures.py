"""Synthetic option C hosts: a real temporary tree with a /proc tree and fixed command
bytes. Never the host's own files, bus, processes or package manager.

The baseline is a masked host whose every conjunct holds against `Host.reviewed`, a
complete test-only REVIEWED literal; production REVIEWED is never filled from here.
"""
import atexit
import contextlib
import copy
import hashlib
import os
from pathlib import Path
import shutil
import socket
import tempfile
import time
import types
from unittest.mock import patch

import r3_packagekit_state as state
from r3_noble_common import digest

REAL_LSTAT = state.lstat_at  # the module's own no-follow lstat, wrapped below
REAL_READ_PROC = state.read_proc

REGISTRATION_BODY = (b'[D-BUS Service]\nName=org.freedesktop.PackageKit\nExec=/usr/libexec/packagekitd\n'
                     b'User=root\nSystemdService=packagekit.service\n')
SYSTEMD1_BODY = (b'[D-BUS Service]\nName=org.freedesktop.systemd1\nExec=/bin/false\nUser=root\n'
                 b'SystemdService=dbus-org.freedesktop.systemd1.service\n')
DBUS_FRAGMENT = (b'[Unit]\nDescription=D-Bus System Message Bus\n\n[Service]\nExecStart=@/usr/bin/dbus-daemon '
                 b'@dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only\n')
SYSTEM_CONF = (b'<busconfig>\n  <standard_system_servicedirs/>\n'
               b'  <servicehelper>/usr/lib/dbus-1.0/dbus-daemon-launch-helper</servicehelper>\n'
               b'  <include ignore_missing="yes">/etc/dbus-1/system.conf</include>\n  <includedir>system.d</includedir>\n'
               b'  <includedir>/etc/dbus-1/system.d</includedir>\n'
               b'  <include ignore_missing="yes">/etc/dbus-1/system-local.conf</include>\n</busconfig>\n')
POLICY_CONF = b'<busconfig><policy user="root"><allow own="org.freedesktop.PackageKit"/></policy></busconfig>\n'
# snapd's include: one servicedir, appended after the standard ones (C2/C9, PR-C1b).
SNAPD_CONF = (b'<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"\n'
              b' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n'
              b'<busconfig>\n  <servicedir>/var/lib/snapd/dbus-1/system-services/</servicedir>\n</busconfig>\n')
SESSION_CONF = b'<busconfig>\n  <type>session</type>\n  <standard_session_servicedirs/>\n  <includedir>session.d</includedir>\n</busconfig>\n'
NEEDRESTART_CONF = b"# needrestart - Restart daemons after library updates.\n$nrconf{verbosity} = 1;\n"
PACKAGED_UNITS = {
    'dbus.service': DBUS_FRAGMENT,
    'dbus.socket': b'[Socket]\nListenStream=/run/dbus/system_bus_socket\n',
    'packagekit.service': b'[Service]\nType=dbus\nBusName=org.freedesktop.PackageKit\nExecStart=/usr/libexec/packagekitd\n',
    'packagekit-offline-update.service': b'[Service]\nExecStart=/usr/libexec/pk-offline-update\n',
    'ssh.service': b'[Service]\nExecStart=/usr/sbin/sshd -D\n',
}
ADMIN_UNIT = b'[Service]\nExecStart=/usr/local/bin/backup --nightly\n'
DBUS_PID = 4321
LISTENER = 4242
KERNEL = '6.8.0-1-generic'
VERSION = '255.4-1ubuntu8.18'
ROWS = [['dbus', '1.14.10-4ubuntu4.1', 'dbus', '1.14.10-4ubuntu4.1', 'installed'],
        ['dbus-daemon', '1.14.10-4ubuntu4.1', 'dbus', '1.14.10-4ubuntu4.1', 'installed'],
        ['linux-image-' + KERNEL, '6.8.0-1.1', 'linux-signed', '6.8.0-1.1', 'installed'],
        ['packagekit', '1.2.8-2ubuntu1.5', 'packagekit', '1.2.8-2ubuntu1.5', 'installed'],
        ['systemd', VERSION, 'systemd', VERSION, 'installed']]
UNIT_FIELDS = ('Id', 'Names', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState', 'Job', 'FragmentPath',
               'DropInPaths', 'NeedDaemonReload', 'InvocationID', 'InactiveExitTimestampMonotonic',
               'ActiveEnterTimestampMonotonic', 'ActiveExitTimestampMonotonic', 'InactiveEnterTimestampMonotonic')


def unit_text(units):
    blocks = []
    for name, fields in units.items():
        blocks.append(''.join(f'{key}={value}\n' for key, value in fields.items()))
    return '\n'.join(blocks).encode()


class Host:
    """One synthetic masked host. Tests mutate `root`, `units`, `outputs` or `reviewed`."""
    def __init__(self, test=None):
        # AF_UNIX paths are short (104 bytes on macOS); /tmp exists on both platforms. The mutation
        # runner points R3_PK_FIXTURE_ROOT at a short per-worker directory it sweeps after every mutant.
        self.root = Path(tempfile.mkdtemp(prefix='r3p-', dir=os.environ.get('R3_PK_FIXTURE_ROOT') or '/tmp')).resolve()
        self.servers = []
        if test is not None:
            test.addCleanup(self.close)
        try:
            self.setup()
        except BaseException:
            if test is None:  # nobody else will remove it (shared_host registers atexit only afterwards)
                self.close()
            raise

    def setup(self):
        info = os.stat(self.root)
        self.owner = (info.st_uid, info.st_gid)
        self.clk_tck = os.sysconf('SC_CLK_TCK')
        now = int(time.time())
        self.btime = now - 1000
        self.start_wall = now + 30
        self.build()
        self.units = self.default_units()
        self.outputs = {'manager': ('UnitPath=' + ' '.join(state.UNIT_ROOTS) + '\nVersion=' + VERSION + '\n').encode(),
                        'pk-package-metadata': ''.join('\t'.join(row) + '\n' for row in ROWS).encode()}
        self.errors, self.faults, self.calls = {}, {}, []
        self.reviewed = self.make_reviewed()

    def close(self):
        for server in self.servers:
            server.close()
        shutil.rmtree(self.root, True)

    def path(self, name):
        return self.root / name.lstrip('/')

    def write(self, name, data, mode=0o644):
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def link(self, name, target):
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)

    def build(self):
        for directory in ('/etc/apt/apt.conf.d', '/etc/dpkg/dpkg.cfg.d', '/var/lib/dpkg/triggers'):
            self.path(directory).mkdir(parents=True)  # the installer's own facts directories
        self.write(state.REGISTRATION, REGISTRATION_BODY)
        self.write('/usr/share/dbus-1/system-services/org.freedesktop.systemd1.service', SYSTEMD1_BODY)
        self.write('/usr/share/dbus-1/system.conf', SYSTEM_CONF)
        self.write('/usr/share/dbus-1/system.d/org.freedesktop.PackageKit.conf', POLICY_CONF)
        self.write(state.SNAPD_INCLUDE, SNAPD_CONF)
        self.path(state.SNAPD_SERVICE_DIR).mkdir(parents=True)
        self.path('/etc/dbus-1/system.d').mkdir(parents=True)
        # The O7/O11/O12 evidence trees (deb-systemd-helper state, needrestart, session bus, linger).
        self.write('/var/lib/systemd/deb-systemd-helper-enabled/ssh.service.dsh-also',
                   b'/etc/systemd/system/multi-user.target.wants/ssh.service\n')
        self.write('/var/lib/systemd/deb-systemd-helper-enabled/multi-user.target.wants/ssh.service', b'')
        self.write('/etc/needrestart/needrestart.conf', NEEDRESTART_CONF)
        self.write('/etc/needrestart/conf.d/README.needrestart', b'# configuration snippets\n')
        self.write('/etc/needrestart/hook.d/10-dpkg', b'#!/bin/sh\n', 0o755)
        self.write('/usr/share/dbus-1/session.conf', SESSION_CONF)
        self.path('/usr/share/dbus-1/session.d').mkdir(parents=True)
        self.path('/var/lib/systemd/linger').mkdir(parents=True)
        self.path('/sys/fs/selinux').mkdir(parents=True)
        for name, body in PACKAGED_UNITS.items():
            self.write('/usr/lib/systemd/system/' + name, body)
        self.link(state.MASK_PATH, '/dev/null')
        self.write('/etc/systemd/system/local.service', ADMIN_UNIT)
        self.link('/etc/systemd/system/multi-user.target.wants/ssh.service', '/usr/lib/systemd/system/ssh.service')
        self.write('/etc/systemd/system/snap-core22-1.mount', b'[Mount]\nWhat=/var/lib/snapd/snaps/core22_1.snap\n')
        self.link('/etc/systemd/system/snapd.mounts.target.wants/snap-core22-1.mount',
                  '/etc/systemd/system/snap-core22-1.mount')
        self.write('/run/systemd/generator/boot.mount', b'[Mount]\nWhat=/dev/sda15\n')
        ssh = hashlib.md5(PACKAGED_UNITS['ssh.service'], usedforsecurity=False).hexdigest()
        self.write('/var/lib/dpkg/info/openssh-server.md5sums',
                   (ssh + '  usr/lib/systemd/system/ssh.service\n' + 'a' * 32 + '  usr/sbin/sshd\n').encode())
        for index, name in enumerate(state.C12_FILES):
            self.write(name, b'code identity ' + name.encode() + b'\n', 0o4754 if 'launch-helper' in name else 0o755)
        self.write('/dev/null', b'')
        self.path('/var').mkdir(exist_ok=True)
        self.link('/var/run', '/run')
        self.link('/lib', 'usr/lib')
        self.path('/run/dbus').mkdir(parents=True)
        self.bind(self.path(state.BUS))
        self.proc()

    def bind(self, path):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.servers.append(server)
        server.bind(str(path))

    def proc(self):
        pid = '/proc/' + str(DBUS_PID)
        self.write(pid + '/cmdline', b'@dbus-daemon\0--system\0--address=systemd:\0--nofork\0--nopidfile\0'
                                     b'--systemd-activation\0--syslog-only\0')
        self.write(pid + '/comm', b'dbus-daemon\n')
        self.link(pid + '/exe', '/usr/bin/dbus-daemon')
        self.write(pid + '/stat', self.stat_line('dbus-daemon', (self.start_wall - self.btime) * self.clk_tck))
        self.path(pid + '/fd').mkdir()
        self.link(pid + '/fd/3', f'socket:[{LISTENER}]')
        self.link(pid + '/fd/4', '/dev/null')
        self.link(pid + '/fd/5', 'pipe:[9999]')  # not a socket: the filter is load-bearing
        self.write(pid + '/net/unix', self.unix_table([('00010000', '01', LISTENER), ('00000000', '03', 5555)]))
        self.write('/proc/1/cmdline', b'/sbin/init\0')
        self.write('/proc/1/comm', b'systemd\n')
        self.write('/proc/1/stat', self.stat_line('systemd', 1))
        self.write('/proc/stat', f'cpu  1 2 3 4\nbtime {self.btime}\nprocesses 9\n'.encode())
        self.write('/proc/sys/kernel/osrelease', (KERNEL + '\n').encode())
        self.write('/proc/sys/kernel/random/boot_id', b'0f0e0d0c-0b0a-0908-0706-050403020100\n')

    @staticmethod
    def stat_line(comm, ticks):
        fields = ['S'] + [str(i) for i in range(1, 19)] + [str(ticks)] + ['0'] * 10
        return ('99 (' + comm + ') ' + ' '.join(fields) + '\n').encode()

    @staticmethod
    def unix_table(rows):
        lines = ['Num       RefCount Protocol Flags    Type St Inode Path']
        for flags, st, inode in rows:
            lines.append(f'0000000000000000: 00000002 00000000 {flags} 0001 {st} {inode} {state.BUS}')
        return ('\n'.join(lines) + '\n').encode()

    def process(self, pid, comm, args=None):
        self.write(f'/proc/{pid}/comm', (comm + '\n').encode())
        self.write(f'/proc/{pid}/cmdline', args if args is not None else b'/usr/libexec/' + comm.encode() + b'\0')
        self.write(f'/proc/{pid}/stat', self.stat_line(comm, 77))

    def default_units(self):
        def unit(name, **values):
            fields = {key: '' for key in UNIT_FIELDS}
            fields.update(Id=name, Names=name, InactiveExitTimestampMonotonic='0', ActiveEnterTimestampMonotonic='0',
                          ActiveExitTimestampMonotonic='0', InactiveEnterTimestampMonotonic='0', NeedDaemonReload='no')
            if name.endswith('.service'):
                fields.update(MainPID='0', NRestarts='0', ExecMainStartTimestamp='')
            fields.update(values)
            return fields
        return {
            'packagekit.service': unit('packagekit.service', LoadState='masked', UnitFileState='masked',
                                       ActiveState='inactive', SubState='dead', FragmentPath=state.MASK_PATH),
            'dbus.service': unit('dbus.service', LoadState='loaded', UnitFileState='static', ActiveState='active',
                                 SubState='running', FragmentPath='/usr/lib/systemd/system/dbus.service',
                                 MainPID=str(DBUS_PID), InvocationID='a' * 32, ExecMainStartTimestamp='@' + str(self.start_wall),
                                 ActiveEnterTimestampMonotonic='5000000'),
            'dbus.socket': unit('dbus.socket', LoadState='loaded', UnitFileState='static', ActiveState='active',
                                SubState='running', FragmentPath='/usr/lib/systemd/system/dbus.socket'),
            'packagekit-offline-update.service': unit('packagekit-offline-update.service', LoadState='loaded',
                                                      UnitFileState='static', ActiveState='inactive', SubState='dead',
                                                      FragmentPath='/usr/lib/systemd/system/packagekit-offline-update.service'),
            **{name: unit(name, LoadState='not-found', ActiveState='inactive', SubState='dead')
               for name in ('packagekit.socket', 'packagekit.path', 'packagekit.timer')}}

    def runner(self, argv, timeout):
        """Fixed command bytes for exactly the module's three argv."""
        names = [name for name, value in state.COMMANDS.items() if value == argv]
        assert len(names) == 1 and 0 < timeout <= state.COMMAND_TIMEOUT, argv
        name = names[0]
        self.calls.append(name)
        if name in self.errors:
            return self.errors[name]
        stdout = unit_text(self.units) if name == 'pk-units' else self.outputs[name]
        if name in self.faults:  # the right bytes, with a failing exit or a warning
            returncode, stderr = self.faults[name]
            return stdout, stderr, returncode
        return stdout, b'', 0

    def make_reviewed(self):
        def sha(name):
            return digest(self.path(name).read_bytes())
        files = {}
        import r3_policy_capture as capture
        for name in state.C12_FILES:
            files[name] = capture.file_record(name, False, str(self.root))
        index = {'/usr/lib/systemd/system/' + name: {'package': 'test', 'sha256': digest(body), 'md5sums': None,
                                                     'listed': '/usr/lib/systemd/system/' + name}
                 for name, body in PACKAGED_UNITS.items() if name != 'ssh.service'}
        index['/usr/lib/systemd/system/ssh.service'] = {'package': 'openssh-server', 'sha256': None,
                                                        'md5sums': 'openssh-server.md5sums',
                                                        'listed': '/usr/lib/systemd/system/ssh.service'}
        kernel_row = next(row for row in ROWS if row[0].startswith('linux-image-'))
        return {
            'proof_id': state.REVIEWED['proof_id'],
            'registration_sha256': digest(REGISTRATION_BODY),
            'unit_roots': state.UNIT_ROOTS,
            'dev_null': (1, 3),
            'o10_ok': True,
            'o13_mode': 'ctime_rule',
            'discovery_caps': dict(state.REVIEWED['discovery_caps']),
            'profiles': ({
                'id': 'synthetic',
                'code': {'rows': [list(row) for row in ROWS if row is not kernel_row], 'manager_version': VERSION,
                         'kernel': KERNEL, 'kernel_row': list(kernel_row), 'files': files},
                'allow': {
                    'lib_alias': 'usr/lib',
                    'service_members': {'/usr/local/share/dbus-1/system-services': (),
                                        '/usr/share/dbus-1/system-services': ('org.freedesktop.PackageKit.service',
                                                                              'org.freedesktop.systemd1.service'),
                                        '/usr/lib/dbus-1/system-services': (), state.SNAPD_SERVICE_DIR: ()},
                    'config_files': {'/usr/share/dbus-1/system.conf': digest(SYSTEM_CONF)},
                    'config_members': {'/usr/share/dbus-1/system.d': {'org.freedesktop.PackageKit.conf': digest(POLICY_CONF),
                                                                      'snapd.system-services.conf': digest(SNAPD_CONF)},
                                       '/etc/dbus-1/system.d': {}},
                    'selinux_rule': 'selinuxfs-absent-or-empty',
                    'masked_fragment_path': state.MASK_PATH,
                    'dbus_names': 'dbus.service',
                    'dbus_fragment': {'path': '/usr/lib/systemd/system/dbus.service', 'sha256': digest(DBUS_FRAGMENT)},
                    'var_run_target': '/run',
                    'unit_index': index,
                    'link_targets': {},
                    'caps': {'entries': 2048, 'bodies': 128, 'body': 64 * 1024, 'aggregate': 8 * 1024 * 1024,
                             'packaged': 4096, 'md5sums_files': 512, 'md5sums_bytes': 16 * 1024 * 1024}}},),
        }

    def lstat_at(self, name, fd):
        """Unprivileged tests cannot mknod: the tree's /dev/null placeholder reads as (1,3)."""
        info = REAL_LSTAT(name, fd)
        if name == 'null' and os.fstat(fd).st_ino == os.stat(self.path('/dev')).st_ino and self.device:
            return types.SimpleNamespace(st_mode=0o20666, st_uid=info.st_uid, st_gid=info.st_gid,
                                         st_ctime_ns=info.st_ctime_ns, st_dev=info.st_dev, st_ino=info.st_ino,
                                         st_rdev=os.makedev(*self.device), st_size=0, st_nlink=1)
        return info

    device = (1, 3)
    btime_step = 0

    def read_proc(self, fd, name, cap):
        """Byte-level clock step (O15): every second /proc/stat read sees btime moved."""
        data = REAL_READ_PROC(fd, name, cap)
        if name == 'stat' and self.btime_step and os.fstat(fd).st_ino == os.stat(self.path('/proc')).st_ino:
            self.stat_reads = getattr(self, 'stat_reads', 0) + 1
            if self.stat_reads % 2 == 0:
                data = data.replace(f'btime {self.btime}'.encode(), f'btime {self.btime + self.btime_step}'.encode())
        return data

    @contextlib.contextmanager
    def active(self, reviewed=None):
        with patch.object(state, 'REVIEWED', state.frozen(self.reviewed if reviewed is None else reviewed)), \
             patch.object(state, 'OWNER', self.owner), patch.object(state, 'lstat_at', self.lstat_at), \
             patch.object(state, 'read_proc', self.read_proc):
            yield

    def observe(self):
        return state.observe(str(self.root), self.runner)

    def raw(self, reviewed=None):
        with self.active(reviewed):
            return self.observe()

    def evaluate(self, reviewed=None):
        with self.active(reviewed):
            norm = state.normalize(self.observe())
            return state.evaluate(norm)

    def checks(self, reviewed=None):
        with self.active(reviewed):
            norm = state.normalize(self.observe())
            return state.checks(state.facts_view(norm)), state.evaluate(norm)


_shared = []


def shared_host():
    """One process-wide masked host for tests that only need complete canned sections."""
    if not _shared:
        host = Host()
        atexit.register(host.close)
        _shared.append(host)
    return _shared[0]


@contextlib.contextmanager
def canned_sections():
    """Legacy collection tests: the format-3 PackageKit sections come from a synthetic
    masked host under its complete test REVIEWED, so documents stay complete."""
    host = shared_host()
    with host.active():
        raw = host.observe()
        reads = {name: section['value'] for name, section in raw.items()}
    real = state.read

    def read(name, _sections, root='/', runner=None, timeout=10):
        return copy.deepcopy(reads[name])

    def command(name, runner=None, timeout=10):
        assert name == 'pk-units'
        return copy.deepcopy(reads['pk-units'])
    assert real is not None
    with host.active(), patch.object(state, 'read', side_effect=read), patch.object(state, 'command', side_effect=command):
        yield host


def module_canned_sections():
    """setUpModule helper: keep `canned_sections` active for the whole test module."""
    import unittest
    stack = contextlib.ExitStack()
    stack.enter_context(canned_sections())
    unittest.addModuleCleanup(stack.close)
