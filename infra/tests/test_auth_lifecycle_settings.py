"""Cloud-free policy parity, reconciliation and drift refusal for LP4-01."""
import contextlib
import io
import copy
import json
from pathlib import Path
import tomllib
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import unittest
from unittest.mock import patch
from auth_settings import managed_auth_settings, validate_managed_auth_settings
from supabase_auth import configure_auth
from pooler import SafeFailure
from test_supabase_resume import TARGET, REF

ORIGIN = TARGET['web_origin']


class AuthLifecycleSettingsTests(unittest.TestCase):
    def test_local_auth_policy_parity(self):
        local = tomllib.loads((Path(__file__).resolve().parents[2] / 'supabase/config.toml').read_text())['auth']
        expected = managed_auth_settings(ORIGIN)
        self.assertEqual(expected['disable_signup'], not local['enable_signup'])
        self.assertEqual(expected['external_email_enabled'], local['email']['enable_signup'])
        self.assertEqual(expected['jwt_exp'], local['jwt_expiry'])
        self.assertEqual(expected['password_min_length'], local['minimum_password_length'])
        self.assertEqual(expected['mailer_otp_exp'], local['email']['otp_expiry'])
        self.assertEqual(expected['mailer_secure_email_change_enabled'], local['email']['double_confirm_changes'])
        self.assertEqual(expected['mailer_autoconfirm'], not local['email']['enable_confirmations'])
        self.assertEqual(expected['security_update_password_require_reauthentication'], local['email']['secure_password_change'])
        self.assertFalse(expected['mailer_notifications_password_changed_enabled'])
        self.assertIn(ORIGIN + '/auth/confirm', expected['uri_allow_list'].split(','))

    def test_every_managed_setting_missing_wrong_or_wrong_type_refused(self):
        good = managed_auth_settings(ORIGIN)
        validate_managed_auth_settings(good, ORIGIN)
        for key, value in good.items():
            for bad in (None, str(value) if not isinstance(value, str) else 'wrong', not value if isinstance(value, bool) else 0):
                candidate = copy.deepcopy(good); candidate[key] = bad
                with self.subTest(key=key, bad=bad), self.assertRaises(SafeFailure):
                    validate_managed_auth_settings(candidate, ORIGIN)
            candidate = copy.deepcopy(good); del candidate[key]
            with self.subTest(missing=key), self.assertRaises(SafeFailure):
                validate_managed_auth_settings(candidate, ORIGIN)
        with self.assertRaises(SafeFailure):
            validate_managed_auth_settings({**good, 'external_new_provider_enabled': True}, ORIGIN)

    def test_jwt_expiry_bounds_postgrest_residual_to_one_hour(self):
        good = managed_auth_settings(ORIGIN)
        self.assertEqual(good['jwt_exp'], 3600)
        for bad in (None, '3600', 3600.0, True, 0, 604800):
            with self.subTest(bad=bad), self.assertRaises(SafeFailure):
                validate_managed_auth_settings({**good, 'jwt_exp': bad}, ORIGIN)

    def test_repeated_reconcile_does_not_write_again_and_refuses_each_ignored_setting(self):
        public = {'disable_signup': True, 'saml_enabled': False,
                  'external': {'email': True, 'phone': False, 'anonymous_users': False}}
        def request(url, **kwargs):
            payload = public if url.endswith('/settings') else {'keys': [{'kid': 'id', 'alg': 'ES256', 'kty': 'EC'}]}
            return 200, json.dumps(payload).encode()
        for ignored in (None, *managed_auth_settings(ORIGIN)):
            state = {'external_github_enabled': True, 'smtp_pass': 'private-sentinel'}; writes = []
            output = io.StringIO()
            def api(path, method='GET', body=None):
                if method == 'PATCH':
                    writes.append(body); state.update(body)
                    if ignored: state.pop(ignored)
                return dict(state)
            with self.subTest(ignored=ignored), contextlib.redirect_stdout(output), patch('supabase_auth.request', side_effect=request), patch('supabase_auth.require_success', side_effect=lambda response: response[1]):
                if ignored:
                    with self.assertRaises(SafeFailure): configure_auth(api, REF, ORIGIN, 'public', 'id')
                    self.assertEqual(output.getvalue(), '')
                else:
                    configure_auth(api, REF, ORIGIN, 'public', 'id')
                    configure_auth(api, REF, ORIGIN, 'public', 'id')
                    self.assertEqual(len(writes), 1)
                    self.assertFalse(state['external_github_enabled'])
                    self.assertEqual(output.getvalue().splitlines(), [
                        'PASS: Auth policy updated; all readbacks passed.',
                        'PASS: Auth policy unchanged (no PATCH); all readbacks passed.',
                    ])
                    self.assertNotIn('private-sentinel', output.getvalue())
