"""Registry authentication must precede pulls without bypassing CI checks."""
from pathlib import Path
import os
import subprocess
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
LOGIN = 'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9'
TRUSTED = "github.actor != 'dependabot[bot]' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
HUB = {'username': '${{ secrets.DOCKERHUB_USERNAME }}',
       'password': '${{ secrets.DOCKERHUB_TOKEN }}'}


def read_yaml(path):
    return yaml.load((ROOT / path).read_text(), Loader=yaml.BaseLoader)


class RegistryWorkflowTests(unittest.TestCase):
    def test_ghcr_login_precedes_image_guard_with_read_only_callers(self):
        steps = read_yaml('.github/actions/supabase-stack/action.yml')['runs']['steps']
        login = next(i for i, step in enumerate(steps) if step.get('uses') == LOGIN)
        prepare = next(i for i, step in enumerate(steps)
                       if step.get('run') == 'python3 infra/scripts/ci_database_image.py prepare')
        self.assertLess(login, prepare)
        self.assertEqual(steps[login]['with'], {'registry': 'ghcr.io',
            'username': '${{ github.actor }}', 'password': '${{ github.token }}'})
        callers = set()
        for path in (ROOT / '.github/workflows').glob('*.yml'):
            workflow = read_yaml(path)
            for name, job in workflow.get('jobs', {}).items():
                if any(step.get('uses') == './.github/actions/supabase-stack'
                       for step in job.get('steps', [])):
                    callers.add((path.name, name))
                    self.assertEqual(job.get('permissions'), {'contents': 'read', 'packages': 'read'})
                    self.assertNotIn('if', job)
        self.assertEqual(callers, {('ci.yml', 'rls-probe'), ('ci.yml', 'docker-build'),
                                  ('integration.yml', 'api-integration'), ('e2e.yml', 'e2e')})

    def test_hub_auth_precedes_builds_and_is_never_forwarded_as_build_arg(self):
        job = read_yaml('.github/workflows/ci.yml')['jobs']['docker-build']
        self.assertNotIn('if', job)
        steps = job['steps']
        login = next(i for i, step in enumerate(steps) if step.get('uses') == LOGIN)
        self.assertEqual(steps[login]['if'], TRUSTED)
        self.assertEqual(steps[login]['with'], {'registry': 'docker.io', **HUB})
        builds = [(i, step) for i, step in enumerate(steps)
                  if step.get('uses', '').startswith('docker/build-push-action@')]
        self.assertEqual(len(builds), 2)
        for index, step in builds:
            self.assertLess(login, index)
            self.assertNotIn('if', step)
            args = step['with']['build-args']
            self.assertIn('NODE_IMAGE=docker.io/library/node:22-bookworm-slim', args.splitlines())
            self.assertNotIn('secrets.', args)
        # Owner candidate builds keep the Dockerfile default, without new secrets.
        self.assertNotIn('NODE_IMAGE', (ROOT / 'infra/scripts/build-images.sh').read_text())

    def test_service_auth_is_available_before_steps_and_missing_pair_fails(self):
        job = read_yaml('.github/workflows/ci.yml')['jobs']['migration-diff']
        self.assertNotIn('if', job)
        service = job['services']['postgres']
        self.assertEqual(service['image'], 'docker.io/library/postgres:17')
        self.assertEqual(service['credentials'], HUB)
        guard = next(step for step in job['steps']
                     if step.get('name') == 'Require Docker Hub credentials for repository runs')
        self.assertEqual(guard['if'], TRUSTED)
        self.assertEqual(guard['env'], {'DOCKERHUB_USERNAME': HUB['username'],
                                      'DOCKERHUB_TOKEN': HUB['password']})
        for username, token in [('', ''), ('fixture-user', ''), ('', 'fixture-token'),
                                ('fixture-user', 'fixture-token')]:
            result = subprocess.run(['bash', '-eu', '-c', guard['run']], text=True,
                capture_output=True, env={'PATH': os.environ['PATH'],
                    'DOCKERHUB_USERNAME': username, 'DOCKERHUB_TOKEN': token})
            self.assertEqual(result.returncode, 0 if username and token else 1)
            self.assertNotIn('fixture-token', result.stdout + result.stderr)
            self.assertNotIn('fixture-user', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
