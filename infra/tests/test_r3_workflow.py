"""Parse the actual dispatch workflow; assert its authority and source boundary."""
from pathlib import Path
import shlex
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
        self.assertNotIn('upload-artifact', str(steps))

    def test_vendor_evidence_is_success_only_and_exact_public_file_allowlist(self):
        workflow = yaml.load((ROOT / '.github/workflows/r3-qualification.yml').read_text(), Loader=yaml.BaseLoader)
        steps = workflow['jobs']['package-provenance']['steps']
        uploads = [s for s in steps if 'upload-artifact@' in s.get('uses', '')]
        self.assertEqual(len(uploads), 1)
        upload = uploads[0]
        self.assertNotIn('if', upload)  # Default success(); failures never publish a pass receipt.
        self.assertEqual(upload['with']['retention-days'], '7')
        self.assertEqual(upload['with']['if-no-files-found'], 'error')
        self.assertEqual(upload['with']['path'].splitlines(), [
            '${{ runner.temp }}/r3-vendor-receipt.json',
            '${{ runner.temp }}/r3-public-artifacts/manifest.json',
            '${{ runner.temp }}/r3-public-artifacts/r3-toolchain.lock.json',
            '${{ runner.temp }}/r3-public-artifacts/provenance/docker.asc',
            '${{ runner.temp }}/r3-public-artifacts/provenance/InRelease',
            '${{ runner.temp }}/r3-public-artifacts/provenance/Packages',
        ])
        verify = next(s for s in steps if 'r3_toolchain.py' in s.get('run', ''))
        self.assertLess(steps.index(verify), steps.index(upload))
        self.assertNotIn('continue-on-error', verify)
        self.assertNotIn('continue-on-error', workflow['jobs']['package-provenance'])
        self.assertNotIn('||', verify['run'])
        commands = [shlex.split(line) for line in verify['run'].splitlines() if line.strip()]
        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[0], ['python3', '-I', '-B', 'infra/scripts/r3_artifacts.py', 'stage', '$R3_BUNDLE'])
        self.assertEqual(commands[1][:-1], ['python3', '-I', '-B', 'infra/scripts/r3_toolchain.py', '$R3_BUNDLE'])
        receipt_path = commands[1][-1]
        self.assertEqual(receipt_path.replace('$RUNNER_TEMP', '${{ runner.temp }}'), upload['with']['path'].splitlines()[0])
        self.assertEqual(commands[2], ['test', '-s', receipt_path])
        self.assertNotIn('secrets.', str(steps))
        self.assertNotIn('r3_install.py', str(steps))


if __name__ == '__main__': unittest.main()
