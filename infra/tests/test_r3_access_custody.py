"""Synthetic custody envelopes and interrupted/refused fetches. No real keys or SSH."""
import base64
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_access_repair as repair
import r3_access_repair_custody as custody
import r3_access_repair_receive as receiver
from r3_noble_common import encoded
from test_r3_access_repair import proposal


def fixture():
    item = proposal()
    before = b'old synthetic key\n'
    suffix = repair.public_line(item['public_key'].encode(), item['public_key_sha256'])[0]
    identity = {'imds': item['target_imds'], 'boot_id': 'synthetic'}
    prepared = {'before_sha256': repair.sha256(before), 'before_bytes': len(before),
                'append_sha256': repair.sha256(suffix), 'append_bytes': len(suffix),
                'public_key_sha256': item['public_key_sha256'], 'uid': 1000, 'gid': 1000,
                'mode': 0o600, 'device': 1, 'inode': 2}
    appended = {**prepared, 'after_sha256': repair.sha256(before + suffix), 'after_bytes': len(before + suffix),
                'status': 'KEY_APPENDED_REVIEW_REQUIRED', 'access_verified': False,
                'qualification': False, 'installation_success': False}
    retained = {'status': 'KEY_APPENDED_REVIEW_REQUIRED', 'phase': 'completed', 'failure': None,
                'cleanup_errors': [], 'access_verified': False, 'qualification': False, 'installation_success': False,
                'identity_before': identity, 'identity_after': identity, 'append': appended,
                'evidence_path': '/var/lib/tonyai-r3-access-recovery-' + item['packet_id']}
    records = {'invocation.json': encoded({'proposal_sha256': repair.sha256(encoded(item)), 'identity_before': identity}),
               'authorized_keys.before': before, 'prepared.json': encoded(prepared),
               'pre-close-result.json': json.dumps(retained, sort_keys=True).encode()}
    summary = {k: retained[k] for k in ('status', 'phase', 'failure', 'cleanup_errors', 'access_verified',
                                        'qualification', 'installation_success', 'evidence_path', 'append')}
    summary.update(pre_close_result_sha256=repair.sha256(records['pre-close-result.json']), identity_stable=True,
                   finalization={'status': retained['status'], 'cleanup_errors': []})
    envelope = {'format': 1, 'purpose': 'R3_REPAIR_PRIVATE_EXPORT', 'packet_id': item['packet_id'],
                'identity_before': identity, 'identity_after': identity, 'status': 'EXPORTED_REVIEW_REQUIRED',
                'failure': None, 'cleanup_errors': [], 'files': {k: {'bytes': len(v), 'sha256': repair.sha256(v),
                       'base64': base64.b64encode(v).decode()} for k, v in records.items()}}
    return item, envelope, summary


