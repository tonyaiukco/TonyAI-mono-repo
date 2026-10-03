"""Provider key/pooler responses are consumed in memory and never persisted as metadata."""
import base64
import json
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from supabase_setup import transfer_runtime
from pooler import SafeFailure, validate_pooler
from cloud_ops import migration_release
from test_deploy_versions import inputs

REF='abcdefghijklmnopqrst'

def key(role, ref=REF):
    payload=base64.urlsafe_b64encode(json.dumps({'role':role,'ref':ref}).encode()).decode().rstrip('=')
    return 'synthetic.'+payload+'.synthetic'


class TransferTests(unittest.TestCase):
    def test_exact_project_keys_and_strict_urls_transfer_only_to_vault(self):
        vault=Mock();vault.get.return_value={'value':'synthetic@:/password'}; vault.identifier.return_value='https://vault.vault.azure.net/secrets/bootstrap-db-password/'+'b'*32
        vault.put.side_effect=lambda name,value,tags: 'https://vault.vault.azure.net/secrets/'+name+'/'+'a'*32
        keys=[{'name':role,'api_key':key(role)} for role in ('anon','service_role')]
        poolers=[{'database_type':'PRIMARY','connection_string':'postgres://postgres.'+REF+':placeholder@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'}]
        api=Mock(side_effect=[keys,poolers])
        journal=Mock(); journal.data={}
        with patch('supabase_setup.provision_buckets') as buckets, patch('supabase_keys.request', side_effect=[(200,b'[]'),(401,b''),(200,b'{}')]):
            public,versions=transfer_runtime(api,vault,REF,journal)
        self.assertEqual(public,key('anon'))
        self.assertEqual(len(vault.put.call_args_list),3)
        for call in vault.put.call_args_list:
            name,value,tags=call.args
            self.assertEqual(tags,{'project':REF})
            if name.endswith('url'): validate_pooler(value,REF,6543 if name=='database-url' else 5432)
            else: self.assertEqual(value,key('service_role'))
        self.assertEqual(set(versions),{'backend_secret_version','database_url_version','direct_url_version'})
        self.assertNotIn('synthetic',json.dumps(versions))
        buckets.assert_called_once_with('https://'+REF+'.supabase.co/storage/v1',key('service_role'))

    def test_wrong_project_or_role_never_writes_to_vault(self):
        for wrong in (key('service_role','z'*20),key('anon')):
            api=Mock(return_value=[{'name':'anon','api_key':key('anon')},{'name':'service_role','api_key':wrong}]);vault=Mock()
            with self.assertRaises(SafeFailure): transfer_runtime(api,vault,REF,Mock())
            vault.put.assert_not_called()

    def test_foreign_or_ambiguous_pooler_never_stores_database_urls(self):
        for hosts in (['aws-0-us-east-1.pooler.supabase.com'],['aws-0-eu-central-1.pooler.supabase.com','aws-1-eu-central-1.pooler.supabase.com']):
            keys=[{'name':role,'api_key':key(role)} for role in ('anon','service_role')]
            rows=[{'database_type':'PRIMARY','connection_string':'postgres://user:placeholder@'+host+':6543/postgres'} for host in hosts]
            api=Mock(side_effect=[keys,rows]);vault=Mock();vault.put.return_value='id'
            journal=Mock(); journal.data={}
            with patch('supabase_keys.request', side_effect=[(200,b'[]'),(401,b''),(200,b'{}')]):
                with self.assertRaises(SafeFailure): transfer_runtime(api,vault,REF,journal)
            self.assertEqual(vault.put.call_count,1)
            self.assertEqual(vault.put.call_args.args[0],'supabase-service-role-key')

    def test_migration_chain_is_bound_to_manifest_sha_and_target(self):
        contract=inputs()
        for head,dirty in [('a'*40,''),('b'*40,''),('a'*40,'dirty')]:
            with patch('cloud_ops.command',side_effect=[head,dirty]):
                if head=='a'*40 and not dirty:
                    self.assertEqual(migration_release(contract,'vault',REF),'a'*40)
                else:
                    with self.assertRaises(SafeFailure): migration_release(contract,'vault',REF)
        with patch('cloud_ops.command') as command:
            with self.assertRaises(SafeFailure): migration_release(contract,'other-vault',REF)
            with self.assertRaises(SafeFailure): migration_release(contract,'vault','z'*20)
            command.assert_not_called()
