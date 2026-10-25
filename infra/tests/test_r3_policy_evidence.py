"""Synthetic collection tests. No guest, package manager, service or cloud execution."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_policy_capture as capture
import r3_policy_evidence as evidence
import r3_policy_validate as validator
import r3_policy_scope as scope
import r3_policy_snap as snap
import r3_noble_guest as guest
import r3_noble_fixture as host
from r3_noble_common import encoded, digest, write
from r3_install_policy import FIXED, DIRECTORIES
from r3_apt_observer import UNITS

BINDING = {'purpose': evidence.A_PURPOSE, 'source': {'sha': 'a' * 40, 'run_id': '12', 'attempt': 1},
           'image_sha256': 'b' * 64, 'fixture_uuid': 'synthetic', 'toolchain_sha256': 'c' * 64}
INVENTORY = b'man-db\tamd64\t2.12.0-4build2\tinstall ok installed\tno\t\t\t\n'
META = {'uid': 0, 'gid': 0, 'mode': 0o755}


def command(name, _deadline=0):
    outputs = {'inventory': INVENTORY, 'audit': b'', 'apt-config': b'APT {};\n',
               'unit-config': b'\n'.join(b'# /usr/lib/systemd/system/' + u.encode() + b'\n[Unit]\n' for u in UNITS),
               'architecture': b'amd64\n', 'os-release': b'ID=ubuntu\nVERSION_ID="24.04"\n',
               **{name: b'\n'.join(b'Id=' + u.encode() + b'\nFragmentPath=/usr/lib/systemd/system/' + u.encode() + b'\nDropInPaths=\nNeedDaemonReload=no\n' for u in UNITS) for name in ('unit-paths', 'unit-paths-after')}}
    return {'argv': evidence.COMMANDS[name], 'stdout': capture.blob(outputs[name]),
            'stderr': capture.blob(b''), 'returncode': 0, 'failure': None}


def release_record():
    raw = b'ID=ubuntu\nVERSION_ID="24.04"\n'
    return {**META, 'bytes': len(raw), 'sha256': digest(raw), 'body': capture.blob(raw)}


def apt_scope():
    return {'directory': {'metadata': META, 'names': []}, 'files': {'/etc/apt/apt.conf': {'absent': True}}}


def unit_scope(_raw=None):
    paths = {u: '/usr/lib/systemd/system/' + u for u in UNITS}
    return {'paths': paths, 'files': {p: {**META, 'mode': 0o644, 'bytes': 7,
            'sha256': digest(b'[Unit]\n'), 'body': capture.blob(b'[Unit]\n')} for p in paths.values()}}


def document(binding=BINDING):
    sections = {name: {'state': 'ok', 'value': command(name)} for name in evidence.COMMANDS}
    sections.update({'file:' + p: {'state': 'ok', 'value': {'absent': True}} for p in (*FIXED, *evidence.EXTRA_FILES)})
    sections.update({'directory:' + p: {'state': 'ok', 'value': {'metadata': META, 'names': []}} for p in DIRECTORIES})
    for name in evidence.SCOPES:
        sections[name] = {'state': 'ok', 'value': apt_scope() if name.startswith('apt-') else unit_scope()}
    sections['file:/usr/lib/systemd/system/unattended-upgrades.service'] = {'state': 'ok',
        'value': unit_scope()['files']['/usr/lib/systemd/system/unattended-upgrades.service']}
    sections['file:/usr/lib/os-release'] = {'state': 'ok', 'value': release_record()}
    sections['cache'] = {'state': 'ok', 'value': {'.': {'directory': True, **META}}}
    sections['dbus-socket'] = {'state': 'ok', 'value': {'exists': False, 'socket': False}}
    return {'format': 1, 'purpose': evidence.PURPOSE, 'binding': binding, 'sections': sections,
            'qualification': False, 'installation_success': False, 'policy_generated': False}


def snap_record():
    """Synthetic known alias under root-owned parents; never the host's real snap."""
    return {'format': 1, 'kind': 'known-alias',
            'alias': {'parent': {**META}, 'leaf': {**META, 'mode': 0o777}, 'link': snap.LINK.decode()},
            'target': {'parent': {**META}, **META, 'bytes': 5, 'sha256': digest(b'snapd')}}


