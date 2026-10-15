"""Disk bootstrap must refuse foreign data before destructive commands."""
import json
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from selfhost_disks import check_destination, inspect_disk, main


class DiskTests(unittest.TestCase):
    def test_main_rejects_foreign_mount_before_format_or_fstab_write(self):
        with tempfile.TemporaryDirectory() as directory:
            first = ('/dev/new0', directory + '/database', {'uuid': None, 'fstype': None})
            second = ('/dev/new1', directory + '/objects', {'uuid': None, 'fstype': None})
            metadata = io.BytesIO(json.dumps({'compute': {'resourceId': '/reviewed-host'}}).encode())
            with patch('sys.argv', ['disks', '--resource-id', '/reviewed-host', '--initialize-empty-disks']), patch('selfhost_disks.os.geteuid', return_value=0), patch('selfhost_disks.build_opener') as opener, patch('selfhost_disks.inspect_disk', side_effect=[first, second]), patch('selfhost_disks.os.path.ismount', return_value=True), patch('selfhost_disks.Path.read_text', return_value=''), patch('selfhost_disks.Path.write_text') as write, patch('selfhost_disks.Path.mkdir'), patch('selfhost_disks.Path.chmod'), patch('selfhost_disks.Path.replace'), patch('selfhost_disks.run', return_value='owned'), patch('selfhost_disks.subprocess.run') as mutate:
                opener.return_value.open.return_value = metadata
                with self.assertRaisesRegex(ValueError, 'occupied'):
                    main()
                write.assert_not_called()
                mutate.assert_not_called()

    def test_foreign_mount_refused_without_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            for expected, actual in [(None, 'foreign'), ('owned', 'foreign')]:
                with patch('selfhost_disks.os.path.ismount', return_value=True), patch('selfhost_disks.run', return_value=actual) as run, patch('selfhost_disks.subprocess.run') as mutate:
                    with self.assertRaises(ValueError):
                        check_destination(directory, {'uuid': expected}, '')
                    mutate.assert_not_called()
                    self.assertTrue(all(call.args[0] == 'findmnt' for call in run.call_args_list))

    def test_hidden_files_and_foreign_fstab_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'existing').write_text('preserve')
            with self.assertRaises(ValueError):
                check_destination(directory, {'uuid': None}, '')
            Path(directory, 'existing').unlink()
            with self.assertRaises(ValueError):
                check_destination(directory, {'uuid': 'owned'}, f'UUID=other {directory} ext4 defaults 0 2')

    def test_partitioned_mounted_and_existing_signature_disks_refused(self):
        base = {'path': '/dev/test', 'type': 'disk', 'size': 64 * 1024**3,
                'fstype': None, 'label': None, 'uuid': None, 'mountpoints': [None]}
        cases = [{'children': [{}]}, {'size': 32}, {'mountpoints': ['/']},
                 {'fstype': 'ext4', 'label': 'foreign', 'uuid': 'other'}]
        for extra in cases:
            with patch('selfhost_disks.Path.resolve', return_value=Path('/dev/test')), patch('selfhost_disks.run', return_value=json.dumps({'blockdevices': [{**base, **extra}]})):
                with self.assertRaises(ValueError):
                    inspect_disk(0, 64, 'database', True)
        with patch('selfhost_disks.Path.resolve', return_value=Path('/dev/test')), patch('selfhost_disks.run', side_effect=[json.dumps({'blockdevices': [base]}), json.dumps({'signatures': [{'type': 'gpt'}]})]):
            with self.assertRaises(ValueError):
                inspect_disk(0, 64, 'database', True)

    def test_existing_owned_disks_main_never_formats_and_migrates_fstab(self):
        with tempfile.TemporaryDirectory() as directory:
            checked = [(f'/dev/test{i}', directory + '/' + name, {'uuid': 'owned-' + name, 'fstype': 'ext4'}) for i, name in enumerate(('database', 'objects'))]
            original = '\n'.join(f"UUID={row['uuid']} {target} ext4 defaults,nodev,nosuid 0 2" for _, target, row in checked)
            metadata = io.BytesIO(json.dumps({'compute': {'resourceId': '/reviewed-host'}}).encode())
            def command(*args):
                return 'owned-database' if args[-1] in ('/dev/test0', directory + '/database') else 'owned-objects'
            with patch('sys.argv', ['disks', '--resource-id', '/reviewed-host']), patch('selfhost_disks.os.geteuid', return_value=0), patch('selfhost_disks.build_opener') as opener, patch('selfhost_disks.inspect_disk', side_effect=checked), patch('selfhost_disks.os.path.ismount', return_value=True), patch('selfhost_disks.Path.read_text', return_value=original), patch('selfhost_disks.Path.write_text') as write, patch('selfhost_disks.Path.chmod'), patch('selfhost_disks.Path.replace'), patch('selfhost_disks.subprocess.run') as mutate, patch('selfhost_disks.run', side_effect=command):
                opener.return_value.open.return_value = metadata
                main()
                self.assertFalse(any(call.args[0][0].startswith('mkfs') for call in mutate.call_args_list))
                migrated = write.call_args_list[-1].args[0]
                self.assertEqual(migrated.count('defaults,nodev,nosuid,nofail,x-systemd.device-timeout=30s'), 2)
                self.assertEqual(migrated.count('UUID=owned-'), 2)

    def test_invalid_second_disk_and_duplicate_lun_abort_before_mutation(self):
        first = ('/dev/test0', '/srv/tonyai/database', {'fstype': None, 'uuid': None})
        for second in (ValueError('second disk invalid'), ('/dev/test0', '/srv/tonyai/objects', {'fstype': None, 'uuid': None})):
            metadata = io.BytesIO(json.dumps({'compute': {'resourceId': '/reviewed-host'}}).encode())
            with patch('sys.argv', ['disks', '--resource-id', '/reviewed-host', '--initialize-empty-disks']), patch('selfhost_disks.os.geteuid', return_value=0), patch('selfhost_disks.build_opener') as opener, patch('selfhost_disks.inspect_disk', side_effect=[first, second]), patch('selfhost_disks.check_destination'), patch('selfhost_disks.Path.read_text', return_value=''), patch('selfhost_disks.Path.mkdir'), patch('selfhost_disks.Path.chmod'), patch('selfhost_disks.Path.replace'), patch('selfhost_disks.Path.exists', return_value=False), patch('selfhost_disks.os.path.ismount', return_value=True), patch('selfhost_disks.run', return_value='owned'), patch('selfhost_disks.Path.write_text') as write, patch('selfhost_disks.subprocess.run') as mutate:
                opener.return_value.open.return_value = metadata
                with self.assertRaises(ValueError): main()
                write.assert_not_called(); mutate.assert_not_called()

    def test_empty_disk_without_initialize_and_wrong_imds_do_not_mutate(self):
        base = {'path': '/dev/test', 'type': 'disk', 'size': 64 * 1024**3,
                'fstype': None, 'label': None, 'uuid': None, 'mountpoints': [None]}
        for identity in ('/reviewed-host', '/other-host'):
            metadata = io.BytesIO(json.dumps({'compute': {'resourceId': identity}}).encode())
            with patch('sys.argv', ['disks', '--resource-id', '/reviewed-host']), patch('selfhost_disks.os.geteuid', return_value=0), patch('selfhost_disks.build_opener') as opener, patch('selfhost_disks.Path.resolve', return_value=Path('/dev/test')), patch('selfhost_disks.run', return_value=json.dumps({'blockdevices': [base], 'signatures': []})) as read, patch('selfhost_disks.subprocess.run') as mutate, patch('selfhost_disks.Path.write_text') as write:
                opener.return_value.open.return_value = metadata
                with self.assertRaisesRegex(ValueError, 'initialization' if identity == '/reviewed-host' else 'identity'):
                    main()
                mutate.assert_not_called(); write.assert_not_called()
                if identity == '/other-host': read.assert_not_called()
                else: self.assertEqual([call.args[0] for call in read.call_args_list], ['lsblk'])

    def test_post_mount_uuid_readback_must_match(self):
        with tempfile.TemporaryDirectory() as directory:
            checked = [(f'/dev/test{i}', directory + '/' + name, {'uuid': 'owned-' + name, 'fstype': 'ext4'}) for i, name in enumerate(('database', 'objects'))]
            metadata = io.BytesIO(json.dumps({'compute': {'resourceId': '/reviewed-host'}}).encode())
            def command(*args):
                if args[0] == 'findmnt':
                    self.assertIn('--target', args)
                    return 'foreign'
                return 'owned-database' if args[-1] == '/dev/test0' else 'owned-objects'
            with patch('sys.argv', ['disks', '--resource-id', '/reviewed-host']), patch('selfhost_disks.os.geteuid', return_value=0), patch('selfhost_disks.build_opener') as opener, patch('selfhost_disks.inspect_disk', side_effect=checked), patch('selfhost_disks.os.path.ismount', return_value=False), patch('selfhost_disks.Path.read_text', return_value=''), patch('selfhost_disks.Path.write_text'), patch('selfhost_disks.Path.chmod'), patch('selfhost_disks.Path.replace'), patch('selfhost_disks.subprocess.run') as mutate, patch('selfhost_disks.run', side_effect=command):
                opener.return_value.open.return_value = metadata
                with self.assertRaisesRegex(ValueError, 'did not read back'): main()
                self.assertIn(['mount', directory + '/database'], [call.args[0] for call in mutate.call_args_list])
                self.assertFalse(any(call.args[0][0].startswith('mkfs') for call in mutate.call_args_list))

    def test_second_destination_is_checked_before_any_format(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory, 'database'); second = Path(directory, 'objects'); second.mkdir()
            valuable = second / 'existing'; valuable.write_text('preserve')
            checked = [('/dev/new0', str(first), {'fstype': None, 'uuid': None}), ('/dev/new1', str(second), {'fstype': None, 'uuid': None})]
            metadata = io.BytesIO(json.dumps({'compute': {'resourceId': '/reviewed-host'}}).encode())
            with patch('sys.argv', ['disks', '--resource-id', '/reviewed-host', '--initialize-empty-disks']), patch('selfhost_disks.os.geteuid', return_value=0), patch('selfhost_disks.build_opener') as opener, patch('selfhost_disks.inspect_disk', side_effect=checked), patch('selfhost_disks.os.path.ismount', return_value=False), patch('selfhost_disks.Path.read_text', return_value=''), patch('selfhost_disks.Path.write_text', side_effect=AssertionError('Invalid second destination reached fstab.')) as write, patch('selfhost_disks.subprocess.run', side_effect=AssertionError('Invalid second destination reached formatting.')) as mutate:
                opener.return_value.open.return_value = metadata
                with self.assertRaisesRegex(ValueError, 'hide existing files'): main()
                mutate.assert_not_called(); write.assert_not_called()
            self.assertEqual(valuable.read_text(), 'preserve'); self.assertFalse(first.exists())
