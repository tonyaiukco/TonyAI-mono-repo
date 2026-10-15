"""Synthetic owner custody, discovery transport and DB classification regressions."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import replacement_escrow as escrow
import replacement_discovery as discovery
import replacement_probe as probe
import secure_transport
from replacement_bundle import encoded, write_new
from replacement_custody import ENV, SODIUM, envelope, marker
from replacement_plan import CREATE
from test_replacement_custody import contract
from test_replacement_plan import inputs


class ReplacementOwnerTests(unittest.TestCase):
    @contextlib.contextmanager
    def escrow_fixture(self, action='save', stage='environment', version=None, existing=False,
                       changed=False, saved_id=None, mismatch=False):
        data = contract(); files = {ENV: b'synthetic-environment'}
        if stage == 'intrinsic': files[SODIUM] = b'synthetic-intrinsic'
        value = envelope(data, stage, files); requests = []; calls = []
        exact = 'a' * 32
        identity = data['recovery_vault_url'] + '/secrets/supabase-r02-' + stage + '/' + exact
        with tempfile.TemporaryDirectory() as folder, contextlib.ExitStack() as stack:
            config = Path(folder) / 'contract'; record = Path(folder) / 'record'
            write_new(config, encoded(data))
            original = encoded(marker(data, stage, 'b' * 32 if mismatch else exact, files))
            if existing: write_new(record, original)
            argv = ['escrow', action, '--stage', stage, '--contract', str(config), '--record', str(record),
                    '--ssh-target', 'tonyaiops@' + data['public_hostname'], '--key', 'synthetic-key', '--known-hosts', 'synthetic-known-hosts']
            if version is not None: argv += ['--version', version]
            exports = 0
            def capture(command, payload=None):
                nonlocal exports
                calls.append(command)
                if command[:3] == ['az', 'account', 'show']:
                    return encoded({'id': data['subscription_id'], 'tenantId': data['tenant_id']})
                if command[:3] == ['az', 'account', 'get-access-token']:
                    return encoded({'accessToken': 'synthetic-token'})
                if 'export ' in command[-1]:
                    exports += 1
                    return encoded(value) + (b' ' if changed and exports > 1 else b'')
                return b''
            def request(req, **kwargs):
                requests.append((req.get_method(), req.full_url))
                response = MagicMock()
                response.__enter__.return_value = io.BytesIO(encoded(
                    {'id': saved_id or identity} if req.get_method() == 'PUT' else {'id': identity, 'value': encoded(value).decode()}))
                return response
            stack.enter_context(patch.object(sys, 'argv', argv))
            stack.enter_context(patch.object(escrow, 'capture', side_effect=capture))
            opener = stack.enter_context(patch.object(escrow, 'build_opener'))
            opener.return_value.open.side_effect = request
            output = stack.enter_context(patch('sys.stdout', new_callable=io.StringIO))
            yield record, requests, calls, output, original

    def test_saved_id_selects_exact_version_and_private_record_without_secret_output(self):
        with self.escrow_fixture() as (record, requests, calls, output, _):
            escrow.main()
            self.assertEqual(json.loads(record.read_bytes())['version'], 'a' * 32)
            self.assertEqual(record.stat().st_mode & 0o777, 0o600)
            gets = [url for method, url in requests if method == 'GET']
            self.assertEqual(len(gets), 1)
            self.assertIn('/' + 'a' * 32 + '?', gets[0])
            self.assertNotIn('synthetic-', output.getvalue())
            self.assertTrue(any('mark environment' in call[-1] for call in calls))

    def test_existing_record_refuses_vault_write_and_preserves_bytes(self):
        with self.escrow_fixture(existing=True) as (record, requests, calls, _, original):
            with self.assertRaisesRegex(ValueError, 'overwrite'): escrow.main()
            self.assertEqual(record.read_bytes(), original)
            self.assertFalse(any(method == 'PUT' for method, _ in requests))
            self.assertFalse(any('mark ' in call[-1] for call in calls))

    def test_reexport_change_refuses_local_record_and_host_mark(self):
        with self.escrow_fixture(changed=True) as (record, _, calls, _, _):
            with self.assertRaisesRegex(ValueError, 'Host changed'): escrow.main()
            self.assertFalse(record.exists())
            self.assertFalse(any('mark ' in call[-1] for call in calls))

    def test_restore_record_mismatch_never_sends_restore_payload(self):
        with self.escrow_fixture('restore', 'intrinsic', 'a' * 32, True, mismatch=True) as (record, _, calls, _, original):
            with self.assertRaisesRegex(ValueError, 'Restore record'): escrow.main()
            self.assertFalse(any('replacement_restore.py' in call[-1] for call in calls))
            self.assertEqual(record.read_bytes(), original)

    def test_latest_or_missing_version_never_issues_vault_get(self):
        for action in ('verify', 'restore'):
            for version in (None, 'latest'):
                with self.subTest(action=action, version=version), self.escrow_fixture(action, 'intrinsic', version) as (_, requests, _, _, _):
                    with self.assertRaises(ValueError): escrow.main()
                    self.assertFalse(any(method == 'GET' for method, _ in requests))

    def test_foreign_saved_id_never_becomes_an_unversioned_get(self):
        with self.escrow_fixture(saved_id='https://foreign.vault.azure.net/secrets/foreign/' + 'a' * 32) as (record, requests, _, _, _):
            with self.assertRaises(ValueError): escrow.main()
            self.assertFalse(record.exists())
            self.assertFalse(any(method == 'GET' for method, _ in requests))

    def test_collision_404_is_absent_and_both_names_must_be_available(self):
        requests = []
        def open_request(req, **kwargs):
            requests.append(req.full_url)
            if 'checkNameAvailability' not in req.full_url and 'checkDnsNameAvailability' not in req.full_url:
                raise HTTPError(req.full_url, 404, 'synthetic missing', {}, None)
            response = MagicMock()
            response.__enter__.return_value.read.return_value = encoded({'nameAvailable': True, 'available': True})
            return response
        with patch.object(discovery, 'azure_token', return_value='synthetic-token'), patch.object(secure_transport, 'build_opener') as opener:
            opener.return_value.open.side_effect = open_request
            discovery.check_collisions(inputs())
        self.assertEqual(len(requests), len(CREATE) + 2)

    def test_collision_existing_resource_stops_before_name_checks(self):
        with patch.object(discovery, 'azure_token', return_value='synthetic-token'), patch.object(discovery, 'json_request', return_value={}) as request:
            with self.assertRaisesRegex(ValueError, 'already exists'): discovery.check_collisions(inputs())
            self.assertEqual(request.call_count, 1)

    def test_collision_unavailable_or_unknown_global_name_refuses(self):
        for vault, dns in [(False, True), (True, False), (None, True), (True, None)]:
            with self.subTest(vault=vault, dns=dns), patch.object(discovery, 'azure_token', return_value='synthetic-token'), patch.object(discovery, 'json_request', side_effect=[None] * len(CREATE) + [{'nameAvailable': vault}, {'available': dns}]):
                with self.assertRaisesRegex(ValueError, 'availability'): discovery.check_collisions(inputs())

    def test_database_password_failure_only_is_401(self):
        with patch.object(probe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 2, b'', b'password authentication failed for user "postgres"')):
            self.assertEqual(probe.database_status('synthetic-image', 'postgres', 'synthetic-password'), 401)

    def test_database_other_errors_are_inconclusive(self):
        for code, stdout, stderr in [(2, b'', b'connection timed out'), (1, b'', b'password authentication failed for user'), (0, b'unexpected', b'')]:
            with self.subTest(code=code, stdout=stdout), patch.object(probe.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, stdout, stderr)):
                self.assertEqual(probe.database_status('synthetic-image', 'postgres', 'synthetic-password'), 0)

    def test_database_process_timeout_is_inconclusive(self):
        with patch.object(probe.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 20)):
            self.assertEqual(probe.database_status('synthetic-image', 'postgres', 'synthetic-password'), 0)
