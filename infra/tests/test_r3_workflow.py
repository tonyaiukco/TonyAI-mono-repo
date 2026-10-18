"""Parse the actual dispatch workflow; assert its authority and source boundary."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


class Workflow(unittest.TestCase):
    def test_dispatch_permissions_sha_bindings_and_step_contexts(self):
        workflow = yaml.load((ROOT / '.github/workflows/r3-qualification.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        source = workflow['on']['workflow_dispatch']['inputs']['source_sha']
        self.assertEqual((source['required'], source['type']), ('true', 'string'))
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        for job in workflow['jobs'].values():
            self.assertEqual(job['runs-on'], 'ubuntu-24.04')
            self.assertNotIn('runner.', str(job.get('env', {})))
            self.assertNotIn('permissions', job)
            steps = job['steps']
            bound = [s for s in steps if s.get('env', {}).get('REVIEWED_SHA') == '${{ inputs.source_sha }}']
            self.assertEqual(len(bound), 1)
            script = bound[0]['run']
            for guard in ('[[ "$REVIEWED_SHA" =~ ^[a-f0-9]{40}$ ]]',
                          'test "$REVIEWED_SHA" = "$GITHUB_SHA"',
                          'test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"'):
                self.assertIn(guard, script)
            self.assertEqual(steps[0]['with']['persist-credentials'], 'false')
            for step in steps:
                self.assertNotIn('upload-artifact', step.get('uses', ''))
                if 'uses' in step:
                    self.assertRegex(step['uses'], r'^[^@]+@[a-f0-9]{40}$')
            self.assertLess(steps.index(bound[0]), len(steps) - 1)
        steps = workflow['jobs']['composition']['steps']
        login = next(s for s in steps if s.get('uses', '').startswith('docker/login-action@'))
        smoke = next(s for s in steps if 'r3_qualification.py' in s.get('run', ''))
        for step in (login, smoke):
            self.assertEqual(step['env']['DOCKER_CONFIG'], '${{ runner.temp }}/r3-docker-config')
        self.assertIn('"$(command -v node)"', smoke['run'])
        self.assertIn('python3 -I -B', smoke['run'])


if __name__ == '__main__': unittest.main()
