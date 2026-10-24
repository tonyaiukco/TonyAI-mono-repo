"""Synthetic fixed-leaf tests; no live guest, image, package or Azure execution."""
import copy
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_snap_leaf as snap
import r3_noble_common as common
import r3_noble_guest as guest
import r3_noble_fixture as host
import r3_noble_inputs as inputs

SOURCE = {'sha': 'a' * 40, 'run_id': '42', 'attempt': 1, 'files': {'x': 'b' * 64}}
MANIFEST = {'purpose': snap.PURPOSE, 'source': SOURCE, 'image_sha256': 'c' * 64,
            'fixture_uuid': 'd7fa1822-80db-4cba-9ef1-6e63549fe928', 'files': {}}
BINDING = guest.snap_binding(MANIFEST)


class LeafObservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def parent(self, held):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        held.append(fd)
        return fd

    def observe(self):
        with patch.object(snap, 'open_parent', side_effect=self.parent):
            value = snap.observe(BINDING)
        snap.validate(value, BINDING)
        return value

    def test_regular_metadata_only(self):
        (self.root / 'snap').write_bytes(b'never read this content')
        with patch.object(snap.os, 'read', side_effect=AssertionError('content read')):
            value = self.observe()
        self.assertEqual(value['status'], snap.OBSERVED)
        self.assertEqual(value['leaf_kind'], 'regular')
        self.assertIsNone(value['link_before'])

    def test_absence_is_explicit_not_policy(self):
        value = self.observe()
        self.assertEqual(value['leaf_kind'], 'absent')
        self.assertEqual(value['status'], snap.OBSERVED)
        self.assertFalse(value['policy_generated'])

    def test_link_text_is_uninterpreted_and_never_opened(self):
        for target in (b'/not-read/secret', b'../../elsewhere', b'snap', b'\xfftarget'):
            with self.subTest(target=target):
                os.symlink(target, os.fsencode(self.root / 'snap'))
                real_open = os.open
                calls = []
                def opened(path, flags, **kwargs):
                    calls.append((path, flags))
                    self.assertEqual(path, self.root)
                    return real_open(path, flags, **kwargs)
                with patch.object(snap.os, 'open', side_effect=opened):
                    value = self.observe()
                self.assertEqual(len(calls), 2)
                self.assertEqual(value['status'], snap.OBSERVED)
                self.assertEqual(value['link_before']['sha256'], common.digest(target))
                (self.root / 'snap').unlink()

    def test_fifo_is_partial_without_leaf_open(self):
        os.mkfifo(self.root / 'snap')
        value = self.observe()
        self.assertEqual(value['status'], snap.PARTIAL)
        self.assertEqual(value['leaf_kind'], 'unsupported')

    def test_fixed_directory_walk_uses_nofollow(self):
        held = []
        with patch.object(snap.os, 'open', side_effect=[10, 11, 12]) as opened:
            self.assertEqual(snap.open_parent(held), 12)
        self.assertEqual(held, [10, 11, 12])
        self.assertEqual([c.args[0] for c in opened.call_args_list], ['/', 'usr', 'bin'])
        self.assertTrue(all(c.args[1] & os.O_NOFOLLOW and c.args[1] & os.O_DIRECTORY
                            for c in opened.call_args_list))
        self.assertEqual(opened.call_args_list[2].kwargs, {'dir_fd': 11})

    def test_leaf_change_and_disappearance_are_partial(self):
        (self.root / 'snap').write_bytes(b'x')
        before = snap.metadata((self.root / 'snap').stat())
        for after in (None, {**before, 'st_ino': before['st_ino'] + 1},
                      {**before, 'st_mode': stat.S_IFLNK | 0o777}):
            with patch.object(snap, 'leaf', side_effect=[before, after]), patch.object(snap, 'link', return_value=None):
                self.assertEqual(self.observe()['status'], snap.PARTIAL)

    def test_parent_replacement_is_partial(self):
        actual = os.fstat
        count = 0
        def changed(fd):
            nonlocal count
            count += 1
            value = actual(fd)
            if count == 3:
                result = snap.metadata(value)
                result['st_ino'] += 1
                return type('Metadata', (), result)()
            return value
        with patch.object(snap.os, 'fstat', side_effect=changed):
            self.assertEqual(self.observe()['status'], snap.PARTIAL)

    def test_link_cap_before_readlink(self):
        with patch.object(snap.os, 'readlink', side_effect=AssertionError('must not read')):
            with self.assertRaises(ValueError):
                snap.link(1, {'st_mode': stat.S_IFLNK, 'st_size': 4097})

    def test_io_error_timeout_and_cleanup_remain_partial(self):
        for error in (PermissionError(13, 'private text'), TimeoutError('private text')):
            with patch.object(snap, 'leaf', side_effect=error):
                value = self.observe()
            self.assertEqual(value['status'], snap.PARTIAL)
            self.assertNotIn('private text', common.encoded(value).decode())
        real_close = os.close
        def close(fd):
            real_close(fd)
            raise OSError(5, 'cleanup')
        with patch.object(snap.os, 'close', side_effect=close):
            value = self.observe()
        self.assertEqual(value['status'], snap.PARTIAL)
        self.assertEqual(len(value['cleanup_errors']), 2)

    def test_schema_forgery(self):
        (self.root / 'snap').symlink_to('unopened')
        value = self.observe()
        changes = [lambda x: x.update(format=True), lambda x: x.update(fixed_path='/etc/shadow'),
                   lambda x: x.update(qualification=True), lambda x: x.update(extra=1),
                   lambda x: x['parent_reopened'].update(st_ino=0),
                   lambda x: x['link_before'].update(sha256='0' * 64),
                   lambda x: x['link_before'].update(bytes=True),
                   lambda x: x['link_before'].update(base64='!'),
                   lambda x: x['leaf_before'].update(st_size=True),
                   lambda x: x['binding'].update(attempt=True)]
        for mutate in changes:
            with self.subTest(mutate=mutate):
                forged = copy.deepcopy(value)
                mutate(forged)
                with self.assertRaises((ValueError, TypeError)):
                    snap.validate(forged, BINDING)


