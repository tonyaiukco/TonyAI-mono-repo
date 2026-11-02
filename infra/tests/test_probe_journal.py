"""Offline failure-boundary proofs: no HTTP, Auth or cloud side effects."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cloud_ops as ops

BASE = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1'


class ProbeJournalTests(unittest.TestCase):
    def test_committed_upload_with_lost_response_still_cleans_exact_durable_path(self):
        for failure in (TimeoutError('synthetic'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as directory:
                journal = Path(directory) / 'objects.json'
                calls = []
                def request(url, method='GET', key=None, body=None, content_type=None):
                    saved = json.loads(journal.read_text())
                    self.assertEqual(len(saved['objects']), 1)
                    entry = saved['objects'][0]
                    self.assertTrue(entry['upload_attempted'])
                    self.assertNotIn('synthetic-secret', journal.read_text())
                    calls.append((method, url, body))
                    if method == 'POST':
                        self.assertEqual(url, BASE + '/object/evidence/' + entry['path'])
                        raise failure
                    self.assertEqual(method, 'DELETE')
                    self.assertEqual(url, BASE + '/object/evidence')
                    self.assertEqual(json.loads(body), {'prefixes': [entry['path']]})
                    return 200, b'{}'
                with patch.object(ops, 'BUCKETS', {'evidence': ops.BUCKETS['evidence']}), patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(type(failure)):
                        ops.probe_buckets(BASE, 'synthetic-secret', journal)
                saved = json.loads(journal.read_text())
                self.assertTrue(saved['objects'][0]['deletion_acknowledged'])
                self.assertFalse(saved['absence_verified'])
                self.assertEqual([x[0] for x in calls], ['POST', 'DELETE'])
                self.assertEqual(os.stat(journal).st_mode & 0o777, 0o600)

    def test_default_probe_upload_timeout_still_attempts_exact_cleanup(self):
        methods = []
        path = 'lp2-foundation-probe/11111111-1111-1111-1111-111111111111.csv'
        def request(url, method='GET', key=None, body=None, content_type=None):
            methods.append(method)
            if method == 'POST':
                self.assertEqual(url, BASE + '/object/evidence/' + path)
                raise TimeoutError('synthetic committed upload, lost response')
            self.assertEqual(url, BASE + '/object/evidence')
            self.assertEqual(json.loads(body), {'prefixes': [path]})
            return 200, b'{}'
        with patch.object(ops, 'BUCKETS', {'evidence': ops.BUCKETS['evidence']}), patch.object(ops, 'uuid4', return_value='11111111-1111-1111-1111-111111111111'), patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(TimeoutError): ops.probe_buckets(BASE, 'synthetic')
        self.assertEqual(methods, ['POST', 'DELETE'])

    def test_existing_journal_refuses_before_any_request(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / 'objects.json'
            journal.write_text('old receipt')
            with patch.object(ops, 'request') as request:
                with self.assertRaises(FileExistsError):
                    ops.probe_buckets(BASE, 'synthetic', journal)
            request.assert_not_called()
            self.assertEqual(journal.read_text(), 'old receipt')

    def test_cleanup_journal_failure_does_not_skip_exact_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / 'objects.json'
            original = ops.write_private_journal
            writes = []
            def write(path, data, exclusive=False):
                writes.append(data['objects'][0]['cleanup_attempted'])
                if data['objects'][0]['cleanup_attempted']:
                    raise OSError('synthetic disk failure')
                original(path, data, exclusive)
            methods = []
            def request(url, method='GET', key=None, body=None, content_type=None):
                methods.append(method)
                if method == 'POST': raise TimeoutError('synthetic lost response')
                self.assertEqual(json.loads(body)['prefixes'], [json.loads(journal.read_text())['objects'][0]['path']])
                return 200, b'{}'
            with patch.object(ops, 'BUCKETS', {'evidence': ops.BUCKETS['evidence']}), patch.object(ops, 'write_private_journal', side_effect=write), patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(OSError): ops.probe_buckets(BASE, 'synthetic', journal)
            self.assertEqual(methods, ['POST', 'DELETE'])
            self.assertTrue(json.loads(journal.read_text())['objects'][0]['upload_attempted'])

    def test_failed_atomic_replace_preserves_previous_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / 'objects.json'
            ops.write_private_journal(journal, {'intent': True}, exclusive=True)
            with patch.object(ops.os, 'replace', side_effect=OSError('synthetic')):
                with self.assertRaises(OSError): ops.write_private_journal(journal, {'result': True})
            self.assertEqual(json.loads(journal.read_text()), {'intent': True})
            self.assertEqual(list(Path(directory).iterdir()), [journal])
