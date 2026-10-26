"""Option C PackageKit state (PR-C1). Synthetic hosts only: a real temporary tree, a /proc
tree and fixed command bytes; never the host's own files, bus, processes or packages.

T-TRUTH (one case per sub-clause), T-LEAF, T-DOMAIN, T-FROZEN, T-ROUTE, T-LEGACY,
T-DRIFT (S1/S2/S3), the C15 boundaries and QA M1/M2. The static contract tests
(T-READONLY, T-IMPORT, T-BUNDLE) are in test_r3_packagekit_contract.py.
"""
import ast
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_packagekit_state as state
import r3_install_policy as policy
import r3_policy_capture as capture
import r3_policy_evidence as evidence
import r3_policy_validate as validator
import r3_policy_scope as scope
import r3_policy_snap as snap
from r3_noble_common import digest, encoded
import r3_pk_fixtures as fx
from r3_pk_fixtures import Host

REG = state.REGISTRATION
V1_GOLDEN = '8fc203d92aee6ba7c22a07fc19c4012563e7aecdd3f8317182e17047e0ee61df'
LOCAL_SERVICES = '/usr/local/share/dbus-1/system-services'


def reviewed_with(**changes):
    def change(value):
        value.update(changes)
    return change


def allow_with(**changes):
    """Change the synthetic host's own profile allowances."""
    def change(value):
        value['profiles'][0]['allow'].update(changes)
    return change


def allow_service(name, directory='/usr/share/dbus-1/system-services'):
    def change(value):
        allow = value['profiles'][0]['allow']
        members = dict(allow['service_members'])
        members[directory] = (*members[directory], name)
        allow['service_members'] = members
    return change


def unit(name, **values):
    def change(host):
        host.units[name].update(values)
    return change


def write(path, data, mode=0o644):
    return lambda host: host.write(path, data, mode)


def link(path, target):
    return lambda host: host.link(path, target)


def chmod(path, mode):
    return lambda host: host.path(path).chmod(mode)


def remove(path):
    return lambda host: os.unlink(host.path(path))


def replace_link(path, target):
    def change(host):
        os.unlink(host.path(path))
        host.link(path, target)
    return change


def raw_value(name, function):
    def change(raw):
        function(raw[name]['value'])
    return change


def registration(body):
    return write(REG, body)


def proc_cmdline(data):
    return write(f'/proc/{fx.DBUS_PID}/cmdline', data)


def unix(rows):
    return lambda host: host.write(f'/proc/{fx.DBUS_PID}/net/unix', host.unix_table(rows))


def rows(change_rows):
    def change(host):
        lines = [list(row) for row in fx.ROWS]
        change_rows(lines)
        host.outputs['pk-package-metadata'] = ''.join('\t'.join(r) + '\n' for r in lines).encode()
    return change


def admin_unit(path, body):
    return write(path, body)


def symlinked_parent(host):
    os.rename(host.path('/etc/systemd/system'), host.path('/etc/systemd/real'))
    host.link('/etc/systemd/system', 'real')


def hard_linked_registration(host):
    os.link(host.path(REG), host.path('/usr/share/dbus-1/registration-copy'))


def nested_directory(host):
    host.path('/etc/systemd/system/a.wants/deeper').mkdir(parents=True)


def times(early_start=False, early_exec_start=False):
    """dbus started before the tree's files were last changed (ctime later than start)."""
    def change(host):
        start = host.btime + 10 if early_start else host.start_wall
        host.write(f'/proc/{fx.DBUS_PID}/stat', host.stat_line('dbus-daemon', (start - host.btime) * host.clk_tck))
        host.units['dbus.service']['ExecMainStartTimestamp'] = '@' + str(host.btime + 10 if early_exec_start else host.start_wall)
    return change


def several(*changes):
    def change(target):
        for item in changes:
            item(target)
    return change


