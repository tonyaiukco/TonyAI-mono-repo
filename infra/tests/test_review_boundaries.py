"""Adversarial API readbacks and CLI trust boundaries identified in PR review."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from github_environment import verify_environment
from configure_oidc import configure
from supabase_keys import select_keys, validate_backend
from test_secret_transfer import key, REF
from test_deploy_versions import inputs
from test_security_failures import GOOD_URL, BASE
import cloud_ops as ops
import release_secrets
from foundation_contract import validate_foundation

ENV = {'name':'staging', 'protection_rules':[{'type':'required_reviewers', 'prevent_self_review':True,
       'reviewers':[{'type':'User','reviewer':{'id':123}}]}],
       'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True}}
POLICY = {'total_count':1,'branch_policies':[{'name':'main','type':'branch'}]}


class OidcEnvironmentTests(unittest.TestCase):
    def test_exact_environment_and_policy(self):
        with patch('github_environment.command', side_effect=[json.dumps(ENV),json.dumps(POLICY)]) as command:
            verify_environment('owner/repo')
        self.assertEqual(command.call_count,2)
        self.assertTrue(all('--hostname' in c.args[0] and 'github.com' in c.args[0] for c in command.call_args_list))
        self.assertIn('repos/owner/repo/environments/staging', command.call_args_list[0].args[0])

    def test_missing_reviewers_self_review_and_extra_branch_or_tag_refused(self):
        variants=[]
        for field,value in [('reviewers',[]),('prevent_self_review',False)]:
            env=copy.deepcopy(ENV);env['protection_rules'][0][field]=value;variants.append((env,POLICY))
        variants.extend([({**ENV,'protection_rules':[]},POLICY),
                         ({**ENV,'deployment_branch_policy':None},POLICY),
                         ({**ENV,'deployment_branch_policy':{'protected_branches':True,'custom_branch_policies':False}},POLICY),
                         (ENV,{'total_count':2,'branch_policies':POLICY['branch_policies']}),
                         (ENV,{'total_count':1,'branch_policies':[{'name':'*','type':'branch'}]}),
                         (ENV,{'total_count':1,'branch_policies':[{'name':'main','type':'tag'}]})])
        for env,policy in variants:
            with self.subTest(env=env,policy=policy), patch('github_environment.command', side_effect=[json.dumps(env),json.dumps(policy)]):
                with self.assertRaises(SafeFailure): verify_environment('owner/repo')

    def test_repository_mismatch_or_failed_environment_lookup_precedes_all_graph_mutations(self):
        for repo in ('foreign/repo','owner/repo'):
            with patch('configure_oidc.az', return_value={'tags':{'environment':'staging','githubRepository':'owner/repo'}}) as az, patch('configure_oidc.verify_environment', side_effect=SafeFailure('Unavailable.')) as check:
                with self.assertRaises(SafeFailure): configure('sub','group',repo)
                self.assertEqual(az.call_count,1)
                self.assertEqual(check.call_count, int(repo=='owner/repo'))


class KeyBindingTests(unittest.TestCase):
    def test_modern_preferred_legacy_fallback_and_live_project_binding(self):
        legacy=[{'name':role,'api_key':key(role)} for role in ('anon','service_role')]
        modern=[{'type':'publishable','api_key':'sb_publishable_synthetic'}, {'type':'secret','api_key':'sb_secret_synthetic'}]
        for rows,expected in [(legacy,(key('anon'),key('service_role'))),(legacy+modern,('sb_publishable_synthetic','sb_secret_synthetic'))]:
            with patch('supabase_keys.request',side_effect=[(200,b'[]'),(401,b''),(200,b'{}')]) as request:
                self.assertEqual(select_keys(rows,REF),expected)
                self.assertTrue(all(c.args[0].startswith('https://'+REF+'.supabase.co/') for c in request.call_args_list))
                self.assertEqual(request.call_args_list[0].kwargs['key'],expected[1])
        with patch('supabase_keys.request') as request:
            with self.assertRaises(SafeFailure): select_keys(legacy+modern+modern,REF)
            request.assert_not_called()

    def test_failed_public_or_privileged_binding_never_accepts_key_pair(self):
        rows=[{'type':'publishable','api_key':'sb_publishable_synthetic'},{'type':'secret','api_key':'sb_secret_synthetic'}]
        for responses in [[(401,b'')],[(200,b'[]'),(200,b'{}')],[(200,b'[]'),(401,b''),(401,b'')]]:
            with patch('supabase_keys.request',side_effect=responses):
                with self.assertRaises(SafeFailure): select_keys(rows,REF)

    def test_backend_store_refuses_foreign_or_unbound_key_before_vault_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'release.json';path.write_text(json.dumps(inputs()))
            for value in (key('service_role','z'*20),'sb_secret_synthetic'):
                with patch.object(sys,'argv',['release_secrets','store','--inputs',str(path),'--name','supabase-service-role-key']), patch('release_secrets.clean_environment'), patch('release_secrets.sys.stdin.isatty',return_value=True), patch('release_secrets.getpass.getpass',return_value=value), patch('supabase_keys.request',return_value=(401,b'')), patch('release_secrets.Vault') as vault:
                    vault.return_value.put.return_value='https://vault.vault.azure.net/secrets/supabase-service-role-key/'+'b'*32
                    with self.assertRaises(SafeFailure): release_secrets.main()
                    vault.assert_not_called()

    def test_verification_rejects_disabled_foreign_or_different_exact_version(self):
        base={'id':'https://vault.vault.azure.net/secrets/database-url/'+'a'*32,'attributes':{'enabled':True},'value':GOOD_URL}
        for change in ({'attributes':{'enabled':False}},{'id':base['id'].replace('vault.vault','foreign.vault')},{'id':base['id'][:-32]+'c'*32}):
            with patch('secure_transport.azure_token',return_value='synthetic'), patch('secure_transport.json_request',return_value={**base,**change}) as request, patch('supabase_keys.request') as probe:
                with self.assertRaises(SafeFailure): release_secrets.verify(inputs())
                self.assertIn('/database-url/'+'a'*32+'?',request.call_args.args[0])
                probe.assert_not_called()


class HelperGuardTests(unittest.TestCase):
    def test_helper_sha_missing_wrong_or_dirty_refuses_before_secret_read(self):
        for sha,head,dirty in [(None,'a'*40,''),('invalid','a'*40,''),
                               ('b'*40,'a'*40,''),('a'*40,'a'*40,'dirty'),('a'*40,'a'*40,'')]:
            argv=['cloud_ops','probe-storage','--vault','vault','--project-ref',REF,'--secret-version','b'*32]
            if sha: argv+=['--source-sha',sha]
            def git(args):
                return {('git','rev-parse','HEAD'):head, ('git','status','--porcelain'):dirty}[tuple(args)]
            with self.subTest(sha=sha,dirty=dirty), patch.object(sys,'argv',argv), patch('cloud_ops.command',side_effect=git), patch('cloud_ops.secret',return_value='sb_secret_synthetic') as secret, patch('cloud_ops.request') as request, patch('cloud_ops.probe_buckets') as probe:
                if sha==head and not dirty:
                    ops.main()
                    secret.assert_called_once_with('vault','supabase-service-role-key','b'*32)
                    probe.assert_called_once()
                else:
                    with self.assertRaises(SafeFailure): ops.main()
                    secret.assert_not_called();request.assert_not_called();probe.assert_not_called()

    def test_bucket_size_and_mimes_are_verified_independently_from_write_response(self):
        for changed in ({'file_size_limit':1},{'allowed_mime_types':['text/plain']}):
            def request(url,method='GET',*args,**kwargs):
                if url==BASE+'/bucket': return 200,b'[]'
                if method!='GET': return 200,b'{}'
                limit,mimes=ops.BUCKETS[url.rsplit('/',1)[-1]]
                return 200,json.dumps({'public':False,'file_size_limit':limit,'allowed_mime_types':mimes,**changed}).encode()
            with patch('cloud_ops.request',side_effect=request):
                with self.assertRaises(SafeFailure): ops.provision_buckets(BASE,'synthetic')

    def test_owner_and_deployer_must_differ(self):
        config=json.loads((Path(__file__).resolve().parents[1]/'config/foundation.example.json').read_text())
        config['config']['owner_object_id']='00000000-0000-0000-0000-000000000003'
        config['config']['deployer_object_id']=config['config']['owner_object_id']
        # Ensure no unrelated invalid placeholder is responsible for the rejection.
        config['config'].update(subscription_id='00000000-0000-0000-0000-000000000001',tenant_id='00000000-0000-0000-0000-000000000002',release_sha='a'*40,repository='owner/repo',registry_name='registry',vault_name='vault')
        with self.assertRaisesRegex(SafeFailure,'owner and deployer'): validate_foundation(config)

    def test_migration_and_storage_cli_pin_explicit_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'release.json';path.write_text(json.dumps(inputs()))
            argv=['cloud_ops','migrate','--vault','vault','--project-ref',REF,'--inputs',str(path)]
            with patch('cloud_ops.migration_release'), patch('cloud_ops.migrate') as migrate:
                with patch.object(sys,'argv',argv):
                    with self.assertRaises(SafeFailure): ops.main()
                    migrate.assert_not_called()
                with patch.object(sys,'argv',argv+['--direct-secret-version','c'*32]): ops.main()
                migrate.assert_called_once_with('vault',REF,'a'*32,'c'*32)
            argv=['cloud_ops','buckets','--vault','vault','--project-ref',REF,'--source-sha','a'*40]
            with patch('cloud_ops.command',side_effect=lambda args: {('git','rev-parse','HEAD'):'a'*40, ('git','status','--porcelain'):''}[tuple(args)]), patch('cloud_ops.secret',return_value='synthetic') as secret, patch('cloud_ops.provision_buckets'):
                with patch.object(sys,'argv',argv):
                    with self.assertRaises(SafeFailure): ops.main()
                    secret.assert_not_called()
                with patch.object(sys,'argv',argv+['--secret-version','b'*32]): ops.main()
                secret.assert_called_once_with('vault','supabase-service-role-key','b'*32)
