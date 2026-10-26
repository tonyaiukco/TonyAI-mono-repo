"""Parse the actual QA workflows, including pre-federation ordering."""
from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class Workflows(unittest.TestCase):
    def test_manual_protected_candidate(self):
        doc = yaml.load((ROOT / '.github/workflows/qa-candidate.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(set(doc['on']), {'workflow_dispatch'})
        self.assertEqual(doc['permissions'], {'contents': 'read'})
        self.assertEqual(doc['concurrency']['cancel-in-progress'], 'false')
        job = doc['jobs']['candidate']
        self.assertEqual(job['if'], "github.ref == 'refs/heads/main' && vars.STAGING_RUNNER_MODE == 'ephemeral-jit'")
        self.assertEqual(job['runs-on'], 'tonyai-staging-eu')
        self.assertEqual(job['environment'], 'staging')
        self.assertEqual(job['permissions'], {'contents': 'read', 'actions': 'read', 'id-token': 'write'})
        steps = job['steps']
        login = next(i for i, s in enumerate(steps) if s.get('uses', '').startswith('azure/login@'))
        for command in ('release_checks.py', 'qa_workflow.py'):
            self.assertLess(next(i for i, s in enumerate(steps) if command in s.get('run', '')), login)
        push = next(i for i, s in enumerate(steps) if 'qa_images.py' in s.get('run', ''))
        self.assertGreater(push, login)
        self.assertIn('--approved-push', steps[push]['run'])
        for step in steps:
            self.assertNotIn('${{', step.get('run', ''))
            if 'uses' in step:
                self.assertRegex(step['uses'], r'^[\w/-]+@[a-f0-9]{40}$')
            if step.get('uses', '').startswith('actions/checkout@'):
                self.assertEqual(step['with']['persist-credentials'], 'false')
        self.assertFalse(any('github_environment.py' in s.get('run', '') for s in steps))

    def test_qa_roots_are_exercised_without_oidc(self):
        doc = yaml.load((ROOT / '.github/workflows/qa-infra.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(doc['permissions'], {'contents': 'read'})
        job = doc['jobs']['qa-infra']
        self.assertNotIn('environment', job)
        self.assertNotIn('permissions', job)
        commands = '\n'.join(s.get('run', '') for s in job['steps'])
        for required in ('foundation/qa application/qa', '-backend=false', '-lockfile=readonly', 'test_qa_', 'qa_policy.py', 'validate', 'test -no-color'):
            self.assertIn(required, commands)
        self.assertNotRegex(commands, r'\b(?:apply|db:deploy|az login)\b')


if __name__ == '__main__':
    unittest.main()
