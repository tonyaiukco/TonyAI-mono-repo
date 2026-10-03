"""Failure injection for non-idempotent management operations and secret transports."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from operation_journal import Journal
from pooler import SafeFailure
from supabase_project import ensure_project
from supabase_auth import ensure_signing_key, configure_auth
from secure_transport import Vault, json_request

REF = 'abcdefghijklmnopqrst'
TARGET = {'name':'tonyai-staging-rehearsal','organization_id':'org','organization_slug':'slug','vault':'vault','web_origin':'https://tonyai-staging-web.example.germanywestcentral.azurecontainerapps.io'}
PROJECT = {'id':REF,'name':TARGET['name'],'organization_id':'org','region':'eu-central-1'}


class ResumeTests(unittest.TestCase):
    def test_project_timeout_reconciles_visible_project_and_never_reposts(self):
        with tempfile.TemporaryDirectory() as d:
            journal = Journal(Path(d)/'journal.json',TARGET)
            vault = Mock(); vault.get.return_value = {'value':'synthetic-password'}
            state = []; posts = []
            def api(path, method='GET', body=None):
                if method == 'POST':
                    self.assertTrue(json.loads(journal.path.read_text())['project_pending'])
                    self.assertEqual(body['region_selection'],{'type':'specific','code':'eu-central-1'})
                    posts.append(body); state.append(PROJECT)
                    raise SafeFailure('Interrupted.')
                return state if path == '/v1/projects' else PROJECT
            with self.assertRaises(SafeFailure): ensure_project(api,vault,journal)
            journal.close()
            journal = Journal(Path(d)/'journal.json',TARGET)
            self.assertEqual(ensure_project(api,vault,journal),REF)
            self.assertEqual(len(posts),1)
            self.assertNotIn('synthetic-password',journal.path.read_text())
            journal.close()

    def test_unrecorded_ambiguous_foreign_region_and_invisible_pending_refused(self):
        for rows,pending in [([PROJECT],False),([PROJECT,PROJECT],True),([],True),([{**PROJECT,'region':'us-east-1'}],True)]:
            with tempfile.TemporaryDirectory() as d:
                journal = Journal(Path(d)/'j.json',TARGET)
                if pending: journal.set(project_pending=True)
                api=Mock(return_value=rows)
                with self.assertRaises(SafeFailure): ensure_project(api,Mock(),journal)
                self.assertEqual(api.call_count,1)
                journal.close()

    def test_journal_lock_and_cross_target_binding(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'j.json'; journal=Journal(path,TARGET)
            with self.assertRaises(SafeFailure): Journal(path,TARGET)
            journal.close()
            with self.assertRaises(SafeFailure): Journal(path,{**TARGET,'vault':'foreign'})

    def test_signing_key_lost_post_response_resumes_unique_delta(self):
        with tempfile.TemporaryDirectory() as d:
            journal=Journal(Path(d)/'j.json',TARGET)
            keys=[]; posts=[]
            def api(path,method='GET',body=None):
                if method == 'POST':
                    self.assertEqual(journal.data['signing_before_ids'],[])
                    posts.append(body)
                    keys.append({'id':'00000000-0000-4000-8000-000000000001','algorithm':'ES256','status':'standby'})
                    raise SafeFailure('Interrupted.')
                if method == 'PATCH': keys[0]['status']='in_use'
                return {'keys':keys}
            with self.assertRaises(SafeFailure): ensure_signing_key(api,REF,journal)
            self.assertEqual(ensure_signing_key(api,REF,journal),keys[0]['id'])
            ensure_signing_key(api,REF,journal)
            self.assertEqual(len(posts),1)
            journal.close()

    def test_unknown_key_creation_outcome_never_reposts(self):
        with tempfile.TemporaryDirectory() as d:
            journal=Journal(Path(d)/'j.json',TARGET); journal.set(signing_before_ids=[])
            api=Mock(return_value={'keys':[]})
            with self.assertRaises(SafeFailure): ensure_signing_key(api,REF,journal)
            self.assertEqual(api.call_count,1)
            journal.close()

    def test_vault_put_recovers_written_value_without_new_version(self):
        record={'id':'https://vault.vault.azure.net/secrets/database-url/'+'a'*32,
                'attributes':{'enabled':True},'value':'synthetic','tags':{'project':REF}}
        with patch('secure_transport.azure_token',return_value='token'), patch('secure_transport.json_request',return_value=record) as request:
            self.assertEqual(Vault('vault').put('database-url','synthetic',{'project':REF}),record['id'])
            self.assertEqual(request.call_count,1)
            self.assertNotIn('synthetic', request.call_args.args[0])

    def test_auth_refuses_partial_readback_before_public_probe(self):
        api=Mock(side_effect=[{'external_github_enabled':True}, {}, {'site_url':'https://evil.invalid'}])
        with patch('supabase_auth.request', side_effect=SafeFailure('Unexpected public probe.')) as public:
            with self.assertRaises(SafeFailure): configure_auth(api,REF,TARGET['web_origin'],'synthetic','id')
            public.assert_not_called()
        desired=api.call_args_list[1].args[2]
        self.assertFalse(desired['external_github_enabled'])
        self.assertTrue(desired['disable_signup'])
        self.assertEqual(desired['uri_allow_list'],TARGET['web_origin']+','+TARGET['web_origin']+'/login')
