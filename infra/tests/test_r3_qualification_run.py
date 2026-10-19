"""Run the real composition orchestration with fake Docker/network boundaries."""
from contextlib import ExitStack, redirect_stderr, redirect_stdout
import copy
import json
import io
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

SECRET = 'PRIVATE_SENTINEL_credentials_argv_runtime'
FAULT_PHASES = {
    'runner': 'RUNNER_GUARD', 'uid': 'ROOT_GUARD', 'node': 'NODE_VERSION',
    'docker-info': 'DOCKER_INFO', 'store': 'IMAGE_STORE', 'containerd': 'IMAGE_STORE',
    'docker-version': 'DOCKER_VERSION', 'compose-version': 'COMPOSE_VERSION',
    'existing-container': 'EMPTY_RUNNER', 'existing-path': 'EMPTY_RUNNER',
    'fetch': 'STAGE_SOURCES', 'settings': 'GENERATE_SETTINGS', 'bind-directories': 'BIND_DIRECTORIES', 'redact': 'REDACT_GATEWAY',
    'render': 'COMPOSE_RENDER', 'effective': 'COMPOSE_VALIDATE', 'pull': 'IMAGE_PULL',
    'image-arch': 'IMAGE_IDENTITY', 'image-os': 'IMAGE_IDENTITY', 'repo-digest': 'IMAGE_IDENTITY',
    'db-policy': 'DATABASE_POLICY', 'seed-create': 'SEED_CREATE', 'seed-copy': 'SEED_COPY',
    'seed-copy-cleanup': 'SEED_COPY', 'seed-cleanup': 'SEED_CLEANUP', 'seed-metadata': 'SEED_METADATA',
    'up-failure': 'DATABASE_START', 'up-cleanup': 'DATABASE_START', 'missing-key': 'DATABASE_KEY',
    'services-start': 'SERVICES_START', 'inspect': 'SERVICES_INSPECT',
    'running-image': 'SERVICES_VALIDATE', 'restart': 'SERVICES_VALIDATE', 'stopped': 'SERVICES_VALIDATE',
    'unhealthy': 'SERVICES_VALIDATE', 'missing-service': 'SERVICES_VALIDATE', 'foreign-service': 'SERVICES_VALIDATE',
    'report-build': 'REPORT_BUILD', 'cleanup': 'COMPOSE_CLEANUP', 'report-write': 'REPORT_WRITE',
}


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
                if fault == 'settings': raise FileNotFoundError(SECRET)
                Path(argv[-1]).write_text('FIXTURE=only'); return b''
            if argv[0] == 'git':
                if fault == 'report-build': raise ValueError(SECRET)
                return b'a' * 40
            self.assertEqual(argv[:3], m.DOCKER)
            args = argv[3:]
            if args[0] == 'info':
                if fault == 'docker-info': return SECRET.encode()
                return json.dumps({'Driver': 'overlay2' if fault != 'store' else 'overlayfs', 'DriverStatus': [['driver-type', 'io.containerd.snapshotter.v1']] if fault == 'containerd' else []}).encode()
            if args[0] == 'version':
                if fault == 'docker-version': raise ValueError(SECRET)
                return b'{"Client":{"Version":"fixture"},"Server":{"Version":"fixture"}}'
            if args == ['compose', 'version', '--short']:
                if fault == 'compose-version': raise ValueError(SECRET)
                return b'fixture-compose'
            if args == ['ps', '-aq']: return b'old' if fault == 'existing-container' else b''
            if args[0] == 'pull':
                if fault == 'pull': raise TimeoutError(SECRET)
                return b''
            if args[:2] == ['image', 'inspect']:
                name = next(n for n, item in lock.items() if item['image'] == args[-1])
                return json.dumps([{'Architecture': 'arm64' if fault == 'image-arch' else 'amd64',
                    'Os': 'windows' if fault == 'image-os' else 'linux',
                    'RepoDigests': [] if fault == 'repo-digest' else [args[-1]],
                    'Id': 'bad' if fault == 'db-policy' else image_ids[name]}]).encode()
            if args[0] == 'create':
                if fault == 'seed-create': raise ValueError(SECRET)
                return b'fixture-seed'
            if args[0] == 'cp':
                if fault in ('seed-copy', 'seed-copy-cleanup'): raise ValueError(SECRET)
                return b''
            if args[0] == 'rm':
                if fault in ('seed-cleanup', 'seed-copy-cleanup'): raise ValueError(SECRET)
                return b''
            if args[0] == 'run':
                if fault == 'seed-metadata': return SECRET.encode()
                return b'999:999:755'
            if args[0] == 'inspect':
                if fault == 'inspect': return SECRET.encode()
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
                if 'config' in args: return SECRET.encode() if fault == 'render' else b'{"fixture":true}'
                if 'up' in args:
                    if fault in ('up-failure', 'up-cleanup') or fault == 'services-start' and args[-1] != 'db': raise ValueError(SECRET)
                    if fault != 'missing-key': (root / 'srv/tonyai/database/db-config/pgsodium_root.key').touch()
                    return b''
                if 'ps' in args: return b'container1 container2'
                if 'down' in args:
                    self.assertFalse((output / 'summary.json').exists(), 'Success summary published before cleanup')
                    if fault in ('cleanup', 'up-cleanup'): raise ValueError(SECRET)
                    return b''
            raise AssertionError(argv)
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64'}
        if fault == 'runner': env['RUNNER_ENVIRONMENT'] = SECRET
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
                if fault == 'fetch': mock(m, 'fetch', side_effect=TimeoutError(SECRET))
                if fault == 'effective': effective.side_effect = ValueError(SECRET)
                if fault == 'redact': redact.side_effect = ValueError(SECRET)
                if fault == 'bind-directories':
                    original_mkdir = Path.mkdir
                    def fail_bind(path, *args, **kwargs):
                        if path == root / 'srv/tonyai/database/postgres': raise PermissionError(SECRET)
                        return original_mkdir(path, *args, **kwargs)
                    mock(Path, 'mkdir', new=fail_bind)
                if fault == 'report-write':
                    original_write = m.write
                    def fail_report(path, data):
                        if path.name == 'summary.json': raise PermissionError(SECRET)
                        return original_write(path, data)
                    mock(m, 'write', side_effect=fail_report)
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    code = m.main([str(output), node])
                if fault:
                    self.assertEqual(code, 1)
                    self.assertEqual(stdout.getvalue(), '')
                    seed = 'FAILED' if fault in ('seed-cleanup', 'seed-copy-cleanup') else 'SUCCEEDED' if any(c[3:4] == ['rm'] for c in self.calls) else 'NOT_STARTED'
                    cleanup = 'FAILED' if fault in ('cleanup', 'up-cleanup') else 'SUCCEEDED' if any(c[-3:] == ['down', '--timeout', '30'] for c in self.calls) else 'NOT_STARTED'
                    expected = {'phase': FAULT_PHASES[fault], 'seed_cleanup': seed, 'compose_cleanup': cleanup}
                    self.assertEqual(stderr.getvalue(), 'FAIL: composition smoke ' + json.dumps(expected, sort_keys=True) + '\n')
                    self.assertFalse((output / 'summary.json').exists())
                else:
                    self.assertEqual(code, 0); self.assertEqual(stderr.getvalue(), '')
                    self.assertEqual(stdout.getvalue(), 'PASS: composition smoke only; full R3 qualification remains gated.\n')
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
        if fault in ('runner', 'uid', 'node', 'docker-info', 'docker-version', 'compose-version', 'store', 'containerd', 'existing-container', 'existing-path'):
            self.assertFalse(output.exists())
        elif fault in ('image-arch', 'image-os', 'repo-digest', 'db-policy'):
            self.assertFalse(any(c[3:4] == ['create'] for c in self.calls))
        elif not fault or FAULT_PHASES[fault] in ('DATABASE_START', 'DATABASE_KEY', 'SERVICES_START', 'SERVICES_INSPECT', 'SERVICES_VALIDATE', 'REPORT_BUILD', 'COMPOSE_CLEANUP', 'REPORT_WRITE'):
            self.assertEqual(self.calls[-1][-3:], ['down', '--timeout', '30'])
            self.assertTrue(any(c[3:] == ['rm', '-v', 'fixture-seed'] for c in self.calls))

    def test_run_and_refusals_cleanup_and_version_report(self):
        for fault in (None, *FAULT_PHASES):
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
