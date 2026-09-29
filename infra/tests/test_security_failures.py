"""Regression tests observe the actual request path and adversarial server responses."""
import contextlib
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cloud_ops as ops
from pooler import CONTAINER_CA, SafeFailure, validate_pooler
from auth_settings import validate_auth_settings
from check_browser_key import check_inputs
from scan_browser_assets import scan

PROJECT = 'abcdefghijklmnopqrst'
BASE = 'https://' + PROJECT + '.supabase.co/storage/v1'
GOOD_URL = f'postgresql://postgres.{PROJECT}:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert={CONTAINER_CA}&pgbouncer=true'
AUTH = {'disable_signup': True, 'saml_enabled': False, 'external': {'email': True, 'phone': False, 'anonymous_users': False, 'github': False}}


class RequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seen = []
        seen = cls.seen
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/credential-target')
                    self.end_headers()
                else:
                    self.send_response(403)
                    self.end_headers()
                    self.wfile.write(b'sensitive-error-body')
            def log_message(self, *args):
                pass
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = 'http://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_real_request_does_not_follow_redirect(self):
        self.seen.clear()
        self.assertEqual(ops.request(self.origin + '/redirect', key='synthetic'), (302, b''))
        self.assertEqual(self.seen, ['/redirect'])

    def test_http_error_body_is_discarded(self):
        self.assertEqual(ops.request(self.origin + '/error', key='synthetic'), (403, b''))


class GuardTests(unittest.TestCase):
    def test_pooler_database_region_and_strict_certificate_required(self):
        validate_pooler(GOOD_URL, PROJECT, 6543)
        bad_urls = [GOOD_URL.replace('/postgres?', '/other?'), GOOD_URL.replace('eu-central-1', 'us-east-1'),
                    GOOD_URL.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs'),
                    GOOD_URL.replace('&sslaccept=strict', ''), GOOD_URL + '&sslaccept=accept_invalid_certs',
                    GOOD_URL.replace(CONTAINER_CA, '/wrong-ca'), GOOD_URL + '&sslrootcert=/wrong-ca']
        for url in bad_urls:
            with self.subTest(url=url), self.assertRaises(SafeFailure):
                validate_pooler(url, PROJECT, 6543)

    def test_migrate_refuses_invalid_secret_before_any_prisma_command(self):
        for position in (0, 1):
            secrets = [GOOD_URL, GOOD_URL.replace(':6543', ':5432')]
            secrets[position] = secrets[position].replace('sslaccept=strict', 'sslaccept=accept_invalid_certs')
            with patch.object(ops, 'secret', side_effect=secrets), patch.object(ops, 'command') as command:
                with self.assertRaises(SafeFailure):
                    ops.migrate('test-vault', PROJECT)
                command.assert_not_called()

    def test_bucket_readback_must_not_trust_write_acknowledgement(self):
        limit, mimes = ops.BUCKETS['evidence']
        stale = {'id':'evidence','public':True,'file_size_limit':limit,'allowed_mime_types':mimes}
        with patch.object(ops, 'request', side_effect=[(200,b'[]'), (200,b'{}'), (200,json.dumps(stale).encode())]):
            with self.assertRaises(SafeFailure):
                ops.provision_buckets(BASE, 'synthetic')

    def test_signed_bytes_and_exact_cleanup_targets(self):
        for correct_bytes in (True, False):
            uploads, deletes = {}, []
            def request(url, method='GET', key=None, body=None, content_type='application/json'):
                if method == 'DELETE':
                    deletes.append((url, json.loads(body)['prefixes']))
                    return 200, b'{}'
                if '/object/public/' in url:
                    return 404, b''
                if '/object/sign/' in url:
                    if method == 'POST':
                        self.assertEqual(json.loads(body), {'expiresIn':60})
                        return 200,json.dumps({'signedURL':url[len(BASE):] + '?token=synthetic'}).encode()
                    original = url.split('?')[0].replace('/object/sign/', '/object/')
                    return 200, uploads[original] if correct_bytes else b'wrong bytes'
                uploads[url] = body
                return 200,b'{}'
            with patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                if correct_bytes:
                    ops.probe_buckets(BASE, 'synthetic')
                else:
                    with self.assertRaises(SafeFailure):
                        ops.probe_buckets(BASE, 'synthetic')
            self.assertEqual(len(uploads), len(deletes))
            for upload in uploads:
                bucket, path = upload[len(BASE + '/object/'):].split('/', 1)
                self.assertIn((BASE + '/object/' + bucket, [path]), deletes)

    def test_auth_settings_fail_closed_for_enabled_or_missing_controls(self):
        validate_auth_settings(AUTH)
        for field in ('disable_signup', 'saml_enabled'):
            for mode in ('missing', 'wrong'):
                settings = json.loads(json.dumps(AUTH))
                if mode == 'missing':
                    del settings[field]
                else:
                    settings[field] = not settings[field]
                with self.assertRaises(SafeFailure): validate_auth_settings(settings)
        for name in ('phone','anonymous_users','github','new_provider'):
            settings = json.loads(json.dumps(AUTH))
            settings['external'][name] = True
            with self.assertRaises(SafeFailure): validate_auth_settings(settings)

    def test_public_key_must_be_accepted_by_exact_project_and_urls(self):
        env = {'SUPABASE_PROJECT_REF':PROJECT, 'NEXT_PUBLIC_SUPABASE_ANON_KEY':'sb_publishable_synthetic',
               'NEXT_PUBLIC_SUPABASE_URL':'https://' + PROJECT + '.supabase.co',
               'API_ORIGIN':'https://tonyai-staging-api.example.germanywestcentral.azurecontainerapps.io'}
        env['NEXT_PUBLIC_API_BASE_URL'] = env['API_ORIGIN'] + '/api/v1'
        with patch('check_browser_key.request', return_value=(200,json.dumps(AUTH).encode())) as request:
            check_inputs(env)
            self.assertEqual(request.call_args.args[0], env['NEXT_PUBLIC_SUPABASE_URL'] + '/auth/v1/settings')
        with patch('check_browser_key.request', return_value=(401,b'')):
            with self.assertRaises(SafeFailure): check_inputs(env)
        for field in ('NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_API_BASE_URL','API_ORIGIN'):
            with patch('check_browser_key.request') as request:
                with self.assertRaises(SafeFailure): check_inputs({**env,field:'http://localhost:3000'})
                request.assert_not_called()

    def test_asset_scan_refuses_privileged_material_without_echoing_it(self):
        import base64
        payload = base64.urlsafe_b64encode(b'{"role":"service_role"}').rstrip(b'=')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'chunk.js'
            for bad in [b'sb_secret_synthetic', b'eyJhbGciOiJIUzI1NiJ9.' + payload + b'.synthetic']:
                path.write_bytes(bad)
                with self.assertRaises(ValueError) as failure: scan(Path(directory))
                self.assertNotIn(bad.decode(), str(failure.exception))
            path.write_text('safe public asset')
            scan(Path(directory))
