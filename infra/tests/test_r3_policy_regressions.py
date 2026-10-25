"""Review regressions with synthetic bytes, local children and disposable source copies."""
import base64
import copy
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import py_compile
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from test_r3_policy_evidence import document, command, apt_scope, unit_scope, release_record, META, BINDING
from test_r3_policy_target import target_document, proposal, HOST_LINE, synthetic_git
import r3_policy_capture as capture
import r3_policy_evidence as evidence
import r3_policy_scope as scope
import r3_policy_validate as validator
import r3_policy_target as target
import r3_policy_receive as receiver
import r3_policy_packet as packet
import r3_policy_git as source_git
import r3_noble_guest as guest
import r3_noble_fixture as host
from r3_noble_common import encoded, digest, write


def body(raw):
    return {**META, 'bytes': len(raw), 'sha256': digest(raw), 'body': capture.blob(raw)}


class ScopeRegressions(unittest.TestCase):
    def test_apt_physical_line_parity_corpus(self):
        tokens = (b'Di/**/r::Etc::Main "/root/.netrc";', b'R/**/ootDir "/tmp/r/";',
                  b'D/* */ir { Etc { Parts "/tmp/p"; }; };', b'%44i/**/r::Etc::Parts "/tmp/p";')
        for token in tokens:
            for quotes in (b'"', b'"""', b'"""""'):
                for prefix in (b'', b'APT::X "1"; ', b'\t'):
                    raw = prefix + b'# ' + quotes + b'\n' + token + b'\n# ' + quotes
                    with self.subTest(raw=raw), self.assertRaises(ValueError):
                        scope.check_apt({'files': {'/etc/apt/apt.conf': body(raw)}})
        self.assertEqual(scope.apt28_comment_view(b'# "\nDi/**/r "x";\n# "'), b'\nDir "x";\n')
        self.assertEqual(scope.apt28_comment_view(b'/* a\nb */ APT::X "1"; // "\n'), b'\n APT::X "1"; \n')
        safe = b'APT::X "shell # comment";\n'
        scope.check_apt({'files': {'/etc/apt/apt.conf': body(safe)}})

    def test_reload_properties_and_stderr(self):
        raw = base64.b64decode(command('unit-paths')['stdout']['base64'])
        for changed in (raw.replace(b'NeedDaemonReload=no', b'NeedDaemonReload=yes', 1),
                        raw.replace(b'NeedDaemonReload=no\n', b'', 1),
                        raw.replace(b'NeedDaemonReload=no', b'NeedDaemonReload=no\nNeedDaemonReload=no', 1)):
            with self.assertRaises(ValueError):
                scope.unit_paths(changed)
        for name in ('unit-paths', 'unit-paths-after', 'unit-config', 'apt-config'):
            doc = document()
            doc['sections'][name]['value']['stderr'] = capture.blob(b'configuration changed\n')
            result = validator.validate(encoded(doc), BINDING)
            self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
            self.assertEqual(result['policy_input_hashes'], {})

    def test_unit_warning_prevents_cat(self):
        names = []
        def queried(name, deadline):
            names.append(name)
            item = command(name)
            if name == 'unit-paths':
                item['stderr'] = capture.blob(b'warning')
            return item
        with patch.object(evidence, 'command', side_effect=queried), \
             patch.object(capture, 'file_record', return_value={'absent': True}), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), \
             patch.object(scope, 'unit_scope', side_effect=unit_scope):
            evidence.collect(BINDING)
        self.assertNotIn('unit-config', names)

    def test_os_release_exact_unique_keys(self):
        for raw in (b'ID=debian\nNOTID=ubuntu\nVERSION_ID="24.04"\n',
                    b'#ID=ubuntu\nVERSION_ID="24.04"\n',
                    b'ID=ubuntu\nVERSION_ID="24.04"\nID=debian\n',
                    b'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_ID="22.04"\n'):
            doc = document()
            doc['sections']['file:/usr/lib/os-release']['value'] = body(raw)
            result = validator.validate(encoded(doc), BINDING)
            self.assertEqual(result['policy_input_hashes'], {})
            self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_independent_content_and_path_cross_checks(self):
        for case in ('cat', 'before-path', 'after-path', 'apt-file', 'fixed-unit'):
            doc = document()
            sections = doc['sections']
            if case == 'cat':
                sections['unit-config']['value']['stdout'] = capture.blob(
                    base64.b64decode(sections['unit-config']['value']['stdout']['base64']) + b'forged\n')
            elif case.endswith('path'):
                name = 'unit-paths' if case == 'before-path' else 'unit-paths-after'
                raw = base64.b64decode(sections[name]['value']['stdout']['base64'])
                sections[name]['value']['stdout'] = capture.blob(raw.replace(b'/usr/lib/', b'/etc/', 1))
            elif case == 'apt-file':
                sections['file:/etc/apt/apt.conf'] = {'state': 'ok', 'value': body(b'APT::X "1";')}
            else:
                sections['file:/usr/lib/systemd/system/unattended-upgrades.service']['value']['mode'] = 0o600
            with self.subTest(case=case):
                self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'PARTIAL_REVIEW_REQUIRED')
        for name in ('apt-scope-before', 'apt-scope-after'):
            doc = document()
            doc['sections'][name]['value']['files']['/etc/apt/apt.conf'] = body(b'Dir "/private";')
            with self.assertRaises(ValueError):
                validator.validate(encoded(doc), BINDING)

    def test_both_imds_observations_must_match_proposal(self):
        doc = target_document()
        doc['identity_before']['imds']['vmId'] = 'foreign'
        doc['identity_after']['imds']['vmId'] = 'foreign'
        self.assertEqual(target.validate_target(encoded(doc), proposal())['policy_input_hashes'], {})

    def test_apt_directory_cannot_add_a_member_outside_checked_scope(self):
        doc = document()
        sections = doc['sections']
        # Both scope observations agree, but neither examined this independently
        # captured member. Its valid body/hash must not bypass the scope guard.
        sections['directory:/etc/apt/apt.conf.d']['value']['names'] = ['20auto-upgrades']
        sections['file:/etc/apt/apt.conf.d/20auto-upgrades'] = {
            'state': 'ok', 'value': body(b'Dir::Etc::Main "/root/.netrc";\n')}
        self.assertEqual(sections['apt-scope-before'], sections['apt-scope-after'])
        result = validator.validate(encoded(doc), BINDING)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(result['policy_input_hashes'], {})