def document_v2(binding=BINDING):
    doc = document(binding)
    doc['format'] = 2
    del doc['sections']['file:/usr/bin/snap']
    doc['sections'][snap.SECTION] = {'state': 'ok', 'value': snap_record()}
    return doc


class Schema(unittest.TestCase):
    def check(self, doc):
        return validator.validate(encoded(doc), BINDING)

    def test_complete_evidence_is_not_policy_or_qualification(self):
        result = self.check(document())
        self.assertEqual(result['status'], 'COLLECTED_REVIEW_REQUIRED')
        for key in ('qualification', 'installation_success', 'policy_generated'):
            self.assertIs(result[key], False)
        self.assertEqual(result['policy_input_hashes']['inventory_sha256'],
                         digest(encoded(validator.inventory(INVENTORY.decode()))))
        self.assertIs(result['packagekit_activation_possible'], False)

    def test_every_section_missing_and_unknown_refused(self):
        for name in document()['sections']:
            doc = document()
            del doc['sections'][name]
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check(doc)
        doc = document()
        doc['sections']['extra'] = {'state': 'not_reached'}
        with self.assertRaises(ValueError):
            self.check(doc)

    def test_every_command_argv_stream_hash_and_exit(self):
        for name in evidence.COMMANDS:
            for field in ('argv', 'hash', 'size'):
                doc = document()
                value = doc['sections'][name]['value']
                if field == 'argv':
                    value['argv'] = ['apt-get', 'install', 'evil']
                elif field == 'hash':
                    value['stderr']['sha256'] = 'f' * 64
                else:
                    value['stdout']['bytes'] += 1
                with self.subTest(name=name, field=field), self.assertRaises(ValueError):
                    self.check(doc)
            doc = document()
            doc['sections'][name]['value']['returncode'] = 7
            self.assertEqual(self.check(doc)['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_source_purpose_schema_and_success_forgery_refused(self):
        for key, value in [('format', True), ('purpose', 'INSTALL'), ('binding', {}),
                           ('qualification', True), ('installation_success', True), ('policy_generated', True)]:
            doc = document()
            doc[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check(doc)
        with self.assertRaises(ValueError):
            validator.validate(encoded(document())[:-1] + b',"format":1}', BINDING)
        with self.assertRaises(ValueError):
            evidence.load(b' ' * (evidence.DOCUMENT_LIMIT + 1))

    def test_partial_and_dirty_observations_never_produce_policy_hashes(self):
        for name in document()['sections']:
            for state in ({'state': 'not_reached'}, {'state': 'error', 'error': 'OSError'}):
                doc = document()
                doc['sections'][name] = state
                result = self.check(doc)
                self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
                self.assertEqual(result['policy_input_hashes'], {})
        for name, raw in [('inventory', b'bad'), ('audit', b'dirty\n'), ('unit-config', b''),
                          ('architecture', b'arm64\n')]:
            doc = document()
            doc['sections'][name]['value']['stdout'] = capture.blob(raw)
            self.assertEqual(self.check(doc)['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_packagekit_true_and_unknown_remain_unqualified(self):
        doc = document()
        path = '/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'
        doc['sections']['file:' + path]['value'] = {**META, 'mode': 0o644, 'bytes': 0,
            'sha256': digest(b''), 'body': capture.blob(b'')}
        doc['sections']['dbus-socket']['value'] = {'exists': True, 'socket': True}
        result = self.check(doc)
        self.assertIs(result['packagekit_activation_possible'], True)
        self.assertIs(result['qualification'], False)
        doc['sections']['dbus-socket'] = {'state': 'error', 'error': 'OSError'}
        self.assertIsNone(self.check(doc)['packagekit_activation_possible'])

    def test_unknown_config_is_not_read_or_accepted(self):
        doc = document()
        path = DIRECTORIES[0]
        doc['sections']['directory:' + path]['value']['names'] = ['credentials']
        doc['sections']['file:' + path + '/credentials'] = {'state': 'error', 'error': 'UNREVIEWED_PATH'}
        self.assertEqual(self.check(doc)['status'], 'PARTIAL_REVIEW_REQUIRED')
        doc['sections']['file:' + path + '/credentials'] = {'state': 'ok', 'value': {'absent': True}}
        with self.assertRaises(ValueError):
            self.check(doc)

    def test_body_hash_cache_path_and_boolean_types(self):
        for bad in ({'absent': 1}, {'absent': True, 'secret': 'x'}):
            doc = document()
            doc['sections']['file:' + FIXED[0]]['value'] = bad
            with self.assertRaises(ValueError):
                self.check(doc)
        doc = document()
        doc['sections']['file:' + FIXED[0]]['value'] = {**META, 'bytes': 1, 'sha256': digest(b'a'), 'body': capture.blob(b'b')}
        with self.assertRaises(ValueError):
            self.check(doc)
        for path in ('../outside', '/outside', 'a//b', 'a/b'):
            doc = document()
            doc['sections']['cache']['value'][path] = {**META, 'bytes': 0, 'sha256': digest(b'')}
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check(doc)


class Capture(unittest.TestCase):
    def test_regular_bytes_metadata_and_symlink_parents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / 'file'
            path.write_bytes(b'native script')
            self.assertEqual(capture.file_record(str(path), True)['body'], capture.blob(b'native script'))
            link = root / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                capture.file_record(str(link))
            directory = root / 'directory'
            directory.symlink_to(root, target_is_directory=True)
            with self.assertRaises(OSError):
                capture.file_record(str(directory / 'file'))
            self.assertEqual(capture.file_record(str(root / 'absent')), {'absent': True})

    def test_hardlink_fifo_oversize_and_changed_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / 'file'
            path.write_bytes(b'ab')
            with patch.object(capture, 'BODY_LIMIT', 1), self.assertRaises(ValueError):
                capture.file_record(str(path), True)
            link = root / 'hard'
            os.link(path, link)
            with self.assertRaises(ValueError):
                capture.file_record(str(path))
            link.unlink()
            fifo = root / 'fifo'
            os.mkfifo(fifo)
            with self.assertRaises(ValueError):
                capture.file_record(str(fifo))
            original = os.read
            def change(fd, size):
                data = original(fd, size)
                path.write_bytes(b'cd')
                return data
            with patch.object(capture.os, 'read', side_effect=change), self.assertRaises(ValueError):
                capture.file_record(str(path))

    def test_cache_rejects_symlinks_and_membership_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'file').write_bytes(b'cache')
            self.assertEqual(capture.cache(str(root))['file']['sha256'], digest(b'cache'))
            with self.assertRaises(ValueError):
                capture.membership(str(root), 0)
            (root / 'link').symlink_to(root)
            with self.assertRaises(OSError):
                capture.cache(str(root))


class CollectionRoute(unittest.TestCase):
    def collect(self, binding=BINDING, checkpoint=lambda _v: None):
        with patch.object(evidence, 'command', side_effect=command), \
             patch.object(capture, 'file_record', side_effect=lambda path, body=False: release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), \
             patch.object(scope, 'unit_scope', side_effect=unit_scope), \
             patch.object(snap, 'observe', return_value=snap_record()):
            return evidence.collect(binding, checkpoint)

    def test_checkpoints_precede_completeness_and_preserve_partial(self):
        points = []
        result = self.collect(checkpoint=lambda d: points.append(copy.deepcopy(d)))
        self.assertEqual(validator.validate(encoded(points[0]), BINDING)['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(validator.validate(encoded(result), BINDING)['status'], 'COLLECTED_REVIEW_REQUIRED')
        self.assertGreater(len(points), 20)

    def test_collection_guest_never_enters_installation_or_maintenance(self):
        manifest = {'purpose': evidence.A_PURPOSE, 'source': BINDING['source'],
                    'image_sha256': BINDING['image_sha256'], 'fixture_uuid': BINDING['fixture_uuid'],
                    'files': {'r3-toolchain.lock.json': BINDING['toolchain_sha256']}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output, port = root / 'output', root / 'port'
            inputs = root / 'inputs'
            inputs.mkdir()
            write(inputs / 'manifest.json', encoded(manifest))
            def verified(_purposes):
                write(output / 'manifest.json', encoded(manifest))
                return manifest
            real_collect = evidence.collect
            def fake_collect(binding, checkpoint):
                with patch.object(evidence, 'command', side_effect=command), \
                     patch.object(capture, 'file_record', side_effect=lambda path, body=False: release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})), \
                     patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
                     patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
                     patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), \
             patch.object(scope, 'unit_scope', side_effect=unit_scope), \
             patch.object(snap, 'observe', return_value=snap_record()):
                    return real_collect(binding, checkpoint)
            with patch.object(guest, 'INPUT', inputs), patch.object(guest, 'OUTPUT', output), \
                 patch.object(guest, 'PORT', str(port)), patch.object(guest, 'verify_input', side_effect=verified), \
                 patch.object(evidence, 'collect', side_effect=fake_collect), \
                 patch.object(guest, 'installation_main', side_effect=AssertionError('installation entered')), \
                 patch.object(guest.r3_maintenance, 'isolate', side_effect=AssertionError('maintenance entered')), \
                 patch.object(guest, 'run', side_effect=AssertionError('mutation reached')):
                self.assertEqual(guest.main(), 0)
            result = host.validate_frame(port.read_bytes(), manifest)
            self.assertEqual(result['status'], 'COLLECTED_REVIEW_REQUIRED')
            self.assertIs(result['install_attempted'], False)
            self.assertEqual(set(p.name for p in output.iterdir()), guest.COLLECTION_FILES)

    def test_interrupted_checkpoint_exports_previous_partial_frame(self):
        manifest = {'purpose': evidence.A_PURPOSE, 'source': BINDING['source'],
                    'image_sha256': BINDING['image_sha256'], 'fixture_uuid': BINDING['fixture_uuid'],
                    'files': {'r3-toolchain.lock.json': BINDING['toolchain_sha256']}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output, port = root / 'output', root / 'port'
            def verified(_purposes):
                write(output / 'manifest.json', encoded(manifest))
                return manifest
            def partial(binding, checkpoint):
                doc = document(binding)
                doc['sections']['cache'] = {'state': 'not_reached'}
                checkpoint(doc)
                with patch.object(guest.os, 'replace', side_effect=OSError('interrupted')):
                    checkpoint(document(binding))
            with patch.object(guest, 'OUTPUT', output), patch.object(guest, 'PORT', str(port)), \
                 patch.object(guest, 'verify_input', side_effect=verified), \
                 patch.object(evidence, 'collect', side_effect=partial):
                self.assertEqual(guest.collection_main(), 1)
            result = host.validate_frame(port.read_bytes(), manifest)
            self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
            self.assertEqual(result['checks']['policy_input_hashes'], {})
            self.assertFalse((output / 'policy-progress.tmp').exists())

    def test_collection_rejects_policy_manifest(self):
        with self.assertRaises(ValueError):
            guest.collection_binding({'purpose': evidence.A_PURPOSE, 'policy_sha256': 'a' * 64})


if __name__ == '__main__':
    unittest.main()
