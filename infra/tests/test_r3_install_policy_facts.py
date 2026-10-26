"""Installer facts versus the collector on real temporary trees; never the host's own files or bus."""
import copy
import json
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_install_policy as policy
import r3_maintenance as maintenance
import r3_packagekit_state as pk_state
import r3_policy_capture as capture
from r3_package_fixtures import observation
from test_r3_maintenance_policy import LOCK_BYTES, fixture

SERVICE = '/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'
REFUSED = 'REFUSED'


class Tree:
    """A minimal root: the installer's directories, an optional registration and one bus-socket shape."""
    def __init__(self, test, registration, bus):
        # AF_UNIX paths are short (104 bytes on macOS): /tmp resolves to /private/tmp there and exists on Linux.
        self.root = Path(tempfile.mkdtemp(prefix='r3f-', dir='/tmp')).resolve()
        test.addCleanup(shutil.rmtree, self.root, True)
        for directory in policy.DIRECTORIES:
            (self.root / directory.lstrip('/')).mkdir(parents=True, exist_ok=True)
            # A member in every directory, so each per-entry read is compared too.
            (self.root / directory.lstrip('/') / 'member').write_bytes(directory.encode() + b'\n')
        if registration:
            path = self.root / SERVICE.lstrip('/')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'[D-BUS Service]\nName=org.freedesktop.PackageKit\nSystemdService=packagekit.service\n')
        run = self.root / 'run'
        if bus == 'no-run':
            return
        run.mkdir()
        if bus == 'no-dbus':
            return
        if bus == 'linked-dbus':
            (self.root / 'elsewhere').mkdir()
            self.bind(self.root / 'elsewhere/system_bus_socket', test)
            (run / 'dbus').symlink_to(self.root / 'elsewhere')
            return
        (run / 'dbus').mkdir()
        target = run / 'dbus/system_bus_socket'
        if bus == 'socket':
            self.bind(target, test)
        elif bus == 'regular':
            target.write_bytes(b'not a socket')
        elif bus == 'linked-socket':
            self.bind(run / 'dbus/real', test)
            target.symlink_to('real')
        elif bus == 'dangling-link':
            target.symlink_to('absent')
        else:
            assert bus == 'no-socket', bus

    def bind(self, path, test):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        test.addCleanup(server.close)
        server.bind(str(path))

    @staticmethod
    def runner(_argv, _timeout):
        return b'', b'synthetic: no systemd or dpkg here\n', 1

    def installer(self):
        return policy.facts(str(self.root), self.runner)

    def collector(self):
        """What the collector records for the same tree: file records and the shared dbus-socket section."""
        files = {name: capture.file_record(name, root=str(self.root)) for name in policy.FIXED}
        return files, pk_state.operation(lambda: pk_state.read('dbus-socket', {}, str(self.root)))


class SameTree(unittest.TestCase):
    """T-SAME-TREE under option C: the installer and the collector read the socket with one
    reader, and on these minimal trees (no /proc, no systemd) both refuse: the predicate is
    None, never False. Full trees are covered by T-DOMAIN in test_r3_packagekit_state."""
    EXPECTED = {'socket': {'exists': True, 'socket': True}, 'no-socket': {'exists': False, 'socket': False},
                'no-dbus': {'exists': False, 'socket': False}, 'no-run': {'exists': False, 'socket': False},
                'regular': REFUSED, 'linked-socket': REFUSED, 'dangling-link': REFUSED, 'linked-dbus': REFUSED}

    def test_predicate_and_file_records_match_or_both_refuse(self):
        for registration in (True, False):
            for bus, expected in self.EXPECTED.items():
                with self.subTest(registration=registration, bus=bus):
                    tree = Tree(self, registration, bus)
                    installer, (files, socket_section) = tree.installer(), tree.collector()
                    observed = pk_state.observe(str(tree.root), Tree.runner)['dbus-socket']
                    self.assertEqual(observed, socket_section)
                    if expected == REFUSED:
                        # An unsafe socket is an error section, whether or not PackageKit is registered.
                        self.assertEqual(socket_section['state'], 'error')
                    else:
                        self.assertEqual(socket_section, {'state': 'ok', 'value': expected})
                    self.assertIsNone(installer['packagekit_activation_possible'])
                    self.assertEqual({name: installer['files'][name] for name in policy.FIXED}, files)

    def test_the_real_registration_record_is_identical_on_both_sides(self):
        tree = Tree(self, True, 'socket')
        installer, (files, _socket) = tree.installer(), tree.collector()
        self.assertFalse(installer['files'][SERVICE].get('absent', False))
        self.assertEqual(installer['files'][SERVICE], files[SERVICE])

    def test_directory_members_are_read_under_the_same_root(self):
        tree = Tree(self, True, 'socket')
        installer, (files, _socket) = tree.installer(), tree.collector()
        for directory in policy.DIRECTORIES:
            name = directory + '/member'
            self.assertEqual(installer['directories'][directory], ['member'])
            self.assertEqual(installer['files'][name], {k: v for k, v in capture.file_record(name, root=str(tree.root)).items()})

    def test_an_unreadable_socket_entry_refuses_rather_than_reading_as_absent(self):
        tree = Tree(self, True, 'socket')
        real = capture.os.stat
        def denied(path, *args, **kwargs):
            if path == 'system_bus_socket':
                raise PermissionError(13, 'denied')
            return real(path, *args, **kwargs)
        with patch.object(capture.os, 'stat', side_effect=denied):
            raw = pk_state.observe(str(tree.root), Tree.runner)
            facts = tree.installer()
        self.assertEqual(raw['dbus-socket'], {'state': 'error', 'error': 'OSError'})
        self.assertIsNone(facts['packagekit_activation_possible'])

    def test_default_root_is_the_real_root(self):
        self.assertEqual(policy.facts.__defaults__, ('/', None))
        self.assertEqual(pk_state.observe.__defaults__, ('/', None))
        self.assertEqual(pk_state.read.__defaults__[0], '/')
        self.assertEqual(capture.socket_record.__defaults__, ('/', False))
        self.assertEqual(capture.directory.__defaults__, ('/',))
        self.assertFalse(hasattr(policy, 'bus_socket'))


