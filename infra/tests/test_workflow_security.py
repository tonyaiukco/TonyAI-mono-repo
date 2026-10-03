"""Parse real workflow YAML and pin the pre-authentication release boundary."""
from pathlib import Path
import unittest
import os
import subprocess
import yaml

ROOT = Path(__file__).resolve().parents[2]


def workflow(name):
    # BaseLoader preserves GitHub's YAML 1.2 `on` key and scalar strings.
    return yaml.load((ROOT / '.github/workflows' / name).read_text(), Loader=yaml.BaseLoader)


class WorkflowTests(unittest.TestCase):
    def test_oidc_only_after_environment_and_release_guards(self):
        for name in ('candidate.yml', 'deploy-staging.yml'):
            doc = workflow(name)
            self.assertEqual(set(doc['on']), {'workflow_dispatch'})
            self.assertEqual(doc['permissions'], {'contents': 'read'})
            for job in doc['jobs'].values():
                self.assertIn("github.ref == 'refs/heads/main'", job['if'])
                steps = job['steps']
                for step in steps:
                    self.assertNotIn('${{', step.get('run', ''))
                    if step.get('uses', '').startswith('actions/checkout@'):
                        self.assertEqual(step['with']['persist-credentials'], 'false')
                login = [i for i, step in enumerate(steps) if step.get('uses', '').startswith('azure/login@')]
                if job.get('permissions', {}).get('id-token') == 'write':
                    self.assertEqual(job['if'], "github.ref == 'refs/heads/main' && vars.STAGING_RUNNER_MODE == 'ephemeral-jit'")
                    self.assertEqual(job.get('environment'), 'staging')
                    self.assertEqual(job['runs-on'], 'tonyai-staging-eu')
                    self.assertEqual(len(login), 1)
                    self.assertEqual(steps[login[0]]['uses'], 'azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6')
                    checks = [i for i, step in enumerate(steps) if step.get('run') == 'python3 infra/scripts/release_checks.py']
                    self.assertEqual(len(checks), 1)
                    self.assertLess(checks[0], login[0])
                    if name == 'deploy-staging.yml':
                        binding = next(i for i, s in enumerate(steps) if s.get('run') == 'python3 infra/scripts/prepare_release.py')
                        self.assertLess(binding, login[0])
                        self.assertEqual(steps[binding]['env']['APPROVED_RELEASE_SHA256'], '${{ needs.validate.outputs.release_sha256 }}')
                else:
                    self.assertFalse(login)
                    self.assertNotIn('environment', job)
            self.assertTrue(any(j.get('permissions', {}).get('id-token') == 'write' for j in doc['jobs'].values()))

    def test_approval_waits_for_visible_manifest_and_hash(self):
        doc = workflow('deploy-staging.yml')
        validate, deploy = doc['jobs']['validate'], doc['jobs']['deploy']
        self.assertNotIn('id-token', validate['permissions'])
        self.assertNotIn('environment', validate)
        self.assertEqual(deploy.get('needs'), 'validate')
        self.assertIn('${{ needs.validate.outputs.release_sha256 }}', deploy['name'])
        self.assertEqual(validate['outputs']['release_sha256'], '${{ steps.manifest.outputs.release_sha256 }}')
        preview = next(s for s in validate['steps'] if s.get('id') == 'manifest')
        self.assertEqual(preview['run'], 'python3 infra/scripts/prepare_release.py --preview')

    def test_guard_changes_trigger_infra_and_integration_can_be_dispatched(self):
        doc = workflow('infra.yml')
        for event in ('push', 'pull_request'):
            self.assertIn('scripts/rls-probes.mjs', doc['on'][event]['paths'])
        self.assertIn('workflow_dispatch', workflow('integration.yml')['on'])

    def test_missing_or_wrong_runner_mode_fails_validate_instead_of_green_skip(self):
        steps = workflow('deploy-staging.yml')['jobs']['validate']['steps']
        guards = [step for step in steps if step.get('id') == 'runner-mode']
        self.assertEqual(len(guards), 1)
        guard = guards[0]
        self.assertEqual(guard.get('env'), {'STAGING_RUNNER_MODE': '${{ vars.STAGING_RUNNER_MODE }}'})
        self.assertEqual(steps[0], guard)
        for mode in (None, '', 'persistent', 'ephemeral-jit'):
            env = {key:value for key,value in os.environ.items() if key != 'STAGING_RUNNER_MODE'}
            if mode is not None: env['STAGING_RUNNER_MODE'] = mode
            result = subprocess.run(['bash', '-e', '-c', guard['run']], env=env, capture_output=True, text=True)
            with self.subTest(mode=mode):
                self.assertEqual(result.returncode == 0, mode == 'ephemeral-jit')
                if mode != 'ephemeral-jit': self.assertIn('::error::', result.stdout)
