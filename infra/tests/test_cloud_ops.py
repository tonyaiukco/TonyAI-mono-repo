"""Credential-free tests for failures that could otherwise leak or misconfigure staging."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ops = load('cloud_ops')
browser = load('check_browser_key')
PROJECT = 'abcdefghijklmnopqrst'
BASE = 'https://' + PROJECT + '.supabase.co/storage/v1'


class CloudOpsTests(unittest.TestCase):
    def test_pooler_requires_correct_project_tls_and_mode(self):
        # Synthetic password only, never a real credential.
        url = 'postgresql://tonyai_runtime.' + PROJECT + ':synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt&pgbouncer=true'
        ops.validate_pooler(url, PROJECT, 6543)
        for bad in [url.replace(PROJECT, 'wrongproject'), url.replace('6543', '5432'),
                    url.replace('sslmode=require', 'sslmode=disable'),
                    url.replace('pgbouncer=true', 'pgbouncer=false'),
                    url.replace('.pooler.supabase.com', '.attacker.invalid')]:
            with self.subTest(bad=bad), self.assertRaises(ops.SafeFailure):
                ops.validate_pooler(bad, PROJECT, 6543)

    def test_command_failure_does_not_reflect_sensitive_output(self):
        with patch.object(ops.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'sensitive-stdout', 'sensitive-stderr')):
            with self.assertRaises(ops.SafeFailure) as failure:
                ops.command(['unused'])
            self.assertNotIn('sensitive', str(failure.exception))

    def test_no_credential_forwarding_on_redirect(self):
        self.assertIsNone(ops.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://attacker.invalid'))

    def test_migrations_get_secrets_via_environment_not_arguments(self):
        values = {
            'database-url': f'postgresql://tonyai_runtime.{PROJECT}:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt&pgbouncer=true',
            'direct-url': f'postgresql://postgres.{PROJECT}:synthetic@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt',
        }
        with patch.object(ops, 'secret', side_effect=lambda vault, name, version: values[name]), patch.object(ops, 'command') as command, contextlib.redirect_stdout(io.StringIO()):
            ops.migrate('test-vault', PROJECT, 'b'*32)
        self.assertEqual(command.call_count, 2)
        self.assertEqual(command.call_args_list[0].args[0], ['pnpm', 'db:deploy'])
        for call in command.call_args_list:
            self.assertNotIn('synthetic', ' '.join(call.args[0]))
            self.assertEqual(call.args[1]['DIRECT_URL'], ops.local_ca_url(values['direct-url']))
            self.assertEqual(call.args[1]['DATABASE_URL'], ops.local_ca_url(values['direct-url']))

    def test_failed_bucket_list_must_not_create_or_update(self):
        with patch.object(ops, 'request', return_value=(403, b'')) as request:
            with self.assertRaises(ops.SafeFailure):
                ops.provision_buckets(BASE, 'synthetic-key')
        self.assertEqual(request.call_count, 1)

    def test_bucket_creation_and_existing_public_bucket_reconciliation(self):
        calls = []
        state = {'evidence': {'id': 'evidence', 'public': True}}

        def request(url, method='GET', key=None, body=None, content_type='application/json'):
            calls.append((method, url, body))
            if url == BASE + '/bucket' and method == 'GET':
                return 200, json.dumps(list(state.values())).encode()
            if method in ('PUT', 'POST'):
                settings = json.loads(body)
                name = settings.get('id', url.rsplit('/', 1)[-1])
                state[name] = {'id': name, **settings}
                return 200, b'{}'
            return 200, json.dumps(state[url.rsplit('/', 1)[-1]]).encode()

        with patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
            ops.provision_buckets(BASE, 'synthetic-key')
            ops.provision_buckets(BASE, 'synthetic-key')
        self.assertEqual(sum(method == 'POST' for method, _, _ in calls), 1)
        for name, (limit, mimes) in ops.BUCKETS.items():
            self.assertIs(state[name]['public'], False)
            self.assertEqual(state[name]['file_size_limit'], limit)
            self.assertEqual(set(state[name]['allowed_mime_types']), set(mimes))

    def test_probe_cleans_up_on_unexpected_public_access_or_signed_url(self):
        for public_status, signed in [(200, ''), (404, 'https://attacker.invalid/key')]:
            calls = []

            def request(url, method='GET', key=None, body=None, content_type='application/json'):
                calls.append((url, method))
                if '/object/public/' in url:
                    return public_status, b''
                if '/object/sign/' in url:
                    return 200, json.dumps({'signedURL': signed}).encode()
                return 200, b'{}'

            with patch.object(ops, 'request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(ops.SafeFailure):
                    ops.probe_buckets(BASE, 'synthetic-key')
            self.assertEqual(calls[-1], (BASE + '/object/evidence', 'DELETE'))
            self.assertFalse(any('attacker.invalid' in url for url, _ in calls))

    def test_browser_key_rejects_privileged_and_wrong_project_jwts(self):
        import base64
        def jwt(role, project):
            payload = base64.urlsafe_b64encode(json.dumps({'role': role, 'ref': project}).encode()).decode().rstrip('=')
            return 'synthetic.' + payload + '.synthetic'
        self.assertTrue(browser.validate(jwt('anon', PROJECT), PROJECT))
        self.assertTrue(browser.validate('sb_publishable_synthetic', PROJECT))
        for key in ['sb_secret_synthetic', jwt('service_role', PROJECT), jwt('anon', 'wrong'), '', 'invalid']:
            self.assertFalse(browser.validate(key, PROJECT))


if __name__ == '__main__':
    unittest.main()