NOW = __import__('time').time
# (sub-clause, expected: False = fails, None = not established, tree change, reviewed change, raw change)
TRUTH = [
    # C1 registration
    ('C1.regular', None, hard_linked_registration, None, None),
    ('C1.regular', None, several(remove(REG), write('/usr/share/dbus-1/real', fx.REGISTRATION_BODY),
                                 link(REG, 'real')), allow_service('real'), None),
    ('C1.owner', False, chmod(REG, 0o664), None, None),
    ('C1.owner', False, None, None, raw_value('dbus-service-dirs', lambda v: v['system'][
        '/usr/share/dbus-1/system-services']['members']['org.freedesktop.PackageKit.service'].update(uid=1234))),
    ('C1.parsed', None, registration(b'[D-BUS Service]\nName=\xff\n'), None, None),
    ('C1.one-group', False, registration(fx.REGISTRATION_BODY + b'[Other]\nX=1\n'), None, None),
    ('C1.one-group', False, registration(fx.REGISTRATION_BODY + b'not a key line\n'), None, None),
    ('C1.keys', False, registration(fx.REGISTRATION_BODY + b'AssumedAppArmorLabel=x\n'), None, None),
    ('C1.keys', False, registration(fx.REGISTRATION_BODY + b'Exec=/bin/true\n'), None, None),
    ('C1.name', False, registration(fx.REGISTRATION_BODY.replace(b'org.freedesktop.PackageKit', b'org.example.Other')), None, None),
    ('C1.systemd-service', False, registration(fx.REGISTRATION_BODY.replace(b'SystemdService=packagekit.service\n', b'')), None, None),
    ('C1.systemd-service', False, registration(fx.REGISTRATION_BODY.replace(b'=packagekit.service', b'=other.service')), None, None),
    ('C1.systemd-service', False, registration(fx.REGISTRATION_BODY + b'SystemdService=packagekit.service\n'), None, None),
    ('C1.systemd-service', None, registration(fx.REGISTRATION_BODY.replace(b'=packagekit.service', b'=')), None, None),
    ('C1.reviewed', None, registration(b'# comment\n' + fx.REGISTRATION_BODY), None, None),
    # C2 service directories
    ('C2.lib-alias', None, replace_link('/lib', 'usr/lib64'), None, None),
    ('C2.lib-alias', None, several(remove('/lib'), lambda h: h.path('/lib').mkdir()), None, None),
    ('C2.lib-alias', None, None, allow_with(lib_alias=None), None),
    *[('C2.owner:' + d, False, several(lambda h, d=d: h.path(d).mkdir(parents=True, exist_ok=True), chmod(d, 0o777)), None, None)
      for d in state.SERVICE_DIRS],
    *[('C2.regular:' + d, None, link(d + '/alias.service', '/tmp/x'), allow_service('alias.service', d), None)
      for d in state.SERVICE_DIRS],
    *[('C2.members:' + d, None, write(d + '/org.example.Foo.service', b'[D-BUS Service]\nName=org.example.Foo\n'), None, None)
      for d in state.SERVICE_DIRS],
    ('C2.no-other-registration:/usr/share/dbus-1/system-services', False,
     write('/usr/share/dbus-1/system-services/pk2.service', b'[D-BUS Service]\nName=org.freedesktop.PackageKit\nExec=/opt/pk\n'),
     allow_service('pk2.service'), None),
    ('C2.members:' + LOCAL_SERVICES, None, write(LOCAL_SERVICES + '/x.service', b'[D-BUS Service]\n'), allow_with(service_members=None), None),
    ('C2.no-other-registration:' + LOCAL_SERVICES, False,
     write(LOCAL_SERVICES + '/pk.service', fx.REGISTRATION_BODY), allow_service('pk.service', LOCAL_SERVICES), None),
    ('C2.no-other-registration:/usr/lib/dbus-1/system-services', False,
     write('/usr/lib/dbus-1/system-services/pk.service', b'[D-BUS Service]\nName=org.freedesktop.packagekit\n'),
     allow_service('pk.service', '/usr/lib/dbus-1/system-services'), None),
    # C3 mask link
    ('C3.link', False, remove(state.MASK_PATH), None, None),
    ('C3.link', False, several(remove(state.MASK_PATH), write(state.MASK_PATH, b'')), None, None),
    ('C3.target', False, replace_link(state.MASK_PATH, '/dev/null/'), None, None),
    ('C3.target', False, replace_link(state.MASK_PATH, 'dev/null'), None, None),
    ('C3.target', False, replace_link(state.MASK_PATH, '/dev/zero'), None, None),
    ('C3.owner', False, None, None, raw_value('link:' + state.MASK_PATH, lambda v: v.update(uid=1234))),
    ('C3.parents', False, chmod('/etc/systemd/system', 0o777), None, None),
    ('C3.link', None, symlinked_parent, None, None),
    ('C3.parents', None, None, None, raw_value('link:' + state.MASK_PATH, lambda v: v['parents'].pop())),
    # Owner halves of the root-owned chains (tests cannot chown, so these are raw-level).
    ('C3.parents', False, None, None, raw_value('link:' + state.MASK_PATH, lambda v: v['parents'][-1].update(uid=1234))),
    ('C4.parents', False, None, None, raw_value('device:/dev/null', lambda v: v['parents'][0].update(gid=1234))),
    ('C10.var', False, None, None, raw_value('dir-meta:/var', lambda v: v['parents'][0].update(uid=1234))),
    ('C10.var', False, None, None, raw_value('dir-meta:/var', lambda v: v.update(uid=1234))),
    ('C10.var-run', False, None, None, raw_value('link:/var/run', lambda v: v.update(uid=1234))),
    ('C2.owner:/usr/share/dbus-1/system-services', False, None, None,
     raw_value('dbus-service-dirs', lambda v: v['system']['/usr/share/dbus-1/system-services'].update(uid=1234))),
    ('C9.dir:/usr/share/dbus-1/system.d', False, None, None,
     raw_value('dbus-config', lambda v: v['dirs']['/usr/share/dbus-1/system.d'].update(gid=1234))),
    # C4 /dev/null
    ('C4.char', False, lambda h: setattr(h, 'device', None), None, None),
    ('C4.rdev', False, lambda h: setattr(h, 'device', (1, 5)), None, None),
    ('C4.owner', False, None, None, raw_value('device:/dev/null', lambda v: v.update(mode=0o644))),
    ('C4.owner', False, None, None, raw_value('device:/dev/null', lambda v: v.update(gid=1234))),
    ('C4.parents', False, chmod('/dev', 0o777), None, None),
    # C5 overrides at every root, the live UnitPath
    *[('C5.no-override', False, write(root + '/packagekit.service', b'[Service]\nExecStart=/bin/true\n'), None, None)
      for root in state.UNIT_ROOTS if root not in ('/etc/systemd/system', '/usr/lib/systemd/system')],
    ('C5.no-override', False, write('/etc/systemd/system/packagekit.service.d/x.conf', b'[Service]\n'), None, None),
    ('C5.no-override', False, write('/usr/lib/systemd/system/packagekit.service.d/x.conf', b'[Service]\n'), None, None),
    ('C5.no-override', False, link('/etc/systemd/system/dbus-org.freedesktop.PackageKit.service', 'packagekit.service'), None, None),
    ('C5.no-override', False, write('/usr/lib/systemd/system/packagekit@.service', b'[Service]\n'), None, None),
    ('C5.no-override', False, several(remove(state.VENDOR_FRAGMENT), link(state.VENDOR_FRAGMENT, '/dev/null')), None, None),
    ('C5.unit-path', None, lambda h: h.outputs.update(manager=('UnitPath=/opt/units ' + ' '.join(state.UNIT_ROOTS)
                                                                + '\nVersion=' + fx.VERSION + '\n').encode()), None, None),
    # C6 loaded view of packagekit.service
    ('C6.Names', False, unit('packagekit.service', Names='packagekit.service dbus-org.freedesktop.PackageKit.service'), None, None),
    ('C6.LoadState', False, unit('packagekit.service', LoadState='loaded'), None, None),
    ('C6.UnitFileState', False, unit('packagekit.service', UnitFileState='masked-runtime'), None, None),
    ('C6.ActiveState', False, unit('packagekit.service', ActiveState='active'), None, None),
    ('C6.SubState', False, unit('packagekit.service', SubState='running'), None, None),
    ('C6.main-pid-zero', False, unit('packagekit.service', MainPID='812'), None, None),
    ('C6.job-empty', False, unit('packagekit.service', Job='7'), None, None),
    ('C6.NeedDaemonReload', False, unit('packagekit.service', NeedDaemonReload='yes'), None, None),
    ('C6.DropInPaths', False, unit('packagekit.service', DropInPaths='/etc/systemd/system/service.d/x.conf'), None, None),
    ('C6.fragment', False, unit('packagekit.service', FragmentPath=state.VENDOR_FRAGMENT), None, None),
    ('C6.fragment', None, None, allow_with(masked_fragment_path=None), None),
    # C7 dbus.service
    ('C7.names', None, unit('dbus.service', Names='dbus.service messagebus.service'), None, None),
    ('C7.no-broker', False, unit('dbus.service', Names='dbus.service dbus-broker.service'), None, None),
    ('C7.LoadState', False, unit('dbus.service', LoadState='masked'), None, None),
    ('C7.ActiveState', False, unit('dbus.service', ActiveState='inactive'), None, None),
    ('C7.SubState', False, unit('dbus.service', SubState='exited'), None, None),
    ('C7.NeedDaemonReload', False, unit('dbus.service', NeedDaemonReload='yes'), None, None),
    ('C7.DropInPaths', False, unit('dbus.service', DropInPaths='/run/systemd/system/dbus.service.d/x.conf'), None, None),
    ('C7.no-drop-in-dirs', False, write('/run/systemd/system/dbus.service.d/x.conf', b'[Service]\n'), None, None),
    ('C7.fragment-path', None, unit('dbus.service', FragmentPath='/etc/systemd/system/dbus.service'), None, None),
    ('C7.fragment-hash', None, write('/usr/lib/systemd/system/dbus.service', fx.DBUS_FRAGMENT + b'# local\n'), None, None),
    ('C7.systemd-activation', False, write('/usr/lib/systemd/system/dbus.service', fx.DBUS_FRAGMENT.replace(b' --systemd-activation', b'')),
     allow_with(dbus_fragment={'path': '/usr/lib/systemd/system/dbus.service',
                               'sha256': digest(fx.DBUS_FRAGMENT.replace(b' --systemd-activation', b''))}), None),
    ('C7.names', None, None, allow_with(dbus_names=None), None),
    # C8 running dbus-daemon
    ('C8.system', False, proc_cmdline(b'@dbus-daemon\0--session\0--systemd-activation\0'), None, None),
    ('C8.systemd-activation', False, proc_cmdline(b'@dbus-daemon\0--system\0--address=systemd:\0'), None, None),
    ('C8.exe', False, replace_link(f'/proc/{fx.DBUS_PID}/exe', '/usr/bin/dbus-broker'), None, None),
    ('C8.exe', None, unit('dbus.service', MainPID='999'), None, None),
    ('C8.exe', None, None, None, raw_value('dbus-daemon-proc', lambda v: v.update(pid=1))),
    # C9 configuration chain
    ('C9.file:/etc/dbus-1/system-local.conf', False,
     write('/etc/dbus-1/system-local.conf', b'<busconfig><servicedir>/opt/s</servicedir></busconfig>\n'), None, None),
    ('C9.file:/etc/dbus-1/system-local.conf', None, write('/etc/dbus-1/system-local.conf', b'<busconfig/>\n'), None, None),
    ('C9.file:/etc/dbus-1/system.conf', False,
     write('/etc/dbus-1/system.conf', b'<busconfig><include>/opt/x.conf</include></busconfig>\n'), None, None),
    ('C9.file:/usr/share/dbus-1/system.conf', None, write('/usr/share/dbus-1/system.conf', fx.SYSTEM_CONF + b'<!-- -->\n'), None, None),
    ('C9.file:/usr/share/dbus-1/system.conf', None, remove('/usr/share/dbus-1/system.conf'), None, None),
    ('C9.dir:/etc/dbus-1/system.d', False,
     write('/etc/dbus-1/system.d/x.conf', b'<busconfig><servicehelper>/opt/h</servicehelper></busconfig>\n'), None, None),
    ('C9.dir:/etc/dbus-1/system.d', False,
     write('/etc/dbus-1/system.d/y.conf', b'<busconfig><includedir>/opt/d</includedir></busconfig>\n'), None, None),
    ('C9.dir:/etc/dbus-1/system.d', None, write('/etc/dbus-1/system.d/z.conf', b'<busconfig><policy/></busconfig>\n'), None, None),
    ('C9.dir:/usr/share/dbus-1/system.d', False, chmod('/usr/share/dbus-1/system.d', 0o777), None, None),
    ('C9.selinux', None, write('/sys/fs/selinux/enforce', b'1\n'), None, None),
    ('C9.selinux', None, None, allow_with(selinux_rule=None), None),
    # C10 /var, /var/run, socket and listener
    ('C10.var', False, chmod('/var', 0o777), None, None),
    ('C10.var', False, None, None, raw_value('dir-meta:/var', lambda v: v.update(type='link', target='/srv/var'))),
    ('C10.var-run', False, several(remove('/var/run'), lambda h: h.path('/var/run').mkdir()), None, None),
    ('C10.var-run', False, replace_link('/var/run', '/srv'), None, None),
    ('C10.var-run', None, None, allow_with(var_run_target=None), None),
    ('C10.socket', None, lambda h: [s.close() for s in h.servers] and os.unlink(h.path(state.BUS)), None, None),
    ('C10.socket', None, several(lambda h: os.unlink(h.path(state.BUS)), write(state.BUS, b'x')), None, None),
    ('C10.listener', None, unix([('00000000', '03', 5555)]), None, None),
    ('C10.listener', None, unix([('00010000', '01', fx.LISTENER), ('00010000', '01', 777)]), None, None),
    ('C10.listener', None, unix([('00000000', '01', fx.LISTENER)]), None, None),
    ('C10.listener', None, unix([('00010000', '01', 9999)]), None, None),
    ('C10.listener', None, unix([('00010000', '01', fx.LISTENER)] + [('00000000', '01', 100 + i) for i in range(65)]), None, None),
    # C11 processes
    ('C11.no-process', False, lambda h: h.process(812, 'packagekitd'), None, None),
    ('C11.no-process', False, lambda h: h.process(813, 'python3', b'/usr/libexec/packagekitd\0'), None, None),
    ('C11.no-process', False, lambda h: h.process(814, 'pk-offline-upda'), None, None),
    ('C11.no-process', False, lambda h: h.process(815, 'packagekitd', b'renamed\0'), None, None),
    # C12 code identity
    ('C12.code', None, rows(lambda r: r[0].__setitem__(1, '1.14.10-4ubuntu4.2')), None, None),
    ('C12.code', None, rows(lambda r: r.append(['dbus-x11', '1', 'dbus', '1', 'installed'])), None, None),
    ('C12.code', None, chmod('/usr/lib/dbus-1.0/dbus-daemon-launch-helper', 0o755), None, None),
    ('C12.code', None, write('/usr/libexec/packagekitd', b'other code\n', 0o755), None, None),
    ('C12.code', None, lambda h: h.outputs.update(manager=('UnitPath=' + ' '.join(state.UNIT_ROOTS)
                                                           + '\nVersion=255.4-1ubuntu8.17\n').encode()), None, None),
    ('C12.code', None, write('/proc/sys/kernel/osrelease', b'6.8.0-2-generic\n'), None, None),
    ('C12.code', None, None, reviewed_with(profiles=()), None),
    # C13 other activators
    ('C13.other-activators', False, admin_unit('/etc/systemd/system/x.service', b'[Service]\nBusName=org.freedesktop.PackageKit\n'), None, None),
    ('C13.other-activators', False, admin_unit('/etc/systemd/system/x.service', b'[Service]\nExecStart=/usr/libexec/packagekitd\n'), None, None),
    ('C13.other-activators', False, admin_unit('/etc/systemd/system/x.service',
                                               b'[Service]\nExecStart=/usr/local/bin/x --then /usr/libexec/packagekitd\n'), None, None),
    ('C13.other-activators', False, admin_unit('/run/systemd/transient/run-u7.service', b'[Service]\nExecStart=/usr/libexec/PackageKitD\n'), None, None),
    ('C13.other-activators', False, admin_unit('/etc/systemd/user/x.service', b'[Service]\nExecStart=/usr/libexec/packagekitd\n'), None, None),
    ('C13.other-activators', False, write('/usr/share/dbus-1/services/org.freedesktop.PackageKit.service', fx.REGISTRATION_BODY), None, None),
    ('C13.other-activators', False, link('/etc/systemd/system/foo.service', '/opt/packagekit-wrapper.service'), None, None),
    ('C13.other-activators', False, link('/etc/systemd/system/multi-user.target.wants/packagekit.service', state.VENDOR_FRAGMENT), None, None),
    ('C13.other-activators', False, link('/etc/systemd/system/packagekit-helper.service', '/usr/lib/systemd/system/ssh.service'), None, None),
    ('C13.other-activators', None, link('/etc/systemd/system/foo.service', '/opt/units/foo.service'), None, None),
    ('C13.other-activators', None, nested_directory, None, None),
    # systemd follows links before `..`: /opt/l -> /srv/x makes this load /srv's file, not local.service.
    ('C13.other-activators', None, several(lambda h: h.path('/srv/x/y').mkdir(parents=True), link('/opt/l', '/srv/x/y'),
                                           link('/etc/systemd/system/evil.service',
                                                '/opt/l/../../etc/systemd/system/local.service')), None, None),
    ('C13.other-activators', None, link('/etc/systemd/system/multi-user.target.wants/two.service', '../../system/local.service'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/x@.service', b'[Service]\nExecStart=/usr/libexec/%i\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/y.service',
                                              b'[Service]\nEnvironment=P=/usr/libexec/x\nExecStart=/bin/sh -c "$P"\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/z.service', b'[Service]\nExecStart=/usr/libexec/pack*\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/w.service', b'[Service]\nExecStart=/usr/bin/a \\\n  $X\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/v.service',
                                              b'[Service]\nExecStartPre=/bin/sh -c "$P"\nExecStart=/usr/bin/true\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/u.service', b'[Service]\nExecReload=/usr/bin/kill -HUP $MAINPID\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/t.service', b'[Service]\nExecStart=/bin/sh -ec "run x"\n'), None, None),
    ('C13.other-activators', False, admin_unit('/etc/systemd/system/s.service', b'[Service]\nExecStart=/usr/libexec/packa"gekit"d\n'), None, None),
    ('C13.other-activators', False, admin_unit('/etc/systemd/system/r.service', b"[Service]\nExecStart=/bin/sh -ec 'packa''gekitd'\n"), None, None),
    ('C13.other-activators', False, admin_unit('/etc/systemd/system/packagekitd.service', b'[Service]\nExecStart=/usr/libexec/%N\n'), None, None),
    ('C13.other-activators', False, link('/etc/systemd/system/x@packagekitd.service', 'x@.service'), None, None),
    ('C13.other-activators', False, write('/run/user/0/dbus-1/services/pk.service', b'[D-BUS Service]\nName=org.freedesktop.PackageKit\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/x.service', b'[Service]\nExecStart=/usr/libexec/\\x70ackagekitd\n'), None, None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/x.service', b'[Service]\nExecStart=\xff\n'), None, None),
    ('C13.other-activators', None, write('/usr/lib/systemd/system/ssh.service', b'[Service]\nExecStart=/usr/sbin/sshd -D -e\n'), None, None),
    ('C13.other-activators', None, write('/var/lib/dpkg/info/openssh-server.md5sums', b'a' * 32 + b'  usr/sbin/sshd\n'), None, None),
    ('C13.other-activators', None, write('/usr/lib/systemd/system/dbus.socket', b'[Socket]\nListenStream=/x\n'), None, None),
    ('C13.other-activators', None, write(state.VENDOR_FRAGMENT, b'[Service]\nExecStart=/usr/libexec/packagekitd --x\n'), None, None),
    ('C13.other-activators', None, None, lambda r: allow_with(caps={**r['profiles'][0]['allow']['caps'], 'entries': 3})(r), None),
    ('C13.other-activators', None, None, lambda r: allow_with(caps={**r['profiles'][0]['allow']['caps'], 'bodies': 1})(r), None),
    ('C13.other-activators', None, admin_unit('/etc/systemd/system/big.service', b'#' * (65 * 1024)), None, None),
    ('C13.other-activators', None, None, lambda r: allow_with(caps={**r['profiles'][0]['allow']['caps'], 'aggregate': 64})(r), None),
    ('C13.other-activators', None, None, lambda r: allow_with(caps={**r['profiles'][0]['allow']['caps'], 'packaged': 2})(r), None),
    ('C13.other-activators', None, None, lambda r: allow_with(caps={**r['profiles'][0]['allow']['caps'], 'md5sums_files': 0})(r), None),
    ('C13.other-activators', None, None, lambda r: allow_with(caps={**r['profiles'][0]['allow']['caps'], 'md5sums_bytes': 40})(r), None),
    ('C13.other-activators', None, lambda h: h.write('/var/lib/dpkg/info/openssh-server.md5sums', h.path(
        '/var/lib/dpkg/info/openssh-server.md5sums').read_bytes() * 2), None, None),
    ('C13.other-activators', None, lambda h: h.write('/var/lib/dpkg/info/openssh-server.md5sums', h.path(
        '/var/lib/dpkg/info/openssh-server.md5sums').read_bytes() + b'XYZ  usr/bin/x\n'), None, None),
    # C14 other PackageKit unit types
    *[('C14.absent', False, write('/etc/systemd/system/' + name, b'[Unit]\n'), None, None) for name in state.C14_NAMES],
    ('C14.absent', False, write('/run/systemd/generator.late/packagekit.timer', b'[Timer]\n'), None, None),
    ('C14.units', False, unit('packagekit.timer', LoadState='loaded'), None, None),
    # C15 activation-cache consistency (tree level; exact boundaries are unit tests below)
    ('C15.cache', None, times(early_start=True), None, None),
    ('C15.cache', None, times(early_exec_start=True), None, None),
    ('C15.cache', None, None, None, raw_value('dbus-daemon-proc', lambda v: v['btime'].__setitem__(1, v['btime'][0] + 5))),
    ('C15.cache', None, lambda h: setattr(h, 'btime_step', 5), None, None),  # byte level: /proc/stat read twice
    ('C15.cache', None, None, None, raw_value('dbus-service-dirs', lambda v: v['system']['/usr/share/dbus-1/system-services'][
        'members']['org.freedesktop.systemd1.service'].update(ctime_ns=2**62))),
    ('C15.cache', None, None, None, raw_value('dbus-config', lambda v: v['files']['/usr/share/dbus-1/system.conf'].update(ctime_ns=2**62))),
    ('C15.cache', None, None, None, raw_value('dbus-config', lambda v: v['dirs']['/usr/share/dbus-1/system.d'].update(ctime_ns=2**62))),
    ('C15.cache', None, None, None, raw_value('dbus-config', lambda v: v['parents']['/etc/dbus-1'].update(ctime_ns=2**62))),
    # C16 offline-update boot path
    ('C16.system-update', False, link('/system-update', '/var/lib/PackageKit'), None, None),
    ('C16.system-update', False, write('/etc/system-update', b''), None, None),
]


def run_case(host, tree, reviewed_change, raw_change):
    if tree:
        tree(host)
    reviewed = copy.deepcopy(host.reviewed)
    if reviewed_change:
        reviewed_change(reviewed)
    with host.active(reviewed):
        raw = host.observe()
        if raw_change:
            raw_change(raw)
        norm = state.normalize(raw)
        view = state.facts_view(norm)
        return reviewed, raw, norm, state.checks(view), state.evaluate(norm)


class Baseline(unittest.TestCase):
    def test_a_masked_host_holds_every_conjunct_against_its_reviewed_values(self):
        host = Host(self)
        _reviewed, raw, norm, results, result = run_case(host, None, None, None)
        self.assertTrue(all(section['state'] == 'ok' for section in raw.values()), raw)
        self.assertEqual({k for k, v in results.items() if v is not True}, set())
        self.assertIs(result, False)
        self.assertIs(norm['c13_verdict'], False)
        self.assertEqual(set(state.facts_view(norm)), {'proof_id', 'pk_core', 'c13_verdict', 'unit_universe_digest'})

    def test_an_unmasked_host_is_true_and_a_host_without_registration_is_none(self):
        host = Host(self)
        os.unlink(host.path(state.MASK_PATH))
        self.assertIs(host.evaluate(), True)
        os.unlink(host.path(REG))
        self.assertIsNone(host.evaluate())  # NOT_C_BASELINE (D2), even unmasked

    def test_production_reviewed_never_yields_false_or_a_full_collection(self):
        """PR-C1 changes no eligibility: undischarged obligations force None on every host."""
        for unmasked in (False, True):
            with self.subTest(unmasked=unmasked):
                host = Host(self)
                if unmasked:
                    os.unlink(host.path(state.MASK_PATH))
                with patch.object(state, 'OWNER', host.owner), patch.object(state, 'lstat_at', host.lstat_at):
                    raw = host.observe()
                    norm = state.normalize(raw)
                    self.assertIsNone(state.evaluate(norm))
                    self.assertEqual(raw['unit-universe']['value']['mode'], 'discovery')
                    self.assertEqual(raw['dpkg-md5sums']['value'], {'mode': 'discovery'})
                    self.assertTrue(state.discovery(raw))
                    self.assertIsNone(norm['c13_verdict'])
                    self.assertRegex(norm['unit_universe_digest'], '^[a-f0-9]{64}$')
                    self.assertNotIn('body', json.dumps(raw['unit-universe']))

    def test_forced_none_obligations(self):
        host = Host(self)
        for change in (reviewed_with(o10_ok=False), reviewed_with(o10_ok=None), reviewed_with(o13_mode='failed'),
                       reviewed_with(o13_mode='unknown')):
            with self.subTest(change=change):
                reviewed = copy.deepcopy(host.reviewed)
                change(reviewed)
                self.assertIsNone(host.evaluate(reviewed))
        # Facts normalized under another proof are never evaluated against this one.
        with host.active():
            view = state.facts_view(state.normalize(host.observe()))
        reviewed = copy.deepcopy(host.reviewed)
        reviewed['proof_id'] = 'o1-o16-review02:' + 'f' * 64
        with host.active(reviewed):
            self.assertIsNone(state.evaluate(view))
        with host.active():
            self.assertIs(state.evaluate(view), False)
        os.unlink(host.path(state.MASK_PATH))
        for change in (reviewed_with(o10_ok=False), reviewed_with(o13_mode='failed')):
            reviewed = copy.deepcopy(host.reviewed)
            change(reviewed)
            self.assertIsNone(host.evaluate(reviewed))  # forced None dominates a failing conjunct (G7)

    def test_unit_output_shape(self):
        host = Host(self)
        rows(lambda r: r.append(['dbus-x11', '', 'dbus', '', 'not-installed']))(host)
        self.assertIs(host.evaluate(), False)  # dpkg's known-but-absent rows are not code identity
        host = Host(self)
        text = fx.unit_text(host.units).replace(b'LoadState=masked\n', b'LoadState=loaded\nLoadState=masked\n', 1)
        host.errors['pk-units'] = (text, b'', 0)
        self.assertIsNone(host.evaluate())  # a duplicated property is never last-one-wins
        host = Host(self)
        units = dict(host.units)
        units.pop('packagekit-offline-update.service')  # collected, never read by a clause
        host.errors['pk-units'] = (fx.unit_text(units), b'', 0)
        self.assertIsNone(host.evaluate())

    def test_oversized_command_output_is_an_error_section(self):
        for name in state.COMMANDS:
            with self.subTest(command=name):
                host = Host(self)
                host.errors[name] = (b'x' * (state.OUTPUT_LIMITS[name] + 1), b'', 0)
                with host.active():
                    raw = host.observe()
                self.assertEqual(raw[name], {'state': 'error', 'error': 'ValueError'})
                host.errors[name] = (b'', b'e' * (state.OUTPUT_LIMITS[name] + 1), 0)
                with host.active():
                    self.assertEqual(host.observe()[name], {'state': 'error', 'error': 'ValueError'})

    def test_reload_on_lookup_is_never_honoured(self):
        """O13 proved it fails for this dbus build: only the ctime rule can establish C15."""
        host = Host(self)
        reviewed = copy.deepcopy(host.reviewed)
        reviewed['o13_mode'] = 'reload_on_lookup'
        self.assertIsNone(host.evaluate(reviewed))
        results, _result = host.checks(reviewed)
        self.assertIsNone(results['C15.cache'])  # even with every ctime consistent
        times(early_start=True)(host)
        _r, _raw, _n, results, result = run_case(host, None, reviewed_with(o13_mode='reload_on_lookup'), None)
        self.assertIsNone(results['C15.cache'])
        self.assertIsNone(result)

    def test_only_the_running_kernel_is_code_identity(self):
        host = Host(self)
        rows(lambda r: r.append(['linux-image-6.8.0-9-generic', '6.8.0-9.9', 'linux-signed', '6.8.0-9.9', 'installed']))(host)
        self.assertIs(host.evaluate(), False)  # an installed, not running kernel (F4)
        rows(lambda r: r[2].__setitem__(1, '6.8.0-1.2'))(host)
        self.assertIsNone(host.evaluate())  # the running kernel's own row changed

    def test_profile_selection(self):
        host = Host(self)
        reviewed = copy.deepcopy(host.reviewed)
        reviewed['profiles'] = (reviewed['profiles'][0], dict(reviewed['profiles'][0], id='duplicate'))
        self.assertIsNone(host.evaluate(reviewed))  # ambiguous: never pick one
        reviewed = copy.deepcopy(host.reviewed)
        other = copy.deepcopy(reviewed['profiles'][0])
        other.update(id='other-target')
        other['code']['manager_version'] = '255.4-1ubuntu8.17'
        other['allow']['dbus_names'] = None  # the other target's own allowances, pending
        reviewed['profiles'] = (other, reviewed['profiles'][0])
        with host.active(reviewed):
            norm = state.normalize(host.observe())
            self.assertIs(state.evaluate(norm), False)
        self.assertEqual(norm['pk_core']['profile_id'], 'synthetic')
        host.outputs['manager'] = ('UnitPath=' + ' '.join(state.UNIT_ROOTS) + '\nVersion=255.4-1ubuntu8.17\n').encode()
        with host.active(reviewed):
            raw = host.observe()
            norm = state.normalize(raw)
            self.assertIsNone(state.evaluate(norm))  # judged by the selected profile's allowances
            self.assertIsNone(state.checks(state.facts_view(norm))['C7.names'])
        self.assertEqual(norm['pk_core']['profile_id'], 'other-target')
        self.assertEqual(raw['unit-universe']['value']['profile'], 'other-target')

    def test_a_profile_without_an_index_collects_with_the_discovery_caps(self):
        host = Host(self)
        allow_with(unit_index=None, caps={**host.reviewed['profiles'][0]['allow']['caps'], 'entries': 1})(host.reviewed)
        with host.active():
            raw = host.observe()
        self.assertEqual(raw['unit-universe']['state'], 'ok')
        self.assertEqual((raw['unit-universe']['value']['mode'], raw['unit-universe']['value']['profile']),
                         ('discovery', 'synthetic'))

    def test_a_universe_collected_for_another_profile_is_not_classified(self):
        host = Host(self)
        with host.active():
            raw = host.observe()
        raw['unit-universe']['value']['profile'] = 'other-target'
        with host.active():
            norm = state.normalize(raw)
        self.assertIsNone(norm['c13_verdict'])


class Truth(unittest.TestCase):
    """T-TRUTH: every sub-clause flips on its own; nothing but all-hold gives False."""
    def test_every_case(self):
        seen = set()
        for index, (name, expected, tree, reviewed_change, raw_change) in enumerate(TRUTH):
            with self.subTest(case=index, clause=name):
                host = Host(self)
                _reviewed, _raw, _norm, results, result = run_case(host, tree, reviewed_change, raw_change)
                self.assertIs(results[name], expected)
                self.assertIs(result, True if expected is False else None)
                seen.add(name)
        host = Host(self)
        _r, _raw, _n, results, _e = run_case(host, None, None, None)
        self.assertEqual(set(results) - seen, set(), 'a sub-clause without its own T-TRUTH case')


def leaves(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, (*path, index))
    else:
        yield path


def without(raw, path):
    copied = copy.deepcopy(raw)
    target = copied
    for key in path[:-1]:
        target = target[key]
    del target[path[-1]]
    return copied


class Leaf(unittest.TestCase):
    """T-LEAF: deleting any single raw leaf, or erroring any section, never yields False."""
    def test_single_leaf_deletion_and_section_errors(self):
        host = Host(self)
        with host.active():
            raw = host.observe()
            self.assertIs(state.evaluate(state.normalize(raw)), False)
            paths = list(leaves(raw))
            self.assertGreater(len(paths), 200)
            for path in paths:
                if path[-1] == 'state' and len(path) == 2:
                    continue
                with self.subTest(leaf=path):
                    self.assertIsNot(state.evaluate(state.normalize(without(raw, path))), False)
            for name in raw:
                for replacement in ({'state': 'error', 'error': 'OSError'}, {'state': 'not_reached'},
                                    {'state': 'error', 'error': 'CHANGED', 'prior': raw[name]['value']}):
                    with self.subTest(section=name, replacement=replacement['state']):
                        changed = dict(raw, **{name: replacement})
                        self.assertIsNot(state.evaluate(state.normalize(changed)), False)
                self.assertIsNot(state.evaluate(state.normalize({k: v for k, v in raw.items() if k != name})), False)


def legacy_record(path, body=False, root='/'):
    from test_r3_policy_evidence import release_record, unit_scope
    if root != '/':
        return REAL_FILE_RECORD(path, body, root)
    return release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})


