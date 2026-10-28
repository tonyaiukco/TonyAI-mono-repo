"""Hosted bucket provisioning/readback and probe bytes match the application contract."""
import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cloud_ops as ops
from pooler import SafeFailure

EXPECTED = {
    'evidence': (10485760, ['application/pdf', 'image/jpeg', 'image/png', ops.XLSX, 'text/csv']),
    'import-sources': (2097152, ['text/csv', ops.XLSX]),
    'report-artifacts': (20971520, ['application/pdf']),
}
BASE = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1'


class HostedBucketTests(unittest.TestCase):
    def reconcile(self, existing, corrupt=None):
        writes = {}
        def request(url, method='GET', key=None, body=None):
            if url == BASE + '/bucket' and method == 'GET':
                return 200, json.dumps([{'id': name} for name in existing]).encode()
            if method in ('POST', 'PUT'):
                data = json.loads(body)
                name = data.get('id', url.rsplit('/', 1)[-1])
                writes[name] = (method, data)
                return 200, b'{}'
            name = url.rsplit('/', 1)[-1]
            limit, mimes = EXPECTED[name]
            actual = {'public': False, 'file_size_limit': limit, 'allowed_mime_types': mimes}
            if corrupt and name == corrupt[0]: actual.update(corrupt[1])
            return 200, json.dumps(actual).encode()
        with patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
            ops.provision_buckets(BASE, 'synthetic')
        return writes

    def test_all_three_contracts_on_create_update_and_upgrade(self):
        self.assertEqual(ops.BUCKETS, EXPECTED)
        for existing in ([], list(EXPECTED), ['evidence', 'import-sources']):
            writes = self.reconcile(existing)
            self.assertEqual(set(writes), set(EXPECTED))
            for name, (limit, mimes) in EXPECTED.items():
                method, data = writes[name]
                self.assertEqual(method, 'PUT' if name in existing else 'POST')
                self.assertIs(data['public'], False)
                self.assertEqual(data['file_size_limit'], limit)
                self.assertEqual(data['allowed_mime_types'], mimes)

    def test_each_bucket_readback_refuses_public_wrong_limit_and_wrong_mime(self):
        for name in EXPECTED:
            for changed in ({'public': True}, {'public': None}, {'file_size_limit': 1},
                            {'allowed_mime_types': ['text/plain']}, {'allowed_mime_types': None}):
                with self.subTest(name=name, changed=changed), self.assertRaises(SafeFailure):
                    self.reconcile(list(EXPECTED), (name, changed))

    def test_pdf_probe_and_exact_cleanup_even_when_signed_read_fails(self):
        for failed in (False, True):
            uploads, deletes = {}, []
            def request(url, method='GET', key=None, body=None, content_type=None):
                if method == 'DELETE':
                    deletes.extend(json.loads(body)['prefixes'])
                    return 200, b'{}'
                if '/object/public/' in url: return 404, b''
                if '/object/sign/' in url:
                    if method == 'POST':
                        return 200, json.dumps({'signedURL': url[len(BASE):]}).encode()
                    path = url.replace('/object/sign/', '/object/')
                    return 200, b'wrong' if failed else uploads[path]
                self.assertEqual(content_type, 'application/pdf')
                self.assertTrue(url.endswith('.pdf'))
                self.assertTrue(body.startswith(b'%PDF-') and body.endswith(b'%%EOF\n'))
                uploads[url] = body
                return 200, b'{}'
            with patch.object(ops, 'BUCKETS', {'report-artifacts': EXPECTED['report-artifacts']}), \
                    patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                if failed:
                    with self.assertRaises(SafeFailure): ops.probe_buckets(BASE, 'synthetic')
                else: ops.probe_buckets(BASE, 'synthetic')
            self.assertEqual(deletes, [url.split('/report-artifacts/')[1] for url in uploads])