class DiagnosticRoute(LeafObservation):
    def frame(self, value=None):
        value = self.observe() if value is None else value
        out = self.root / 'output'
        out.mkdir()
        common.write(out / 'manifest.json', common.encoded(MANIFEST))
        common.write(out / 'snap-leaf.json', common.encoded(value))
        result = {'format': 1, 'purpose': snap.PURPOSE, 'qa_ready': False,
                  'target_qualified': False, 'install_attempted': False, 'status': value['status'],
                  'phase': 'snap-leaf', 'source': SOURCE, 'checks': snap.validate(value, BINDING),
                  'files': {p.name: common.file_hash(p) for p in out.iterdir()}}
        common.write(out / 'result.json', common.encoded(result))
        return out, result

    def test_actual_three_member_frame_validates(self):
        out, result = self.frame()
        self.assertEqual(host.validate_frame(guest.archive(out), MANIFEST), result)

    def test_other_purpose_and_extra_members_refused(self):
        out, _ = self.frame()
        with self.assertRaises(ValueError):
            host.validate_frame(guest.archive(out), {**MANIFEST, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY'})
        common.write(out / 'native-state.json', b'{}')
        with self.assertRaises(ValueError):
            host.validate_frame(guest.archive(out), MANIFEST)

    def test_direct_frame_member_allowlist(self):
        out, result = self.frame()
        entries = {p.name: p.read_bytes() for p in out.iterdir()}
        entries['native-state.json'] = b'{}'
        with self.assertRaises(ValueError):
            host.validate_snap(entries, result, MANIFEST)

    def test_result_claims_independently_checked(self):
        out, result = self.frame()
        entries = {p.name: p.read_bytes() for p in out.iterdir()}
        for field, value in [('install_attempted', True), ('qa_ready', True), ('checks', {}),
                             ('status', 'COLLECTED_REVIEW_REQUIRED'), ('format', True)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                host.validate_snap(entries, {**result, field: value}, MANIFEST)

    def test_new_route_never_enters_installer_or_collector(self):
        with patch.object(guest, 'read', return_value=common.encoded(MANIFEST)), \
             patch.object(guest, 'snap_main', return_value=19) as called, \
             patch.object(guest, 'installation_main', side_effect=AssertionError('installer')), \
             patch.object(guest, 'collection_main', side_effect=AssertionError('collector')):
            self.assertEqual(guest.main(), 19)
            called.assert_called_once_with()

    def test_supplied_policy_refused_before_fetch(self):
        with patch.object(inputs, 'fetch', side_effect=AssertionError('network')):
            for policy, collection in [(b'{}', False), (None, True)]:
                with self.assertRaises(ValueError):
                    inputs.stage(None, None, None, None, None, policy, collection, snap_leaf=True)
        for change in ({'policy_sha256': 'a' * 64}, {'files': {'installation-policy.json': 'b' * 64}}):
            with self.assertRaises(ValueError):
                guest.snap_binding({**MANIFEST, **change})

    def test_guest_roundtrip_is_metadata_only(self):
        out = self.root / 'guest'
        port = self.root / 'port'
        value = self.observe()
        def verified(_):
            common.write(out / 'manifest.json', common.encoded(MANIFEST))
            return MANIFEST
        with patch.object(guest, 'OUTPUT', out), patch.object(guest, 'PORT', port), \
             patch.object(guest, 'verify_input', side_effect=verified), \
             patch.object(snap, 'observe', return_value=value), \
             patch.object(guest.signal, 'signal'), patch.object(guest.signal, 'alarm') as alarm, \
             patch.object(guest, 'run', side_effect=AssertionError('command')):
            self.assertEqual(guest.snap_main(), 0)
        self.assertEqual([c.args for c in alarm.call_args_list], [(120,), (10,), (60,), (0,)])
        self.assertEqual(set(p.name for p in out.iterdir()), guest.SNAP_FILES)
        self.assertEqual(host.validate_frame(port.read_bytes(), MANIFEST)['status'], snap.OBSERVED)


if __name__ == '__main__':
    unittest.main()