REAL_FILE_RECORD = capture.file_record
REAL_READ = state.read


def collect_on(host):
    """The real collector over the host's tree and command bytes (legacy sections are canned)."""
    from test_r3_policy_evidence import BINDING, META, apt_scope, unit_scope, command, snap_record
    def rooted(name, sections, root='/', runner=None, timeout=10):
        return REAL_READ(name, sections, str(host.root), None, timeout)
    with patch.object(evidence, 'command', side_effect=command), \
         patch.object(capture, 'file_record', side_effect=legacy_record), \
         patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
         patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
         patch.object(scope, 'apt_scope', side_effect=apt_scope), \
         patch.object(scope, 'unit_scope', side_effect=unit_scope), \
         patch.object(snap, 'observe', return_value=snap_record()), \
         patch.object(state, 'read', side_effect=rooted), patch.object(state, 'execute', side_effect=host.runner):
        doc = evidence.collect(BINDING)
    return json.loads(encoded(doc)), BINDING


class DomainPaths:
    def paths(self, host, reviewed):
        with host.active(reviewed):
            try:
                facts, _raw, norm = policy.facts_state(str(host.root), host.runner)
                facts['evaluated'] = state.evaluate(norm)  # what PR-C2's wired gate would see
            except (OSError, ValueError):
                facts = None  # the installer refuses outright (e.g. a linked registration)
            raw = host.observe()
            retained = json.loads(encoded(raw))  # what an evidence archive gives back
            controller = state.evaluate(state.normalize(retained))
            doc, binding = collect_on(host)
            checked = validator.validate(encoded(doc), binding)
            collected = state.normalize(state.raw_from_sections(doc['sections']))
        return facts, controller, checked, collected