class DeadlineAndPartial(unittest.TestCase):
    def test_deadline_escapes_section_and_command_catches(self):
        self.assertEqual(evidence.error_code(TimeoutError()), 'TimeoutError')
        self.assertEqual(evidence.error_code(UnicodeDecodeError('utf8', b'x', 0, 1, 'bad')), 'UnicodeError')
        for action in (lambda: evidence.operation(lambda: evidence.deadline_alarm(None, None)),
                       lambda: evidence.command('audit', float('inf'))):
            with patch.object(evidence, 'run', side_effect=evidence.CollectionDeadline()), self.assertRaises(evidence.CollectionDeadline):
                action()
        self.assertEqual(evidence.error_code(evidence.CollectionDeadline()), 'TimeoutError')

    def test_expired_budget_prevents_reread_and_retains_prior(self):
        clock = [0]
        reads_after = []
        def cache():
            clock[0] = 241
            return {'.': {'directory': True, **META}}
        def file(path, _body=False):
            if clock[0] > 240:
                reads_after.append(path)
            return release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})
        with patch.object(evidence.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(evidence, 'command', side_effect=command), patch.object(capture, 'file_record', side_effect=file), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'cache', side_effect=cache), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), patch.object(scope, 'unit_scope', side_effect=unit_scope):
            doc = evidence.collect(BINDING)
        self.assertEqual(reads_after, [])
        self.assertEqual(validator.validate(encoded(doc), BINDING)['policy_input_hashes'], {})
        self.assertIn('prior', doc['sections']['file:/usr/lib/os-release'])

    def test_reread_drift_is_partial(self):
        counts = {}
        def file(path, _body=False):
            counts[path] = counts.get(path, 0) + 1
            if path == '/usr/lib/os-release':
                value = release_record()
                if counts[path] > 1:
                    value['mode'] = 0o600
                return value
            return unit_scope()['files'].get(path, {'absent': True})
        with patch.object(evidence, 'command', side_effect=command), patch.object(capture, 'file_record', side_effect=file), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), patch.object(scope, 'unit_scope', side_effect=unit_scope):
            doc = evidence.collect(BINDING)
        self.assertEqual(doc['sections']['file:/usr/lib/os-release']['error'], 'CHANGED')
        self.assertEqual(validator.validate(encoded(doc), BINDING)['policy_input_hashes'], {})

    def test_unknown_member_names_are_retained_never_read(self):
        for name in ('20auto-upgrades~', 'has space', 'caf\u00e9.conf', 'line\nbreak'):
            seen = []
            def file(path, _body=False):
                seen.append(path)
                return {'absent': True}
            directory = '/etc/apt/apt.conf.d'
            with patch.object(evidence, 'command', side_effect=command), patch.object(capture, 'file_record', side_effect=file), \
                 patch.object(capture, 'membership', side_effect=lambda path: {'metadata': META, 'names': [name] if path == directory else []}), \
                 patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
                 patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
                 patch.object(scope, 'apt_scope', side_effect=ValueError('synthetic unreviewed scope')), \
                 patch.object(scope, 'unit_scope', side_effect=unit_scope):
                doc = evidence.collect(BINDING)
            self.assertNotIn(directory + '/' + name, seen)
            self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'PARTIAL_REVIEW_REQUIRED')
        for name in ('a/b', '\0', '.', '..', ''):
            with self.assertRaises(ValueError):
                validator.member_name(name)

    def test_complete_checkpoint_then_failure_has_no_hashes(self):
        manifest = {'purpose': evidence.A_PURPOSE, 'source': BINDING['source'],
                    'image_sha256': BINDING['image_sha256'], 'fixture_uuid': BINDING['fixture_uuid'],
                    'files': {'r3-toolchain.lock.json': BINDING['toolchain_sha256']}}
        for exception, code in ((PermissionError(), 'OSError'), (KeyError(), 'RuntimeError'),
                                (evidence.CollectionDeadline(), 'TimeoutError')):
            with tempfile.TemporaryDirectory() as tmp:
                output, port = Path(tmp) / 'out', Path(tmp) / 'port'
                def verified(purposes):
                    self.assertEqual(purposes, (evidence.A_PURPOSE,))
                    write(output / 'manifest.json', encoded(manifest))
                    return manifest
                def fail(binding, checkpoint):
                    checkpoint(document(binding))
                    raise exception
                with patch.object(guest, 'OUTPUT', output), patch.object(guest, 'PORT', str(port)), \
                     patch.object(guest, 'verify_input', side_effect=verified), patch.object(evidence, 'collect', side_effect=fail), \
                     patch.object(guest.signal, 'signal'), patch.object(guest.signal, 'alarm'):
                    self.assertEqual(guest.collection_main(), 1)
                result = host.validate_frame(port.read_bytes(), manifest)
                self.assertEqual(result['failure_type'], code)
                self.assertEqual(result['checks']['status'], 'PARTIAL_REVIEW_REQUIRED')
                self.assertEqual(result['checks']['policy_input_hashes'], {})

    def test_manifest_errors_never_fall_back_to_installer(self):
        for raw in (OSError(), b'{', b'{}', b'{"purpose":"unknown"}'):
            with patch.object(guest, 'read', side_effect=raw if isinstance(raw, Exception) else None, return_value=raw), \
                 patch.object(guest, 'installation_main', side_effect=AssertionError('installation reached')), \
                 patch.object(guest, 'collection_main', side_effect=AssertionError('collection reached')):
                self.assertEqual(guest.main(), 1)

    def test_verify_input_route_purposes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inp, out = root / 'input', root / 'out'
            inp.mkdir(); out.mkdir()
            write(inp / 'manifest.json', encoded({'files': {}, 'purpose': evidence.A_PURPOSE}))
            def path_text(path, **_kwargs):
                return 'd7fa1822-80db-4cba-9ef1-6e63549fe928' if 'product_uuid' in str(path) else 'dev ' + str(inp) + ' iso9660 ro 0 0'
            with patch.object(guest, 'INPUT', inp), patch.object(guest, 'OUTPUT', out), \
                 patch.object(guest.os, 'geteuid', return_value=0), patch.object(Path, 'read_text', path_text):
                with self.assertRaises(ValueError):
                    guest.verify_input(('FIXTURE_DIAGNOSTIC_ONLY', 'FIXTURE_MAINTENANCE_ONLY'))
                self.assertEqual(guest.verify_input((evidence.A_PURPOSE,))['purpose'], evidence.A_PURPOSE)


