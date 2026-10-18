"""Reject wrong or reused CI database images before migrations can run."""
import copy
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
import ci_database_image as image


class CommandDiagnosticsTests(unittest.TestCase):
    def test_command_failure_reports_only_fixed_stage_and_reason(self):
        for stderr, reason in [('private-output', 'command refused'),
                               ('private-output: Data limit exceeded', 'registry request limit')]:
            result = subprocess.CompletedProcess([], 1, 'private-stdout', stderr)
            with patch.object(image.subprocess, 'run', return_value=result):
                with self.assertRaises(image.QualificationFailure) as raised:
                    image.command('docker', 'pull', 'private-reference')
            self.assertEqual(str(raised.exception),
                             f'immutable image pull failed ({reason}); diagnostics withheld.')
            self.assertNotIn('private', str(raised.exception))


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
        self.container_data = {'id': self.policy['config_digest'], 'reference': image.REGISTRY + '/' + self.policy['image_tag'], 'running': True}
        self.cli_version = self.policy['cli_version']
        self.existing = ''
        env = patch.dict(os.environ, {'CI': 'true', 'GITHUB_ACTIONS': 'true',
                                     'PATH': os.environ.get('PATH', ''),
                                     'SUPABASE_INTERNAL_IMAGE_REGISTRY': image.REGISTRY}, clear=True)
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
        pull = ('docker', 'pull', '--platform', 'linux/amd64', image.REGISTRY + '/' + self.policy['image'])
        tag = ('docker', 'tag', image.REGISTRY + '/' + self.policy['image'], image.REGISTRY + '/' + self.policy['image_tag'])
        self.assertLess(self.calls.index(pull), self.calls.index(tag))
        image.verify(self.root)
        self.assertIn(('docker', 'image', 'inspect', self.policy['config_digest'], '--format',
            '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'), self.calls)

    def test_non_ci_or_wrong_registry_refuses_before_any_command(self):
        self.assertEqual(image.REGISTRY, 'ghcr.io')
        for key, value in [('CI', 'false'), ('GITHUB_ACTIONS', 'false'),
                           ('SUPABASE_INTERNAL_IMAGE_REGISTRY', 'public.ecr.aws'),
                           ('SUPABASE_INTERNAL_IMAGE_REGISTRY', 'docker.io'),
                           ('SUPABASE_INTERNAL_IMAGE_REGISTRY', 'unreviewed.invalid')]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                with self.assertRaises(ValueError): image.prepare(self.root)
        self.assertEqual(self.calls, [])

    def test_failed_digest_pull_stops_without_tag_or_registry_fallback(self):
        def fail_pull(*argv):
            if argv[:2] == ('docker', 'pull'):
                self.calls.append(argv)
                raise image.QualificationFailure('immutable image pull failed')
            return self.command(*argv)
        with patch.object(image, 'command', side_effect=fail_pull):
            with self.assertRaises(image.QualificationFailure): image.prepare(self.root)
        pulls = [argv for argv in self.calls if argv[:2] == ('docker', 'pull')]
        self.assertEqual(pulls, [('docker', 'pull', '--platform', 'linux/amd64',
                                 'ghcr.io/' + self.policy['image'])])
        self.assertFalse(any(argv[:2] == ('docker', 'tag') for argv in self.calls))

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

    def test_advisory_floor_cannot_be_downgraded_or_bypassed(self):
        for minimum, actual in [('3.2.3', '3.4.4'), ('3.4.2', '3.4.0'),
                                ('3.4.2', '3.4.2-rc1'), ('bad', '3.4.4')]:
            policy = {**self.policy, 'minimum_supautils': minimum, 'supautils': actual}
            (self.root / image.POLICY.relative_to(ROOT)).write_text(json.dumps(policy))
            with self.subTest(minimum=minimum, actual=actual), self.assertRaises(ValueError):
                image.prepare(self.root)
        self.assertEqual(self.calls, [])

    def test_engine_overrides_refuse_before_pull(self):
        for config in ('[db]\nmajor_version = 16\n',
                       '[db]\nmajor_version = 17\norioledb_version = "17"\n',
                       '[db]\nmajor_version = 17\n[experimental]\norioledb_version = "17"\n'):
            (self.root / 'supabase/config.toml').write_text('project_id = "fixture"\n' + config)
            with self.subTest(config=config), self.assertRaises(ValueError):
                image.prepare(self.root)
        self.assertFalse(any(argv[:2] == ('docker', 'pull') for argv in self.calls))

    def test_startup_repository_sql_refuses_before_pull(self):
        migrations = self.root / 'supabase/migrations'
        migrations.mkdir()
        with self.assertRaises(ValueError): image.prepare(self.root)
        migrations.rmdir()
        seed = self.root / 'supabase/seed.sql'
        seed.write_text('SELECT 1;')
        with self.assertRaises(ValueError): image.prepare(self.root)
        seed.unlink()
        seed.symlink_to('missing.sql')
        with self.assertRaises(ValueError): image.prepare(self.root)
        seed.unlink()
        for paths in ('[db.seed]\nsql_paths = ["./seeds/*.sql"]\n',
                      '[db.migrations]\nschema_paths = ["./schemas/*.sql"]\n'):
            (self.root / 'supabase/config.toml').write_text('project_id = "fixture"\n[db]\nmajor_version = 17\n' + paths)
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                image.prepare(self.root)
        self.assertFalse(any(argv[:2] == ('docker', 'pull') for argv in self.calls))

    def test_policy_records_advisories_and_production_reviewed_body(self):
        self.assertGreaterEqual(image.version(self.policy['minimum_supautils']), (3, 4, 2))
        self.assertGreaterEqual(image.version(self.policy['supautils']), image.version(self.policy['minimum_supautils']))
        self.assertEqual(set(self.policy['security_advisories']), {
            'GHSA-5pqj-rc76-r669', 'GHSA-v9vh-54vv-7vfg',
            'GHSA-vxh6-6m4g-c39q', 'GHSA-xj9m-rx42-rfc7'})
        module = (ROOT / 'packages/db/scripts/runtime-role.mjs').as_uri()
        reviewed = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
            'import { REVIEWED_PLATFORM_DEFINERS } from ' + json.dumps(module) + ';'
            'console.log(JSON.stringify(REVIEWED_PLATFORM_DEFINERS));'], text=True))
        self.assertEqual(self.policy['reviewed_graphql_body_md5'], reviewed['graphql.increment_schema_version()'])

    def test_wrong_pulled_image_refuses_tag_and_wrong_running_identity_refuses(self):
        for field, bad in [('id', 'sha256:' + '0' * 64), ('os', 'windows'), ('architecture', 'arm64')]:
            original = copy.deepcopy(self.image_data)
            self.image_data[field] = bad
            with self.assertRaises(ValueError): image.prepare(self.root)
            self.image_data = original
        self.assertFalse(any(argv[:2] == ('docker', 'tag') for argv in self.calls))
        for field, bad in [('id', 'sha256:' + '0' * 64), ('reference', 'supabase/postgres:unreviewed'),
                           ('reference', 'public.ecr.aws/' + self.policy['image_tag']), ('running', False)]:
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
            self.assertEqual(steps[index]['env']['SUPABASE_INTERNAL_IMAGE_REGISTRY'], image.REGISTRY)

    def test_disposable_fixture_password_meets_unchanged_auth_policy(self):
        action = yaml.load((ROOT / '.github/actions/supabase-stack/action.yml').read_text(), Loader=yaml.BaseLoader)
        steps = action['runs']['steps']
        export = next(i for i, step in enumerate(steps) if step.get('name') == 'Export Supabase env')
        seed = next(i for i, step in enumerate(steps) if step.get('name') == 'Migrate and seed')
        self.assertLess(export, seed)
        match = re.search(r'echo "TONYAI_TEST_PASSWORD=([^"\n]+)" >> "\$GITHUB_ENV"', steps[export]['run'])
        self.assertIsNotNone(match)
        config = tomllib.loads((ROOT / 'supabase/config.toml').read_text())
        minimum = config['auth']['minimum_password_length']
        self.assertGreaterEqual(minimum, 12)
        self.assertGreaterEqual(len(match[1]), minimum)

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