class Domain(DomainPaths, unittest.TestCase):
    """T-DOMAIN: installer, collector + validator, and a retained-raw controller agree for every
    T-TRUTH tree, from the same bytes (no pre-built raw dicts)."""
    def test_the_installer_gate_is_not_wired_before_pr_c2(self):
        """Security P2-2: even a host whose every conjunct holds gives the installer None, so a
        filled REVIEWED (PR-C1b) cannot pass preflight before PR-C2's mask-record, continuity
        and phase checks exist; the gate itself stays `is not False`."""
        self.assertIs(policy.PACKAGEKIT_GATE_WIRED, False)
        host = Host(self)
        with host.active():
            facts, raw, norm = policy.facts_state(str(host.root), host.runner)
            self.assertIs(state.evaluate(norm), False)
            self.assertIsNone(facts['packagekit_activation_possible'])
            self.assertEqual(policy.facts(str(host.root), host.runner)['packagekit'], facts['packagekit'])
            self.assertEqual(state.volatile(raw)['dbus_main_pid'], str(fx.DBUS_PID))
            with patch.object(policy, 'PACKAGEKIT_GATE_WIRED', True):
                self.assertIs(policy.facts(str(host.root), host.runner)['packagekit_activation_possible'], False)
                os.unlink(host.path(state.MASK_PATH))
                self.assertIs(policy.facts(str(host.root), host.runner)['packagekit_activation_possible'], True)

    def test_complete_collection_hashes_the_c_facts(self):
        host = Host(self)
        with host.active():
            doc, binding = collect_on(host)
            checked = validator.validate(encoded(doc), binding)
            view = state.facts_view(state.normalize(state.raw_from_sections(doc['sections'])))
        self.assertEqual(checked['status'], 'COLLECTED_REVIEW_REQUIRED')
        self.assertIs(checked['packagekit_activation_possible'], False)
        self.assertEqual(checked['predicate_contract'], 'option-c/' + state.REVIEWED['proof_id'])
        sections = doc['sections']
        facts = {'files': {key[5:]: {k: v for k, v in value['value'].items() if k != 'body'} for key, value in sections.items()
                           if key.startswith('file:') and key[5:] not in evidence.EXTRA_FILES},
                 'directories': {p: sections['directory:' + p]['value']['names'] for p in policy.DIRECTORIES},
                 'packagekit_activation_possible': False, 'packagekit': view}
        self.assertEqual(checked['policy_input_hashes']['facts_sha256'], digest(encoded(facts)))

    def test_a_failed_command_is_partial(self):
        for name in state.COMMANDS:
            for fault in ((1, b''), (0, b'warning\n'), (None, b'')):
                with self.subTest(command=name, fault=fault):
                    host = Host(self)
                    host.faults[name] = fault
                    with host.active():
                        doc, binding = collect_on(host)
                        checked = validator.validate(encoded(doc), binding)
                    self.assertEqual(checked['status'], 'PARTIAL_REVIEW_REQUIRED')
                    self.assertEqual(checked['policy_input_hashes'], {})
                    self.assertIsNot(checked['packagekit_activation_possible'], False)

    def test_production_collection_is_discovery_only_and_never_a_policy_input(self):
        host = Host(self)
        with patch.object(state, 'OWNER', host.owner), patch.object(state, 'lstat_at', host.lstat_at):
            doc, binding = collect_on(host)
            checked = validator.validate(encoded(doc), binding)
        self.assertEqual(checked['status'], 'DISCOVERY_ONLY')
        self.assertEqual(checked['policy_input_hashes'], {})
        self.assertIsNone(checked['packagekit_activation_possible'])
        self.assertEqual(doc['format'], 3)
        # A discovery document relabelled with an unknown mode must be refused, never hashed.
        bad = copy.deepcopy(doc)
        bad['sections']['unit-universe']['value']['mode'] = 'partial'
        with self.assertRaises(ValueError):
            validator.validate(encoded(bad), binding)

    def test_discovery_is_decided_by_the_validators_own_selection(self):
        """QA P2-A / security P2-N1: a document's declared mode never yields hashes on its own."""
        host = Host(self)
        with host.active():
            doc, binding = collect_on(host)
            self.assertEqual(validator.validate(encoded(doc), binding)['status'], 'COLLECTED_REVIEW_REQUIRED')
        # Collected in full under one module version, validated under one without that profile.
        with patch.multiple(state, OWNER=host.owner, lstat_at=host.lstat_at):
            checked = validator.validate(encoded(doc), binding)
        self.assertEqual((checked['status'], checked['policy_input_hashes']), ('DISCOVERY_ONLY', {}))
        # The two sections disagree, or name another profile: never full.
        with host.active():
            for name, change in (('dpkg-md5sums', lambda v: v.clear() or v.update(mode='discovery')),
                                 ('unit-universe', lambda v: v.update(profile='other-target'))):
                with self.subTest(section=name):
                    bad = copy.deepcopy(doc)
                    change(bad['sections'][name]['value'])
                    checked = validator.validate(encoded(bad), binding)
                    self.assertEqual((checked['status'], checked['policy_input_hashes']), ('DISCOVERY_ONLY', {}))
        # A production discovery document relabelled as full is refused or discovery, never hashed.
        with patch.multiple(state, OWNER=host.owner, lstat_at=host.lstat_at):
            doc, binding = collect_on(host)
            for value in (doc['sections']['unit-universe']['value'], doc['sections']['dpkg-md5sums']['value']):
                value['mode'] = 'full'
            doc['sections']['dpkg-md5sums']['value']['files'] = {}
            try:
                checked = validator.validate(encoded(doc), binding)
            except ValueError:
                checked = {'status': 'REFUSED', 'policy_input_hashes': {}}
            self.assertEqual(checked['policy_input_hashes'], {})
            self.assertNotEqual(checked['status'], 'COLLECTED_REVIEW_REQUIRED')

    def test_discovery_needs_this_modules_own_index(self):
        host = Host(self)
        with patch.multiple(state, OWNER=host.owner, lstat_at=host.lstat_at):
            raw = host.observe()
            raw['unit-universe']['value']['mode'] = 'full'
            raw['dpkg-md5sums']['value'] = {'mode': 'full', 'files': {}}
            self.assertIsNone(raw['unit-universe']['value']['profile'])
            self.assertTrue(state.discovery(raw))  # no reviewed profile here, whatever the sections say

    def test_drift_between_reads_is_partial(self):
        host = Host(self)
        calls = {}
        def drifting(name, sections, root='/', runner=None, timeout=10):
            calls[name] = calls.get(name, 0) + 1
            value = REAL_READ(name, sections, str(host.root), None, timeout)
            if name == 'link:/var/run' and calls[name] == 2:
                value['target'] = '/srv'
            if name == 'dbus-daemon-proc' and calls[name] == 2:
                value['cmdline'] = capture.blob(b'@dbus-daemon\0--system\0')
            return value
        with host.active():
            from test_r3_policy_evidence import BINDING, META, apt_scope, unit_scope, command, snap_record
            with patch.object(evidence, 'command', side_effect=command), \
                 patch.object(capture, 'file_record', side_effect=legacy_record), \
                 patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
                 patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
                 patch.object(scope, 'apt_scope', side_effect=apt_scope), \
                 patch.object(scope, 'unit_scope', side_effect=unit_scope), \
                 patch.object(snap, 'observe', return_value=snap_record()), \
                 patch.object(state, 'read', side_effect=drifting), patch.object(state, 'execute', side_effect=host.runner):
                doc = json.loads(encoded(evidence.collect(BINDING)))
            self.assertEqual(doc['sections']['link:/var/run']['error'], 'CHANGED')
            self.assertEqual(doc['sections']['dbus-daemon-proc']['error'], 'CHANGED')
            self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'PARTIAL_REVIEW_REQUIRED')
            # Every re-read section was read twice; the process identity alone is compared.
            self.assertEqual({n for n, c in calls.items() if c == 2}, set(state.REREAD))
            # A second unit read that differs field by field is partial too.
            doc, binding = collect_on(host)
            doc['sections']['pk-units-after']['value'] = state.command('pk-units', lambda a, t: (
                fx.unit_text({**host.units, 'packagekit.service': {**host.units['packagekit.service'], 'NRestarts': '1'}}), b'', 0))
            self.assertEqual(validator.validate(encoded(doc), binding)['status'], 'PARTIAL_REVIEW_REQUIRED')
            doc, binding = collect_on(host)
            self.assertEqual(validator.validate(encoded(doc), binding)['status'], 'COLLECTED_REVIEW_REQUIRED')

    def test_malformed_sections_refuse_the_document(self):
        host = Host(self)
        with host.active():
            doc, binding = collect_on(host)
            for name, change in (('unit-candidates', lambda v: v['roots'].pop('/run/systemd/transient')),
                                 ('pk-units', lambda v: v.update(argv=['systemctl', 'show'])),
                                 ('dbus-daemon-proc', lambda v: v.update(extra=1)),
                                 ('unit-universe', lambda v: v.update(mode='partial'))):
                with self.subTest(section=name):
                    bad = copy.deepcopy(doc)
                    change(bad['sections'][name]['value'])
                    with self.assertRaises(ValueError):
                        validator.validate(encoded(bad), binding)
            bad = copy.deepcopy(doc)
            fragment = bad['sections']['pk-fragments']['value']['/usr/lib/systemd/system/dbus.service']
            fragment['bytes'] += 1  # a size that is not the body's
            with self.assertRaises(ValueError):
                validator.validate(encoded(bad), binding)
            bad = copy.deepcopy(doc)
            bad['sections']['pk-dpkg-index']['value']['argv'] = ['dpkg-query', '-L', 'openssh-server']
            with self.assertRaises(ValueError):
                validator.validate(encoded(bad), binding)
            bad = copy.deepcopy(doc)
            del bad['sections']['pk-dpkg-index']
            with self.assertRaises(ValueError):
                validator.validate(encoded(bad), binding)


