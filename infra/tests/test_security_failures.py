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
GOOD_URL = f'postgresql://tonyai_runtime.{PROJECT}:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert={CONTAINER_CA}&pgbouncer=true'
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

    def test_secret_transport_does_not_follow_redirect_or_echo_error_body(self):
        from secure_transport import json_request
        self.seen.clear()
        with self.assertRaises(SafeFailure) as result:
            json_request(self.origin + '/redirect', token='synthetic')
        self.assertEqual(self.seen, ['/redirect'])
        self.assertNotIn('synthetic', str(result.exception))
        with self.assertRaises(SafeFailure) as result:
            json_request(self.origin + '/error', token='synthetic')
        self.assertNotIn('sensitive-error-body', str(result.exception))

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

    def test_pooler_rejects_every_unapproved_query_key(self):
        for extra in ('host=127.0.0.1', 'host=evil.example.com',
                      'host=aws-0-us-east-1.pooler.supabase.com', 'SSLACCEPT=strict',
                      'schema=public', 'options=anything', 'unknown=', '%68ost=evil.example.com'):
            with self.subTest(extra=extra), self.assertRaises(SafeFailure):
                validate_pooler(GOOD_URL + '&' + extra, PROJECT, 6543)

    def test_runtime_secret_returns_only_validated_enabled_exact_version(self):
        record = {'id':'https://vault.vault.azure.net/secrets/database-url/'+'a'*32,
                  'value':GOOD_URL, 'attributes':{'enabled':True}}
        with patch('secure_transport.azure_token', return_value='synthetic'), patch('secure_transport.json_request', return_value=record):
            self.assertEqual(ops.runtime_secret_id('vault',PROJECT,'a'*32), record['id'])
        for change in ({'value':GOOD_URL+'&host=evil.example.com'}, {'attributes':{'enabled':False}},
                       {'id':record['id'].replace('vault.vault','foreign.vault')},
                       {'id':record['id'].rsplit('/',1)[0]}):
            with self.subTest(change=change), patch('secure_transport.azure_token', return_value='synthetic'), patch('secure_transport.json_request', return_value={**record,**change}):
                with self.assertRaises(SafeFailure): ops.runtime_secret_id('vault',PROJECT,'a'*32)

    def test_migrate_refuses_invalid_secret_before_any_prisma_command(self):
        direct = GOOD_URL.replace('tonyai_runtime.', 'postgres.').replace(':6543', ':5432')
        for url in (direct.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs'),
                    direct.replace('postgres.', 'tonyai_runtime.'), direct + '&host=evil.invalid'):
            with patch.object(ops, 'secret', return_value=url), patch.object(ops, 'command') as command:
                with self.assertRaises(SafeFailure):
                    ops.migrate('test-vault', PROJECT, 'b'*32)
                command.assert_not_called()

    def test_bucket_readback_must_not_trust_write_acknowledgement(self):
        limit, mimes = ops.BUCKETS['evidence']
        stale = {'id':'evidence','public':True,'file_size_limit':limit,'allowed_mime_types':mimes}
        def request(url, method='GET', *args, **kwargs):
            if url == BASE + '/bucket': return 200, b'[]'
            if method != 'GET': return 200, b'{}'
            bucket = url.rsplit('/', 1)[-1]
            limit, mimes = ops.BUCKETS[bucket]
            return 200, json.dumps({**stale, 'id':bucket, 'file_size_limit':limit, 'allowed_mime_types':mimes}).encode()
        with patch.object(ops, 'request', side_effect=request):
            with self.assertRaises(SafeFailure):
                ops.provision_buckets(BASE, 'synthetic')

    def test_signed_bytes_and_exact_cleanup_targets(self):
        self.storage_probe(correct_bytes=True, public=False)
        self.storage_probe(correct_bytes=False, public=False)

    def test_public_download_is_denied_even_when_signed_download_is_valid(self):
        self.storage_probe(correct_bytes=True, public=True)

    def storage_probe(self, correct_bytes, public):
        uploads, deletes = {}, []
        def request(url, method='GET', key=None, body=None, content_type='application/json'):
            if method == 'DELETE':
                deletes.append((url, json.loads(body)['prefixes']))
                return 200, b'{}'
            if '/object/public/' in url:
                return (200, b'public bytes') if public else (404, b'')
            if '/object/sign/' in url:
                if method == 'POST':
                    self.assertEqual(json.loads(body), {'expiresIn':60})
                    return 200,json.dumps({'signedURL':url[len(BASE):] + '?token=synthetic'}).encode()
                original = url.split('?')[0].replace('/object/sign/', '/object/')
                return 200, uploads[original] if correct_bytes else b'wrong bytes'
            uploads[url] = body
            return 200,b'{}'
        with patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
            if correct_bytes and not public:
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
               'PREFIX':'tonyai', 'ACA_DEFAULT_DOMAIN':'example.germanywestcentral.azurecontainerapps.io',
               'API_ORIGIN':'https://tonyai-staging-api.example.germanywestcentral.azurecontainerapps.io'}
        env['NEXT_PUBLIC_API_BASE_URL'] = env['API_ORIGIN'] + '/api/v1'
        with patch('check_browser_key.request', side_effect=[(401,b''),(200,json.dumps(AUTH).encode())]) as request:
            check_inputs(env)
            self.assertEqual(request.call_args.args[0], env['NEXT_PUBLIC_SUPABASE_URL'] + '/auth/v1/settings')
        with patch('check_browser_key.request', return_value=(401,b'')):
            with self.assertRaises(SafeFailure): check_inputs(env)
        with patch('check_browser_key.request') as request:
            forged = 'https://tonyai-staging-api.evil.com.germanywestcentral.azurecontainerapps.io'
            with self.assertRaises(SafeFailure):
                check_inputs({**env, 'API_ORIGIN':forged, 'NEXT_PUBLIC_API_BASE_URL':forged+'/api/v1'})
            request.assert_not_called()
        for field in ('NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_API_BASE_URL','API_ORIGIN'):
            with patch('check_browser_key.request') as request:
                with self.assertRaises(SafeFailure): check_inputs({**env,field:'http://localhost:3000'})
                request.assert_not_called()

    def test_browser_build_rejects_open_auth_settings_and_missing_key_enforcement(self):
        env = {'SUPABASE_PROJECT_REF':PROJECT, 'NEXT_PUBLIC_SUPABASE_ANON_KEY':'sb_publishable_synthetic',
               'NEXT_PUBLIC_SUPABASE_URL':'https://' + PROJECT + '.supabase.co',
               'PREFIX':'tonyai', 'ACA_DEFAULT_DOMAIN':'example.germanywestcentral.azurecontainerapps.io',
               'API_ORIGIN':'https://tonyai-staging-api.example.germanywestcentral.azurecontainerapps.io'}
        env['NEXT_PUBLIC_API_BASE_URL'] = env['API_ORIGIN'] + '/api/v1'
        for field in ('disable_signup', 'phone', 'anonymous_users'):
            settings = json.loads(json.dumps(AUTH))
            if field == 'disable_signup': settings[field] = False
            else: settings['external'][field] = True
            with self.subTest(field=field), patch('check_browser_key.request', side_effect=[(401,b''),(200,json.dumps(settings).encode())]):
                with self.assertRaises(SafeFailure): check_inputs(env)
        with patch('check_browser_key.request', return_value=(200,json.dumps(AUTH).encode())):
            with self.assertRaises(SafeFailure): check_inputs(env)

    def test_asset_scan_refuses_privileged_material_without_echoing_it(self):
        import base64
        payload = base64.urlsafe_b64encode(b'{"role":"service_role"}').rstrip(b'=')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError): scan(Path(directory))
            path = Path(directory) / 'chunk.js'
            for bad in [b'sb_secret_synthetic', b'eyJhbGciOiJIUzI1NiJ9.' + payload + b'.synthetic']:
                path.write_bytes(bad)
                with self.assertRaises(ValueError) as failure: scan(Path(directory))
                self.assertNotIn(bad.decode(), str(failure.exception))
            path.write_text('safe public asset')
            scan(Path(directory))
