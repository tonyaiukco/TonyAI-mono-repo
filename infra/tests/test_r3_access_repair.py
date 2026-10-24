"""Synthetic recovery tests only. Never opens real SSH state or contacts a guest."""
import base64
import json
import os
from pathlib import Path
import sys
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_access_repair as repair
import r3_access_repair_guest as guest
import r3_access_repair_packet as packet

WIRE = (11).to_bytes(4, 'big') + b'ssh-ed25519' + (32).to_bytes(4, 'big') + b'x' * 32
KEY = b'ssh-ed25519 ' + base64.b64encode(WIRE) + b' synthetic\n'
HASH = repair.sha256(KEY)


def proposal():
    files = {'infra/scripts/synthetic.py': 'a' * 64}
    target = {name: 'synthetic' for name in guest.IMDS_FIELDS}
    target['resourceId'] = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/synthetic/providers/Microsoft.Compute/virtualMachines/synthetic'
    target['location'] = 'swedencentral'
    return {'format': 1, 'purpose': 'R3_SSH_KEY_APPEND_ONLY', 'packet_id': 'b' * 32,
            'source': {'published_sha': 'c' * 40, 'files': files,
                       'sha256': repair.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode())},
            'target_imds': target,
            'public_key': KEY.decode(), 'public_key_sha256': HASH, 'execution_authorized': False}


