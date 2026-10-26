"""Offline signature-boundary tests. GPG/dpkg commands are faked, never claimed as crypto evidence."""
import copy
import io
import json
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_artifacts as artifacts
import r3_toolchain as toolchain

BEGIN = b'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n'
SIGNATURE = b'-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n'


class Provenance(unittest.TestCase):
    def fixture(self, root):
        self.root = root
        self.lock = json.loads((artifacts.ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes())
        (root / 'artifacts').mkdir(); (root / 'provenance').mkdir()
        for item in self.lock['packages'] + [self.lock['node']]:
            data = item['url'].encode(); item['sha256'] = artifacts.sha(data)
            (root / 'artifacts' / item['url'].rsplit('/', 1)[1]).write_bytes(data)
        self.index = ''.join('Package: {name}\nVersion: {version}\nArchitecture: {architecture}\nSHA256: {sha256}\n\n'.format(**p) for p in self.lock['packages']).encode()
        self.plain = 'Suite: noble\nSHA256:\n %s %d stable/binary-amd64/Packages\n' % (artifacts.sha(self.index), len(self.index))
        (root / 'provenance/Packages').write_bytes(self.index)
        (root / 'provenance/docker.asc').write_bytes(b'fixture key')
        (root / 'provenance/InRelease').write_bytes(BEGIN + self.plain.encode() + SIGNATURE)
        (root / 'r3-toolchain.lock.json').write_text(json.dumps(self.lock))
        self.status = '[GNUPG:] VALIDSIG SUBKEY 1 2 3 4 5 6 7 8 ' + self.lock['docker_signing_fingerprint']
        self.key = self.lock['docker_signing_fingerprint']; self.metadata_bad = False
        self.bind()

    def bind(self):
        files = {p.relative_to(self.root).as_posix(): artifacts.sha(p.read_bytes()) for p in self.root.rglob('*') if p.is_file() and p.name != 'manifest.json'}
        self.manifest = {'format': 2, 'source_sha': 'a' * 40, 'files': files,
                         'provenance': {n: files['provenance/' + n] for n in ('docker.asc', 'InRelease', 'Packages')},
                         'install_authorized': False, 'image_transport': 'UNQUALIFIED'}
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest))
        self.approved = artifacts.sha((self.root / 'r3-toolchain.lock.json').read_bytes())

    def command(self, argv):
        if '--show-keys' in argv: return 'fpr:::::::::' + self.key + ':\n'
        if '--dearmor' in argv:
            Path(argv[argv.index('--output') + 1]).write_bytes(b'fixture keyring'); return ''
        if '--decrypt' in argv:
            self.assertIn('--no-default-keyring', argv)
            self.assertTrue(Path(argv[argv.index('--keyring') + 1]).is_file())
            Path(argv[argv.index('--output') + 1]).write_text(self.plain)
            return self.status
        if argv[0] == 'dpkg-deb':
            item = next(p for p in self.lock['packages'] if argv[-1].endswith(p['url'].rsplit('/', 1)[1]))
            return '\n'.join([item['name'], 'wrong' if self.metadata_bad else item['version'], item['architecture']]) + '\n'
        raise AssertionError(argv)

    def test_chain_and_each_negative_binding(self):
        faults = [None, 'prefix', 'suffix', 'second-block', 'bad-signature', 'second-signature', 'signer', 'key',
                  'suite', 'sha1-only', 'duplicate-sha256', 'duplicate-index', 'index-size', 'index-hash',
                  'package-pin', 'signed-package-pin', 'deb-hash', 'node-hash', 'metadata', 'lock-hash', 'lock-format', 'observed-hash']
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); self.fixture(root)
                release = root / 'provenance/InRelease'
                if fault == 'prefix': release.write_bytes(b'forged hash\n' + release.read_bytes())
                if fault == 'suffix': release.write_bytes(release.read_bytes() + b'forged hash\n')
                if fault == 'second-block': release.write_bytes(release.read_bytes() * 2)
                if fault == 'bad-signature': self.status = '[GNUPG:] BADSIG PRIMARY'
                if fault == 'second-signature': self.status += '\n' + self.status
                if fault == 'signer': self.status = self.status.replace(self.key, 'F' * 40)
                if fault == 'key': self.key = 'F' * 40
                if fault == 'suite': self.plain = self.plain.replace('noble', 'jammy')
                if fault == 'sha1-only': self.plain = self.plain.replace('SHA256:', 'SHA1:')
                if fault == 'duplicate-sha256': self.plain += 'SHA256:\n'
                if fault == 'duplicate-index': self.plain += self.plain.splitlines()[-1] + '\n'
                if fault == 'index-size': self.plain = self.plain.replace(str(len(self.index)), '0')
                if fault == 'index-hash': self.plain = self.plain.replace(artifacts.sha(self.index), '0' * 64)
                if fault == 'signed-package-pin':
                    changed = self.index.replace(self.lock['packages'][0]['sha256'].encode(), b'a' * 64)
                    (root / 'provenance/Packages').write_bytes(changed)
                    self.plain = self.plain.replace(artifacts.sha(self.index), artifacts.sha(changed))
                if fault == 'package-pin':
                    self.lock['packages'][0]['sha256'] = 'a' * 64
                    (root / 'r3-toolchain.lock.json').write_text(json.dumps(self.lock))
                if fault in ('deb-hash', 'node-hash'):
                    item = self.lock['node'] if fault == 'node-hash' else self.lock['packages'][0]
                    (root / 'artifacts' / item['url'].rsplit('/', 1)[1]).write_bytes(b'tampered')
                if fault == 'metadata': self.metadata_bad = True
                if fault == 'lock-format':
                    self.lock['format'] = 1; (root / 'r3-toolchain.lock.json').write_text(json.dumps(self.lock))
                self.bind()  # Isolate chain guards from the separate file-hash guard.
                if fault == 'lock-hash': self.approved = 'f' * 64
                if fault == 'observed-hash':
                    self.manifest['provenance']['Packages'] = 'e' * 64
                    (root / 'manifest.json').write_text(json.dumps(self.manifest))
                with patch.object(toolchain, 'capture', side_effect=self.command) as commands:
                    if fault:
                        with self.assertRaises(ValueError): toolchain.verify_toolchain(root, self.approved)
                        if fault in ('prefix', 'suffix', 'second-block', 'lock-hash'):
                            commands.assert_not_called()
                    else:
                        lock, paths = toolchain.verify_toolchain(root, self.approved)
                        self.assertEqual(lock, self.lock); self.assertEqual(len(paths), 5)

    @unittest.skipUnless(shutil.which('gpg') and shutil.which('gpgconf'), 'GPG is not installed; fake-command tests are not cryptographic evidence')
    def test_real_gpg_signed_plaintext_and_outer_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); bundle = root / 'bundle'; bundle.mkdir(); self.fixture(bundle)
            home = root / 'gnupg'; home.mkdir(mode=0o700)
            gpg = ['gpg', '--batch', '--no-options', '--homedir', str(home)]
            def run(args):
                return subprocess.check_output(gpg + args, stderr=subprocess.DEVNULL, timeout=60)
            try:
                run(['--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
                     'R3 fixture <r3@example.invalid>', 'rsa2048', 'sign', '0'])
                keys = run(['--with-colons', '--list-keys']).decode()
                self.lock['docker_signing_fingerprint'] = next(line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:'))
                (bundle / 'provenance/docker.asc').write_bytes(run(['--armor', '--export']))
                plain = root / 'Release'; plain.write_text(self.plain)
                signed = bundle / 'provenance/InRelease'; signed.unlink()
                run(['--pinentry-mode', 'loopback', '--passphrase', '', '--output', str(signed), '--clearsign', str(plain)])
                genuine = signed.read_bytes()
                self.assertEqual(toolchain.verify_index(bundle, self.lock)['Packages'], artifacts.sha(self.index))
                for forged in (b'forged hash\n' + genuine, genuine + b'forged hash\n'):
                    signed.write_bytes(forged)
                    with self.assertRaises(ValueError): toolchain.verify_index(bundle, self.lock)
            finally:
                subprocess.run(['gpgconf', '--homedir', str(home), '--kill', 'gpg-agent'], capture_output=True, timeout=10)

    def test_verifier_reads_authenticated_plaintext_not_cleartext(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(Path(tmp))
            # The fake verifier produces different authenticated plaintext. Raw
            # armor has a valid-looking SHA256 line but cannot supply the binding.
            self.plain = self.plain.replace('SHA256:', 'SHA1:')
            with patch.object(toolchain, 'capture', side_effect=self.command), self.assertRaises(ValueError):
                toolchain.verify_toolchain(self.root, self.approved)

    def test_explicit_install_approval_does_not_require_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(Path(tmp))
            with patch.object(toolchain, 'capture', side_effect=self.command), \
                 patch.object(toolchain, 'clean_source', side_effect=AssertionError('Installer cannot use Git')), \
                 patch.object(toolchain, 'source_bytes', side_effect=AssertionError('Installer cannot read checkout')):
                lock, paths = toolchain.verify_toolchain(self.root, self.approved)
            self.assertEqual(lock, self.lock)
            self.assertEqual(len(paths), 5)

    def test_fetch_requires_https_at_source_and_redirect_and_digest(self):
        class Response(io.BytesIO): pass
        for url, redirected, expected, valid in [
                ('https://example', 'https://example', artifacts.sha(b'public'), True),
                ('http://example', 'https://example', artifacts.sha(b'public'), False),
                ('https://example', 'http://example', artifacts.sha(b'public'), False),
                ('https://example', 'https://example', 'f' * 64, False),
                ('https://example', 'https://example', 'bad', False)]:
            response = Response(b'public'); response.url = redirected
            with self.subTest(url=url, redirected=redirected, expected=expected), patch.object(artifacts.urllib.request, 'urlopen', return_value=response):
                if valid: self.assertEqual(artifacts.fetch(url, expected), b'public')
                else:
                    with self.assertRaises(ValueError): artifacts.fetch(url, expected)

    def test_stage_binds_clean_tracked_allowlist_and_current_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); repo = root / 'repo'; repo.mkdir()
            names = ['infra/scripts/' + n for n in artifacts.HELPERS]
            names += ['infra/selfhost/' + n for n in (*artifacts.RUNTIME, 'r3-toolchain.lock.json', 'database-image-policy.json')]
            for name in names:
                path = repo / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((artifacts.ROOT / name).read_bytes())
            def git(*args): return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL)
            (repo / '.gitignore').write_text('private.json\n')
            git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            git('add', '.'); git('commit', '-qm', 'fixture')
            expected = git('rev-parse', 'HEAD').decode().strip()
            (repo / 'infra/scripts/private.json').write_text('private sentinel never staged')
            def metadata(directory, lock):
                return {n: artifacts.sha((directory / 'provenance' / n).read_bytes()) for n in ('docker.asc', 'InRelease', 'Packages')}
            with patch.object(artifacts, 'ROOT', repo), patch.object(artifacts, 'fetch', return_value=b'public fixture') as fetch, patch.object(toolchain, 'verify_index', side_effect=metadata) as verified:
                manifest = artifacts.stage(root / 'bundle')
                self.assertEqual(manifest['source_sha'], expected)
                self.assertEqual({n.removeprefix('helpers/') for n in manifest['files'] if n.startswith('helpers/')}, set(artifacts.HELPERS))
                self.assertNotIn('private sentinel', ''.join(p.read_text() for p in (root / 'bundle/helpers').iterdir()))
                self.assertNotIn('secrets_included', manifest)
                verified.assert_called_once()
                metadata_calls = [c for c in fetch.call_args_list if len(c.args) == 1]
                self.assertEqual(len(metadata_calls), 3)  # Mutable metadata: verified chain, not stale byte pins.
                (repo / 'infra/scripts/r3_install.py').write_text('dirty')
                fetch.reset_mock()
                with self.assertRaises(ValueError): artifacts.stage(root / 'dirty-bundle')
                fetch.assert_not_called()

    def test_source_commit_cleanliness_allowlist_and_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def git(*args): return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)
            git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            (root / '.gitignore').write_text('ignored\n'); (root / 'public').write_bytes(b'public')
            git('add', '.'); git('commit', '-qm', 'fixture')
            with patch.object(artifacts, 'ROOT', root):
                source = artifacts.clean_source()
                self.assertEqual(artifacts.source_bytes(source, 'public'), b'public')
                (root / 'ignored').write_text('never staged')
                self.assertEqual(artifacts.clean_source(), source)
                with self.assertRaises(subprocess.CalledProcessError): artifacts.source_bytes(source, 'ignored')
                (root / 'untracked').write_text('private')
                with self.assertRaises(ValueError): artifacts.clean_source()
                (root / 'untracked').unlink(); (root / 'public').write_text('dirty')
                with self.assertRaises(ValueError): artifacts.clean_source()
                with self.assertRaises(ValueError): artifacts.source_bytes(source, 'public')
            self.assertNotIn('selfhost_docker.sh', artifacts.HELPERS)
            self.assertEqual(set(artifacts.HELPERS), {'r3_artifacts.py', 'r3_toolchain.py', 'r3_install.py', 'r3_package_state.py', 'r3_apt_observer.py',
                'replacement_host.py', 'replacement_bundle.py', 'replacement-source-layout.json', 'selfhost_init.mjs', 'selfhost_pin.py',
                'r3_install_policy.py', 'r3_packagekit_state.py', 'r3_policy_capture.py', 'r3_maintenance.py',
                'r3_noble_common.py', 'r3_noble_identity.py'})


if __name__ == '__main__': unittest.main()
