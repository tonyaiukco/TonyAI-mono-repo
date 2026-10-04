"""Interrupted bootstrap disable/Auth resume and validated fresh-terminal journals."""
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from pooler import SafeFailure
from operation_journal import Journal
from runtime_urls import transfer_urls
from secure_transport import Vault
from supabase_setup import run
from test_supabase_resume import TARGET, REF
from test_security_failures import GOOD_URL
import test_resource_trust
import session_resources


class SetupTests(unittest.TestCase):
    def test_disable_lost_reply_resumes_exact_urls_without_reading_bootstrap_or_new_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            journal=Journal(Path(directory)/'j.json',TARGET)
            records={'bootstrap-db-password':{'id':'https://vault.vault.azure.net/secrets/bootstrap-db-password/'+'b'*32,'value':'synthetic','attributes':{'enabled':True}}}
            writes=[];disabled=[]
            vault=Mock()
            vault.identifier.side_effect=lambda r,n,v=None: r['id']
            vault.get.side_effect=lambda n,v=None: records[n]
            def put(name,value,tags):
                writes.append(name)
                records[name]={'id':'https://vault.vault.azure.net/secrets/'+name+'/'+'a'*32,'value':value,'attributes':{'enabled':True},'tags':tags}
                return records[name]['id']
            def disable(name,version):
                self.assertEqual(journal.data['url_checkpoint']['bootstrap_password_version'],'b'*32)
                disabled.append((name,version))
                records.pop('bootstrap-db-password',None)
                if len(disabled)==1: raise SafeFailure('Lost reply.')
            vault.put.side_effect=put;vault.disable.side_effect=disable
            api=Mock(return_value=[{'database_type':'PRIMARY','connection_string':GOOD_URL}])
            with self.assertRaises(SafeFailure): transfer_urls(api,vault,REF,journal)
            journal.close();journal=Journal(Path(directory)/'j.json',TARGET)
            vault.get.reset_mock()
            versions=transfer_urls(api,vault,REF,journal)
            self.assertEqual(writes,['direct-url'])
            self.assertEqual(vault.get.call_args_list[0].args,('direct-url','a'*32))
            self.assertEqual(len(disabled),2)
            self.assertEqual(api.call_count,1)
            self.assertEqual(set(versions),{'direct_url_version'})
            self.assertNotIn('synthetic',journal.path.read_text())
            journal.close()

    def test_disable_requires_exact_version_and_disabled_acknowledgment(self):
        identity='https://vault.vault.azure.net/secrets/bootstrap-db-password/'+'a'*32
        for response in ({'id':identity,'attributes':{'enabled':False}}, {'id':identity,'attributes':{'enabled':True}}, {'id':identity[:-32]+'b'*32,'attributes':{'enabled':False}}):
            with patch('secure_transport.azure_token',return_value='synthetic'), patch('secure_transport.json_request',return_value=response) as request:
                if response['id']==identity and not response['attributes']['enabled']:
                    Vault('vault').disable('bootstrap-db-password','a'*32)
                else:
                    with self.assertRaises(SafeFailure): Vault('vault').disable('bootstrap-db-password','a'*32)
                self.assertEqual(request.call_args.args[1],'PATCH')
                self.assertEqual(request.call_args.args[3],{'attributes':{'enabled':False}})

    def test_setup_target_health_interruption_and_completed_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'config.json';config.write_text(json.dumps(TARGET))
            foundation=Path(directory)/'foundation.json';foundation.write_text('{}')
            args=SimpleNamespace(config=config,foundation=foundation,journal=Path(directory)/'j.json')
            session={'VAULT_NAME':TARGET['vault'],'WEB_ORIGIN':TARGET['web_origin'],'AZURE_TENANT_ID':'tenant'}
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch('terraform_run.clean_environment'))
                stack.enter_context(patch('foundation_contract.validate_foundation',return_value={'subscription_id':'sub','resource_group':'group','tenant_id':'tenant'}))
                restore=stack.enter_context(patch('session_resources.restore',return_value=session))
                prompt=stack.enter_context(patch('supabase_setup.getpass.getpass',return_value='synthetic'))
                stack.enter_context(patch('supabase_setup.sys.stdin.isatty',return_value=True))
                vault=stack.enter_context(patch('supabase_setup.Vault'))
                project=stack.enter_context(patch('supabase_setup.ensure_project',return_value=REF))
                api=stack.enter_context(patch('supabase_setup.json_request',return_value={'status':'ACTIVE_HEALTHY'}))
                transfer=stack.enter_context(patch('supabase_setup.transfer_runtime',return_value=('public',{'database_url_version':'a'*32,'backend_secret_version':'b'*32})))
                signing=stack.enter_context(patch('supabase_setup.ensure_signing_key',return_value='kid'))
                auth=stack.enter_context(patch('supabase_setup.configure_auth',side_effect=SafeFailure('Interrupted.')))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                for field in session:
                    restore.return_value={**session,field:'foreign'}
                    with self.assertRaises(SafeFailure): run(args)
                    prompt.assert_not_called();vault.assert_not_called()
                restore.return_value=session
                api.return_value={'status':'COMING_UP'}
                with self.assertRaises(SafeFailure): run(args)
                transfer.assert_not_called()
                api.return_value={'status':'ACTIVE_HEALTHY'}
                with self.assertRaises(SafeFailure): run(args)
                # Reopening the journal also proves every failure released its lock.
                journal=Journal(args.journal,TARGET);self.assertFalse(journal.data.get('configured',False));journal.close()
                auth.side_effect=None
                run(args)
                self.assertTrue(json.loads(args.journal.read_text())['configured'])
                count=transfer.call_count
                run(args)
                self.assertEqual(transfer.call_count,count)
                self.assertEqual(auth.call_count,2)
                self.assertTrue(all(c.args[0]=='https://api.supabase.com/v1/projects/'+REF for c in api.call_args_list))


class JournalSessionTests(unittest.TestCase):
    def test_session_uses_completed_bound_journal_and_ignores_obsolete_tags(self):
        fixture=test_resource_trust.ResourceTrustTests();fixture.setUp()
        fixture.tags['supabaseProjectRef']='z'*20
        valid={'target':{'vault':'vault','web_origin':'https://tonyai-staging-web.real.germanywestcentral.azurecontainerapps.io'},'project_ref':REF,'configured':True}
        with tempfile.TemporaryDirectory() as directory, patch.object(session_resources,'az',side_effect=fixture.az):
            path=Path(directory)/'j.json';path.write_text(json.dumps(valid))
            env=session_resources.restore('sub','staging',path)
            self.assertEqual(env['SUPABASE_PROJECT_REF'],REF)
            self.assertNotIn('API_DIGEST',env)
            for change in ({'configured':False},{'project_ref':'invalid'},{'target':{**valid['target'],'vault':'foreign'}},{'target':{**valid['target'],'web_origin':'https://evil.invalid'}}):
                path.write_text(json.dumps({**valid,**change}))
                with self.assertRaises(SafeFailure): session_resources.restore('sub','staging',path)
