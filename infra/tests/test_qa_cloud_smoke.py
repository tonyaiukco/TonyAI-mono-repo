"""Offline fake I/O only; no cloud, credentials, browser, Prisma or database contact."""
from contextlib import ExitStack
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from qa_discovery import digest
from qa_deployment_contract import accepted_history
from qa_smoke_contract import target_for, validate_journal
from qa_cloud_smoke import run, prepare, authenticate, credentials
from qa_deployment_fixtures import evidence, synthetic_history, NOW, app_data


class SwedenSmokeTests(unittest.TestCase):
    def setUp(self):
        self.evidence = evidence()
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(synthetic_history())
        self.context = accepted_history(self.evidence, now=NOW)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.path = self.directory / 'journal.json'
        self.journal = dict(schema=1, evidence_sha256=digest(self.evidence), target=target_for(self.context['inputs']))
        self.path.write_text(json.dumps(self.journal))
        self.ca = self.directory / 'ca.crt'; self.ca.write_bytes(b'public-ca')

    def invoke(self, cleanup=False):
        run(self.evidence, digest(self.evidence), self.path, digest(self.journal), self.ca, cleanup_only=cleanup)

    def io(self):
        mocks = {}
        for name in ('authenticate', 'collect', 'credentials', 'backend_key', 'auth_call', 'cleanup', 'child'):
            mocks[name] = self.stack.enter_context(patch('qa_cloud_smoke.' + name))
        mocks['collect'].return_value = {'synthetic': 'stable-public-readback'}
        mocks['credentials'].return_value = ('public-synthetic', 'OWNER-URL-CANARY')
        mocks['backend_key'].return_value = 'BACKEND-CANARY'
        mocks['auth_call'].side_effect = lambda base,key,method,path,body: dict(id=body['id'], email=body['email'])
        return mocks

    def test_prepare_is_offline_draft_and_cannot_be_reused_as_evidence(self):
        self.path.unlink()
        with patch('qa_cloud_smoke.authenticate') as auth, patch('qa_cloud_smoke.collect') as read:
            result = prepare(self.evidence, digest(self.evidence), self.path)
            self.assertEqual(result['status'], 'BLOCKED_DRAFT'); self.assertFalse(result['authorization'])
            self.assertFalse(result['authenticated_provenance']); auth.assert_not_called(); read.assert_not_called()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(Exception): prepare(result, digest(result), self.directory / 'draft.json')

    def test_candidate_requires_actual_downloader_and_exact_provenance(self):
        unit = self.evidence['unit7']
        for defect in ('none', 'candidate', 'source', 'archive', 'run', 'failed'):
            candidate, provenance = deepcopy(unit['candidate']), deepcopy(unit['candidate_provenance'])
            if defect == 'candidate': candidate['api_digest'] = 'sha256:' + 'f'*64
            if defect in ('source', 'archive', 'run'): provenance[{'source':'source_sha','archive':'archive_sha256','run':'run_id'}[defect]] = 'foreign'
            with self.subTest(defect=defect), patch('qa_cloud_smoke.download', return_value=(candidate, provenance)) as download:
                if defect == 'failed': download.side_effect = SafeFailure('unavailable')
                if defect == 'none': authenticate(self.evidence)
                else:
                    with self.assertRaises(SafeFailure): authenticate(self.evidence)
                download.assert_called_once_with('tonyaiukco/TonyAI-mono-repo', 'e'*40, '123', with_provenance=True)

    def test_target_and_journal_rejection_precedes_all_external_io(self):
        for defect in ('hash', 'evidence', 'mode', 'sourceSha', 'releaseId', 'apiDigest', 'webDigest', 'dbCaSha256',
                       'web', 'api', 'supabase', 'userId', 'email', 'duplicate'):
            journal = deepcopy(self.journal)
            if defect == 'evidence': journal['evidence_sha256'] = 'f'*64
            elif defect in ('userId', 'email'): journal['target']['tenants'][0][defect] = 'foreign'
            elif defect == 'duplicate': journal['target']['tenants'][1] = journal['target']['tenants'][0]
            elif defect != 'hash': journal['target'][defect] = 'foreign'
            self.path.write_text(json.dumps(journal))
            with self.subTest(defect=defect), ExitStack() as stack:
                mocks = [stack.enter_context(patch('qa_cloud_smoke.' + n)) for n in ('authenticate','collect','credentials','backend_key','child','cleanup')]
                with self.assertRaises(SafeFailure):
                    run(self.evidence, digest(self.evidence), self.path, '0'*64 if defect=='hash' else digest(journal), self.ca)
                for mock in mocks: mock.assert_not_called()

    def test_failure_paths_never_publish_success_and_attempt_cleanup(self):
        for failure in ('none','before','prompt-drift','first-auth','second-auth','created-id','fixture','browser','timeout','interrupt','after','cleanup','post-cleanup-drift'):
            with self.subTest(failure=failure), ExitStack() as stack:
                for suffix in ('.attempt.json','.passed.json'):
                    Path(str(self.path)+suffix).unlink(missing_ok=True)
                mocks = {n:stack.enter_context(patch('qa_cloud_smoke.'+n)) for n in
                         ('authenticate','collect','credentials','backend_key','auth_call','cleanup','child')}
                mocks['credentials'].return_value=('public-synthetic','OWNER-URL-CANARY')
                mocks['backend_key'].return_value='BACKEND-CANARY'
                mocks['collect'].side_effect = ([SafeFailure('before')] if failure=='before' else
                    [{'stable':1}, {'stable':2 if failure=='prompt-drift' else 1},
                     {'stable':2 if failure=='after' else 1}, {'stable':2 if failure=='post-cleanup-drift' else 1}])
                calls=[]
                def auth(base,key,method,path,body):
                    self.assertTrue(Path(str(self.path)+'.attempt.json').exists())
                    calls.append(method)
                    if failure=='first-auth' or failure=='second-auth' and len(calls)==2: raise SafeFailure('auth')
                    return dict(id='foreign' if failure=='created-id' else body['id'],email=body['email'])
                mocks['auth_call'].side_effect=auth
                def child(script,env):
                    self.assertNotIn('BACKEND-CANARY', env.values())
                    self.assertNotIn('NODE_OPTIONS',env); self.assertNotIn('UNCLASSIFIED_CREDENTIAL',env)
                    if script=='image-smoke.mjs':
                        self.assertNotIn('OWNER-URL-CANARY',env.values()); self.assertNotIn('SMOKE_DB_CA_FILE',env)
                    if failure=='fixture' and script=='smoke-fixtures.mjs' or failure=='browser' and script=='image-smoke.mjs': raise SafeFailure('child')
                    if failure=='timeout': raise subprocess.TimeoutExpired('redacted',600)
                    if failure=='interrupt': raise KeyboardInterrupt
                mocks['child'].side_effect=child
                if failure=='cleanup': mocks['cleanup'].side_effect=SafeFailure('cleanup')
                stack.enter_context(patch.dict(os.environ, NODE_OPTIONS='ambient',UNCLASSIFIED_CREDENTIAL='ambient'))
                if failure=='none': self.invoke()
                else:
                    with self.assertRaises((SafeFailure,subprocess.TimeoutExpired,KeyboardInterrupt)): self.invoke()
                self.assertEqual(Path(str(self.path)+'.passed.json').exists(),failure=='none')
                if failure=='before':
                    mocks['credentials'].assert_not_called(); mocks['backend_key'].assert_not_called()
                if failure in ('before','prompt-drift'): mocks['auth_call'].assert_not_called(); mocks['child'].assert_not_called()
                else: mocks['cleanup'].assert_called_once()
                for file in self.directory.glob('journal*'):
                    self.assertNotIn('CANARY',file.read_text()); self.assertNotIn('password',file.read_text())

    def test_cleanup_requires_bound_attempt_then_no_owner_url_or_child(self):
        mocks=self.io()
        with self.assertRaises(FileNotFoundError): self.invoke(cleanup=True)
        mocks['backend_key'].assert_not_called()
        attempt=Path(str(self.path)+'.attempt.json')
        attempt.write_text(json.dumps(dict(journal_sha256='0'*64,evidence_sha256=digest(self.evidence))))
        with self.assertRaises(SafeFailure): self.invoke(cleanup=True)
        mocks['backend_key'].assert_not_called()
        attempt.write_text(json.dumps(dict(journal_sha256=digest(self.journal),evidence_sha256=digest(self.evidence))))
        self.invoke(cleanup=True)
        mocks['credentials'].assert_not_called(); mocks['child'].assert_not_called(); mocks['cleanup'].assert_called_once()
        self.assertFalse(Path(str(self.path)+'.passed.json').exists())

    def test_existing_attempt_or_report_refuses_before_authentication(self):
        mocks=self.io()
        for suffix in ('.attempt.json','.passed.json'):
            file=Path(str(self.path)+suffix); file.write_text('{}')
            with self.assertRaises(SafeFailure): self.invoke()
            mocks['authenticate'].assert_not_called(); mocks['credentials'].assert_not_called()
            file.unlink()

    def test_bad_public_material_refuses_owner_prompt(self):
        with patch('qa_cloud_smoke.getpass.getpass',return_value='invalid') as prompt:
            with self.assertRaises(SafeFailure): credentials(self.context['inputs'], b'bad-ca')
            prompt.assert_called_once()


if __name__ == '__main__': unittest.main()
