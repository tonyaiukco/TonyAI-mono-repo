"""Offline migration transport security boundaries; no cloud or secret reads."""
import copy
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import migration_binding as binding
import migration_runner as runner
import hosted_migrate
from pooler import SafeFailure
from test_deploy_versions import inputs


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.contract = inputs()
        self.files = {
            'pnpm-lock.yaml': ('prisma@6.19.3:\n' + binding.ENGINE_COMMIT).encode(),
            binding.SCHEMA_PATH: b'schema fixture', binding.CA_PATH: b'public CA fixture',
            'packages/db/scripts/runtime-role.mjs': b'checker fixture',
            binding.MIGRATIONS + '/migration_lock.toml': b'provider = "postgresql"',
            binding.MIGRATIONS + '/001_first/migration.sql': b'SELECT 1;\n',
        }
        f, r = self.contract['foundation'], self.contract['release']
        self.candidate = {'schema': 1, 'environment': 'staging', 'source_sha': r['source_sha'],
            'api_digest': r['api_digest'], 'web_digest': r['web_digest'],
            'registry': f['registry_name'] + '.azurecr.io', 'supabase_project_ref': r['supabase_project_ref'],
            'lockfile_sha256': hashlib.sha256(self.files['pnpm-lock.yaml']).hexdigest(),
            'migrations': [{'name': '001_first', 'sha256': hashlib.sha256(b'SELECT 1;\n').hexdigest()}]}
        for kind in ('api', 'web'):
            self.candidate[kind + '_origin'] = 'https://' + f['prefix'] + '-staging-' + kind + '.' + f['default_domain']

    def prepare(self, directory, candidate=None):
        paths = '\n'.join(p for p in self.files if p.startswith(binding.MIGRATIONS)).encode()
        with patch.object(binding, 'clean') as clean, patch.object(binding, 'git', return_value=paths), \
                patch.object(binding, 'committed', side_effect=lambda root, sha, path: self.files[path]):
            image = binding.prepare(Path('/selected-source'), self.contract, candidate or self.candidate, directory)
        clean.assert_called_once_with(Path('/selected-source'), self.contract['release']['source_sha'])
        return image

    def test_public_bundle_preserves_source_bytes_and_every_candidate_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.prepare(directory)
            bundle = json.loads((Path(directory) / 'bundle.json').read_text())
            self.assertEqual(bundle['migrations'][0]['sql'], 'SELECT 1;\n')
            self.assertEqual(set(p.name for p in Path(directory).iterdir()), {'bundle.json', 'schema.prisma', 'ca.crt', 'pnpm-lock.yaml', 'packages'})
            self.assertIn('@sha256:', image)
            for key in self.candidate:
                bad = copy.deepcopy(self.candidate); bad[key] = 'tampered'
                with self.subTest(field=key), self.assertRaises(SafeFailure): self.prepare(directory, bad)
            self.files[binding.MIGRATIONS + '/001_first/migration.sql'] = b'SELECT 2;'
            with self.assertRaises(SafeFailure): self.prepare(directory)

    def test_symlinks_missing_files_and_dirty_sources_are_refused(self):
        for mode in (b'120000 blob ref\tpath', b'', b'100755 blob ref\tpath'):
            with patch.object(binding, 'git', return_value=mode), self.assertRaises(SafeFailure):
                binding.committed('/source', 'a' * 40, 'path')
        for responses in [(b'b' * 40, b''), (b'a' * 40, b' M modified')]:
            with patch.object(binding, 'git', side_effect=responses), self.assertRaises(SafeFailure):
                binding.clean('/source', 'a' * 40)

    def test_owner_version_must_match_canonical_configured_journal(self):
        journal = {'configured': True, 'project_ref': self.contract['release']['supabase_project_ref'],
                   'versions': {'direct_url_version': 'b' * 32,
                                'backend_secret_version': self.contract['release']['backend_secret_version']}}
        hosted_migrate.validate_journal(journal, self.contract, 'b' * 32)
        for key, value in [('configured', False), ('project_ref', 'z' * 20), ('versions', {})]:
            with self.assertRaises(SafeFailure): hosted_migrate.validate_journal({**journal, key: value}, self.contract, 'b' * 32)
        with self.assertRaises(SafeFailure): hosted_migrate.validate_journal(journal, self.contract, 'c' * 32)

    def test_engine_hash_is_checked_before_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad'; path.write_bytes(b'wrong-engine')
            with self.assertRaises(SafeFailure): binding.copy_engine(path, directory)
            self.assertFalse((Path(directory) / 'schema-engine').exists())



