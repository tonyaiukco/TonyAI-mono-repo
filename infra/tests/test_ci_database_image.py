"""Reject wrong or reused CI database images before migrations can run."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
import ci_database_image as image


class DatabaseImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.policy = json.loads(image.POLICY.read_text())
        target = self.root / image.POLICY.relative_to(ROOT)
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps(self.policy))
        (self.root / 'supabase/.temp').mkdir(parents=True)
        (self.root / 'supabase/config.toml').write_text('project_id = "fixture"\n[db]\nmajor_version = 17\n')
        self.calls = []
        self.image_data = {'id': self.policy['config_digest'], 'os': 'linux', 'architecture': 'amd64'}
        self.container_data = {'id': self.policy['config_digest'], 'reference': self.policy['image_tag'], 'running': True}
        self.cli_version = self.policy['cli_version']
        self.existing = ''
        env = patch.dict(os.environ, {'CI': 'true', 'GITHUB_ACTIONS': 'true',
                                     'SUPABASE_INTERNAL_IMAGE_REGISTRY': 'docker.io'}, clear=True)
        env.start(); self.addCleanup(env.stop)
        stub = patch.object(image, 'command', side_effect=self.command)
        stub.start(); self.addCleanup(stub.stop)

    def command(self, *argv):
        self.calls.append(argv)
        if argv == ('supabase', '--version'):
            return self.cli_version
        if argv[:2] == ('docker', 'ps'):
            return self.existing
        if argv[:3] == ('docker', 'image', 'inspect'):
            return json.dumps(self.image_data)
        if argv[:3] == ('docker', 'container', 'inspect'):
            self.assertEqual(argv[3], 'supabase_db_fixture')
            return json.dumps(self.container_data)
        if argv[:2] in [('docker', 'pull'), ('docker', 'tag')]:
            return ''
        self.fail('Unexpected command: ' + repr(argv))

    def test_pull_exact_digest_before_tag_and_verify_running_content(self):
        image.prepare(self.root)
        pull = ('docker', 'pull', '--platform', 'linux/amd64', self.policy['image'])
        tag = ('docker', 'tag', self.policy['image'], self.policy['image_tag'])
        self.assertLess(self.calls.index(pull), self.calls.index(tag))
        image.verify(self.root)
        self.assertIn(('docker', 'image', 'inspect', self.policy['config_digest'], '--format',
            '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'), self.calls)

    def test_non_ci_or_wrong_registry_refuses_before_any_command(self):
        for key, value in [('CI', 'false'), ('GITHUB_ACTIONS', 'false'),
                           ('SUPABASE_INTERNAL_IMAGE_REGISTRY', 'unreviewed.invalid')]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                with self.assertRaises(ValueError): image.prepare(self.root)
        self.assertEqual(self.calls, [])

    def test_wrong_cli_existing_database_and_link_override_refuse_before_pull(self):
        self.cli_version = '0.0.0'
        with self.assertRaises(ValueError): image.prepare(self.root)
        self.cli_version = self.policy['cli_version']
        self.existing = 'stopped-container'
        with self.assertRaises(ValueError): image.prepare(self.root)
        self.existing = ''
        for filename, content in [('postgres-version', '17.0.0'), ('project-ref', 'linked')]:
            path = self.root / 'supabase/.temp' / filename
            path.write_text(content)
            with self.assertRaises(ValueError): image.prepare(self.root)
            path.unlink()
        self.assertFalse(any(argv[:2] == ('docker', 'pull') for argv in self.calls))

    def test_wrong_pulled_image_refuses_tag_and_wrong_running_identity_refuses(self):
        for field, bad in [('id', 'sha256:' + '0' * 64), ('os', 'windows'), ('architecture', 'arm64')]:
            original = copy.deepcopy(self.image_data)
            self.image_data[field] = bad
            with self.assertRaises(ValueError): image.prepare(self.root)
            self.image_data = original
        self.assertFalse(any(argv[:2] == ('docker', 'tag') for argv in self.calls))
        for field, bad in [('id', 'sha256:' + '0' * 64), ('reference', 'supabase/postgres:unreviewed'), ('running', False)]:
            original = copy.deepcopy(self.container_data)
            self.container_data[field] = bad
            with self.assertRaises(ValueError): image.verify(self.root)
            self.container_data = original

    def test_action_orders_guards_before_migration_and_seed(self):
        action = yaml.load((ROOT / '.github/actions/supabase-stack/action.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(action['inputs']['cli-version']['default'], self.policy['cli_version'])
        steps = action['runs']['steps']
        prepare = next(i for i,s in enumerate(steps) if s.get('run') == 'python3 infra/scripts/ci_database_image.py prepare')
        start = next(i for i,s in enumerate(steps) if s.get('run', '').startswith('supabase start '))
        verify = next(i for i,s in enumerate(steps) if s.get('run') == 'python3 infra/scripts/ci_database_image.py verify')
        migrate = next(i for i,s in enumerate(steps) if 'pnpm --filter @tonyai/db run deploy' in s.get('run', ''))
        self.assertLess(prepare, start); self.assertLess(start, verify); self.assertLess(verify, migrate)
        for index in (prepare, start, verify):
            self.assertEqual(steps[index]['env']['SUPABASE_INTERNAL_IMAGE_REGISTRY'], 'docker.io')

    def test_candidate_qa_lock_and_ci_trigger_coverage(self):
        lock = json.loads((ROOT / 'infra/selfhost/images.qa.lock.json').read_text())
        self.assertEqual(lock['services']['db'], {'image': self.policy['image'], 'platform': self.policy['platform']})
        workflow = yaml.load((ROOT / '.github/workflows/integration.yml').read_text(), Loader=yaml.BaseLoader)
        for event in ('push', 'pull_request'):
            for path in ('infra/scripts/ci_database_image.py', 'infra/selfhost/database-image-policy.json',
                         'infra/selfhost/images.qa.lock.json', '.github/actions/supabase-stack/**'):
                self.assertIn(path, workflow['on'][event]['paths'])


if __name__ == '__main__':
    unittest.main()