class DomainCases(DomainPaths, unittest.TestCase):
    """T-DOMAIN over every T-TRUTH tree. Its own class so that mutation routes outside the
    state module can run the targeted Domain tests alone (CI time)."""
    def test_every_tree_case_agrees_on_every_path(self):
        cases = [(None, None)] + [(tree, reviewed_change) for _n, _e, tree, reviewed_change, raw_change in TRUTH
                                  if tree is not None and raw_change is None]
        for index, (tree, reviewed_change) in enumerate(cases):
            with self.subTest(case=index):
                host = Host(self)
                if tree:
                    tree(host)
                reviewed = copy.deepcopy(host.reviewed)
                if reviewed_change:
                    reviewed_change(reviewed)
                facts, controller, checked, collected = self.paths(host, reviewed)
                if facts is None:
                    self.assertIsNot(checked['packagekit_activation_possible'], False)
                    self.assertIsNot(controller, False)
                    continue
                self.assertIs(checked['packagekit_activation_possible'], facts['evaluated'])
                self.assertIs(controller, facts['evaluated'])
                self.assertIsNone(facts['packagekit_activation_possible'])  # not wired before PR-C2
                self.assertEqual(state.facts_view(collected), facts['packagekit'])
                self.assertEqual(checked['predicate_contract'], 'option-c/' + state.REVIEWED['proof_id'])