class EntrypointTests(unittest.TestCase):
    def invoke(self, operation, url):
        contract = inputs()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for name, value in {'inputs': contract, 'candidate': {},
                'journal': {'configured': True, 'project_ref': contract['release']['supabase_project_ref'],
                'versions': {'direct_url_version': 'b' * 32,
                             'backend_secret_version': contract['release']['backend_secret_version']}}}.items():
                (path / name).write_text(json.dumps(value))
            argv = ['hosted_migrate', operation, '--source-sha', 'a' * 40,
                    '--migration-source', directory, '--inputs', str(path / 'inputs'),
                    '--candidate', str(path / 'candidate'), '--journal', str(path / 'journal'),
                    '--engine-file', str(path / 'engine'), '--direct-secret-version', 'b' * 32]
            with patch.object(sys, 'argv', argv), patch.dict(os.environ, {}, clear=True), \
                    patch.object(hosted_migrate, 'clean'), patch.object(hosted_migrate, 'prepare', return_value='image'), \
                    patch.object(hosted_migrate, 'copy_engine'), patch.object(hosted_migrate, 'inspect_image', return_value={}), \
                    patch.object(hosted_migrate, 'secret', return_value=url) as secret, \
                    patch.object(hosted_migrate, 'run', return_value={}) as run, contextlib.redirect_stdout(io.StringIO()):
                try: hosted_migrate.main()
                except SafeFailure:
                    run.assert_not_called()
                    raise
            return secret, run, contract

    def url(self, runtime=False):
        project = inputs()['release']['supabase_project_ref']
        role, port = ('tonyai_runtime', 6543) if runtime else ('postgres', 5432)
        return (f'postgresql://{role}.{project}:SYNTHETIC@aws-0-eu-north-1.pooler.supabase.com:{port}/postgres'
                '?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt' +
                ('&pgbouncer=true' if runtime else ''))

    def test_invalid_target_role_and_tls_refused_before_runner(self):
        for operation in ('probe', 'migrate', 'owner-check', 'runtime-check'):
            valid = self.url(operation == 'runtime-check')
            for bad in (valid.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs'),
                        valid.replace('eu-north-1', 'eu-west-1'), valid + '&host=evil.invalid',
                        self.url(operation != 'runtime-check')):
                with self.subTest(operation=operation), self.assertRaises(SafeFailure):
                    self.invoke(operation, bad)

    def test_verify_reads_no_secret_and_live_modes_select_exact_role_version(self):
        secret, run, _ = self.invoke('verify', '')
        secret.assert_not_called(); run.assert_not_called()
        for operation in ('probe', 'migrate', 'owner-check', 'runtime-check'):
            runtime = operation == 'runtime-check'
            secret, run, contract = self.invoke(operation, self.url(runtime))
            secret.assert_called_once_with(contract['foundation']['vault_name'],
                'database-url' if runtime else 'direct-url',
                contract['release']['database_secret_version'] if runtime else 'b' * 32)
            self.assertEqual(run.call_args.args[4], operation)
            self.assertIn('sslaccept=strict', run.call_args.args[3])
            self.assertIn('sslcert=%2Fmigration%2Fca.crt', run.call_args.args[3])


