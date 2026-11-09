"""Public hosts: one origin derivation, inert until bound, refused outside the parent domain."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from public_hosts import (generated_origins, hosts_from_env, public_host_env, public_origins,
                          validate_public_hosts, web_origins)
from terraform_run import validate_release
from foundation_contract import validate_foundation

FOUNDATION = {'subscription_id': '00000000-0000-0000-0000-000000000001',
              'tenant_id': '00000000-0000-0000-0000-000000000002', 'environment': 'staging',
              'resource_group': 'tonyai-apps', 'prefix': 'tonyai', 'registry_name': 'tonyaiacr',
              'vault_name': 'tonyai-kv', 'default_domain': 'qa.swedencentral.azurecontainerapps.io'}
RELEASE = {'source_sha': 'a' * 40, 'release_id': 'r1', 'supabase_project_ref': 'a' * 20,
           'api_digest': 'sha256:' + 'a' * 64, 'web_digest': 'sha256:' + 'b' * 64,
           'database_secret_version': 'c' * 32, 'backend_secret_version': 'd' * 32,
           'storage_cleanup_hold': True, 'storage_sweep_interval_seconds': 300}
GENERATED = {'api': 'https://tonyai-staging-api.qa.swedencentral.azurecontainerapps.io',
             'web': 'https://tonyai-staging-web.qa.swedencentral.azurecontainerapps.io'}
HOSTS = {'web': 'qa.tonyai.io', 'api': 'api.qa.tonyai.io'}


class PublicHostsTests(unittest.TestCase):
    def test_absent_or_unbound_hosts_keep_the_generated_origins(self):
        for foundation in (FOUNDATION, {**FOUNDATION, 'public_hosts': {**HOSTS, 'bound': False}}):
            with self.subTest(foundation=foundation.get('public_hosts')):
                self.assertEqual(public_origins(foundation), GENERATED)
                self.assertEqual(web_origins(foundation), [GENERATED['web']])
                self.assertEqual(public_host_env(foundation), {})
        self.assertEqual(generated_origins(FOUNDATION), GENERATED)

    def test_bound_hosts_become_the_origins_and_the_generated_web_origin_stays_allowed(self):
        foundation = {**FOUNDATION, 'public_hosts': {**HOSTS, 'bound': True}}
        self.assertEqual(public_origins(foundation), {'api': 'https://api.qa.tonyai.io', 'web': 'https://qa.tonyai.io'})
        self.assertEqual(web_origins(foundation), ['https://qa.tonyai.io', GENERATED['web']])
        self.assertEqual(public_host_env(foundation), {'WEB_HOST': 'qa.tonyai.io', 'API_HOST': 'api.qa.tonyai.io'})

    def test_hosts_outside_the_parent_domain_or_malformed_are_refused(self):
        bad = [
            {**HOSTS, 'bound': True, 'web': 'qa.example.com'},
            {**HOSTS, 'bound': True, 'api': 'api.tonyai.io.evil.com'},
            {**HOSTS, 'bound': True, 'web': 'tonyai.io'},
            {**HOSTS, 'bound': True, 'web': 'QA.tonyai.io'},
            {**HOSTS, 'bound': True, 'web': 'https://qa.tonyai.io'},
            {**HOSTS, 'bound': True, 'web': '-qa.tonyai.io'},
            {**HOSTS, 'bound': True, 'web': 'a' * 250 + '.tonyai.io'},
            {**HOSTS, 'bound': True, 'api': 'qa.tonyai.io'},
            {**HOSTS, 'bound': 'true'},
            {**HOSTS},
            {**HOSTS, 'bound': True, 'extra': 1},
            ['qa.tonyai.io'],
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(SafeFailure):
                validate_public_hosts(value)

    def test_release_validation_accepts_only_valid_public_hosts(self):
        foundation, _ = validate_release({'foundation': {**FOUNDATION, 'public_hosts': {**HOSTS, 'bound': True}},
                                          'release': RELEASE})
        self.assertTrue(foundation['public_hosts']['bound'])
        with self.assertRaises(SafeFailure):
            validate_release({'foundation': {**FOUNDATION, 'public_hosts': {**HOSTS, 'bound': True, 'web': 'qa.evil.io'}},
                              'release': RELEASE})
        with self.assertRaises(SafeFailure):
            validate_release({'foundation': {**FOUNDATION, 'other': 1}, 'release': RELEASE})

    def test_workflow_variables_are_both_or_neither(self):
        self.assertIsNone(hosts_from_env({}))
        self.assertEqual(hosts_from_env({'WEB_HOST': 'qa.tonyai.io', 'API_HOST': 'api.qa.tonyai.io'}),
                         {**HOSTS, 'bound': True})
        for env in ({'WEB_HOST': 'qa.tonyai.io'}, {'API_HOST': 'api.qa.tonyai.io'},
                    {'WEB_HOST': 'qa.evil.io', 'API_HOST': 'api.qa.tonyai.io'}):
            with self.subTest(env=env), self.assertRaises(SafeFailure):
                hosts_from_env(env)


    def test_foundation_contract_accepts_hosts_and_sender_and_refuses_the_rest(self):
        config = {'subscription_id': '00000000-0000-0000-0000-000000000001', 'tenant_id': '00000000-0000-0000-0000-000000000002',
                  'owner_object_id': '00000000-0000-0000-0000-000000000003', 'environment': 'staging', 'prefix': 'tonyai',
                  'resource_group': 'staging', 'registry_name': 'registry', 'vault_name': 'vault',
                  'repository': 'owner/repo', 'release_sha': 'a' * 40,
                  'email': {'client_id': '00000000-0000-0000-0000-000000000010', 'principal_id': '00000000-0000-0000-0000-000000000011',
                            'tenant_id': '00000000-0000-0000-0000-000000000002', 'custom_domain': 'tonyai.io'}}
        validate_foundation({'config': config})
        for hosts in (HOSTS, {**HOSTS, 'certificates': True}, {**HOSTS, 'certificates': True, 'monitored': True}):
            validate_foundation({'config': {**config, 'public_hosts': hosts}})
        validate_foundation({'config': {**config, 'email': {**config['email'], 'sender_username': 'no-reply'}}})
        validate_foundation({'config': {**config, 'availability_tests': True}})
        for flag in ('true', 1, None):
            with self.subTest(availability_tests=flag), self.assertRaises(SafeFailure):
                validate_foundation({'config': {**config, 'availability_tests': flag}})
        for bad in ({**HOSTS, 'web': 'qa.evil.io'}, {**HOSTS, 'certificates': 'yes'}, {**HOSTS, 'bound': True},
                    {**HOSTS, 'monitored': True}, {**HOSTS, 'certificates': True, 'monitored': 1},
                    {'web': 'qa.tonyai.io'}, {**HOSTS, 'api': 'qa.tonyai.io'}, 'qa.tonyai.io'):
            with self.subTest(hosts=bad), self.assertRaises(SafeFailure):
                validate_foundation({'config': {**config, 'public_hosts': bad}})
        for sender in ('no reply', 'no-reply@tonyai.io', '', '-x', 'a' * 65, 1):
            with self.subTest(sender=sender), self.assertRaises(SafeFailure):
                validate_foundation({'config': {**config, 'email': {**config['email'], 'sender_username': sender}}})

if __name__ == '__main__':
    unittest.main()