class Custody(unittest.TestCase):
    def test_complete_source_bound_export_is_only_review_evidence(self):
        item, envelope, summary = fixture()
        value = custody.validate_export(encoded(envelope), item, summary)
        self.assertEqual(value['status'], 'REPAIR_EVIDENCE_VERIFIED_REVIEW_REQUIRED')
        self.assertFalse(value['qualification'])
        self.assertFalse(value['policy_generated'])

    def test_bad_invocation_before_image_and_partial_finalization_refuse(self):
        for change in ('before', 'invocation', 'hash', 'cleanup', 'missing', 'identity', 'path'):
            item, envelope, summary = fixture()
            if change == 'before': envelope['files']['authorized_keys.before']['base64'] = base64.b64encode(b'changed').decode()
            if change == 'invocation':
                raw = encoded({'proposal_sha256': '0' * 64, 'identity_before': envelope['identity_before']})
                envelope['files']['invocation.json'] = {'base64': base64.b64encode(raw).decode(), 'bytes': len(raw), 'sha256': repair.sha256(raw)}
            if change == 'hash':summary['pre_close_result_sha256'] = '0' * 64
            if change == 'cleanup':summary['finalization'] = {'status': 'PARTIAL_REVIEW_REQUIRED', 'cleanup_errors': ['OSError']}
            if change == 'missing':envelope['files']['prepared.json'] = {'absent': True}
            if change == 'identity':envelope['identity_after'] = {'imds': {}}
            if change == 'path':summary['evidence_path'] += '-different'
            with self.subTest(change=change), self.assertRaises((ValueError, KeyError)):
                custody.validate_export(encoded(envelope), item, summary)

    def test_receiver_complete_partial_and_failed_seal_never_overclaim(self):
        for arm_complete, sealed in ((True, True), (False, True), (True, False)):
            with self.subTest(arm=arm_complete, sealed=sealed), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve(); root.chmod(0o700)
                item, envelope, summary = fixture()
                plan = {'custody': {'known_hosts': '/synthetic/public'},
                        'target': {'connection': {'host': '192.0.2.1', 'user': 'tonyaiops'}}}
                control = {'status': 'KEY_APPENDED_CUSTODY_REQUIRED' if arm_complete else 'PARTIAL_REVIEW_REQUIRED',
                           'phase': 'repair', 'custody': {'sealed': True},
                           'guest_summary': summary if arm_complete else None}
                raw = encoded(control)
                (root / 'repair-summary.json').write_bytes(raw)
                (root / 'delivery.json').write_bytes(b'{}')
                (root / 'repair-consumed.json').write_bytes(encoded({'delivery_sha256': repair.sha256(b'{}')}))
                fresh = {'host_key_fingerprint': 'synthetic', 'repair_summary_sha256': repair.sha256(raw),
                         'observed_at': datetime.now(timezone.utc).isoformat()}
                def bounded_read(path, *args):
                    if str(path) == '/synthetic/public': return b'public'
                    if Path(path).name == 'export.py': return b'synthetic reader'
                    return Path(path).read_bytes()
                def fetch(_argv, _payload, output, _interrupted):
                    (output / 'guest.json').write_bytes(encoded(envelope))
                    return {'returncode': 0, 'failure': None, 'cleanup_errors': [], 'remote_exit_proven': False}
                with patch.object(receiver, 'approve', return_value=(plan, item, fresh)), \
                     patch.object(receiver, 'known_host', return_value='synthetic'), patch.object(receiver, 'read', side_effect=bounded_read), \
                     patch.object(receiver, 'probe'), patch.object(receiver, 'ssh_argv', return_value=['synthetic']), \
                     patch.object(receiver, 'receive', side_effect=fetch), \
                     patch.object(receiver, 'seal', return_value={'sealed': sealed, 'failure': None if sealed else 'OSError'}):
                    result = receiver.execute(root, b'{}', 'a' * 64, b'{}', raw, [])
                expected = 'REPAIR_EVIDENCE_VERIFIED_REVIEW_REQUIRED' if arm_complete and sealed else 'PARTIAL_REVIEW_REQUIRED'
                self.assertEqual(result['status'], expected)
                self.assertFalse(result['qualification'])
                self.assertFalse(result['installation_success'])
                self.assertTrue((root / 'export-capture/guest.json').exists())
                self.assertTrue((root / 'export-summary.json').exists())

    def test_sealing_keeps_plaintext_and_partial_ciphertext_on_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); root.chmod(0o700)
            (root / 'recipient.pub').write_bytes(b'synthetic')
            (root / 'private.txt').write_bytes(b'synthetic private evidence')
            dest = root.parent / (root.name + '.age')
            self.addCleanup(lambda: dest.unlink(missing_ok=True))
            def failed_age(*args, **kwargs):
                dest.write_bytes(b'partial cipher')
                raise TimeoutError('synthetic')
            with patch.object(custody, 'custody_inputs'), patch.object(custody, 'run', side_effect=failed_age):
                result = custody.seal({'recipient': 'synthetic', 'age': 'synthetic'}, root, dest)
            self.assertFalse(result['sealed'])
            self.assertEqual(result['failure'], 'TimeoutError')
            self.assertTrue((root / 'capture.tar').exists())
            self.assertEqual(dest.read_bytes(), b'partial cipher')
            self.assertEqual(dest.stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / 'private.txt').read_bytes(), b'synthetic private evidence')

    def test_primary_fetch_failure_survives_successful_seal_and_interrupt_blocks_ssh(self):
        for interrupted in ([], ['SIGTERM']):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve();root.chmod(0o700)
                item, envelope, summary = fixture()
                plan = {'custody': {'known_hosts': '/synthetic/public', 'recipient': 'synthetic'},
                        'target': {'connection': {'host': '192.0.2.1', 'user': 'tonyaiops'}}}
                control = {'status': 'KEY_APPENDED_CUSTODY_REQUIRED', 'phase': 'repair',
                           'custody': {'sealed': True}, 'guest_summary': summary}
                raw = encoded(control)
                (root / 'repair-summary.json').write_bytes(raw)
                (root / 'delivery.json').write_bytes(b'{}')
                (root / 'repair-consumed.json').write_bytes(encoded({'delivery_sha256': repair.sha256(b'{}')}))
                fresh = {'host_key_fingerprint': 'synthetic', 'repair_summary_sha256': repair.sha256(raw),
                         'observed_at': datetime.now(timezone.utc).isoformat()}
                def bounded_read(path, *args):
                    if str(path) == '/synthetic/public':return b'public'
                    if Path(path).name == 'export.py':return b'synthetic reader'
                    return Path(path).read_bytes()
                with patch.object(receiver, 'approve', return_value=(plan, item, fresh)), \
                     patch.object(receiver, 'known_host', return_value='synthetic'), patch.object(receiver, 'read', side_effect=bounded_read), \
                     patch.object(receiver, 'probe'), patch.object(receiver, 'ssh_argv', return_value=['synthetic']), \
                     patch.object(receiver, 'receive', side_effect=OSError('synthetic refusal')) as fetch, \
                     patch.object(receiver, 'seal', return_value={'sealed': True, 'failure': None}):
                    result = receiver.execute(root, b'{}', 'a' * 64, b'{}', raw, interrupted)
                self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
                self.assertEqual(result['failure'], 'ValueError' if interrupted else 'OSError')
                self.assertEqual(fetch.call_count, 0 if interrupted else 1)
                self.assertTrue((root / 'export-consumed.json').exists())
                self.assertTrue(result['sealed'])


if __name__ == '__main__':
    unittest.main()