class ClockBoundaries(unittest.TestCase):
    """C15 ctime rule on both sides of the boundary (G1/N1, O15, security H2)."""
    def proc(self, **changes):
        value = {'btime': [1000, 1000], 'start_ticks': 500 * 100, 'clk_tck': 100, 'wall_ns': 10**13}
        value.update(changes)
        return value

    def test_boundaries(self):
        start = (1000 + 500) * 10**9
        dbus = {'ExecMainStartTimestamp': '@1500'}
        margin = state.CTIME_MARGIN_NS
        rule = state.ctime_rule
        self.assertIs(rule(self.proc(), dbus, [start - margin]), True)
        self.assertIs(rule(self.proc(), dbus, [1, start - margin - 1]), True)  # image-built files predate the start
        self.assertIs(rule(self.proc(), dbus, [start - margin + 1]), False)   # inside (start - M, start)
        self.assertIs(rule(self.proc(), dbus, [start]), False)
        self.assertIs(rule(self.proc(), dbus, [start + 1]), False)            # later: never True
        self.assertIs(rule(self.proc(wall_ns=start - margin - 10), dbus, [start - margin]), False)  # future ctime
        self.assertIs(rule(self.proc(btime=[1000, 1002]), dbus, [1]), False)  # btime step within one boot
        self.assertIs(rule(self.proc(btime=[1000, 1001]), dbus, [1]), True)
        self.assertIs(rule(self.proc(), {'ExecMainStartTimestamp': '@1400'}, [start - margin]), False)  # H2
        self.assertIs(rule(self.proc(), {'ExecMainStartTimestamp': ''}, [1]), False)
        self.assertIs(rule(self.proc(), dbus, []), False)


class Frozen(unittest.TestCase):
    """T-FROZEN: independent literals, never imported from the module under test."""
    def test_commands_sections_and_lists(self):
        props = ('Id,Names,LoadState,UnitFileState,ActiveState,SubState,Job,FragmentPath,DropInPaths,NeedDaemonReload,'
                 'InvocationID,InactiveExitTimestampMonotonic,ActiveEnterTimestampMonotonic,ActiveExitTimestampMonotonic,'
                 'InactiveEnterTimestampMonotonic,MainPID,NRestarts,ExecMainStartTimestamp')
        self.assertEqual(state.COMMANDS, {
            'pk-units': ['systemctl', 'show', '--no-pager', '--timestamp=unix', '--property=' + props,
                         'packagekit.service', 'dbus.service', 'dbus.socket', 'packagekit-offline-update.service',
                         'packagekit.socket', 'packagekit.path', 'packagekit.timer'],
            'manager': ['systemctl', 'show', '--no-pager', '--property=UnitPath,Version'],
            'pk-package-metadata': ['dpkg-query', '-W',
                                    '-f=${binary:Package}\\t${Version}\\t${source:Package}\\t${source:Version}\\t${db:Status-Status}\\n',
                                    'dbus*', 'libdbus-1-3*', 'systemd', 'systemd-sysv', 'libsystemd-shared', 'libsystemd0*',
                                    'libglib2.0*', 'packagekit*', 'init-system-helpers', 'needrestart', 'linux-image-*']})
        self.assertEqual(evidence.C_COMMANDS, {'pk-dpkg-index': ['dpkg-query', '-L', 'packagekit', 'dbus-daemon',
            'dbus-system-bus-common', 'dbus-user-session', 'libsystemd-shared', 'libglib2.0-0t64']})
        self.assertEqual(state.SECTION_NAMES, (
            'pk-units', 'manager', 'pk-package-metadata', 'link:/etc/systemd/system/packagekit.service', 'link:/var/run',
            'link:/lib', 'dir-meta:/var', 'device:/dev/null', 'dbus-socket', 'unit-candidates', 'unit-universe',
            'dpkg-md5sums', 'pk-fragments', 'dbus-service-dirs', 'dbus-config', 'dbus-daemon-proc', 'pk-binaries',
            'pk-processes'))
        self.assertEqual(state.REREAD, (
            'link:/etc/systemd/system/packagekit.service', 'link:/var/run', 'link:/lib', 'dir-meta:/var',
            'device:/dev/null', 'unit-candidates', 'unit-universe', 'dpkg-md5sums', 'pk-fragments', 'dbus-service-dirs',
            'dbus-config', 'dbus-daemon-proc', 'pk-binaries'))
        self.assertEqual(state.UNIT_ROOTS, (
            '/etc/systemd/system.control', '/run/systemd/system.control', '/run/systemd/transient',
            '/run/systemd/generator.early', '/etc/systemd/system', '/etc/systemd/system.attached', '/run/systemd/system',
            '/run/systemd/system.attached', '/run/systemd/generator', '/usr/local/lib/systemd/system',
            '/usr/lib/systemd/system', '/run/systemd/generator.late'))
        self.assertEqual(state.SERVICE_DIRS, ('/usr/local/share/dbus-1/system-services', '/usr/share/dbus-1/system-services',
                                              '/usr/lib/dbus-1/system-services'))
        self.assertEqual(state.CONFIG_FILES, ('/usr/share/dbus-1/system.conf', '/etc/dbus-1/system.conf',
                                              '/etc/dbus-1/system-local.conf'))
        self.assertEqual(state.CONFIG_DIRS, ('/usr/share/dbus-1/system.d', '/etc/dbus-1/system.d'))
        self.assertEqual(state.C5_NAMES, ('packagekit.service', 'packagekit.service.d', 'packagekit@.service',
                                          'packagekit@.service.d', 'dbus-org.freedesktop.PackageKit.service'))
        self.assertEqual(state.C14_NAMES, ('packagekit.socket', 'packagekit.path', 'packagekit.timer', 'packagekit@.socket'))
        self.assertEqual(state.VENDOR_FRAGMENT, '/usr/lib/systemd/system/packagekit.service')
        self.assertEqual(state.USER_ROOTS, (
            '/root/.config/systemd/user.control', '/run/user/0/systemd/user.control', '/run/user/0/systemd/transient',
            '/run/user/0/systemd/generator.early', '/root/.config/systemd/user', '/etc/systemd/user', '/etc/xdg/systemd/user',
            '/run/user/0/systemd/user', '/run/systemd/user', '/run/user/0/systemd/generator',
            '/root/.local/share/systemd/user', '/usr/local/share/systemd/user', '/usr/share/systemd/user',
            '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', '/var/lib/snapd/desktop/systemd/user',
            '/run/user/0/systemd/generator.late'))
        self.assertEqual(state.SESSION_DIRS, ('/root/.local/share/dbus-1/services', '/usr/local/share/dbus-1/services',
                                              '/usr/share/dbus-1/services', '/var/lib/snapd/desktop/dbus-1/services',
                                              '/run/user/0/dbus-1/services'))
        self.assertEqual(state.DBUS_PARENTS, ('/usr/share/dbus-1', '/etc/dbus-1', '/usr/local/share/dbus-1', '/usr/lib/dbus-1'))
        self.assertEqual(state.C12_FILES, (
            '/usr/libexec/packagekitd', '/usr/bin/dbus-daemon', '/usr/lib/dbus-1.0/dbus-daemon-launch-helper',
            '/usr/lib/systemd/systemd', '/usr/lib/x86_64-linux-gnu/systemd/libsystemd-shared-255.so',
            '/usr/lib/x86_64-linux-gnu/libgio-2.0.so.0.8000.0'))
        self.assertEqual(state.PK_FRAGMENTS, (
            '/usr/lib/systemd/system/dbus.service', '/usr/lib/systemd/system/dbus.socket',
            '/usr/lib/systemd/system/packagekit.service', '/usr/lib/systemd/system/packagekit-offline-update.service'))
        self.assertEqual(state.PK_PROCESSES, {'packagekitd', 'pk-offline-update', 'pk-offline-upda'})
        self.assertEqual(state.CANDIDATES, (*state.C5_NAMES, *state.C14_NAMES, 'dbus.service.d', 'dbus.socket.d',
                                            'service.d', 'socket.d'))
        self.assertEqual(state.SYSTEM_UPDATE, ('/system-update', '/etc/system-update'))
        self.assertEqual(state.VOLATILE_UNIT, ('MainPID', 'Job', 'InvocationID', 'NRestarts', 'InactiveExitTimestampMonotonic',
                                               'ActiveEnterTimestampMonotonic', 'ActiveExitTimestampMonotonic',
                                               'InactiveEnterTimestampMonotonic', 'ExecMainStartTimestamp'))
        self.assertEqual(state.OUTPUT_LIMITS, {'pk-units': 131072, 'manager': 16384, 'pk-package-metadata': 131072})
        self.assertEqual(state.SO_ACCEPTCON, 0x10000)
        self.assertEqual(state.VOLATILE_NAME.pattern, 'snap[-.]')
        self.assertEqual(state.ESCAPES.pattern, rb'\\[xuU0-7]')
        self.assertEqual(state.INDIRECTION.pattern, r'[%$*?\[`]|(^|\s)-[A-Za-z]*c[A-Za-z]*(\s|$)')
        self.assertEqual(state.RISKY_TAGS.pattern, rb'<\s*(servicedir|servicehelper|standard_system_servicedirs|'
                                                   rb'standard_session_servicedirs|include|includedir)\b')
        self.assertEqual(state.CTIME_MARGIN_NS, 2_000_000_000)

    def test_mask_invariants_v1_bytes_are_frozen(self):
        """Golden: a fixed view gives pinned bytes, whatever later module edits do (F1)."""
        def entry(**values):
            return {'type': 'absent', **values}
        roots = {root: {'entries': {name: entry() for name in (*state.CANDIDATES, 'later-name.service')}}
                 for root in state.UNIT_ROOTS}
        roots['/run/systemd/transient'] = {'absent': True}
        roots['/run/systemd/later-root'] = {'entries': {name: entry() for name in state.CANDIDATES}}  # never in v1
        roots['/etc/systemd/system']['entries']['packagekit.service'] = {'type': 'link', 'target': '/dev/null'}
        parents = [{'uid': 0, 'gid': 0, 'mode': 0o755, 'later': 1}] * 4
        units = {name: {'Id': name, 'Names': name, 'LoadState': 'not-found', 'UnitFileState': '', 'ActiveState': 'inactive',
                        'SubState': 'dead', 'FragmentPath': '', 'DropInPaths': '', 'NeedDaemonReload': 'no',
                        'job_empty': True, 'main_pid_zero': None, 'later': 2} for name in state.PK_UNITS}
        units['packagekit.service'].update(LoadState='masked', UnitFileState='masked', FragmentPath=state.MASK_PATH,
                                           main_pid_zero=True)
        view = {'pk_core': {'mask_link': {'type': 'link', 'uid': 0, 'gid': 0, 'mode': 0o777, 'target': '/dev/null',
                                          'parents': parents, 'later': 3},
                            'dev_null': {'type': 'char', 'uid': 0, 'gid': 0, 'mode': 0o666, 'rdev': [1, 3],
                                         'parents': parents[:2]},
                            'candidates': roots, 'units': units}}
        value = state.MASK_INVARIANTS[1](view)
        self.assertIs(state.MASK_INVARIANTS[1], state.mask_invariants_v1)
        self.assertEqual(set(state.MASK_INVARIANTS), {1})
        self.assertEqual(digest(encoded(value)), V1_GOLDEN)

    def test_mask_invariants_v1_is_frozen(self):
        self.assertEqual(state.MASK_INVARIANTS_V1, ('mask_link', 'dev_null', 'candidates', 'unit', 'trigger_units'))
        self.assertEqual(state.MASK_UNIT_V1, ('Id', 'Names', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState',
                                              'main_pid_zero', 'job_empty', 'NeedDaemonReload', 'DropInPaths',
                                              'FragmentPath'))
        host = Host(self)
        with host.active():
            view = state.facts_view(state.normalize(host.observe()))
        value = state.mask_invariants_v1(view)
        self.assertEqual(set(value), {'mask_invariants_format', 'mask_link', 'dev_null', 'candidates', 'unit', 'trigger_units'})
        self.assertEqual(value['mask_invariants_format'], 1)
        self.assertEqual(value['mask_link']['target'], '/dev/null')
        self.assertEqual(value['trigger_units'], {'packagekit.socket': 'not-found', 'packagekit.path': 'not-found',
                                                  'packagekit.timer': 'not-found'})
        self.assertEqual(set(next(iter(value['candidates'].values()))) if not next(iter(value['candidates'].values())).get('absent')
                         else set(), set())  # the first root is absent on this host
        self.assertEqual(set(value['candidates']['/etc/systemd/system']), {
            'packagekit.service', 'packagekit.service.d', 'packagekit@.service', 'packagekit@.service.d',
            'dbus-org.freedesktop.PackageKit.service', 'packagekit.socket', 'packagekit.path', 'packagekit.timer',
            'packagekit@.socket'})

    def test_production_reviewed_values(self):
        reviewed = state.REVIEWED
        with self.assertRaises(TypeError):
            reviewed['o10_ok'] = True
        self.assertEqual(dict(reviewed, discovery_caps=dict(reviewed['discovery_caps'])), {
            'proof_id': 'o1-o14-findings01:410717a7f1f417776bcb14fa4c7d78788613e3259519e6c6130f5054ae41ad13',
            'registration_sha256': '6fbf6a1c93cc31edf72431901fae7c3931fd5f52856d3298ce09ae69466e4022',
            'unit_roots': state.UNIT_ROOTS, 'dev_null': (1, 3), 'o10_ok': False, 'o13_mode': 'ctime_rule',
            'discovery_caps': {'entries': 2048}, 'profiles': ()})
        self.assertEqual(state.OWNER, (0, 0))
        self.assertEqual(state.UNIVERSE_BODY_LIMIT, 65536)

    def test_profile_shape_rules(self):
        self.assertEqual(state.profile_errors(state.REVIEWED), [])
        host = Host(self)
        self.assertEqual(state.profile_errors(host.reviewed), [])
        good = host.reviewed['profiles'][0]
        cases = {'keys': dict(good, extra=1), 'code': copy.deepcopy(good)}
        cases['code']['code']['kernel_row'] = ['linux-image-9.9.9-1-generic', '1', 'linux', '1', 'installed']
        for reason, profile in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(state.profile_errors({'profiles': (profile,)}), [(good['id'], reason)])
        missing = copy.deepcopy(good)
        missing['allow'].pop('caps')
        self.assertEqual(state.profile_errors({'profiles': (missing,)}), [(good['id'], 'keys')])
        twin = dict(copy.deepcopy(good), id='twin')
        self.assertEqual(state.profile_errors({'profiles': (good, twin)}), [('twin', 'duplicate code identity')])

    def test_units_and_managers_keep_their_fca74df_values(self):
        import r3_apt_observer
        self.assertEqual(r3_apt_observer.UNITS, ('apt-daily.timer', 'apt-daily-upgrade.timer', 'apt-daily.service',
                                                 'apt-daily-upgrade.service', 'unattended-upgrades.service'))
        self.assertEqual(r3_apt_observer.MANAGERS, {'apt', 'apt-get', 'dpkg', 'unattended-upgrade', 'unattended-upgrades',
                                                    'unattended-upgr', 'apt.systemd.daily', 'apt.systemd.dai', 'packagekitd',
                                                    'aptd', 'synaptic'})


