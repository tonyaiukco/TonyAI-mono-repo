"""Public builder material, cache invalidation and pre-authentication bindings."""
import base64
from copy import deepcopy
import json
from pathlib import Path
import unittest
from test_qa_application import fixture
from qa_contract import SUBSCRIPTION, sha256
from qa_images import build_command, public_material
from qa_workflow import prepare


class Build(unittest.TestCase):
    def setUp(self):
        self.selected, self.image, self.inputs, self.key, self.certificate = fixture()

    def test_accepted_public_material(self):
        public_material(self.selected['build'], self.key, self.certificate)

    def test_key_and_certificate_rejections(self):
        for key, certificate in [(self.key + 'x', self.certificate), (self.key, b'PRIVATE KEY')]:
            with self.assertRaises(Exception):
                public_material(self.selected['build'], key, certificate)
        payload = base64.urlsafe_b64encode(b'{"role":"service_role"}').decode().rstrip('=')
        key = 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.synthetic'
        build = {**self.selected['build'], 'browser_key_sha256': sha256(key.encode())}
        with self.assertRaises(Exception):
            public_material(build, key, self.certificate)
        pem = b'-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----'
        build = {**self.selected['build'], 'db_ca_sha256': sha256(pem)}
        with self.assertRaises(Exception):
            public_material(build, self.key, pem)

    def test_build_has_provenance_and_ca_cache_binding(self):
        cmd = build_command('api', self.selected, Path('/synthetic'))
        self.assertIn('--provenance=mode=min', cmd)
        self.assertIn('--sbom=true', cmd)
        self.assertIn('QA_DB_CA_SHA256=' + sha256(self.certificate), cmd)
        self.assertIn('NODE_IMAGE=' + self.selected['build']['node_image'], cmd)
        self.assertNotIn(self.key, ' '.join(cmd))
        changed = deepcopy(self.selected)
        changed['build']['db_ca_sha256'] = '0' * 64
        self.assertNotEqual(cmd, build_command('api', changed, Path('/synthetic')))

    def test_workflow_binds_identity_before_login(self):
        env = {'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': 'tonyaiukco/TonyAI-mono-repo',
               'GITHUB_SHA': 'a' * 40, 'QA_TARGET_JSON': json.dumps(self.selected),
               'QA_TENANT_ID': self.selected['foundation']['tenant_id'], 'QA_SUBSCRIPTION_ID': SUBSCRIPTION,
               'QA_CLIENT_ID': '00000000-0000-0000-0000-000000000004',
               'QA_PUBLIC_DB_CA': self.certificate.decode(), 'NEXT_PUBLIC_SUPABASE_ANON_KEY': self.key}
        self.assertEqual(prepare(env)[0], self.selected)
        for key in ('GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'QA_TENANT_ID', 'QA_SUBSCRIPTION_ID', 'QA_CLIENT_ID'):
            with self.subTest(key=key), self.assertRaises(Exception):
                prepare({**env, key: 'foreign'})


if __name__ == '__main__':
    unittest.main()
