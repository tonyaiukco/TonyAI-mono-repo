"""Offline tests for the R3 private DB candidate's hosted-runner controller and workflow.

No Docker, database, registry or network is used: downloads are replaced by local
archives and the candidate entry by a stub process. These tests cannot show that the
pinned Node, Prisma or image bytes run on the hosted runner; only a dispatched
rehearsal can.
"""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_db_candidate_run as runner

ROOT = Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / runner.CANDIDATE
sha = lambda data: hashlib.sha256(data).hexdigest()


def load_candidate(name, filename):
    spec = importlib.util.spec_from_file_location(name, CANDIDATE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def real_lock():
    return json.loads((ROOT / runner.LOCK).read_text())


def copy_tree(target):
    """The files validate_lock reads, copied so a test can tamper with them."""
    for rel in (runner.CANDIDATE, runner.GENERATED):
        shutil.copytree(ROOT / rel, target / rel, ignore=shutil.ignore_patterns('__pycache__'))
    for rel in ('infra/selfhost/images.qa.lock.json', 'infra/selfhost/r3-toolchain.lock.json'):
        (target / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, target / rel)


class WorkflowTests(unittest.TestCase):
    def test_dispatch_only_single_attempt_no_secrets_and_ciphertext_upload(self):
        text = (ROOT / runner.WORKFLOW).read_text()
        workflow = yaml.load(text, Loader=yaml.BaseLoader)
        self.assertEqual(list(workflow['on']), ['workflow_dispatch'])
        inputs = workflow['on']['workflow_dispatch']['inputs']
        self.assertEqual(set(inputs), {'mode', 'source_sha', 'approval', 'recipient', 'recipient_sha256'})
        self.assertEqual((inputs['mode']['type'], inputs['mode']['options']), ('choice', ['rehearsal', 'attempt']))
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertEqual(workflow['concurrency'], {'group': 'r3-db-candidate', 'cancel-in-progress': 'false'})
        self.assertEqual(set(workflow['jobs']), {runner.JOB})
        job = workflow['jobs'][runner.JOB]
        self.assertEqual(job['if'], "github.event_name == 'workflow_dispatch' && github.run_attempt == 1")
        self.assertEqual((job['runs-on'], job['permissions']), ('ubuntu-24.04', {'contents': 'read'}))
        self.assertNotIn('secrets.', text)
        self.assertNotIn('id-token', text)
        checkout, controller, upload = job['steps']
        self.assertEqual(checkout['uses'], 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09')
        self.assertEqual(checkout['with'], {'ref': '${{ github.sha }}', 'persist-credentials': 'false'})
        self.assertEqual(controller['run'], 'python3 -I -B infra/scripts/r3_db_candidate_run.py')
        self.assertEqual(controller['env'], {
            'R3_MODE': '${{ inputs.mode }}', 'R3_SOURCE_SHA': '${{ inputs.source_sha }}',
            'R3_APPROVAL': '${{ inputs.approval }}', 'R3_RECIPIENT': '${{ inputs.recipient }}',
            'R3_RECIPIENT_SHA256': '${{ inputs.recipient_sha256 }}'})
        self.assertNotIn('continue-on-error', controller)
        self.assertEqual(upload['uses'], 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
        self.assertEqual(upload['if'], 'always()')
        self.assertEqual(upload['with']['path'].splitlines(), [
            '${{ runner.temp }}/r3-db-candidate-publish/' + name
            for name in ('db-candidate-evidence.tar.age', 'binding.json', 'summary.json')])
        self.assertEqual((upload['with']['retention-days'], upload['with']['if-no-files-found']), ('7', 'error'))


class SourceBindingTests(unittest.TestCase):
    ENV = {'R3_SOURCE_SHA': 'a' * 40, 'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKFLOW_SHA': 'a' * 40,
           'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1', 'RUNNER_ENVIRONMENT': 'github-hosted',
           'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REF': 'refs/heads/feat/x', 'GITHUB_RUN_ID': '7',
           'GITHUB_REPOSITORY': 'o/r', 'GITHUB_WORKFLOW_REF': 'o/r/' + runner.WORKFLOW + '@refs/heads/feat/x'}

    def test_dispatch_binding_refuses_reruns_other_events_and_workflows(self):
        for key, value in (('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_WORKFLOW_SHA', 'b' * 40),
                           ('GITHUB_WORKFLOW_REF', 'o/r/.github/workflows/r3-image-transport.yml@refs/heads/feat/x'),
                           ('RUNNER_ENVIRONMENT', 'self-hosted'), ('RUNNER_ARCH', 'ARM64'), ('GITHUB_REF', 'refs/tags/v1'),
                           ('R3_SOURCE_SHA', 'a' * 39), ('GITHUB_SHA', 'b' * 40)):
            with self.subTest(key=key), patch.object(runner, 'git', side_effect=AssertionError('no git before binding')):
                with self.assertRaisesRegex(ValueError, 'binding differs'):
                    runner.source_binding({**self.ENV, key: value})

    def test_source_binding_hashes_a_clean_tracked_tree_including_the_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            env = {**os.environ, 'GIT_AUTHOR_NAME': 'fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                   'GIT_COMMITTER_NAME': 'fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
            git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], check=True, capture_output=True, env=env).stdout
            git('init', '-q')
            for rel, text in ((runner.WORKFLOW, 'name: fixture\n'), (runner.LOCK, '{}\n')):
                (repo / rel).parent.mkdir(parents=True, exist_ok=True)
                (repo / rel).write_text(text)
            git('add', '.')
            git('commit', '-q', '-m', 'fixture')
            head = git('rev-parse', 'HEAD').decode().strip()
            bound = {**self.ENV, 'R3_SOURCE_SHA': head, 'GITHUB_SHA': head, 'GITHUB_WORKFLOW_SHA': head}
            with patch.object(runner, 'ROOT', repo):
                source = runner.source_binding(bound)
                self.assertEqual((source['workflow_sha256'], source['lock_sha256']),
                                 (sha(b'name: fixture\n'), sha(b'{}\n')))
                self.assertNotIn('files', source)
                git('update-index', '--skip-worktree', runner.LOCK)
                (repo / runner.LOCK).write_text('{"attempt": 1}\n')
                with self.assertRaisesRegex(ValueError, 'Tracked source bytes differ'):
                    runner.source_binding(bound)


class LockTests(unittest.TestCase):
    def test_committed_lock_agrees_with_the_committed_bytes(self):
        lock = real_lock()
        toolchain = runner.validate_lock(lock)
        self.assertEqual(toolchain['sha256'], 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de')
        self.assertEqual(lock['attempt'], {'attempt_id': None, 'owner_decision_sha256': None})
        self.assertEqual(lock['source_manifest_sha256'], '055ef39ddd62e36e7db3bb6e759c1d39dba2f753927097ea2c50e28c88d7ba1b')
        self.assertEqual(lock['client_artifacts_sha256'], '2f5c1e886a0babaefa8b19caa6f1869fd72b1268a54e7a88b9110fff0dab40b0')

    def test_hashes_are_the_ones_the_candidate_itself_computes(self):
        lock = real_lock()
        executor = load_candidate('r3_db_run_test_executor', 'runtime_executor.py')
        entry = load_candidate('r3_db_run_test_entry', 'attempt_entry.py')
        self.assertEqual(runner.js_canonical(lock['source_manifest']), executor.js_canonical(lock['source_manifest']))
        approval = {'source_manifest_sha256': lock['source_manifest_sha256']}
        manifest = entry.approved_manifest(approval, {'node_source_manifest': lock['source_manifest']})
        self.assertEqual(sorted(entry.verify_files(manifest)), sorted(lock['source_manifest']))
        per_file = {p: m['sha256'] for p, m in lock['client_artifacts'].items()}
        self.assertEqual(sha(executor.js_canonical(per_file).encode()), lock['client_artifacts_sha256'])
        self.assertEqual(lock['config_digest'], load_candidate('r3_db_run_test_contract', 'runtime_contract.py').CONFIG_DIGEST)

    def test_vendored_client_satisfies_the_entrypoint_text_gates(self):
        lock, generated = real_lock(), ROOT / runner.GENERATED
        index = (generated / 'index.js').read_text()
        entry_source = (CANDIDATE / 'entrypoint.mjs').read_text()
        self.assertIn("export const CLIENT_VERSION = '" + lock['prisma']['client_version'] + "';", entry_source)
        self.assertIn("export const ENGINE_REVISION = '" + lock['prisma']['engine_revision'] + "';", entry_source)
        self.assertIn('"clientVersion": "6.19.3"', index)
        self.assertIn('"engineVersion": "' + lock['prisma']['engine_revision'] + '"', index)
        self.assertIn('"rootEnvPath": null', index)
        self.assertIn('"value": "' + lock['root'] + '/client"', index)
        self.assertNotIn('"native": true', index)
        self.assertNotIn('/Users/', index + (generated / 'schema.prisma').read_text())
        schema = (generated / 'schema.prisma').read_bytes()
        self.assertEqual(json.loads((generated / 'package.json').read_text())['name'], 'prisma-client-' + sha(schema))
        self.assertIn(b'output        = "' + lock['root'].encode() + b'/client"', schema)
        self.assertIn(b'binaryTargets = ["debian-openssl-3.0.x"]', schema)
        self.assertNotIn(b'model ', schema)
        self.assertEqual(sorted(p for p in lock['client_artifacts'] if p != lock['node']['path']),
                         sorted(lock['root'] + '/client/' + n for n in
                                ('index.js', 'package.json', 'schema.prisma', 'runtime/library.js', runner.ENGINE_FILE)))

    def test_any_drift_is_refused(self):
        def tampered(edit_tree=None, edit_lock=None):
            with tempfile.TemporaryDirectory() as temp:
                tree = Path(temp)
                copy_tree(tree)
                lock = real_lock()
                if edit_tree:
                    edit_tree(tree)
                if edit_lock:
                    edit_lock(lock)
                runner.validate_lock(lock, root=tree)

        def append(rel):
            return lambda tree: (tree / rel).write_bytes((tree / rel).read_bytes() + b'\n')
        cases = [
            ('candidate byte', append(runner.CANDIDATE + '/live_ops.py'), None, 'differ from the lock manifest'),
            ('extra candidate file', lambda t: (t / runner.CANDIDATE / 'extra.py').write_text('x'), None, 'lock manifest'),
            ('generated byte', append(runner.GENERATED + '/index.js'), None, 'Generated client pin differs'),
            ('extra generated file', lambda t: (t / runner.GENERATED / 'edge.js').write_text('x'), None, 'Generated client files'),
            ('image lock', lambda t: (t / 'infra/selfhost/images.qa.lock.json').write_text(
                json.dumps({'services': {'db': {'image': 'supabase/postgres@sha256:' + '0' * 64, 'platform': 'linux/amd64'}}})),
             None, 'image pin'),
            ('manifest hash', None, lambda l: l.update(source_manifest_sha256='0' * 64), 'manifest hash'),
            ('fixed root', None, lambda l: l.update(root='/tmp/elsewhere'), 'location'),
            ('port', None, lambda l: l.update(endpoint_port=5432), 'location'),
            ('node member', None, lambda l: l['node'].update(member='node-v22.23.3-linux-x64/bin/npm'), 'Node pin'),
            ('node path', None, lambda l: l['node'].update(path='/usr/bin/node'), 'Node pin'),
            ('artifact sha', None, lambda l: l['client_artifacts'][l['node']['path']].update(sha256='0' * 64), 'artifacts differ'),
            ('artifact extra', None, lambda l: l['client_artifacts'].update({'/tmp/x/client/index.js': {'sha256': '0' * 64, 'bytes': 1}}),
             'artifacts differ'),
            ('artifacts hash', None, lambda l: l.update(client_artifacts_sha256='0' * 64), 'artifacts hash'),
            ('engine pin', None, lambda l: l['prisma']['engine'].update(sha256='0' * 64), 'artifacts differ'),
            ('engine url', None, lambda l: l['prisma']['engine'].update(url='http://binaries.prisma.sh/x'), 'download pin'),
            ('library header', None, lambda l: l['prisma']['runtime_library'].update(generated_header='x'), 'inconsistent'),
            ('half-bound attempt', None, lambda l: l['attempt'].update(attempt_id='a' * 32), 'Attempt binding'),
            ('attempt id shape', None, lambda l: l['attempt'].update(attempt_id='A' * 32, owner_decision_sha256='b' * 64),
             'Attempt binding'),
            ('lock key', None, lambda l: l.update(extra=1), 'shape'),
        ]
        for name, tree, lock, message in cases:
            with self.subTest(name), self.assertRaisesRegex(ValueError, message):
                tampered(tree, lock)


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.lock = real_lock()
        self.rehearsal = {'purpose': runner.REHEARSAL_PURPOSE, 'consumes_attempt': False,
                          'source_manifest_sha256': self.lock['source_manifest_sha256']}

    def bound(self):
        lock = json.loads(json.dumps(self.lock))
        lock['attempt'] = {'attempt_id': 'a' * 32, 'owner_decision_sha256': 'b' * 64}
        approval = {'purpose': runner.ATTEMPT_PURPOSE, 'single_attempt': True, 'attempt_id': 'a' * 32,
                    'owner_decision_sha256': 'b' * 64, 'client_artifacts_sha256': lock['client_artifacts_sha256'],
                    'source_manifest_sha256': lock['source_manifest_sha256']}
        return lock, approval

    def test_rehearsal_approval_binds_the_manifest_and_never_the_attempt(self):
        self.assertEqual(runner.parse_approval('rehearsal', json.dumps(self.rehearsal), self.lock), self.rehearsal)
        for over, message in (({'consumes_attempt': True}, 'Not a rehearsal'), ({'purpose': runner.ATTEMPT_PURPOSE}, 'Not a rehearsal'),
                              ({'source_manifest_sha256': '0' * 64}, 'manifest')):
            with self.subTest(over=over), self.assertRaisesRegex(ValueError, message):
                runner.parse_approval('rehearsal', json.dumps({**self.rehearsal, **over}), self.lock)
        for text in ('', '[]', ' ' * 5000):
            with self.subTest(text=text[:5]), self.assertRaises(ValueError):
                runner.parse_approval('rehearsal', text, self.lock)
        with self.assertRaisesRegex(ValueError, 'Unknown mode'):
            runner.parse_approval('execute', json.dumps(self.rehearsal), self.lock)

    def test_attempt_needs_a_reviewed_binding_and_an_exactly_matching_approval(self):
        _, approval = self.bound()
        with self.assertRaisesRegex(ValueError, 'No attempt is bound'):
            runner.parse_approval('attempt', json.dumps(approval), self.lock)
        lock, approval = self.bound()
        self.assertEqual(runner.parse_approval('attempt', json.dumps(approval), lock), approval)
        for key, value in (('attempt_id', 'c' * 32), ('owner_decision_sha256', 'c' * 64), ('client_artifacts_sha256', 'c' * 64),
                           ('single_attempt', 'true'), ('purpose', runner.REHEARSAL_PURPOSE)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'differs from the bound attempt'):
                runner.parse_approval('attempt', json.dumps({**approval, key: value}), lock)
        with self.assertRaisesRegex(ValueError, 'Not a rehearsal'):
            runner.parse_approval('rehearsal', json.dumps(approval), lock)


def tar_bytes(members, compression):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:' + compression) as tar:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class StagingTests(unittest.TestCase):
    """Synthetic archives under a synthetic lock: proves the extraction/reconstruction rules only."""
    NODE, MEMBER, ENGINE = b'\x7fELF node fixture', b'"use strict";library fixture', b'\x7fELF engine fixture'

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.work, self.fixed = self.dir / 'work', self.dir / 'fixed'
        self.work.mkdir()
        self.fixed.mkdir()
        header = '\n/* generated */\n'
        self.archives = {
            'node': tar_bytes([('node-v1-linux-x64/bin/node', self.NODE), ('node-v1-linux-x64/README', b'x')], 'xz'),
            'library': tar_bytes([('package/runtime/library.js', self.MEMBER)], 'gz'),
            'engine': gzip.compress(self.ENGINE)}
        self.lock = {
            'root': str(self.fixed),
            'node': {'member': 'node-v1-linux-x64/bin/node', 'path': str(self.fixed / 'node-v1-linux-x64/bin/node'),
                     'sha256': sha(self.NODE), 'bytes': len(self.NODE)},
            'prisma': {'generated': {}, 'runtime_library': {
                'url': 'https://example.invalid/library.tgz', 'archive_sha256': sha(self.archives['library']),
                'archive_bytes': len(self.archives['library']),
                'archive_integrity': 'sha512-' + base64.b64encode(hashlib.sha512(self.archives['library']).digest()).decode(),
                'member': 'package/runtime/library.js', 'member_sha256': sha(self.MEMBER), 'member_bytes': len(self.MEMBER),
                'generated_header': header, 'sha256': sha(header.encode() + self.MEMBER),
                'bytes': len(header.encode() + self.MEMBER)},
                'engine': {'url': 'https://example.invalid/engine.gz', 'archive_sha256': sha(self.archives['engine']),
                           'archive_bytes': len(self.archives['engine']), 'sha256': sha(self.ENGINE), 'bytes': len(self.ENGINE)}}}
        self.toolchain = {'url': 'https://example.invalid/node.tar.xz', 'sha256': sha(self.archives['node'])}
        generated = self.dir / 'repo' / runner.GENERATED
        generated.mkdir(parents=True)
        for name in runner.GENERATED_FILES:
            (generated / name).write_bytes(name.encode())
            self.lock['prisma']['generated'][name] = {'sha256': sha(name.encode()), 'bytes': len(name)}
        self.lock['client_artifacts'] = runner.expected_artifacts(self.lock)

    def fetch(self, overrides=None):
        archives = {**self.archives, **(overrides or {})}
        def fake(url, path, limit, deadline, expected=None):
            data = archives[{'https://example.invalid/node.tar.xz': 'node', 'https://example.invalid/library.tgz': 'library',
                             'https://example.invalid/engine.gz': 'engine'}[url]]
            Path(path).write_bytes(data)
            if expected is not None and sha(data) != expected:
                raise ValueError('Input hash mismatch')
        return patch.object(runner, 'fetch', side_effect=fake)

    def test_stages_exactly_the_pinned_bytes_at_the_pinned_paths(self):
        with self.fetch():
            runner.stage_node(self.work, self.lock, self.toolchain, 0)
            runner.stage_client(self.work, self.lock, 0, root=self.dir / 'repo')
        self.assertEqual(Path(self.lock['node']['path']).read_bytes(), self.NODE)
        self.assertEqual(os.stat(self.lock['node']['path']).st_mode & 0o777, 0o755)
        library = self.fixed / 'client/runtime/library.js'
        self.assertEqual(library.read_bytes(), b'\n/* generated */\n' + self.MEMBER)
        self.assertEqual((self.fixed / 'client' / runner.ENGINE_FILE).read_bytes(), self.ENGINE)
        with patch.object(os.path, 'realpath', side_effect=lambda p: p):
            self.assertEqual(runner.verify_artifacts(self.lock), self.lock['client_artifacts'])
        (self.fixed / 'client/index.js').chmod(0o644)
        with open(self.fixed / 'client/index.js', 'ab') as stream:
            stream.write(b'x')
        with patch.object(os.path, 'realpath', side_effect=lambda p: p), self.assertRaisesRegex(ValueError, 'Staged artifact'):
            runner.verify_artifacts(self.lock)

    def test_a_staged_path_that_resolves_elsewhere_is_refused(self):
        with self.fetch():
            runner.stage_node(self.work, self.lock, self.toolchain, 0)
            runner.stage_client(self.work, self.lock, 0, root=self.dir / 'repo')
        node = self.lock['node']['path']
        with patch.object(os.path, 'realpath', side_effect=lambda p: '/elsewhere' + p if p == node else p), \
                self.assertRaisesRegex(ValueError, 'Staged artifact'):
            runner.verify_artifacts(self.lock)

    def test_refuses_wrong_members_digests_and_integrity(self):
        cases = [
            ('node member missing', 'node', tar_bytes([('other/bin/node', self.NODE)], 'xz'), 'Unexpected archive member'),
            ('node member twice', 'node', tar_bytes([('node-v1-linux-x64/bin/node', self.NODE)] * 2, 'xz'), 'Unexpected archive member'),
            ('library member size', 'library', tar_bytes([('package/runtime/library.js', self.MEMBER + b'x')], 'gz'),
             'Unexpected archive member'),
            ('node bytes', 'node', tar_bytes([('node-v1-linux-x64/bin/node', self.NODE.upper())], 'xz'), 'Node binary differs'),
            ('library bytes', 'library', tar_bytes([('package/runtime/library.js', self.MEMBER.upper())], 'gz'),
             'runtime library differs'),
        ]
        for name, key, archive, message in cases:
            with self.subTest(name):
                lock = json.loads(json.dumps(self.lock))
                lock['root'] = str(self.dir / name.replace(' ', '-'))
                lock['node']['path'] = lock['root'] + '/node-v1-linux-x64/bin/node'
                if key == 'library':
                    lock['prisma']['runtime_library'].update(
                        archive_sha256=sha(archive), archive_bytes=len(archive),
                        archive_integrity='sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode())
                toolchain = {**self.toolchain, 'sha256': sha(archive)} if key == 'node' else self.toolchain
                work = self.dir / ('work-' + name.replace(' ', '-'))
                work.mkdir()
                with self.fetch({key: archive}), self.assertRaisesRegex(ValueError, message):
                    runner.stage_node(work, lock, toolchain, 0)
                    runner.stage_client(work, lock, 0, root=self.dir / 'repo')
        lock = json.loads(json.dumps(self.lock))
        lock['prisma']['runtime_library']['archive_integrity'] = 'sha512-' + base64.b64encode(b'0' * 64).decode()
        with self.fetch(), self.assertRaisesRegex(ValueError, 'lockfile integrity'):
            runner.stage_client(self.work, lock, 0, root=self.dir / 'repo')
        engine = gzip.compress(self.ENGINE + b'tail')
        lock = json.loads(json.dumps(self.lock))
        lock['root'] = str(self.dir / 'engine-tail')
        lock['prisma']['engine'].update(archive_sha256=sha(engine), archive_bytes=len(engine))
        work = self.dir / 'work-engine'
        work.mkdir()
        with self.fetch({'engine': engine}), self.assertRaisesRegex(ValueError, 'Prisma engine differs'):
            runner.stage_client(work, lock, 0, root=self.dir / 'repo')

    def test_fixed_root_is_never_reused(self):
        with patch.object(runner, 'run', side_effect=AssertionError('no sudo for an existing root')):
            with self.assertRaisesRegex(ValueError, 'never reuse'):
                runner.prepare_root(self.dir, fixed=self.fixed)

    def test_fixed_root_parents_must_be_root_owned_and_not_writable(self):
        calls = []
        with patch.object(runner, 'run', side_effect=lambda argv, *a, **k: calls.append(argv)):
            with self.assertRaisesRegex(ValueError, 'parent is unsafe'):
                runner.prepare_root(self.dir, fixed=self.dir / 'new-root')
        self.assertEqual(calls, [])      # this test host's temp parents are not root-owned: nothing was created


class EntryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)

    def test_deadline_sends_one_sigterm_then_returns_without_an_exit_code(self):
        script = ('import signal,sys,time\n'
                  'signal.signal(signal.SIGTERM, lambda *a: (sys.stdout.write("torn-down"), sys.stdout.flush(), sys.exit(9)))\n'
                  'time.sleep(30)\n')
        with patch.object(runner, 'FIXED_ROOT', self.dir):
            rc, out, _ = runner.run_entry([sys.executable, '-c', script], timeout=1)
        self.assertEqual((rc, out), (None, b'torn-down'))

    def test_entry_gets_no_ambient_environment(self):
        with patch.object(runner, 'FIXED_ROOT', self.dir), patch.dict(os.environ, {'DOCKER_HOST': 'tcp://x', 'PGPASSWORD': 'x'}):
            rc, out, _ = runner.run_entry([sys.executable, '-c', 'import os,json;print(json.dumps(sorted(os.environ)))'], timeout=30)
        self.assertEqual(rc, 0)
        self.assertEqual(set(json.loads(out)) - {'__CF_USER_TEXT_ENCODING'}, set(runner.ENTRY_ENV))

    def test_only_the_bounded_summary_and_a_code_are_published(self):
        self.assertEqual(runner.entry_summary(b'{"status": "REHEARSAL_PASSED"}'), {'status': 'REHEARSAL_PASSED'})
        for out in (b'[]', b'not json', b'{"a": "' + b'x' * runner.SUMMARY_LIMIT + b'"}', b'\xff',
                    b'{}' + b' ' * runner.SUMMARY_LIMIT + b'{"hidden": 1}'):
            self.assertIsNone(runner.entry_summary(out))
        self.assertEqual(runner.entry_code(b'trace\nPINNED_FILE:live_ops.py\n'), 'PINNED_FILE:live_ops.py')
        for err in (b'', b'password=hunter2\n', b'Traceback (most recent call last):\n', b'CODE /etc/passwd\n'):
            self.assertIsNone(runner.entry_code(err))


class FlowTests(unittest.TestCase):
    def test_packets_have_exactly_the_keys_the_entry_requires(self):
        entry = load_candidate('r3_db_run_test_entry_keys', 'attempt_entry.py')
        lock, inputs = real_lock(), Path('/x/inputs')
        paths = {'age': '/x/age', 'age_sha256': '0' * 64, 'recipient': '/x/r.pub', 'recipient_sha256': '1' * 64}
        rehearsal = runner.build_packet('rehearsal', lock, inputs, paths)
        attempt = runner.build_packet('attempt', lock, inputs, paths)
        self.assertEqual(set(rehearsal), set(entry.REHEARSAL_PACKET_KEYS))
        self.assertEqual(set(attempt), set(entry.PACKET_KEYS))
        self.assertEqual(rehearsal['source_root'], str(CANDIDATE))
        self.assertEqual((attempt['node_path'], attempt['endpoint_port']), (lock['node']['path'], 55432))
        self.assertTrue(attempt['work_dir'].startswith(str(runner.FIXED_ROOT) + '/'))

    def flow(self, mode='rehearsal', drift=False, entry_rc=0):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        fixed = base / 'fixed'
        work, raw, publish = base / 'work', base / 'raw', base / 'publish'
        for directory in (work, raw, publish):
            directory.mkdir()
        lock = real_lock()
        if mode == 'attempt':
            lock['attempt'] = {'attempt_id': 'a' * 32, 'owner_decision_sha256': 'b' * 64}
        approval = ({'purpose': runner.REHEARSAL_PURPOSE, 'consumes_attempt': False} if mode == 'rehearsal' else
                    {'purpose': runner.ATTEMPT_PURPOSE, 'single_attempt': True, 'attempt_id': 'a' * 32,
                     'owner_decision_sha256': 'b' * 64, 'client_artifacts_sha256': lock['client_artifacts_sha256']})
        approval['source_manifest_sha256'] = lock['source_manifest_sha256']
        order, source = [], {'sha': 'a' * 40}
        bindings = iter([{**source, 'sha': 'b' * 40} if drift else source])
        def step(name, value=None):
            def call(*args, **kwargs):
                order.append(name)
                return value(*args, **kwargs) if callable(value) else value
            return call
        def fake_age(inputs, fixture, recipient_bytes, raw_dir, deadline):
            order.append('age')
            (inputs / 'age').write_bytes(b'age')
            (inputs / 'recipient.pub').write_bytes(recipient_bytes)
        def fake_entry(argv, timeout):
            order.append(('entry', argv[-2], timeout))
            (fixed / 'run/publish').mkdir(parents=True)
            (fixed / 'run/publish/db-candidate-evidence.tar.age').write_bytes(b'ciphertext')
            return entry_rc, b'{"status": "REHEARSAL_PASSED"}', b''
        key = 'ssh-ed25519 ' + base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0 ' + b'k' * 32).decode()
        env = {'R3_APPROVAL': json.dumps(approval), 'R3_RECIPIENT': key, 'R3_RECIPIENT_SHA256': sha((key + '\n').encode())}
        summary = {}
        lock_text = json.dumps(lock).encode()
        real_read = runner.read
        with patch.object(runner, 'FIXED_ROOT', fixed), \
                patch.object(runner, 'read', side_effect=lambda p, *a: lock_text if str(p).endswith(runner.LOCK) else real_read(p, *a)), \
                patch.object(runner, 'validate_lock', step('lock', {'sha256': '0' * 64})), \
                patch.object(runner, 'prepare_root', step('fixed-root', lambda raw_dir: fixed.mkdir(mode=0o700))), \
                patch.object(runner, 'stage_node', step('node')), patch.object(runner, 'stage_client', step('prisma')), \
                patch.object(runner, 'verify_artifacts', step('verify', lock['client_artifacts'])), \
                patch.object(runner, 'stage_age', side_effect=fake_age), \
                patch.object(runner, 'closure_evidence', step('closure', ({'summary': {}}, {}))), \
                patch.object(runner, 'source_binding', side_effect=lambda env: next(bindings)), \
                patch.object(runner, 'run_entry', side_effect=fake_entry):
            try:
                result = runner.candidate(mode, env, source, work, raw, publish, summary)
            except ValueError as exc:
                result = exc
        return result, order, summary, fixed, publish

    def test_rehearsal_flow_order_and_publication(self):
        result, order, summary, fixed, publish = self.flow()
        self.assertIs(result, True)
        self.assertEqual(order, ['lock', 'fixed-root', 'node', 'prisma', 'verify', 'age',
                                 ('entry', '--rehearse', runner.ENTRY_TIMEOUT['rehearsal'])])
        self.assertEqual((publish / 'db-candidate-evidence.tar.age').read_bytes(), b'ciphertext')
        self.assertEqual(summary['ciphertext_sha256'], sha(b'ciphertext'))
        packet = json.loads((fixed / 'inputs/packet.json').read_text())
        self.assertNotIn('state_dir', packet)
        self.assertFalse((fixed / 'state').exists())
        self.assertFalse((fixed / 'inputs/binding.json').exists())
        self.assertEqual(json.loads((fixed / 'inputs/manifest.json').read_text()),
                         {'node_source_manifest': real_lock()['source_manifest']})

    def test_attempt_flow_adds_the_closure_binding_and_state(self):
        result, order, summary, fixed, _ = self.flow('attempt', entry_rc=3)
        self.assertIs(result, False)
        self.assertEqual(order[-2:], ['closure', ('entry', '--execute', runner.ENTRY_TIMEOUT['attempt'])])
        self.assertEqual(summary['entry_exit_code'], 3)
        binding = json.loads((fixed / 'inputs/binding.json').read_text())
        self.assertEqual((binding['attempt_id'], binding['owner_decision_sha256']), ('a' * 32, 'b' * 64))
        self.assertEqual(os.stat(fixed / 'state').st_mode & 0o777, 0o700)

    def test_source_drift_stops_before_the_entry(self):
        result, order, _, _, publish = self.flow(drift=True)
        self.assertIsInstance(result, ValueError)
        self.assertNotIn('entry', [o[0] if isinstance(o, tuple) else o for o in order])
        self.assertFalse((publish / 'db-candidate-evidence.tar.age').exists())

    def test_main_refuses_an_unknown_mode_and_still_writes_public_files(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {'R3_MODE': 'execute', 'RUNNER_TEMP': temp, 'R3_RECIPIENT_SHA256': 'not-a-hash'}
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(runner, 'source_binding', side_effect=AssertionError('never bound')):
                self.assertEqual(runner.main(), 1)
            summary = json.loads((Path(temp) / 'r3-db-candidate-publish/summary.json').read_text())
            binding = json.loads((Path(temp) / 'r3-db-candidate-publish/binding.json').read_text())
        self.assertEqual((summary['status'], summary['mode'], summary['failure']), ('REFUSED', None, 'ValueError: Unknown mode'))
        self.assertEqual((binding['source'], binding['recipient_sha256']), (None, None))
        self.assertEqual((summary['historical_status'], summary['r3_status']), ('NOT_REPRODUCED', 'OPEN'))


if __name__ == '__main__':
    unittest.main()