class Route(unittest.TestCase):
    """T-ROUTE: the read-only A collection route runs only the module's fixed argv and never
    reaches mask, installation or maintenance code."""
    def test_policy_collection_route_is_read_only(self):
        result, argv = self.route(production=False)
        self.assertEqual(result['status'], 'COLLECTED_REVIEW_REQUIRED')
        self.assertIs(result['install_attempted'], False)
        self.assertTrue(argv)
        self.assertLessEqual({tuple(a) for a in argv}, {tuple(v) for v in state.COMMANDS.values()})
        self.assertNotIn('r3_packagekit_mask', sys.modules)

    def test_every_sealing_consumer_shares_the_complete_statuses(self):
        self.assertEqual(validator.SEALED_STATUSES, ('COLLECTED_REVIEW_REQUIRED', 'DISCOVERY_ONLY'))
        for name in ('r3_noble_guest.py', 'r3_noble_fixture.py', 'r3_policy_receive.py', 'r3_policy_target.py'):
            with self.subTest(module=name):
                self.assertIn('SEALED_STATUSES', (SCRIPTS / name).read_text())
                self.assertNotIn("== 'COLLECTED_REVIEW_REQUIRED' else", (SCRIPTS / name).read_text())

    def test_a_discovery_run_completes_but_is_never_a_policy_input(self):
        result, _argv = self.route(production=True)
        self.assertEqual(result['status'], 'DISCOVERY_ONLY')
        self.assertEqual(result['checks']['policy_input_hashes'], {})

    def route(self, production):
        import r3_noble_guest as guest
        import r3_noble_fixture as controller
        from test_r3_policy_evidence import BINDING, META, apt_scope, unit_scope, command, snap_record
        from r3_noble_common import write
        host = Host(self)
        manifest = {'purpose': evidence.A_PURPOSE, 'source': BINDING['source'], 'image_sha256': BINDING['image_sha256'],
                    'fixture_uuid': BINDING['fixture_uuid'], 'files': {'r3-toolchain.lock.json': BINDING['toolchain_sha256']}}
        argv = []
        def runner(value, timeout):
            argv.append(value)
            return host.runner(value, timeout)
        def rooted(name, sections, root='/', runner=None, timeout=10):
            return REAL_READ(name, sections, str(host.root), None, timeout)
        active = (patch.multiple(state, OWNER=host.owner, lstat_at=host.lstat_at) if production else host.active())
        with tempfile.TemporaryDirectory() as tmp, active:
            output, port, inputs = Path(tmp) / 'output', Path(tmp) / 'port', Path(tmp) / 'inputs'
            inputs.mkdir()
            write(inputs / 'manifest.json', encoded(manifest))
            def verified(_purposes):
                write(output / 'manifest.json', encoded(manifest))
                return manifest
            with patch.object(guest, 'INPUT', inputs), patch.object(guest, 'OUTPUT', output), patch.object(guest, 'PORT', str(port)), \
                 patch.object(guest, 'verify_input', side_effect=verified), \
                 patch.object(evidence, 'command', side_effect=command), \
                 patch.object(capture, 'file_record', side_effect=legacy_record), \
                 patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
                 patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
                 patch.object(scope, 'apt_scope', side_effect=apt_scope), \
                 patch.object(scope, 'unit_scope', side_effect=unit_scope), \
                 patch.object(snap, 'observe', return_value=snap_record()), \
                 patch.object(state, 'read', side_effect=rooted), patch.object(state, 'execute', side_effect=runner), \
                 patch.object(guest, 'installation_main', side_effect=AssertionError('installation entered')), \
                 patch.object(guest.r3_maintenance, 'isolate', side_effect=AssertionError('maintenance entered')), \
                 patch.object(guest, 'run', side_effect=AssertionError('mutation reached')):
                self.assertEqual(guest.main(), 0)
            result = controller.validate_frame(port.read_bytes(), manifest)
        return result, argv