class CaptureRechecks(unittest.TestCase):
    def test_path_identity_and_read_length_rechecked(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve() / 'file'
            path.write_bytes(b'ab')
            before = path.stat()
            altered = SimpleNamespace(**{key: getattr(before, key) + (1 if key == 'st_ino' else 0) for key in capture.FIELDS})
            with patch.object(capture.os, 'stat', return_value=altered), self.assertRaises(ValueError):
                capture.file_record(str(path), True)
            with patch.object(capture.os, 'read', side_effect=[b'abcd', b'']), self.assertRaises(ValueError):
                capture.file_record(str(path), True)


class SourceAndCustody(unittest.TestCase):
    def test_git_environment_and_replace_options_are_fixed(self):
        with patch.dict(os.environ, {'GIT_DIR': '/evil', 'GIT_WORK_TREE': '/evil', 'GIT_CONFIG_COUNT': '1'}), \
             patch.object(source_git.subprocess, 'check_output', return_value=b'head') as call:
            source_git.git(Path('/reviewed'), 'rev-parse', 'HEAD')
        argv = call.call_args.args[0]
        self.assertEqual(argv, ['git', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', '/reviewed', 'rev-parse', 'HEAD'])
        env = call.call_args.kwargs['env']
        self.assertNotIn('GIT_DIR', env)
        self.assertNotIn('GIT_WORK_TREE', env)
        self.assertNotIn('GIT_CONFIG_COUNT', env)
        self.assertEqual(env['GIT_NO_REPLACE_OBJECTS'], '1')
        self.assertEqual(env['GIT_NO_LAZY_FETCH'], '1')
        self.assertEqual(env['GIT_CONFIG_GLOBAL'], '/dev/null')

    def test_real_git_replacement_environment_and_ignored_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = {**os.environ, 'HOME': tmp, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                   'GIT_AUTHOR_NAME': 'Synthetic Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                   'GIT_COMMITTER_NAME': 'Synthetic Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'}
            env = {k: v for k, v in env.items() if not k.startswith('GIT_') or k in (
                'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
                'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL')}
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], env=env, stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-q')
            path = root / 'infra/scripts/example.py'
            path.parent.mkdir(parents=True)
            (root / '.gitignore').write_text('*.pyc\n')
            path.write_bytes(b'original')
            git('add', '.')
            git('commit', '-qm', 'synthetic original')
            original = git('rev-parse', 'HEAD')
            path.write_bytes(b'replaced')
            git('commit', '-qam', 'synthetic replacement')
            replacement = git('rev-parse', 'HEAD')
            git('reset', '--hard', original)
            git('replace', original, replacement)
            monitor = root / '.git/fsmonitor'
            marker = root / '.git/monitor-invoked'
            monitor.write_text('#!/bin/sh\ntouch ' + str(marker) + '\n')
            monitor.chmod(0o700)
            git('config', 'core.fsmonitor', str(monitor))
            files = {'infra/scripts/example.py': digest(b'original')}
            with patch.dict(os.environ, {'GIT_DIR': str(root / 'foreign'), 'GIT_WORK_TREE': '/foreign'}):
                self.assertEqual(source_git.verified_head(root, files), original)
            self.assertFalse(marker.exists())
            (path.parent / 'ignored.pyc').write_bytes(b'ignored cache')
            with self.assertRaises(ValueError):
                source_git.verified_head(root, files)

    def test_ignored_runtime_files_and_blob_drift_refuse(self):
        for changed in ('status', 'ignored', 'blob'):
            def git(_root, *args):
                if args[0] == 'config': return b''
                if args[:2] == ('rev-parse', '--git-path'): return b'/synthetic-absent-git-info-attributes'
                if args[0] == 'rev-parse': return b'a' * 40
                if args[0] == 'status':
                    return b'?? unsafe' if (changed == 'ignored' and '--ignored' in args or changed == 'status' and '--ignored' not in args) else b''
                return b'changed' if changed == 'blob' else b'ok'
            with patch.object(source_git, 'git', side_effect=git), self.assertRaises(ValueError):
                source_git.verified_head(Path('/synthetic'), {'test.py': digest(b'ok')})

    def test_unverified_draft_has_no_base_sha(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(packet, 'verified_head', side_effect=ValueError('dirty')):
            draft = packet.prepare(Path(tmp) / 'packet')
            self.assertIsNone(draft['source']['base_sha'])
            self.assertIsNone(draft['source']['published_sha'])

    def test_host_key_exact_identity_and_fingerprint(self):
        expected = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(HOST_LINE.split()[2])).digest()).decode().rstrip('=')
        self.assertEqual(receiver.known_host(HOST_LINE, '192.0.2.1'), expected)
        for raw in (HOST_LINE.replace(b'192.0.2.1', b'*'), b'@cert-authority ' + HOST_LINE,
                    HOST_LINE.replace(b'192.0.2.1', b'192.0.2.2'), HOST_LINE * 2, HOST_LINE + b'# extra\n',
                    HOST_LINE.replace(b'ssh-ed25519', b'ssh-rsa', 1), b'192.0.2.1 ssh-ed25519 YWJj\n'):
            with self.assertRaises(ValueError):
                receiver.known_host(raw, '192.0.2.1')
        argv = receiver.ssh_argv({'target': {'connection': {'host': '192.0.2.1', 'user': 'ubuntu'}},
                                 'custody': {'known_hosts': '/tmp/hosts', 'ssh_public_key': '/tmp/key.pub'}})
        self.assertIn('UpdateHostKeys=no', argv)
        self.assertIn('CheckHostIP=no', argv)

    def test_cli_imports_source_despite_unchecked_hash_pyc(self):
        # --help performs imports/argument parsing only, never receiver execution.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / 'infra/scripts'
            shutil.copytree(packet.ROOT / 'infra/scripts', scripts, ignore=shutil.ignore_patterns('__pycache__'))
            marker = root / 'poisoned'
            fake = root / 'fake.py'
            fake.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("poison")\n')
            pyc = Path(__import__('importlib.util', fromlist=['cache_from_source']).cache_from_source(str(scripts / 'r3_policy_evidence.py')))
            pyc.parent.mkdir(exist_ok=True)
            py_compile.compile(str(fake), cfile=str(pyc), invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
            for entry in ('r3_policy_packet.py', 'r3_policy_receive.py'):
                result = subprocess.run([sys.executable, '-I', '-B', str(scripts / entry), '--help'], capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertFalse(marker.exists())

    def test_original_failure_survives_cleanup_failure(self):
        real_kill = receiver.kill_group
        def cleanup(child):
            real_kill(child)
            raise OSError('cleanup')
        with tempfile.TemporaryDirectory() as tmp, patch.object(receiver, 'DOCUMENT_LIMIT', 1), \
             patch.object(receiver, 'kill_group', side_effect=cleanup):
            result = receiver.receive([sys.executable, '-c', 'import sys;sys.stdin.read();print("overflow")'], b'x', Path(tmp))
        self.assertEqual(result['failure'], 'ValueError')
        self.assertEqual(result['cleanup_errors'], ['OSError'])

    def test_signal_during_receive_returns_partial_and_closes_child(self):
        for number in (signal.SIGINT, signal.SIGTERM):
            with tempfile.TemporaryDirectory() as tmp:
                code = 'import os,signal,sys,time;sys.stdin.read();print("partial",flush=True);os.kill(os.getppid(),' + str(int(number)) + ');time.sleep(5)'
                with receiver.capture_signals() as interrupted:
                    result = receiver.receive([sys.executable, '-c', code], b'x', Path(tmp), interrupted)
                self.assertEqual(result['failure'], 'InterruptedError')
                self.assertEqual(interrupted, [signal.Signals(number).name])
                self.assertEqual(result['cleanup_errors'], [])
                self.assertEqual((Path(tmp) / 'guest.json').read_bytes(), b'partial\n')


class ReceiverFinalization(unittest.TestCase):
    def test_transport_validation_seal_and_interruption_statuses(self):
        for case in ('complete', 'transport-failure', 'cleanup-failure', 'nonzero', 'partial', 'seal-failure', 'signal'):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                approval_file = root / 'approval.json'
                approval_file.write_bytes(b'{}')
                packet_dir = root / 'packet'
                packet_dir.mkdir()
                p = {**proposal(), 'custody': {'recipient': 'synthetic', 'age': '/synthetic/age'}}
                interrupted = []
                def receive(_argv, _guest, output, _interrupted):
                    doc = target_document()
                    if case == 'partial': doc['identity_after'] = None
                    if case == 'signal': interrupted.append('SIGTERM')
                    write(output / 'guest.json', encoded(doc))
                    write(output / 'stderr.private', b'')
                    return {'failure': 'OSError' if case == 'transport-failure' else None,
                            'returncode': 1 if case == 'nonzero' else 0,
                            'cleanup_errors': ['OSError'] if case == 'cleanup-failure' else [],
                            'remote_exit_proven': False}
                def seal(argv, _output, label, **_kwargs):
                    if case == 'seal-failure' and label == 'seal': raise OSError('synthetic seal')
                    write(Path(argv[argv.index('-o') + 1]), b'synthetic ciphertext')
                argv = ['receiver', '--packet', str(packet_dir), '--approval', str(approval_file),
                        '--approval-sha256', digest(b'{}'), '--execute']
                with (patch.object(sys, 'argv', argv), patch.object(receiver, 'approved', return_value=(p, b'synthetic')),
                      patch.object(receiver, 'ssh_argv', return_value=['synthetic']), patch.object(receiver, 'receive', side_effect=receive),
                      patch.object(receiver, 'run', side_effect=seal)):
                    result = receiver.execute(interrupted)
                summary = json.loads((packet_dir / 'collection-summary.json').read_bytes())
                self.assertEqual(result, 0 if case == 'complete' else 2)
                self.assertEqual(summary['status'], 'COLLECTED_REVIEW_REQUIRED' if case == 'complete' else 'PARTIAL_REVIEW_REQUIRED')
                self.assertEqual(summary['sealed'], case != 'seal-failure')
                if case not in ('complete', 'seal-failure'):
                    checked = json.loads((packet_dir / 'private-capture/validation.json').read_bytes())
                    self.assertEqual(checked['status'], 'PARTIAL_REVIEW_REQUIRED')
                    self.assertEqual(checked['policy_input_hashes'], {})
                self.assertTrue((packet_dir / 'private-capture/capture.json').is_file())
                self.assertTrue((packet_dir / 'private-capture/capture.tar').is_file())



def setUpModule():
    # Format-3 collection reads its PackageKit sections from a synthetic masked host.
    import r3_pk_fixtures
    r3_pk_fixtures.module_canned_sections()

if __name__ == '__main__':
    unittest.main()