class RunnerTests(unittest.TestCase):
    def test_remote_and_overridden_docker_contexts_are_refused(self):
        for variable in ('DOCKER_HOST', 'DOCKER_CONTEXT'):
            with patch.dict(os.environ, {variable: 'remote'}), self.assertRaises(SafeFailure): runner.docker_environment()
        for endpoint in ('tcp://example.invalid:2375', 'ssh://remote', 'unix://relative'):
            with patch.dict(os.environ, {}, clear=True), patch.object(runner.subprocess, 'run', return_value=Mock(returncode=0, stdout=endpoint)), self.assertRaises(SafeFailure):
                runner.docker_environment()
        with patch.dict(os.environ, {'PATH': '/bin', 'DEBUG': 'secret'}, clear=True), \
                patch.object(runner.subprocess, 'run', return_value=Mock(returncode=0, stdout='unix:///local.sock')), \
                patch.object(Path, 'stat', return_value=Mock(st_mode=stat.S_IFSOCK)):
            env = runner.docker_environment()
        self.assertEqual(env, {'PATH': '/bin', 'DOCKER_HOST': 'unix:///local.sock'})

    def test_docker_argv_has_only_public_mounts_and_no_credential_env(self):
        args = runner.arguments('fixture', 'registry/image@sha256:' + 'a' * 64, '/public/bundle', '/public/engine')
        self.assertEqual(args[args.index('--env') + 1], 'NODE_OPTIONS=')
        self.assertEqual(args.count('--env'), 1)
        for flag in ('--read-only', '--log-driver=none', '--no-healthcheck', '--pull=never', '--cap-drop=ALL'):
            self.assertIn(flag, args)
        self.assertNotIn('--datasource', args)
        self.assertNotIn('/var/run/docker.sock', ' '.join(args))

    def test_cleanup_error_still_kills_client_and_reports_unknown_outcome(self):
        child = Mock(pid=4242, returncode=0)
        child.poll.return_value = None
        child.communicate.side_effect = [(' {"status":"READ_ONLY_QUERY_SUCCEEDED","applied_count":0}', ''), ('', '')]
        with patch.object(runner.subprocess, 'Popen', return_value=child), \
                patch.object(runner.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 1)), \
                patch.object(runner.os, 'killpg') as kill:
            with self.assertRaisesRegex(SafeFailure, 'cleanup unconfirmed'):
                runner.run('image', '/bundle', '/engine', 'SYNTHETIC_SECRET', 'probe', env={'PATH': '/bin'})
        kill.assert_called_once_with(4242, signal.SIGKILL)
        self.assertEqual(child.communicate.call_count, 2)
        self.assertEqual(child.communicate.call_args.kwargs['timeout'], 5)

    def test_secret_only_enters_stdin_and_errors_are_not_reflected(self):
        child = Mock(pid=4242, returncode=1)
        child.poll.return_value = None
        child.communicate.side_effect = [(json.dumps({'status': 'STOPPED', 'prisma_code': 'P1011 SECRET'}), 'SECRET'), ('', '')]
        with patch.object(runner.subprocess, 'Popen', return_value=child) as spawn, \
                patch.object(runner.subprocess, 'run', return_value=Mock(returncode=0)), patch.object(runner.os, 'killpg'):
            with self.assertRaises(SafeFailure) as error:
                runner.run('image', '/bundle', '/engine', 'SECRET', 'probe', env={'PATH': '/bin'})
        self.assertNotIn('SECRET', str(error.exception))
        self.assertNotIn('SECRET', str(spawn.call_args))
        self.assertIn('SECRET', child.communicate.call_args_list[0].args[0])

    def test_sigterm_routes_through_interrupt_cleanup(self):
        with self.assertRaises(KeyboardInterrupt): hosted_migrate.interrupted(signal.SIGTERM, None)

    def test_os_sigterm_stops_running_client_and_removes_own_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / 'docker'
            marker, removal = root / 'started', root / 'removed'
            fake.write_text('#!' + sys.executable + '\n' +
                'import sys,time,os\nfrom pathlib import Path\n' +
                'if sys.argv[1] == "run":\n' +
                ' Path(' + repr(str(marker)) + ').write_text(str(os.getpid()))\n' +
                ' time.sleep(60)\n' +
                'elif sys.argv[1] == "rm":\n' +
                ' Path(' + repr(str(removal)) + ').write_text(sys.argv[-1])\n')
            fake.chmod(0o755)
            code = ('import sys,signal\n' +
                'sys.path.insert(0,' + repr(str(Path(runner.__file__).parent)) + ')\n' +
                'from hosted_migrate import interrupted\nfrom migration_runner import run\n' +
                'signal.signal(signal.SIGTERM,interrupted)\n' +
                'try: run("image","/bundle","/engine","SYNTHETIC_SECRET","probe",env={"PATH":' + repr(directory) + '})\n' +
                'except BaseException: sys.exit(1)\n')
            child = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                while not marker.exists() and time.monotonic() < deadline: time.sleep(0.02)
                self.assertTrue(marker.exists())
                os.kill(child.pid, signal.SIGTERM)
                out, err = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 1)
                self.assertNotIn(b'SYNTHETIC_SECRET', out + err)
                self.assertRegex(removal.read_text(), r'^tonyai-migration-[a-f0-9]{32}$')
                with self.assertRaises(ProcessLookupError): os.kill(int(marker.read_text()), 0)
            finally:
                if child.poll() is None: child.kill(); child.wait()

    def test_node_protocol_regressions(self):
        result = subprocess.run(['node', '--test', str(Path(__file__).with_name('migration-engine.test.mjs'))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