class Legacy(unittest.TestCase):
    """T-LEGACY: formats 1/2 keep status, hashes and predicate and gain only the contract name;
    their facts can never hash-equal option C facts."""
    def test_legacy_documents(self):
        from test_r3_policy_evidence import BINDING, document, document_v2
        for build in (document, document_v2):
            with self.subTest(format=build.__name__):
                result = validator.validate(encoded(build()), BINDING)
                self.assertEqual(result['predicate_contract'], 'legacy')
                self.assertEqual(result['status'], 'COLLECTED_REVIEW_REQUIRED')
                self.assertIs(result['packagekit_activation_possible'], False)
                # Computed at base 1304cee: legacy hashes are unchanged by format 3.
                self.assertEqual(result['policy_input_hashes']['facts_sha256'],
                                 'a2be67e4d93fa607f663020ae9b3437a949773d87dd636a27f8083d7d74cee39')
                self.assertEqual(result['policy_input_hashes']['inventory_sha256'],
                                 '90a4afaed4d344c576fa49f729c5e1e695133e6583da8ce159c9724867d69a9f')
                self.assertEqual(set(result), {'status', 'predicate_contract', 'packagekit_activation_possible',
                                               'policy_input_hashes', 'qualification', 'installation_success',
                                               'policy_generated'})

    def test_c_facts_never_equal_legacy_facts(self):
        host = Host(self)
        with host.active():
            facts = policy.facts(str(host.root), host.runner)
        self.assertEqual(set(facts), {'files', 'directories', 'packagekit_activation_possible', 'packagekit'})
        legacy = {key: value for key, value in facts.items() if key != 'packagekit'}
        self.assertNotEqual(digest(encoded(legacy)), digest(encoded(facts)))
        # A policy bound to legacy-shaped facts refuses the C observation at preflight.
        from test_r3_maintenance_policy import LOCK_BYTES, fixture
        value, before, _facts = fixture()
        value['facts_sha256'] = digest(encoded(legacy))
        with self.assertRaisesRegex(ValueError, 'baseline/configuration differs'):
            policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})


class Drift(unittest.TestCase):
    """T-DRIFT S1/S2/S3 at the state level: the event projection survives what it should."""
    def projection(self, host, reviewed=None):
        with host.active(reviewed):
            norm = state.normalize(host.observe())
            return digest(encoded(state.mask_invariants_v1(state.facts_view(norm)))), state.evaluate(norm)

    def test_s1_unrelated_drift_keeps_the_mask_record(self):
        host = Host(self)
        before = self.projection(host)
        with host.active():
            facts_before = policy.facts(str(host.root), host.runner)
        host.write('/etc/apt/apt.conf', b'APT::Get::Assume-Yes "true";\n')
        host.write('/etc/systemd/system/backup.timer', b'[Timer]\nOnCalendar=daily\n')
        after = self.projection(host)
        with host.active():
            facts_after = policy.facts(str(host.root), host.runner)
        self.assertEqual(before, after)
        self.assertEqual(after[1], False)
        self.assertNotEqual(facts_before, facts_after)  # a new collection and policy are required

    def test_s3_reviewed_value_change_gives_none_until_reviewed_then_same_record(self):
        host = Host(self)
        before = self.projection(host)
        rows(lambda r: r[4].__setitem__(1, '255.4-1ubuntu8.19'))(host)
        changed = self.projection(host)
        self.assertEqual((changed[0], changed[1]), (before[0], None))
        reviewed = copy.deepcopy(host.reviewed)
        systemd = next(row for row in reviewed['profiles'][0]['code']['rows'] if row[0] == 'systemd')
        systemd[1] = '255.4-1ubuntu8.19'
        self.assertEqual(self.projection(host, reviewed), (before[0], False))

    def test_s2_mask_invariant_change_changes_the_projection(self):
        for change in (remove(state.MASK_PATH), replace_link(state.MASK_PATH, '/dev/zero'),
                       write('/run/systemd/system/packagekit.service', b'[Service]\n'),
                       unit('packagekit.service', ActiveState='active')):
            with self.subTest(change=change):
                host = Host(self)
                before = self.projection(host)
                change(host)
                after = self.projection(host)
                self.assertNotEqual(before[0], after[0])
                self.assertIs(after[1], True)


class Universe(unittest.TestCase):
    """QA M1: the facts digest covers stable admin and package roots only; the C13 verdict
    still covers every root."""
    def view(self, host):
        with host.active():
            norm = state.normalize(host.observe())
        return norm['unit_universe_digest'], norm['c13_verdict']

    def test_volatile_roots_and_snap_units_leave_the_digest(self):
        host = Host(self)
        before = self.view(host)
        host.write('/run/systemd/transient/session-4.scope', b'[Scope]\n')
        host.write('/run/user/0/systemd/transient/run-u9.service', b'[Service]\nExecStart=/bin/true\n')
        host.write('/etc/systemd/system/snap-core22-2.mount', b'[Mount]\nWhat=/var/lib/snapd/snaps/core22_2.snap\n')
        host.link('/etc/systemd/system/snapd.mounts.target.wants/snap-core22-2.mount',
                  '/etc/systemd/system/snap-core22-2.mount')
        host.write('/etc/systemd/system/snap.lxd.daemon.service', b'[Service]\nExecStart=/usr/bin/snap run lxd.daemon\n')
        self.assertEqual(self.view(host), before)

    def test_stable_roots_change_the_digest_and_volatile_activators_are_still_found(self):
        host = Host(self)
        before = self.view(host)
        host.write('/etc/systemd/system/backup.timer', b'[Timer]\n')
        self.assertNotEqual(self.view(host)[0], before[0])
        host = Host(self)
        host.write('/etc/systemd/system/local.service', fx.ADMIN_UNIT.replace(b'--nightly', b'--nightlx'))  # same size
        self.assertNotEqual(self.view(host)[0], before[0])  # body bytes, not only names
        host = Host(self)
        host.write('/run/systemd/transient/run-u7.service', b'[Service]\nExecStart=/usr/libexec/packagekitd\n')
        digest_value, verdict = self.view(host)
        self.assertEqual(digest_value, before[0])
        self.assertIs(verdict, True)

    def test_a_relative_parent_link_from_a_scanned_directory_resolves(self):
        host = Host(self)
        link('/usr/lib/systemd/system/multi-user.target.wants/ssh.service', '../ssh.service')(host)
        self.assertIs(host.evaluate(), False)

    def test_links_through_the_reviewed_lib_alias_resolve(self):
        host = Host(self)
        link('/etc/systemd/system/sockets.target.wants/ssh.service', '/lib/systemd/system/ssh.service')(host)
        self.assertIs(host.evaluate(), False)
        reviewed = copy.deepcopy(host.reviewed)
        reviewed['profiles'][0]['allow']['lib_alias'] = 'usr/lib64'
        self.assertIsNone(host.evaluate(reviewed))

    def test_reviewed_out_of_root_link_literal(self):
        host = Host(self)
        link('/etc/systemd/system/foo.service', '/opt/units/foo.service')(host)
        reviewed = copy.deepcopy(host.reviewed)
        self.assertIsNone(host.evaluate(reviewed))
        reviewed['profiles'][0]['allow']['link_targets'] = {'/etc/systemd/system/foo.service': '/opt/units/foo.service'}
        self.assertIs(host.evaluate(reviewed), False)


class FixtureCleanup(unittest.TestCase):
    """The synthetic hosts never outlive their test, even when building one fails."""
    def root(self):
        directory = tempfile.TemporaryDirectory(prefix='r3fx-', dir='/tmp')
        self.addCleanup(directory.cleanup)
        environment = patch.dict(os.environ, {'R3_PK_FIXTURE_ROOT': directory.name})
        environment.start()
        self.addCleanup(environment.stop)
        return Path(directory.name)

    def test_hosts_are_rooted_where_the_runner_says(self):
        root = self.root()
        host = Host(self)
        self.assertEqual(host.root.parent, root.resolve())

    def test_a_shared_host_that_fails_to_build_removes_its_root(self):
        root = self.root()
        for failure in (RuntimeError('broken'), KeyboardInterrupt()):
            with patch.object(Host, 'build', side_effect=failure), self.assertRaises(type(failure)):
                Host()
            self.assertEqual(list(root.iterdir()), [])

    def test_a_test_host_that_fails_to_build_is_removed_by_its_cleanup(self):
        root = self.root()
        case = unittest.TestCase()
        with patch.object(Host, 'build', side_effect=RuntimeError('broken')), self.assertRaises(RuntimeError):
            Host(case)
        self.assertEqual(len(list(root.iterdir())), 1)
        case.doCleanups()
        self.assertEqual(list(root.iterdir()), [])


class Volatile(unittest.TestCase):
    def test_volatile_holds_the_dropped_values_and_refuses_gaps(self):
        host = Host(self)
        with host.active():
            raw = host.observe()
            value = state.volatile(raw)
            self.assertEqual(value['dbus_main_pid'], str(fx.DBUS_PID))
            self.assertEqual(value['listener_inodes'], [fx.LISTENER])
            self.assertEqual(value['btime'], host.btime)
            self.assertEqual(value['packagekit'], {key: host.units['packagekit.service'][key] for key in state.VOLATILE_UNIT})
            self.assertEqual(value['dbus_start_ticks'], (host.start_wall - host.btime) * host.clk_tck)
            self.assertEqual(value['boot_id'], '0f0e0d0c-0b0a-0908-0706-050403020100')
            self.assertIsNotNone(value['socket_identity'])
            norm = state.normalize(raw)
            text = encoded(state.facts_view(norm)).decode()
            for dropped in (str(host.btime), value['boot_id'], 'a' * 32):
                self.assertNotIn(dropped, text)
            for name in ('pk-units', 'dbus-daemon-proc'):
                with self.subTest(section=name), self.assertRaises((state.Unavailable, ValueError, KeyError)):
                    state.volatile(dict(raw, **{name: {'state': 'error', 'error': 'OSError'}}))


if __name__ == '__main__':
    unittest.main()
