"""Run the real composition orchestration with fake Docker/network boundaries."""
from contextlib import ExitStack
import copy
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_qualification as qualification


class Smoke(unittest.TestCase):
    def exercise(self, root, fault=None):
        root = root.resolve(); self.calls = []
        m = types.ModuleType('rebased_qualification'); m.__file__ = str(SCRIPTS / 'r3_qualification.py')
        source = (SCRIPTS / 'r3_qualification.py').read_text().replace("'/srv/tonyai", "'" + str(root) + '/srv/tonyai')
        exec(compile(source, m.__file__, 'exec'), m.__dict__)
        lock = json.loads((m.ROOT / 'infra/selfhost/images.qa.lock.json').read_bytes())['services']
        policy = json.loads((m.ROOT / 'infra/selfhost/database-image-policy.json').read_bytes())
        image_ids = {name: policy['config_digest'] if name == 'db' else 'sha256:' + name for name in lock}
        output = root / 'output'; node = '/fixture/node'
        if fault == 'existing-path': (root / 'srv/tonyai').mkdir(parents=True)
        def capture(argv, cwd=None, data=None):
            self.calls.append(argv)
            if argv[0] == node:
                if argv[1] == '--version': return b'v0' if fault == 'node' else b'v22.23.3'
                Path(argv[-1]).write_text('FIXTURE=only'); return b''
            if argv[0] == 'git': return b'a' * 40
            self.assertEqual(argv[:3], m.DOCKER)
            args = argv[3:]
            if args[0] == 'info': return json.dumps({'Driver': 'overlay2' if fault != 'store' else 'overlayfs', 'DriverStatus': [['driver-type', 'io.containerd.snapshotter.v1']] if fault == 'containerd' else []}).encode()
            if args[0] == 'version': return b'{"Client":{"Version":"fixture"},"Server":{"Version":"fixture"}}'
            if args == ['compose', 'version', '--short']: return b'fixture-compose'
            if args == ['ps', '-aq']: return b'old' if fault == 'existing-container' else b''
            if args[0] == 'pull': return b''
            if args[:2] == ['image', 'inspect']:
                name = next(n for n, item in lock.items() if item['image'] == args[-1])
                return json.dumps([{'Architecture': 'arm64' if fault == 'image-arch' else 'amd64',
                    'Os': 'windows' if fault == 'image-os' else 'linux',
                    'RepoDigests': [] if fault == 'repo-digest' else [args[-1]],
                    'Id': 'bad' if fault == 'db-policy' else image_ids[name]}]).encode()
            if args[0] == 'create': return b'fixture-seed'
            if args[0] in ('cp', 'rm'): return b''
            if args[0] == 'run': return b'999:999:755'
            if args[0] == 'inspect':
                result = [{'Config': {'Labels': {'com.docker.compose.service': name}}, 'Image': image_ids[name],
                    'HostConfig': {'RestartPolicy': {'Name': 'no'}}, 'State': {'Running': True, 'Health': {'Status': 'healthy'}}} for name in sorted(m.ACTIVE)]
                if fault == 'running-image': result[0]['Image'] = 'wrong'
                if fault == 'restart': result[0]['HostConfig']['RestartPolicy']['Name'] = 'always'
                if fault == 'stopped': result[0]['State']['Running'] = False
                if fault == 'unhealthy': result[0]['State']['Health']['Status'] = 'unhealthy'
                if fault == 'missing-service': result.pop()
                if fault == 'foreign-service': result[0]['Config']['Labels']['com.docker.compose.service'] = 'other'
                return json.dumps(result).encode()
            if args[0] == 'compose':
                if 'config' in args: return b'{"fixture":true}'
                if 'up' in args:
                    if fault == 'up-failure': raise ValueError('up failed')
                    if fault != 'missing-key': (root / 'srv/tonyai/database/db-config/pgsodium_root.key').touch()
                    return b''
                if 'ps' in args: return b'container1 container2'
                if 'down' in args: return b''
            raise AssertionError(argv)
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64'}
        old_cwd = Path.cwd(); mask = os.umask(0o077)
        try:
            with ExitStack() as stack:
                def mock(obj, name, **kw): return stack.enter_context(patch.object(obj, name, **kw))
                stack.enter_context(patch.dict(os.environ, env, clear=True))
                mock(m.platform, 'system', return_value='Linux'); mock(m.platform, 'machine', return_value='x86_64')
                mock(m.platform, 'freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '24.04'})
                mock(m.os, 'geteuid', return_value=501 if fault == 'uid' else 0); mock(m.os, 'chown')
                mock(m, 'capture', side_effect=capture); mock(m, 'fetch', return_value=b'public source')
                effective = mock(m, 'check_effective'); redact = mock(m, 'redact_gateway')
                if fault:
                    with self.assertRaises(ValueError): m.run(output, node)
                    self.assertFalse((output / 'summary.json').exists())
                else:
                    m.run(output, node)
                    summary = json.loads((output / 'summary.json').read_bytes())
                    self.assertEqual(summary['status'], 'COMPOSITION_SMOKE_PASS'); self.assertIs(summary['qa_ready'], False)
                    self.assertEqual(set(summary['services']), m.ACTIVE)
                    self.assertEqual(summary['tooling']['node'], 'v22.23.3')
                    self.assertIs(summary['tooling']['pinned_engine_qualified'], False)
                    self.assertEqual(summary['tooling']['image_store'], 'classic-overlay2')
                    self.assertEqual(summary['tooling']['compose'], 'fixture-compose')
                    runtime = output / 'runtime'
                    self.assertEqual(runtime.stat().st_mode & 0o777, 0o755)
                    for path in runtime.rglob('*'):
                        expected_mode = 0o755 if path.is_dir() or path.name.endswith('entrypoint.sh') else 0o600 if path.name == '.env' else 0o644
                        self.assertEqual(path.stat().st_mode & 0o777, expected_mode, str(path))
                    effective.assert_called_once_with({'fixture': True}, lock); redact.assert_called_once()
        finally:
            os.chdir(old_cwd); os.umask(mask)
        if fault in ('uid', 'node', 'store', 'containerd', 'existing-container', 'existing-path'):
            self.assertFalse(output.exists())
        elif fault in ('image-arch', 'image-os', 'repo-digest', 'db-policy'):
            self.assertFalse(any(c[3:4] == ['create'] for c in self.calls))
        else:
            self.assertEqual(self.calls[-1][-3:], ['down', '--timeout', '30'])
            self.assertTrue(any(c[3:] == ['rm', '-v', 'fixture-seed'] for c in self.calls))

    def test_run_and_refusals_cleanup_and_version_report(self):
        for fault in (None, 'uid', 'node', 'store', 'containerd', 'existing-container', 'existing-path',
                      'image-arch', 'image-os', 'repo-digest', 'db-policy', 'running-image', 'restart',
                      'stopped', 'unhealthy', 'missing-service', 'foreign-service', 'up-failure', 'missing-key'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                self.exercise(Path(tmp), fault)

    def test_isolated_cli_imports_have_controlled_errors(self):
        import subprocess
        for name in ('r3_transfer.py', 'r3_qualification.py'):
            result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPTS / name)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('Traceback', result.stderr)
            self.assertNotIn('ModuleNotFoundError', result.stderr)


if __name__ == '__main__': unittest.main()