class Repair(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.ssh = root / 'ssh'
        self.evidence = root / 'evidence'
        self.ssh.mkdir(mode=0o700)
        self.evidence.mkdir(mode=0o700)
        self.file = self.ssh / 'authorized_keys'
        self.file.write_bytes(b'old-key-with-comment\n')
        self.file.chmod(0o600)
        self.ssh_fd = os.open(self.ssh, os.O_RDONLY | os.O_DIRECTORY)
        self.ev_fd = os.open(self.evidence, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.ssh_fd)
        self.addCleanup(os.close, self.ev_fd)

    def run_repair(self):
        return repair.append_verified(self.ssh_fd, self.ev_fd, os.getuid(), os.getgid(), KEY, HASH)

    def test_prefix_permissions_and_private_backup_preserved(self):
        before = self.file.read_bytes()
        info = self.file.stat()
        result = self.run_repair()
        self.assertEqual(self.file.read_bytes(), before + repair.public_line(KEY, HASH)[0])
        self.assertEqual(self.file.stat().st_ino, info.st_ino)
        self.assertEqual(self.file.stat().st_mode, info.st_mode)
        self.assertEqual((self.evidence / 'authorized_keys.before').read_bytes(), before)
        self.assertEqual((self.evidence / 'authorized_keys.before').stat().st_mode & 0o777, 0o600)
        self.assertFalse(result['access_verified'])
        self.assertFalse(result['qualification'])

    def test_missing_final_newline_preserves_exact_prefix(self):
        self.file.write_bytes(b'old-key')
        self.run_repair()
        self.assertEqual(self.file.read_bytes(), b'old-key\n' + repair.public_line(KEY, HASH)[0])

    def test_restricted_existing_key_is_not_widened(self):
        before = b'command="false",restrict ' + KEY
        self.file.write_bytes(before)
        with self.assertRaisesRegex(ValueError, 'KEY_ALREADY_PRESENT'):
            self.run_repair()
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(list(self.evidence.iterdir()), [])

    def test_equivalent_rsa_mpints_do_not_widen_restricted_key(self):
        def wire(parts):
            return b''.join(len(x).to_bytes(4, 'big') + x for x in parts)
        exponent = b'\x01\x00\x01'
        modulus = b'\0\x80' + b'x' * 255
        canonical = wire((b'ssh-rsa', exponent, modulus))
        alternate = wire((b'ssh-rsa', b'\0' + exponent, b'\0' + modulus))
        key = b'ssh-rsa ' + base64.b64encode(canonical) + b'\n'
        before = b'restrict ssh-rsa ' + base64.b64encode(alternate) + b'\n'
        self.file.write_bytes(before)
        with self.assertRaisesRegex(ValueError, 'KEY_ALREADY_PRESENT'):
            repair.append_verified(self.ssh_fd, self.ev_fd, os.getuid(), os.getgid(), key, repair.sha256(key))
        self.assertEqual(self.file.read_bytes(), before)

    def test_existing_noncanonical_base64_and_oversize_tokens_refused(self):
        line, identity = repair.public_line(KEY, HASH)
        token = line.split()[1]
        with self.assertRaisesRegex(ValueError, 'KEY_ALREADY_PRESENT'):
            repair.refuse_existing_identity(b'restrict ' + token + b'====', identity)
        with self.assertRaisesRegex(ValueError, 'EXISTING_TOKEN_SIZE'):
            repair.refuse_existing_identity(b'A' * (repair.MAX_APPEND + 1), identity)

    def test_concurrent_change_during_final_readback_is_partial(self):
        original = repair.bounded_read
        reads = []
        def change_after_read(fd, limit=repair.MAX_KEYS):
            data = original(fd, limit)
            reads.append(1)
            if len(reads) == 2:
                self.file.write_bytes(b'changed-after-read\n')
            return data
        with patch.object(repair, 'bounded_read', side_effect=change_after_read):
            with self.assertRaisesRegex(ValueError, 'CHANGED'):
                self.run_repair()
        self.assertEqual(self.file.read_bytes(), b'changed-after-read\n')
        self.assertTrue((self.evidence / 'prepared.json').exists())

    def test_symlink_fifo_directory_missing_and_hardlink_refused(self):
        for kind in ('symlink', 'fifo', 'directory', 'missing', 'hardlink'):
            with self.subTest(kind=kind):
                if self.file.exists() or self.file.is_symlink():
                    self.file.unlink()
                other = self.ssh / 'other'
                other.write_bytes(b'do-not-touch')
                if kind == 'symlink':
                    self.file.symlink_to(other)
                elif kind == 'fifo':
                    os.mkfifo(self.file)
                elif kind == 'directory':
                    self.file.mkdir()
                elif kind == 'hardlink':
                    os.link(other, self.file)
                with self.assertRaises((OSError, ValueError)):
                    self.run_repair()
                self.assertEqual(other.read_bytes(), b'do-not-touch')
                if kind == 'directory':
                    self.file.rmdir()
                self.assertEqual(list(self.evidence.iterdir()), [])

    def test_wrong_mode_owner_and_oversize_refused(self):
        for mode in (0o666, 0o640, 0o400):
            self.file.chmod(mode)
            with self.assertRaises((ValueError, PermissionError)):
                self.run_repair()
        self.file.chmod(0o600)
        # Some host filesystems strip setuid during chmod. Exercise the guard
        # with exact guest metadata rather than claiming that bit was retained.
        info = self.file.stat()
        privileged_mode = SimpleNamespace(st_mode=stat.S_IFREG | 0o4600,
            st_nlink=1, st_uid=info.st_uid, st_gid=info.st_gid, st_size=info.st_size)
        with self.assertRaisesRegex(ValueError, 'FILE_MODE'):
            repair.regular(privileged_mode, os.getuid(), os.getgid())
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_OWNER'):
            repair.append_verified(self.ssh_fd, self.ev_fd, os.getuid() + 1, os.getgid(), KEY, HASH)
        self.file.write_bytes(b'x' * (repair.MAX_KEYS + 1))
        with self.assertRaisesRegex(ValueError, 'FILE_SIZE'):
            self.run_repair()

    def test_short_append_is_retained_and_not_retried(self):
        original = os.write
        appends = []
        def short(fd, data):
            if data == repair.public_line(KEY, HASH)[0]:
                appends.append(1)
                return original(fd, data[:5])
            return original(fd, data)
        before = self.file.read_bytes()
        with patch.object(repair.os, 'write', side_effect=short):
            with self.assertRaisesRegex(ValueError, 'PARTIAL_APPEND'):
                self.run_repair()
        self.assertEqual(appends, [1])
        self.assertEqual(self.file.read_bytes(), before + b'ssh-e')
        self.assertEqual((self.evidence / 'authorized_keys.before').read_bytes(), before)
        self.assertTrue((self.evidence / 'prepared.json').exists())

    def test_existing_evidence_does_not_allow_replay(self):
        (self.evidence / 'authorized_keys.before').write_bytes(b'retained')
        before = self.file.read_bytes()
        with self.assertRaises(FileExistsError):
            self.run_repair()
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual((self.evidence / 'authorized_keys.before').read_bytes(), b'retained')

    def test_concurrent_change_before_append_refuses(self):
        original = repair.private_record
        def interfere(fd, name, data):
            original(fd, name, data)
            if name == 'prepared.json':
                with self.file.open('ab') as output:
                    output.write(b'external-change\n')
        with patch.object(repair, 'private_record', side_effect=interfere):
            with self.assertRaisesRegex(ValueError, 'CHANGED'):
                self.run_repair()
        self.assertNotIn(b'ssh-ed25519', self.file.read_bytes())

    def test_key_hash_options_injection_and_wire_type_refused(self):
        for key in (b'command="false" ' + KEY, KEY + KEY, KEY.replace(b'ssh-ed25519', b'ssh-rsa', 1),
                    KEY.replace(b' synthetic', b'\rsynthetic')):
            with self.subTest(key=key), self.assertRaises((ValueError, UnicodeError)):
                repair.public_line(key, repair.sha256(key))
        with self.assertRaisesRegex(ValueError, 'KEY_HASH'):
            repair.public_line(KEY, '0' * 64)

    def test_local_account_scope(self):
        row = b'tonyaiops:x:1000:1000::/home/tonyaiops:/bin/bash\n'
        self.assertEqual(repair.account(row), (1000, 1000))
        for raw in (row + row, row.replace(b'1000:', b'0:', 1),
                    row.replace(b'/home/tonyaiops', b'/root'), row.replace(b'/bin/bash', b'/bin/false')):
            with self.assertRaises(ValueError):
                repair.account(raw)

    def test_guest_invalid_proposal_cannot_observe_identity(self):
        with patch.object(guest, 'identity', side_effect=AssertionError('network forbidden')):
            result = guest.main({})
        self.assertEqual(result['status'], 'REFUSED_REVIEW_REQUIRED')
        self.assertEqual(result['refusal_code'], 'PROPOSAL')
        self.assertIsNone(result['evidence_path'])

    def test_guest_missing_source_authority_target_and_key_refuse_before_observation(self):
        for field, value in (('execution_authorized', True), ('format', True),
                             ('target_imds', {}), ('packet_id', '../escape'),
                             ('public_key_sha256', '0' * 64)):
            item = proposal()
            item[field] = value
            with self.subTest(field=field), patch.object(guest, 'identity', side_effect=AssertionError('network')):
                self.assertEqual(guest.main(item)['status'], 'REFUSED_REVIEW_REQUIRED')
        item = proposal()
        item['source']['published_sha'] = None
        with patch.object(guest, 'identity', side_effect=AssertionError('network')):
            self.assertEqual(guest.main(item)['refusal_code'], 'UNPUBLISHED_SOURCE')

    def test_guest_target_mismatch_cannot_open_files(self):
        item = proposal()
        observed = {'imds': dict(item['target_imds'], vmId='wrong'), 'boot_id': 'synthetic'}
        with patch.object(guest.sys, 'platform', 'linux'), patch.object(guest.os, 'geteuid', return_value=0), \
             patch.object(guest.sys, 'dont_write_bytecode', True), \
             patch.object(guest, 'identity', return_value=observed), \
             patch.object(guest, 'Directories', side_effect=AssertionError('file access')):
            result = guest.main(item)
        self.assertEqual(result['refusal_code'], 'IMDS_MISMATCH')
        self.assertIsNone(result['evidence_path'])

    def test_directory_chain_refuses_leaf_links_and_detects_replacement(self):
        with guest.ExitStack() as stack:
            dirs = guest.Directories.__new__(guest.Directories)
            dirs.stack, dirs.edges = stack, []
            root = dirs.keep(os.open(self.tmp.name, os.O_RDONLY | os.O_DIRECTORY))
            self.ssh.rename(Path(self.tmp.name) / 'original')
            self.ssh.symlink_to('original')
            with self.assertRaises(OSError):
                dirs.child(root, 'ssh', os.getuid(), 0o700)
            self.ssh.unlink()
            self.ssh.mkdir(mode=0o700)
            dirs.child(root, 'ssh', os.getuid(), 0o700)
            self.ssh.rename(Path(self.tmp.name) / 'moved')
            self.ssh.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'CHANGED'):
                dirs.verify()

    def test_renderer_is_offline_draft_and_preserves_old_target(self):
        root = Path(self.tmp.name)
        supplied = root / 'retained.json'
        supplied.write_text(json.dumps({'target': {'imds': proposal()['target_imds']}}))
        key = root / 'identity.pub'
        key.write_bytes(KEY)
        before = supplied.read_bytes()
        destination = root / 'packet'
        with patch.object(packet, 'verified_head', side_effect=ValueError('unpublished')):
            result = packet.prepare(destination, supplied, key, HASH)
        self.assertIsNone(result['source']['published_sha'])
        self.assertFalse(result['execution_authorized'])
        self.assertEqual(supplied.read_bytes(), before)
        manifest = json.loads((destination / 'packet.json').read_bytes())
        self.assertFalse(manifest['retained_target_is_fresh'])
        self.assertIsNone(manifest['encrypted_custody_export'])
        self.assertEqual(manifest['guest_sha256'], repair.sha256((destination / 'guest.py').read_bytes()))
        compile((destination / 'guest.py').read_bytes(), '<synthetic-draft>', 'exec')
        with patch.object(packet, 'verified_head', side_effect=ValueError('unpublished')):
            with self.assertRaises(FileExistsError):
                packet.prepare(destination, supplied, key, HASH)

    def test_synthetic_guest_path_accepts_its_own_attempt_directory(self):
        root = Path(self.tmp.name) / 'guest'
        ssh = root / 'home' / 'tonyaiops' / '.ssh'
        ssh.mkdir(parents=True, mode=0o700)
        (root / 'var' / 'lib').mkdir(parents=True)
        keys = ssh / 'authorized_keys'
        keys.write_bytes(b'original synthetic key\n')
        keys.chmod(0o600)
        uid, gid = os.getuid(), os.getgid()
        original_check = guest.Directories.check
        class SyntheticDirectories(guest.Directories):
            def __init__(self, stack):
                self.stack, self.edges = stack, []
                self.root = self.keep(os.open(root, os.O_RDONLY | os.O_DIRECTORY))
            @staticmethod
            def check(fd, owner, mode):
                return original_check(fd, uid if owner == 0 else owner, mode)
        original_append = guest.append_verified
        def synthetic_append(*args):
            # Only the simulated root-owned evidence directory maps to our
            # unprivileged local uid. No actual root or guest is involved.
            with patch.object(repair.os, 'geteuid', return_value=uid):
                return original_append(*args)
        item = proposal()
        observed = {'imds': item['target_imds'], 'boot_id': 'synthetic'}
        with patch.object(guest.sys, 'platform', 'linux'), \
             patch.object(guest.os, 'geteuid', return_value=0), \
             patch.object(guest.sys, 'dont_write_bytecode', True), \
             patch.object(guest, 'identity', return_value=observed), \
             patch.object(guest, 'Directories', SyntheticDirectories), \
             patch.object(guest, 'local_account', return_value=(uid, gid)), \
             patch.object(guest, 'append_verified', side_effect=synthetic_append):
            result = guest.main(item)
            repeated = guest.main(item)
        self.assertEqual(result['status'], 'KEY_APPENDED_REVIEW_REQUIRED', result)
        self.assertEqual(result['cleanup_errors'], [])
        self.assertEqual(keys.read_bytes(), b'original synthetic key\n' + repair.public_line(KEY, HASH)[0])
        self.assertEqual(repeated['failure'], 'FileExistsError')
        evidence = root / 'var' / 'lib' / ('tonyai-r3-access-recovery-' + item['packet_id'])
        retained = json.loads((evidence / 'pre-close-result.json').read_bytes())
        self.assertEqual(retained['status'], 'KEY_APPENDED_REVIEW_REQUIRED')
        self.assertFalse(retained['access_verified'])

    def test_cleanup_does_not_hide_primary_refusal(self):
        original = os.close
        self.file.write_bytes(KEY)
        def close_then_fail(fd):
            original(fd)
            raise OSError('synthetic cleanup failure')
        with patch.object(repair.os, 'close', side_effect=close_then_fail):
            with self.assertRaisesRegex(ValueError, 'KEY_ALREADY_PRESENT') as caught:
                self.run_repair()
        self.assertEqual(caught.exception.cleanup_errors, ['OSError'])


if __name__ == '__main__':
    unittest.main()
