"""No-network lifecycle custody, backup validation and deadline regressions."""
from datetime import datetime, timedelta, timezone
import json
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import hosted_lifecycle_bootstrap as bootstrap
import hosted_backup_evidence as backup
from pooler import SafeFailure
from test_deploy_versions import inputs


class EvidenceTests(unittest.TestCase):
    def test_backup_requires_recent_completed_timezone_region_and_actual_booleans(self):
        now = datetime.now(timezone.utc)
        payload = {'region': 'eu-north-1', 'walg_enabled': True, 'pitr_enabled': False,
                   'backups': [{'status': 'COMPLETED', 'inserted_at': now.isoformat()}]}
        report = backup.summary(payload, now)
        self.assertTrue(report['recent_completed_backup_observed'])
        self.assertFalse(report['restore_proven']); self.assertFalse(report['storage_file_bytes_proven'])
        for defect in ['region', 'boolean', 'naive', 'future', 'invalid']:
            with self.subTest(defect=defect):
                p = json.loads(json.dumps(payload))
                if defect == 'region': p['region'] = 'other'
                if defect == 'boolean': p['walg_enabled'] = 1
                if defect == 'naive': p['backups'][0]['inserted_at'] = now.replace(tzinfo=None).isoformat()
                if defect == 'future': p['backups'][0]['inserted_at'] = (now + timedelta(hours=1)).isoformat()
                if defect == 'invalid': p['backups'][0]['inserted_at'] = 'bad'
                with self.assertRaises(SafeFailure): backup.summary(p, now)
        for age in [37, 200]:
            payload['backups'][0]['inserted_at'] = (now - timedelta(hours=age)).isoformat()
            self.assertFalse(backup.summary(payload, now)['recent_completed_backup_observed'])
        payload['backups'][0]['status'] = 'FAILED'
        self.assertEqual(backup.summary(payload, now)['completed_backup_count'], 0)

    def test_backup_whole_request_timeout_preserves_not_accepted_intent_and_no_token(self):
        fixture = inputs(); candidate = {'source_sha': fixture['release']['source_sha']}
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'backup.json'
            with patch.object(backup, 'clean'), patch.object(backup, 'prepare'), \
                 patch.object(backup.getpass, 'getpass', return_value='SECRET-TOKEN'), \
                 patch.object(backup.subprocess, 'run', side_effect=subprocess.TimeoutExpired('worker', 60)) as child:
                with self.assertRaises(SafeFailure): backup.run(candidate, fixture, 'a'*40, directory, receipt)
            self.assertEqual(child.call_args.kwargs['timeout'], 60)
            self.assertIn('SECRET-TOKEN', child.call_args.kwargs['input'].decode())
            self.assertNotIn('SECRET-TOKEN', str(child.call_args.args))
            self.assertFalse(json.loads(receipt.read_text())['accepted'])
            self.assertNotIn('SECRET-TOKEN', receipt.read_text())

    def test_backup_worker_fixed_get_no_redirect_errors_or_raw_token_output(self):
        endpoint = 'https://api.supabase.com/v1/projects/' + 'a'*20 + '/database/backups'
        for defect in ['none', 'foreign', 'query', 'redirect', 'oversize']:
            rawin = json.dumps({'url': endpoint + ('?download=1' if defect == 'query' else '') if defect != 'foreign' else 'https://evil.invalid', 'token': 'SECRET'})
            source = Mock(); source.buffer = io.BytesIO(rawin.encode())
            dest = Mock(); dest.buffer = io.BytesIO()
            response = Mock(status=200); response.read.return_value = b'x'*1048577 if defect == 'oversize' else b'{}'
            response.__enter__ = Mock(return_value=response); response.__exit__ = Mock(return_value=False)
            opener = Mock(); opener.open.return_value = response
            if defect == 'redirect': opener.open.side_effect = RuntimeError('SECRET provider error')
            with patch.object(backup.sys, 'stdin', source), patch.object(backup.sys, 'stdout', dest), patch.object(backup, 'build_opener', return_value=opener) as build:
                code = backup.read_worker()
            self.assertEqual(code, 0 if defect == 'none' else 1)
            self.assertNotIn(b'SECRET', dest.buffer.getvalue())
            if defect in ['foreign', 'query']: opener.open.assert_not_called()
            else:
                build.assert_called_once_with(backup.NoRedirect)
                request = opener.open.call_args.args[0]
                self.assertEqual(request.get_method(), 'GET'); self.assertEqual(request.full_url, endpoint)
                self.assertEqual(opener.open.call_args.kwargs['timeout'], 15)

    def test_quarantine_rotates_password_durably_and_requires_identity_readback(self):
        target = bootstrap.target_for({'source_sha': 'a'*40, 'supabase_project_ref': 'a'*20})
        own = {'id': target['userId'], 'email': target['email'],
               'app_metadata': {'l10_lifecycle_bootstrap': target['organisationId']},
               'banned_until': '9999-01-01T00:00:00Z'}
        for mismatch in [False, True]:
            after = {**own, 'id': 'foreign'} if mismatch else own
            with patch.object(bootstrap, 'auth_call', side_effect=[own, {}, after]) as call:
                self.assertEqual(bootstrap.quarantine('https://example.invalid', 'SECRET', target), not mismatch)
                mutation = call.call_args_list[1].args
                self.assertEqual(mutation[4]['ban_duration'], '876000h')
                self.assertGreater(len(mutation[4]['password']), 32)
                self.assertEqual(mutation[3], '/' + target['userId'])
        with patch.object(bootstrap, 'auth_call', return_value={**own, 'email': 'foreign@invalid.test'}) as call:
            with self.assertRaises(SafeFailure): bootstrap.quarantine('https://example.invalid', 'SECRET', target)
            self.assertEqual(call.call_count, 1)

    def test_bootstrap_lost_fixture_ack_quarantines_only_intended_user_without_deletion(self):
        fixture = inputs(); candidate = {'source_sha': fixture['release']['source_sha'],
            'supabase_project_ref': fixture['release']['supabase_project_ref']}
        target = bootstrap.target_for(candidate)
        own = {'id': target['userId'], 'email': target['email'],
               'app_metadata': {'l10_lifecycle_bootstrap': target['organisationId']},
               'banned_until': '9999-01-01T00:00:00Z'}
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'bootstrap.json'
            with patch.object(bootstrap, 'prepared') as prepared, patch.object(bootstrap, 'target_for', return_value=target), \
                 patch.object(bootstrap.getpass, 'getpass', return_value='Secret-Password-12'), \
                 patch.object(bootstrap, 'secret', return_value='SECRET'), patch.object(bootstrap, 'validate_pooler'), \
                 patch.object(bootstrap, 'run_probe', side_effect=SafeFailure('lost ACK')), \
                 patch.object(bootstrap, 'auth_call', side_effect=[own, own, {}, own]) as auth:
                prepared.return_value.__enter__.return_value = ('image', Path(directory), {}, 'seal', 'ca')
                with self.assertRaises(SafeFailure): bootstrap.run(candidate, fixture, receipt, 'a'*40, directory, 'b'*32)
            state = json.loads(receipt.read_text())
            self.assertFalse(state['bootstrap_complete']); self.assertTrue(state['retirement_required'])
            self.assertTrue(state['intended_auth_quarantined_on_failure'])
            self.assertEqual(auth.call_args_list[0].args[4]['ban_duration'], '876000h')
            self.assertTrue(all(call.args[2] != 'DELETE' for call in auth.call_args_list))
            self.assertNotIn('Secret-Password', receipt.read_text()); self.assertNotIn('SECRET', receipt.read_text())

    def test_mismatched_create_id_is_preserved_and_never_deleted(self):
        fixture = inputs(); candidate = {'source_sha': fixture['release']['source_sha'],
            'supabase_project_ref': fixture['release']['supabase_project_ref']}
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'bootstrap.json'; foreign = '12345678-1234-1234-1234-123456789abc'
            with patch.object(bootstrap, 'prepared') as prepared, \
                 patch.object(bootstrap.getpass, 'getpass', return_value='Secret-Password-12'), \
                 patch.object(bootstrap, 'secret', return_value='SECRET'), patch.object(bootstrap, 'validate_pooler'), \
                 patch.object(bootstrap, 'auth_call', side_effect=[{'id': foreign}, None]) as auth:
                prepared.return_value.__enter__.return_value = ('image', Path(directory), {}, 'seal', 'ca')
                with self.assertRaises(SafeFailure): bootstrap.run(candidate, fixture, receipt, 'a'*40, directory, 'b'*32)
            state = json.loads(receipt.read_text())
            self.assertEqual(state['unexpected_response_id'], foreign); self.assertTrue(state['unexpected_response_requires_review'])
            self.assertEqual(auth.call_count, 2)
            self.assertTrue(all(call.args[2] != 'DELETE' for call in auth.call_args_list))


if __name__ == '__main__': unittest.main()
