"""Credential-free refusal tests for bounded R3 preparation."""
import copy
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_artifacts as artifacts
import r3_transfer as transfer
import r3_qualification as qualification
import r3_toolchain as toolchain
import r3_install as install


class Artifacts(unittest.TestCase):
    def bundle(self, folder):
        root = Path(folder)
        data = b'public-artifact'
        artifacts.write(root / 'artifacts/example', data)
        manifest = {'format': 1, 'files': {'artifacts/example': artifacts.sha(data)},
                    'image_transport': 'UNQUALIFIED', 'install_authorized': False, 'secrets_included': False}
        artifacts.write(root / 'manifest.json', json.dumps(manifest).encode())
        return root, manifest

    def test_valid_regular_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            root, manifest = self.bundle(folder)
            self.assertEqual(artifacts.verify(root), manifest)

    def test_changed_missing_extra_linked_or_secret_claim_refused(self):
        for fault in ('changed', 'missing', 'extra', 'symlink', 'hardlink', 'authority', 'secret'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as folder:
                root, manifest = self.bundle(folder)
                path = root / 'artifacts/example'
                if fault == 'changed': path.write_bytes(b'changed')
                if fault == 'missing': path.unlink()
                if fault == 'extra': (root / 'extra').write_bytes(b'extra')
                if fault == 'symlink':
                    path.unlink(); path.symlink_to('/etc/hosts')
                if fault == 'hardlink': os.link(path, root / 'extra')
                if fault in ('authority', 'secret'):
                    manifest['install_authorized' if fault == 'authority' else 'secrets_included'] = True
                    (root / 'manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError): artifacts.verify(root)

    def test_reused_stage_refuses_before_network(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(artifacts, 'fetch') as fetch:
            with self.assertRaises(FileExistsError): artifacts.stage(folder)
            fetch.assert_not_called()

    def test_transfer_is_fixed_regular_archive_and_never_remote(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'bundle'; root.mkdir()
            lock_bytes = (artifacts.ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes()
            lock = json.loads(lock_bytes)
            files = {'r3-toolchain.lock.json': artifacts.sha(lock_bytes)}
            artifacts.write(root / 'r3-toolchain.lock.json', lock_bytes)
            # Synthetic small package bytes, bound by a correspondingly reviewed
            # temporary lock; tests archive mechanics without downloading binaries.
            for item in lock['packages'] + [lock['node']]:
                item['sha256'] = artifacts.sha(b'package')
                name = 'artifacts/' + item['url'].rsplit('/', 1)[1]
                files[name] = item['sha256']; artifacts.write(root / name, b'package')
            lock_bytes = json.dumps(lock).encode()
            (root / 'r3-toolchain.lock.json').write_bytes(lock_bytes)
            files['r3-toolchain.lock.json'] = artifacts.sha(lock_bytes)
            artifacts.write(root / 'manifest.json', json.dumps({'format': 1, 'files': files,
                'image_transport': 'UNQUALIFIED', 'install_authorized': False, 'secrets_included': False}).encode())
            reviewed = Path(folder) / 'reviewed/infra/selfhost'; reviewed.mkdir(parents=True)
            (reviewed / 'r3-toolchain.lock.json').write_bytes(lock_bytes)
            output = Path(folder) / 'out'
            with patch.object(transfer, 'ROOT', Path(folder) / 'reviewed'):
                proposal = transfer.prepare(root, output)
                with self.assertRaises(FileExistsError): transfer.prepare(root, output)
            self.assertFalse(proposal['azure_mutations_authorized'])
            self.assertIn('--no-download', proposal['proposed_install_argv'])
            with tarfile.open(output / 'transfer.tar') as archive:
                self.assertTrue(all(p.isfile() and p.name.startswith('r3/') and p.uid == 0 and p.mtime == 0 for p in archive))


class Qualification(unittest.TestCase):
    def test_only_selected_disposable_target_and_no_target_overrides(self):
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64'}
        release = {'ID': 'ubuntu', 'VERSION_ID': '24.04'}
        qualification.require_runner(env, 'Linux', 'x86_64', release)
        for key, value in [('RUNNER_ENVIRONMENT', 'self-hosted'), ('RUNNER_ARCH', 'ARM64'), ('DOCKER_HOST', 'tcp://other'), ('COMPOSE_PROFILES', 'https'), ('DATABASE_URL', 'private')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                qualification.require_runner({**env, key: value}, 'Linux', 'x86_64', release)
        with self.assertRaises(ValueError): qualification.require_runner(env, 'Darwin', 'arm64', release)

    def test_effective_identity_profiles_restart_and_gcm(self):
        lock = {name: {'image': name + '@sha256:' + 'a' * 64, 'platform': 'linux/amd64'} for name in qualification.ACTIVE | {'caddy', 'functions', 'supavisor'}}
        services = {name: {**value, 'restart': 'no'} for name, value in lock.items()}
        for name in ('caddy', 'functions', 'supavisor'): services[name]['profiles'] = ['https' if name == 'caddy' else 'unused']
        services['realtime']['environment'] = {'DB_ENC_WRITE_GCM': 'true', 'DB_ENC_KEY_GCM': 'a' * 32}
        config = {'services': services}
        with patch.object(qualification, 'validate'):
            qualification.check_effective(config, lock)
            for fault in ('image', 'platform', 'restart', 'profile', 'gcm'):
                bad = copy.deepcopy(config)
                if fault in ('image', 'platform', 'restart'): bad['services']['db'][fault] = 'wrong'
                if fault == 'profile': bad['services']['caddy'].pop('profiles')
                if fault == 'gcm': bad['services']['realtime']['environment']['DB_ENC_KEY_GCM'] = 'a' * 31
                with self.subTest(fault=fault), self.assertRaises(ValueError): qualification.check_effective(bad, lock)

    def test_qualification_import_does_not_run_initializer(self):
        source = (artifacts.ROOT / 'infra/scripts/selfhost_init.mjs').read_text()
        self.assertIn('export const createSettings', source)
        self.assertIn('import.meta.url === pathToFileURL(process.argv[1]).href', source)


class OfflineInstall(unittest.TestCase):
    def test_signed_chain_and_package_metadata_fail_closed(self):
        for fault in (None, 'signature', 'fingerprint', 'release-index', 'archive', 'metadata'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); (root / 'provenance').mkdir(); (root / 'artifacts').mkdir()
                (root / 'artifacts/engine.deb').write_bytes(b'archive')
                (root / 'artifacts/node.tar.xz').write_bytes(b'node')
                package_hash = artifacts.sha(b'archive')
                index = ('Package: engine\nVersion: 1.0\nArchitecture: amd64\nSHA256: ' + package_hash + '\n').encode()
                release = (artifacts.sha(index) + ' ' + str(len(index)) + ' stable/binary-amd64/Packages\n').encode()
                if fault == 'release-index': release = b'wrong index binding'
                provenance = {'docker.asc': b'key', 'InRelease': release, 'Packages': index}
                for name, data in provenance.items(): (root / 'provenance' / name).write_bytes(data)
                lock = {'docker_signing_fingerprint': 'PRIMARY',
                        'provenance': dict(zip(('signing_key_sha256', 'InRelease_sha256', 'Packages_sha256'), map(artifacts.sha, provenance.values()))),
                        'packages': [{'name': 'engine', 'version': '1.0', 'url': 'https://example/engine.deb', 'sha256': package_hash}],
                        'node': {'url': 'https://example/node.tar.xz', 'sha256': artifacts.sha(b'node')}}
                raw = json.dumps(lock).encode(); (root / 'r3-toolchain.lock.json').write_bytes(raw)
                if fault == 'archive': (root / 'artifacts/engine.deb').write_bytes(b'changed')
                def command(argv):
                    if '--show-keys' in argv: return 'fpr:::::::::' + ('WRONG' if fault == 'fingerprint' else 'PRIMARY') + ':\n'
                    if '--verify' in argv: return '[GNUPG:] ' + ('BADSIG PRIMARY' if fault == 'signature' else 'VALIDSIG PRIMARY 1 2 3 4 5 6 7 8 PRIMARY')
                    if argv[0] == 'dpkg-deb': return 'engine\n' + ('2.0' if fault == 'metadata' else '1.0') + '\namd64\n'
                    return ''
                with patch.object(toolchain, 'verify'), patch.object(toolchain, 'capture', side_effect=command):
                    if fault:
                        with self.assertRaises(ValueError): toolchain.verify_toolchain(root, artifacts.sha(raw))
                    else:
                        result, paths = toolchain.verify_toolchain(root, artifacts.sha(raw))
                        self.assertEqual(result, lock); self.assertEqual(paths, [str(root / 'artifacts/engine.deb')])

    def test_persistent_masks_must_all_survive_install_readback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for service in install.SERVICES:
                (root / service).symlink_to('/dev/null')
            install.verify_masks(root)
            (root / 'docker.service').unlink()
            with self.assertRaises(ValueError): install.verify_masks(root)
            (root / 'docker.service').symlink_to('/some/unit')
            with self.assertRaises(ValueError): install.verify_masks(root)

    def test_transferred_lock_uses_explicit_approval_hash_not_repository(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'r3-toolchain.lock.json').write_text('{}')
            # Reaching provenance validation demonstrates no repo-relative read;
            # a wrong approved hash must stop before signature/package commands.
            with patch.object(toolchain, 'verify'), patch.object(toolchain, 'ROOT', root / 'absent'), patch.object(toolchain, 'capture') as capture:
                with self.assertRaisesRegex(ValueError, 'Different toolchain lock'):
                    toolchain.verify_toolchain(root, 'a' * 64)
                with self.assertRaises(FileNotFoundError) as error:
                    toolchain.verify_toolchain(root, artifacts.sha(b'{}'))
                self.assertIn('provenance', str(error.exception))
                capture.assert_not_called()

    def test_offline_dependency_closure_refuses_extra_remove_or_missing(self):
        lock = {'packages': [{'name': 'engine'}, {'name': 'cli'}]}
        for output in ('Inst engine (1)\nInst cli (1)\nInst extra (2)', 'Inst engine (1)\nInst cli (1)\nRemv old', 'Inst engine (1)'):
            with patch.object(toolchain, 'capture', return_value=output), self.assertRaises(ValueError):
                toolchain.dependency_plan(lock, ['a.deb', 'b.deb'])
        with patch.object(toolchain, 'capture', return_value='Inst engine (1)\nInst cli (1)') as capture:
            toolchain.dependency_plan(lock, ['a.deb', 'b.deb'])
            self.assertIn('--simulate', capture.call_args.args[0])
            self.assertIn('--no-download', capture.call_args.args[0])

    def test_nonroot_install_refuses_before_artifact_or_host_access(self):
        with patch.object(install.os, 'geteuid', return_value=501), patch.object(install, 'verify_toolchain') as verify:
            with self.assertRaises(ValueError): install.install('bundle', 'contract', 'approval', 'a' * 64)
            verify.assert_not_called()

    def test_no_automatic_activation_in_installer(self):
        source = Path(install.__file__).read_text()
        self.assertNotIn("'unmask'", source)
        self.assertNotIn("'enable'", source)
        self.assertNotIn("'--now'", source)
        self.assertIs(install.DAEMON['live-restore'], False)


if __name__ == '__main__':
    unittest.main()