class GateValues(unittest.TestCase):
    """Only the literal False passes the activation gate."""
    def check(self, change):
        value, before, facts = fixture()
        facts = copy.deepcopy(facts)
        change(facts)
        value['facts_sha256'] = policy.digest(policy.encoded(facts))
        return lambda: policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})

    def test_every_value_but_false_refuses(self):
        for bad in (True, None, 0, 0.0, '', 'false', 'False', [], {}, 1):
            with self.subTest(value=bad), self.assertRaisesRegex(ValueError, 'PackageKit'):
                self.check(lambda f, bad=bad: f.update(packagekit_activation_possible=bad))()
        with self.assertRaisesRegex(ValueError, 'PackageKit'):
            self.check(lambda f: f.pop('packagekit_activation_possible'))()
        self.check(lambda f: f.update(packagekit_activation_possible=False))()


class PreflightGuards(unittest.TestCase):
    def test_each_native_trigger_guard_file_is_required(self):
        for name in ('/usr/bin/mandb', '/usr/bin/setpriv', '/etc/manpath.config',
                     '/var/lib/dpkg/info/man-db.postinst', '/var/lib/dpkg/info/man-db.triggers'):
            with self.subTest(name=name):
                value, before, facts = fixture()
                facts['files'][name] = {'absent': True}
                value['facts_sha256'] = policy.digest(policy.encoded(facts))
                with self.assertRaisesRegex(ValueError, 'Missing native trigger guard'):
                    policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})

    def test_trigger_package_must_be_fully_installed_at_the_approved_version(self):
        for status in ('hold ok installed', 'install ok half-configured', 'install ok triggers-pending'):
            with self.subTest(status=status):
                value, before, facts = fixture()
                before['man-db:amd64']['status'] = status
                value['inventory_sha256'] = policy.digest(policy.encoded(before))
                with self.assertRaisesRegex(ValueError, 'existing installed'):
                    policy.preflight(value, LOCK_BYTES, before, b'config', facts, b'units', {})


class ValidatorPredicate(unittest.TestCase):
    """The collected predicate is registration AND socket, exactly like the installer's."""
    def test_both_terms_are_required(self):
        from test_r3_policy_evidence import BINDING, document, encoded, validator
        for registered, exists in ((True, True), (True, False), (False, True), (False, False)):
            with self.subTest(registered=registered, exists=exists):
                doc = document()
                if registered:
                    raw = b'[D-BUS Service]\n'
                    doc['sections']['file:' + SERVICE] = {'state': 'ok', 'value': {
                        'uid': 0, 'gid': 0, 'mode': 0o644, 'bytes': len(raw), 'sha256': policy.digest(raw),
                        'body': capture.blob(raw)}}
                doc['sections']['dbus-socket'] = {'state': 'ok', 'value': {'exists': exists, 'socket': exists}}
                result = validator.validate(encoded(doc), BINDING)
                self.assertIs(result['packagekit_activation_possible'], registered and exists)


class MaintenanceGuards(unittest.TestCase):
    def test_inventory_drift_before_the_service_stop_refuses_before_stopping(self):
        with tempfile.TemporaryDirectory() as name:
            command = Mock()
            def inventory_read(phase, _timeout):
                return {'same': phase != 'pre-stop'}
            with self.assertRaisesRegex(ValueError, 'Inventory changed before service stop'):
                maintenance.isolate(Path(name), {'same': True}, inventory_read, command, time.monotonic() + 120,
                                    observer=Mock(side_effect=[observation(), observation(), observation()]))
            self.assertFalse(any(call.args[0] == ['systemctl', 'stop', *maintenance.SERVICES]
                                 for call in command.call_args_list))

    def test_completion_record_must_match_exactly(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            with patch.object(Path, 'is_symlink', return_value=True), patch.object(maintenance.os, 'readlink', return_value='/dev/null'):
                maintenance.isolate(directory, {'same': True}, lambda _phase, _timeout: {'same': True}, Mock(),
                                    time.monotonic() + 120, observer=Mock(side_effect=[observation(), observation(), observation()]))
            intent, final, complete = (json.loads((directory / (n + '.json')).read_bytes())
                                       for n in ('maintenance-intent', 'maintenance-final', 'maintenance-complete'))
            maintenance.validate_evidence(intent, final, complete)
            for change in ({'inventory_unchanged': False}, {'release_authorized': True}, {'units': []}, {'extra': 1}):
                with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'completion differs'):
                    maintenance.validate_evidence(intent, final, {**complete, **change})


if __name__ == '__main__':
    unittest.main()
