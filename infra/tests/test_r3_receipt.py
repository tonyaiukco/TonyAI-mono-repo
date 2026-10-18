"""Commit/source and receipt regressions; mocked vendor checks are not crypto proof."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_artifacts as artifacts
import r3_toolchain as toolchain


class Receipt(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        self.output = self.root / 'receipt.json'
        names = ['infra/scripts/' + n for n in artifacts.HELPERS]
        names += ['infra/selfhost/' + n for n in (*artifacts.RUNTIME, 'r3-toolchain.lock.json', 'database-image-policy.json')]
        for name in names:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((artifacts.ROOT / name).read_bytes())
        upstream_path = self.repo / 'infra/selfhost/upstream.lock.json'
        upstream = json.loads(upstream_path.read_bytes())
        for name in upstream['files']:
            data = ('synthetic upstream ' + name).encode()
            upstream['files'][name] = artifacts.sha(data)
            artifacts.write(self.bundle / 'runtime' / name, data)
        upstream_path.write_text(json.dumps(upstream))
        lock_path = self.repo / 'infra/selfhost/r3-toolchain.lock.json'
        self.lock = json.loads(lock_path.read_bytes())
        for item in self.lock['packages'] + [self.lock['node']]:
            data = ('synthetic archive ' + item['url']).encode()
            item['sha256'] = artifacts.sha(data)
            artifacts.write(self.bundle / 'artifacts' / item['url'].rsplit('/', 1)[1], data)
        lock_path.write_text(json.dumps(self.lock))
        for name in artifacts.HELPERS:
            artifacts.write(self.bundle / 'helpers' / name, (self.repo / 'infra/scripts' / name).read_bytes())
        for name in artifacts.RUNTIME:
            target = 'compose.images.json' if name == 'images.qa.lock.json' else name
            artifacts.write(self.bundle / 'runtime' / target, (self.repo / 'infra/selfhost' / name).read_bytes())
        for name in ('r3-toolchain.lock.json', 'database-image-policy.json'):
            artifacts.write(self.bundle / name, (self.repo / 'infra/selfhost' / name).read_bytes())
        for name in ('docker.asc', 'InRelease', 'Packages'):
            artifacts.write(self.bundle / 'provenance' / name, ('synthetic ' + name).encode())
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        self.source = self.git('rev-parse', 'HEAD').decode().strip()
        self.manifest = {'format': 2, 'source_sha': self.source, 'files': {},
                         'provenance': {n: artifacts.sha((self.bundle / 'provenance' / n).read_bytes())
                                        for n in ('docker.asc', 'InRelease', 'Packages')},
                         'image_transport': 'UNQUALIFIED', 'install_authorized': False}
        self.reseal()
        self.addCleanup(patch.stopall)
        patch.object(artifacts, 'ROOT', self.repo).start()
        self.verifier = patch.object(toolchain, 'verify_toolchain_snapshot', return_value=(copy.deepcopy(self.lock), [])).start()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL)

    def reseal(self):
        self.manifest['files'] = {p.relative_to(self.bundle).as_posix(): artifacts.sha(p.read_bytes())
                                  for p in self.bundle.rglob('*') if p.is_file() and p != self.bundle / 'manifest.json'}
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest, indent=2))

    def expected_receipt(self, manifest_bytes, lock_bytes):
        return {
            'format': 1, 'status': 'VENDOR_ARTIFACT_PROVENANCE_PASS',
            'evidence_kind': 'real-vendor-artifacts-not-ci-fixture', 'source_sha': self.source,
            'manifest_sha256': artifacts.sha(manifest_bytes), 'lock_sha256': artifacts.sha(lock_bytes),
            'docker_signing_fingerprint': self.lock['docker_signing_fingerprint'],
            'provenance_sha256': self.manifest['provenance'],
            'packages': [{'name': p['name'], 'version': p['version'], 'architecture': p['architecture'], 'sha256': p['sha256']}
                         for p in self.lock['packages']],
            'node': {'version': self.lock['node']['version'], 'sha256': self.lock['node']['sha256']},
            'qa_ready': False, 'install_authorized': False,
            'unproven': ['Target OS dependency closure', 'Pinned engine and image store',
                         'Offline installer lifecycle and reboot', 'Offline image transport',
                         'Private database regression', 'Realtime source and GCM consumer',
                         'Final host source map, SSH, disks and custody', 'R4 and application readiness'],
        }

    def test_exact_receipt_and_verified_byte_hashes(self):
        manifest_bytes = (self.bundle / 'manifest.json').read_bytes()
        lock_bytes = (self.bundle / 'r3-toolchain.lock.json').read_bytes()
        def verified(directory, manifest, reviewed, approved_hash):
            self.assertEqual((directory, manifest, reviewed, approved_hash),
                             (self.bundle, self.manifest, lock_bytes, artifacts.sha(lock_bytes)))
            # Later path reads must not substitute bytes for the verified snapshot.
            (self.bundle / 'manifest.json').write_bytes(b'replaced after verification')
            (self.bundle / 'r3-toolchain.lock.json').write_bytes(b'replaced lock')
            return copy.deepcopy(self.lock), []
        self.verifier.side_effect = verified
        old_umask = os.umask(0o022)
        try:
            result = toolchain.provenance_receipt(self.bundle, self.output)
        finally:
            os.umask(old_umask)
        self.verifier.assert_called_once()
        expected = self.expected_receipt(manifest_bytes, lock_bytes)
        self.assertEqual(result, expected)
        self.assertEqual(json.loads(self.output.read_bytes()), expected)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_resealed_noncommitted_source_entries_and_pins_are_refused(self):
        names = ['helpers/r3_install.py', 'runtime/compose.qa.yml', 'runtime/compose.images.json',
                 'runtime/volumes/db/roles.sql', 'runtime/upstream.lock.json',
                 'database-image-policy.json', 'r3-toolchain.lock.json']
        names += ['artifacts/' + item['url'].rsplit('/', 1)[1] for item in (self.lock['packages'][0], self.lock['node'])]
        for name in names:
            with self.subTest(name=name):
                path = self.bundle / name
                original = path.read_bytes()
                path.write_bytes(original + b' changed')
                self.reseal()
                artifacts.verify(self.bundle)  # Internally consistent is insufficient.
                with self.assertRaises(ValueError):
                    toolchain.provenance_receipt(self.bundle, self.output)
                self.assertFalse(self.output.exists())
                self.verifier.assert_not_called()
                path.write_bytes(original)
        self.reseal()

    def test_missing_or_extra_resealed_entry_is_refused(self):
        path = self.bundle / 'helpers/r3_install.py'
        original = path.read_bytes()
        for fault in ('missing', 'extra'):
            with self.subTest(fault=fault):
                if fault == 'missing': path.unlink()
                else: (self.bundle / 'helpers/extra.py').write_bytes(b'foreign')
                self.reseal()
                artifacts.verify(self.bundle)
                with self.assertRaises(ValueError): toolchain.provenance_receipt(self.bundle, self.output)
                self.verifier.assert_not_called()
                self.assertFalse(self.output.exists())
                if fault == 'missing': path.write_bytes(original)
                else: (self.bundle / 'helpers/extra.py').unlink()
        self.reseal()

    def test_skip_worktree_cannot_replace_committed_lock_or_helper(self):
        for name in ('infra/selfhost/r3-toolchain.lock.json', 'infra/scripts/r3_install.py'):
            with self.subTest(name=name):
                path = self.repo / name
                original = path.read_bytes()
                self.git('update-index', '--skip-worktree', name)
                path.write_bytes(original + b' ')
                self.assertEqual(artifacts.clean_source(), self.source)
                with self.assertRaisesRegex(ValueError, 'Source changed'):
                    toolchain.provenance_receipt(self.bundle, self.output)
                self.verifier.assert_not_called()
                self.assertFalse(self.output.exists())
                path.write_bytes(original)
                self.git('update-index', '--no-skip-worktree', name)

    def test_source_and_verification_failures_never_write_receipt(self):
        for fault in ('source', 'verification', 'source-changed', 'reuse'):
            with self.subTest(fault=fault):
                if fault == 'source':
                    self.manifest['source_sha'] = 'c' * 40
                    self.reseal()
                if fault == 'reuse': self.output.write_text('existing evidence')
                self.verifier.side_effect = ValueError('verification failed') if fault == 'verification' else None
                source = [self.source, ('c' * 40 if fault == 'source-changed' else self.source)]
                with patch.object(toolchain, 'clean_source', side_effect=source):
                    with self.assertRaises((ValueError, FileExistsError)):
                        toolchain.provenance_receipt(self.bundle, self.output)
                if fault == 'source': self.verifier.assert_not_called()
                if fault == 'reuse': self.assertEqual(self.output.read_text(), 'existing evidence')
                else: self.assertFalse(self.output.exists())
                self.verifier.reset_mock()
                self.manifest['source_sha'] = self.source
                self.reseal()


class ReceiptCLI(unittest.TestCase):
    def test_isolated_cli_refuses_bad_arguments_and_failing_bundle(self):
        # Run in a private source copy with only the verifier result stubbed. This
        # distinguishes argument-count refusal from an unrelated dirty-tree error.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('r3_toolchain.py', 'r3_artifacts.py'):
                (root / name).write_bytes(Path(toolchain.__file__).with_name(name).read_bytes())
            source = (root / 'r3_toolchain.py').read_text()
            marker = "if __name__ == '__main__':"
            self.assertEqual(source.count(marker), 1)
            prefix, cli = source.split(marker)
            fake = '\ndef provenance_receipt(*args):\n    raise ValueError("fixture verification refusal")\n\n'
            (root / 'r3_toolchain.py').write_text(prefix + fake + marker + cli)
            output = root / 'receipt.json'
            for args in ([], ['bundle'], ['bundle', str(output)], ['bundle', str(output), 'extra']):
                result = subprocess.run([sys.executable, '-I', '-B', str(root / 'r3_toolchain.py'), *args], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'FAIL:', result.stderr)
                self.assertNotIn(b'PASS', result.stdout + result.stderr)
                self.assertFalse(output.exists())
            # An accepting stub must still not be reachable with bad arity.
            (root / 'r3_toolchain.py').write_text(prefix + '\ndef provenance_receipt(*args):\n    return {}\n\n' + marker + cli)
            for args in ([], ['bundle'], ['bundle', str(output), 'extra']):
                result = subprocess.run([sys.executable, '-I', '-B', str(root / 'r3_toolchain.py'), *args], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b'PASS', result.stdout + result.stderr)
            # Also exercise the actual, unmodified production entry point.
            result = subprocess.run([sys.executable, '-I', '-B', toolchain.__file__, str(root / 'missing'), str(output)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'PASS', result.stdout + result.stderr)
            self.assertFalse(output.exists())


if __name__ == '__main__': unittest.main()
