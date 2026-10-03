"""Restore holds must be explicit and cannot disappear through legacy manifests."""
import copy
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from test_deploy_versions import inputs
from terraform_run import validate_release
from foundation_contract import validate_foundation
from deploy_apps import check_hold_transition, main
from pooler import SafeFailure


class OperationalSettingsTests(unittest.TestCase):
    def test_required_hold_and_bounded_integer_interval(self):
        for key in ('storage_cleanup_hold', 'storage_sweep_interval_seconds'):
            value = inputs(); del value['release'][key]
            with self.subTest(missing=key), self.assertRaises(SafeFailure): validate_release(value)
        for bad in ('false', 'true', 0, 1, None, []):
            value = inputs(); value['release']['storage_cleanup_hold'] = bad
            with self.subTest(hold=bad), self.assertRaises(SafeFailure): validate_release(value)
        for bad in (True, False, 0, -1, 86401, 1.5, '300', None):
            value = inputs(); value['release']['storage_sweep_interval_seconds'] = bad
            with self.subTest(interval=bad), self.assertRaises(SafeFailure): validate_release(value)
        for hold in (True, False):
            for interval in (1, 300, 86400):
                value = inputs(); value['release'].update(storage_cleanup_hold=hold, storage_sweep_interval_seconds=interval)
                validate_release(value)

    def test_live_hold_needs_acknowledgement_and_lookup_failures_fail_closed(self):
        value = inputs()
        def live(hold):
            return {'name': 'tonyai-staging-api', 'containers': [{'env': [{'name': 'STORAGE_CLEANUP_HOLD', 'value': hold}]}]}
        for held in ('1', None, 'unknown'):
            with self.subTest(held=held), self.assertRaises(SafeFailure):
                check_hold_transition(value, read=lambda *args: live(held))
        check_hold_transition(value, acknowledge=True, read=lambda *args: live('1'))
        check_hold_transition(value, read=lambda *args: live('0'))
        with self.assertRaises(SafeFailure): check_hold_transition(value, read=lambda *args: {})
        with self.assertRaises(RuntimeError): check_hold_transition(value, read=lambda *args: (_ for _ in ()).throw(RuntimeError('lookup failed')))
        value['release']['storage_cleanup_hold'] = True
        check_hold_transition(value, read=lambda *args: self.fail('Setting hold needs no pre-existing app'))

    def test_deploy_checks_hold_before_any_terraform_action(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'; path.write_text(json.dumps(inputs()))
            for flag in ([], ['--approved-apply']):
                with patch('sys.argv', ['deploy_apps.py', '--backend', 'unused', '--inputs', str(path), *flag]), patch('deploy_apps.check_hold_transition', side_effect=SafeFailure('held')) as guard, patch('deploy_apps.invoke') as invoke:
                    with self.assertRaises(SafeFailure): main()
                    guard.assert_called_once()
                    invoke.assert_not_called()

    def test_monitoring_rejects_missing_invalid_or_unknown_fields(self):
        payload = {'subscription_id': '00000000-0000-0000-0000-000000000001',
                   'tenant_id': '00000000-0000-0000-0000-000000000002',
                   'owner_object_id': '00000000-0000-0000-0000-000000000003',
                   'environment': 'staging', 'prefix': 'tonyai', 'resource_group': 'tonyai-staging',
                   'registry_name': 'registry', 'vault_name': 'vault',
                   'repository': 'owner/repo', 'release_sha': 'a'*40}
        payload['runtime_secrets_ready'] = True
        good = {'operator_name': 'Test Operator', 'operator_email': 'operator@example.invalid',
                'api_digest': 'sha256:' + 'a'*64, 'supabase_project_ref': 'abcdefghijklmnopqrst',
                'database_secret_version': 'a'*32, 'backend_secret_version': 'b'*32}
        payload['monitoring'] = good
        validate_foundation({'config': payload})
        for field in good:
            for bad in (None, '', 42, 'invalid'):
                # 'invalid' is a valid operator name, so exercise a disallowed character there.
                if field == 'operator_name' and bad == 'invalid': bad = '<operator>'
                candidate = copy.deepcopy(payload); candidate['monitoring'][field] = bad
                with self.subTest(field=field, bad=bad), self.assertRaises(SafeFailure): validate_foundation({'config': candidate})
            candidate = copy.deepcopy(payload); del candidate['monitoring'][field]
            with self.subTest(missing=field), self.assertRaises(SafeFailure): validate_foundation({'config': candidate})
        for bad in ([], 'monitor', {**good, 'secret_value': 'never'}):
            candidate = copy.deepcopy(payload); candidate['monitoring'] = bad
            with self.assertRaises(SafeFailure): validate_foundation({'config': candidate})
        payload['runtime_secrets_ready'] = False
        with self.assertRaises(SafeFailure): validate_foundation({'config': payload})
