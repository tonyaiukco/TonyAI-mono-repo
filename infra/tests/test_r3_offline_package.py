"""Local fixture proof only: no daemon, guest, package installation or network."""
import copy
import io
import json
import os
import shutil
from contextlib import chdir, contextmanager
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_guard_files as guards
import r3_image_transport as transport
import r3_package_evidence as packages
import r3_source_plan as source
from replacement_bundle import digest, encoded
import replacement_host
import selfhost_pin
from replacement_host import required_source_paths, validate_contract
from test_replacement_custody import contract


def oci_fixture(root):
    (root / 'blobs/sha256').mkdir(parents=True)
    def blob(data, media):
        value = digest(data)
        (root / 'blobs/sha256' / value).write_bytes(data)
        return {'digest': 'sha256:' + value, 'size': len(data), 'mediaType': media}
    layer = blob(b'fixture layer', 'application/vnd.oci.image.layer.v1.tar')
    config = blob(encoded({'os': 'linux', 'architecture': 'amd64',
                           'rootfs': {'type': 'layers', 'diff_ids': [layer['digest']]}}),
                  'application/vnd.oci.image.config.v1+json')
    manifest = blob(encoded({'schemaVersion': 2, 'config': config, 'layers': [layer],
                            'annotations': {'org.opencontainers.image.description': 'fixture image',
                                            'org.opencontainers.image.title': 'fixture',
                                            'org.opencontainers.image.licenses': 'fixture-only'}}),
                    'application/vnd.oci.image.manifest.v1+json')
    names = transport.ACTIVE | {'caddy', 'functions', 'supavisor'}
    lock = {name: {'image': name + '@' + manifest['digest'], 'platform': 'linux/amd64'} for name in names}
    index = {'schemaVersion': 2, 'manifests': [
        {**manifest, 'annotations': {'org.opencontainers.image.ref.name': value['image']}}
        for value in lock.values()]}
    (root / 'oci-layout').write_bytes(encoded({'imageLayoutVersion': '1.0.0'}))
    (root / 'index.json').write_bytes(encoded(index))
    return lock, index, config, layer


def tar_bytes(entries):
    with io.BytesIO() as stream:
        with tarfile.open(fileobj=stream, mode='w:xz') as tar:
            for name, data, kind in entries:
                member = tarfile.TarInfo(name)
                member.type, member.size = kind, len(data)
                member.linkname = 'missing' if kind == tarfile.SYMTYPE else ''
                tar.addfile(member, io.BytesIO(data))
        return stream.getvalue()


def package_fixture(root, fault=None):
    repo = root / 'repo/infra/selfhost'
    repo.mkdir(parents=True)
    artifacts = root / 'artifacts'
    artifacts.mkdir()
    lock = json.loads((packages.ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes())
    for number, item in enumerate(lock['packages']):
        name = 'wrong' if fault == 'identity' and number == 0 else item['name']
        control = f"Package: {name}\nVersion: {item['version']}\nArchitecture: amd64\nDepends: libc6,\n libsystemd0\nPre-Depends: fixture-pre (>= 1)\n".encode()
        members = [('debian-binary', b'2.0\n'),
                   ('control.tar.xz', tar_bytes([('./control', control, tarfile.REGTYPE),
                                                ('./postinst', b'#!/bin/sh\nexit 0\n', tarfile.REGTYPE)])),
                   ('data.tar.xz', tar_bytes([]))]
        if fault == 'ar-layout' and number == 0:
            members.append(('extra', b'unreviewed'))
        data = b'!<arch>\n'
        for member, content in members:
            header = f"{member:<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(content):<10}`\n".encode()
            assert len(header) == 60
            data += header + content + (b'\n' if len(content) % 2 else b'')
        path = artifacts / item['url'].rsplit('/', 1)[1]
        path.write_bytes(data)
        item['sha256'] = digest(data)
        if number == 0 and fault == 'hash': path.write_bytes(data + b'changed')
        if number == 0 and fault == 'symlink':
            target = root / 'outside.deb'; path.rename(target); path.symlink_to(target)
    node_member = 'node-v22.23.3-linux-x64/bin/node'
    members = [(node_member, b'synthetic ELF bytes; never executed', tarfile.REGTYPE)]
    if fault == 'node-duplicate': members *= 2
    if fault == 'node-missing': members = []
    if fault == 'node-link': members = [(node_member, b'', tarfile.SYMTYPE)]
    data = tar_bytes(members)
    (artifacts / lock['node']['url'].rsplit('/', 1)[1]).write_bytes(data)
    lock['node']['sha256'] = digest(data)
    (repo / 'r3-toolchain.lock.json').write_bytes(encoded(lock))
    return artifacts, lock


def rewrite_image(root, lock, index, mutate):
    descriptor = index['manifests'][0]
    manifest_path = root / 'blobs/sha256' / descriptor['digest'][7:]
    manifest = json.loads(manifest_path.read_bytes())
    config_path = root / 'blobs/sha256' / manifest['config']['digest'][7:]
    config = json.loads(config_path.read_bytes())
    mutate(manifest, config)
    config_bytes = encoded(config)
    config_path.unlink()
    (root / 'blobs/sha256' / digest(config_bytes)).write_bytes(config_bytes)
    manifest['config'].update(digest='sha256:' + digest(config_bytes), size=len(config_bytes))
    data = encoded(manifest)
    manifest_path.unlink()
    (root / 'blobs/sha256' / digest(data)).write_bytes(data)
    for name, entry in zip(lock, index['manifests']):
        lock[name]['image'] = name + '@sha256:' + digest(data)
        entry.update(digest='sha256:' + digest(data), size=len(data))
        entry['annotations']['org.opencontainers.image.ref.name'] = lock[name]['image']
    (root / 'index.json').write_bytes(encoded(index))


class OfflinePackage(unittest.TestCase):
    def test_original_index_is_retained_with_unique_amd64_child(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lock, index, _, _ = oci_fixture(root)
            child = {k: v for k, v in index['manifests'][0].items() if k != 'annotations'}
            child['platform'] = {'os': 'linux', 'architecture': 'amd64'}
            child['annotations'] = {'org.opencontainers.image.version': 'fixture', 'com.docker.official-images.bashbrew.arch': 'amd64'}
            original_index = encoded({'schemaVersion': 2, 'manifests': [
                {**child, 'digest': 'sha256:' + 'e' * 64, 'platform': {'os': 'unknown', 'architecture': 'unknown'},
                 'annotations': {'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': child['digest']}},
                child, {**child, 'digest': 'sha256:' + 'f' * 64,
                        'platform': {'os': 'linux', 'architecture': 'arm64'}}]})
            parent_hash = digest(original_index)
            (root / 'blobs/sha256' / parent_hash).write_bytes(original_index)
            for name, item in lock.items():
                item['image'] = name + '@sha256:' + parent_hash
            index['manifests'] = [{'digest': 'sha256:' + parent_hash, 'size': len(original_index),
                                  'mediaType': 'application/vnd.oci.image.index.v1+json',
                                  'annotations': {'org.opencontainers.image.ref.name': item['image']}}
                                 for item in lock.values()]
            (root / 'index.json').write_bytes(encoded(index))
            images, _, _ = transport.verify(root, lock)
            self.assertEqual(images['realtime']['image'], lock['realtime']['image'])
            self.assertEqual(images['realtime']['platform_manifest_digest'], child['digest'])
            for children in ([], [child, child], [{**child, 'platform': {'os': 'linux', 'architecture': 'arm64'}}],
                             [{**child, 'mediaType': 'application/vnd.oci.image.index.v1+json'}],
                             [child, {**child, 'platform': {**child['platform'], 'variant': ''}}],
                             [child, {**child, 'platform': {**child['platform'], 'os.features': []}}],
                             [{**child, 'platform': {**child['platform'], 'variant': 'v3'}}]):
                bad = encoded({'schemaVersion': 2, 'manifests': children})
                new_hash = digest(bad)
                old = root / 'blobs/sha256' / parent_hash
                old.unlink()
                (root / 'blobs/sha256' / new_hash).write_bytes(bad)
                for name, item in lock.items(): item['image'] = name + '@sha256:' + new_hash
                for entry, item in zip(index['manifests'], lock.values()):
                    entry.update(digest='sha256:' + new_hash, size=len(bad),
                                 annotations={'org.opencontainers.image.ref.name': item['image']})
                (root / 'index.json').write_bytes(encoded(index))
                with self.assertRaises(ValueError): transport.verify(root, lock)
                parent_hash = new_hash

    def test_guard_render_and_source_map_exclude_network_installers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plan = guards.prepare(root / 'guard')
            expected = {
                '/etc/ssh/sshd_config.d/00-tonyai.conf': ('707ade3a8e8c3543a603248afb58da57552ff51891c752b9b502516f62205511', '0o644'),
                '/etc/systemd/system/docker.service.d/tonyai-mounts.conf': ('6ca20b31b309981f68403b87a27842746a64258ad6fa08c53d5550d3dff345a1', '0o644'),
                '/etc/systemd/system/tonyai-host-identity.service': ('7bbfa44e2984845a7558109402a3adb62f6d0fbaea447d6af7eaa106cad22e9a', '0o644'),
                '/usr/local/sbin/tonyai-runtime-guard': ('615a153ca8db5a3491abfd4e718ef8853450742077e7c04e5df4e20c505011bb', '0o755'),
            }
            self.assertEqual({k: (v['sha256'], v['mode']) for k, v in plan['files'].items()}, expected)
            for target, entry in plan['files'].items():
                data = (root / 'guard' / entry['payload']).read_bytes()
                self.assertEqual(digest(data), entry['sha256'])
                self.assertEqual(data, guards.payload()[target][0])
            with self.assertRaises(FileExistsError):
                guards.prepare(root / 'guard')
            report = source.prepare('a' * 64, root / 'source.json')
            self.assertEqual(set(report['files']), required_source_paths())
            self.assertEqual(report['bootstrap_status'], 'NOT_READY_FOR_BOOTSTRAP_APPROVAL')
            self.assertEqual(report['files']['/opt/tonyai-tools/node-v22.23.3-linux-x64/bin/node']['mode'], '0o755')
            self.assertEqual(report['files']['/etc/docker/daemon.json']['sha256'], digest(encoded(source.DAEMON)))
            with self.assertRaises(ValueError):
                source.prepare('invalid', root / 'invalid.json')
            c = contract()
            c['files'] = report['proposed_contract_files']
            c['source_sha256'] = report['proposed_source_sha256']
            validate_contract(c)
            for legacy in ('selfhost_docker.sh', 'selfhost_host_guard.sh'):
                wrong = copy.deepcopy(c)
                wrong['files']['/usr/local/lib/tonyai/' + legacy] = 'a' * 64
                wrong['source_sha256'] = digest(encoded(wrong['files']))
                with self.assertRaises(ValueError):
                    validate_contract(wrong)
            self.assertFalse(plan['install_authorized'])
            self.assertNotIn('curl', b''.join(x[0] for x in guards.payload().values()).decode())

    def test_control_duplicate_fields_links_and_traversal_refused(self):
        with self.assertRaises(ValueError):
            packages.fields(b'Package: x\nPackage: y\n')
        self.assertEqual(packages.fields(b'Depends: x,\n y\n')['Depends'], 'x,\n y')
        for name, kind in (('../escape', tarfile.REGTYPE), ('postinst', tarfile.SYMTYPE)):
            with self.subTest(name=name), io.BytesIO() as stream:
                with tarfile.open(fileobj=stream, mode='w:xz') as tar:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    tar.addfile(info, io.BytesIO())
                with patch.object(packages.subprocess, 'check_output',
                                  side_effect=[b'debian-binary\ncontrol.tar.xz\ndata.tar.xz\n', stream.getvalue()]):
                    with self.assertRaises(ValueError):
                        packages.control_files(Path('fixture.deb'))

    def test_exact_oci_archive_and_no_execution_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            layout = root / 'layout'
            lock, _, config, _ = oci_fixture(layout)
            repo = root / 'repo/infra/selfhost'
            repo.mkdir(parents=True)
            (repo / 'images.qa.lock.json').write_bytes(encoded({'services': lock}))
            with patch.object(transport, 'ROOT', root / 'repo'):
                result = transport.prepare(layout, root / 'out')
            self.assertEqual(result['archive_sha256'], transport.file_hash(root / 'out/images.oci.tar'))
            self.assertEqual(set(result['images']), set(lock))
            self.assertEqual(result['images']['db']['config_digest'], config['digest'])
            self.assertEqual(set(result['active_services']), transport.ACTIVE)
            self.assertEqual(result['status'], 'TRANSPORT_BYTES_VERIFIED_NOT_IMPORTED')
            self.assertFalse(result['qa_ready'])

    def test_oci_missing_extra_corrupt_digest_reference_platform_and_links(self):
        faults = ('missing', 'extra', 'corrupt', 'reference', 'duplicate',
                  'size', 'foreign-url', 'index-not-manifest', 'symlink', 'wrong-lock-platform')
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                lock, index, config, layer = oci_fixture(root)
                blob = root / 'blobs/sha256' / layer['digest'][7:]
                if fault == 'missing': blob.unlink()
                if fault == 'extra': (root / 'extra').write_bytes(b'not allowed')
                if fault == 'corrupt': blob.write_bytes(b'changed bytes')
                if fault == 'reference': index['manifests'][0]['annotations']['org.opencontainers.image.ref.name'] = 'tag:latest'
                if fault == 'duplicate': index['manifests'].append(index['manifests'][0])
                if fault == 'size': index['manifests'][0]['size'] += 1
                if fault == 'foreign-url': index['manifests'][0]['urls'] = ['https://registry.example/blob']
                if fault == 'index-not-manifest': index['manifests'][0]['mediaType'] = 'application/vnd.oci.image.index.v1+json'
                if fault == 'symlink':
                    data = blob.read_bytes(); blob.unlink()
                    other = root / 'outside'; other.write_bytes(data); blob.symlink_to(other)
                if fault == 'wrong-lock-platform': lock['db']['platform'] = 'linux/arm64'
                (root / 'index.json').write_bytes(encoded(index))
                with self.assertRaises(ValueError):
                    transport.verify(root, lock)

    def test_oci_root_entry_digest_must_equal_locked_reference_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lock, index, _, _ = oci_fixture(root)

            def blob(data, media):
                value = digest(data)
                (root / 'blobs/sha256' / value).write_bytes(data)
                return {'digest': 'sha256:' + value, 'size': len(data), 'mediaType': media}

            layer = blob(b'second complete image layer', 'application/vnd.oci.image.layer.v1.tar')
            config = blob(encoded({'os': 'linux', 'architecture': 'amd64',
                                   'rootfs': {'type': 'layers', 'diff_ids': [layer['digest']]}}),
                          'application/vnd.oci.image.config.v1+json')
            manifest = blob(encoded({'schemaVersion': 2, 'config': config, 'layers': [layer]}),
                            'application/vnd.oci.image.manifest.v1+json')
            entry = next(item for item in index['manifests']
                         if item['annotations']['org.opencontainers.image.ref.name'] == lock['db']['image'])
            entry.update(digest=manifest['digest'], size=manifest['size'])
            (root / 'index.json').write_bytes(encoded(index))
            with self.assertRaisesRegex(ValueError, 'Original repository digest lost'):
                transport.verify(root, lock)

    def test_packaging_compares_to_verified_pins_not_later_input_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            layout = root / 'layout'
            lock, _, _, layer = oci_fixture(layout)
            repo = root / 'repo/infra/selfhost'
            repo.mkdir(parents=True)
            (repo / 'images.qa.lock.json').write_bytes(encoded({'services': lock}))
            path = layout / 'blobs/sha256' / layer['digest'][7:]
            original = path.read_bytes()
            real_verify, calls = transport.verify, []
            def concurrent_edit(*args):
                if calls:
                    path.write_bytes(original)
                result = real_verify(*args)
                if not calls:
                    path.write_bytes(b'corrupt layer')
                calls.append(True)
                return result
            with patch.object(transport, 'ROOT', root / 'repo'), patch.object(transport, 'verify', side_effect=concurrent_edit):
                with self.assertRaisesRegex(ValueError, 'Packaged bytes differ'):
                    transport.prepare(layout, root / 'out')
            self.assertFalse((root / 'out/transport-analysis.json').exists())

    def test_inspect_synthetic_debs_and_node_retains_relationships_without_closure(self):
        for fault in (None, 'hash', 'symlink', 'identity', 'ar-layout', 'node-duplicate', 'node-missing', 'node-link'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                artifacts, lock = package_fixture(root, fault)
                # Only the production hard-coded archive pins differ in this fixture.
                # Real ar parsing, hashing, control identity and Node-member reading run.
                with patch.object(packages, 'ROOT', root / 'repo'), patch.object(packages, 'validate_lock') as validate:
                    if fault:
                        with self.assertRaises(ValueError): packages.inspect(artifacts, root / 'out')
                        self.assertFalse((root / 'out/package-analysis.json').exists())
                        continue
                    report = packages.inspect(artifacts, root / 'out')
                validate.assert_called_once_with(lock)
                self.assertEqual(report['status'], 'PINNED_ARCHIVE_ANALYSIS_ONLY')
                self.assertEqual(report['dependency_closure'], 'OPEN')
                self.assertIsNone(report['target_inventory'])
                self.assertIs(report['install_authorized'], False)
                self.assertIs(report['qa_ready'], False)
                self.assertIs(report['node']['executed'], False)
                self.assertEqual(report['node']['binary_sha256'], digest(b'synthetic ELF bytes; never executed'))
                self.assertEqual(report['node']['archive_sha256'], lock['node']['sha256'])
                self.assertEqual(report['lock_sha256'], digest(encoded(lock)))
                self.assertIn('--no-remove', report['no_download_plan_argv'])
                self.assertEqual([p['name'] for p in report['packages']], [p['name'] for p in lock['packages']])
                for item, pin in zip(report['packages'], lock['packages']):
                    self.assertEqual({k: item[k] for k in ('name', 'version', 'architecture', 'sha256')},
                                     {k: pin[k] for k in ('name', 'version', 'architecture', 'sha256')})
                    self.assertEqual(item['relationships'], {'Depends': 'libc6,\n libsystemd0', 'Pre-Depends': 'fixture-pre (>= 1)',
                                     'Provides': '', 'Conflicts': '', 'Breaks': '', 'Replaces': ''})
                    for name, value in item['control_files'].items():
                        self.assertEqual(digest((root / 'out' / item['name'] / name).read_bytes()), value)

    def test_runtime_source_plan_matches_gateway_writer_and_host_verifier(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / 'repo'
            shutil.copytree(source.ROOT / 'infra', repo / 'infra', ignore=shutil.ignore_patterns('__pycache__', 'tests'))
            runtime = root / 'runtime'
            template = runtime / 'volumes/api/envoy/lds.template.yaml'
            template.parent.mkdir(parents=True)
            data = b'header\n  inline_string: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"\nfooter\n'
            template.write_bytes(data)
            upstream_file = repo / 'infra/selfhost/upstream.lock.json'
            upstream = json.loads(upstream_file.read_bytes())
            upstream['files']['volumes/api/envoy/lds.template.yaml'] = digest(data)
            upstream_file.write_bytes(encoded(upstream))
            with chdir(runtime), patch.object(selfhost_pin, 'GATEWAY_TEMPLATE_SHA256', digest(data)):
                selfhost_pin.redact_gateway()
            generated = template.with_name('lds.qa.yaml')
            with patch.object(source, 'ROOT', repo):
                report = source.prepare('a' * 64, root / 'plan.json', runtime)
                self.assertEqual(report['derived_gateway']['sha256'], digest(generated.read_bytes()))
                with patch.object(replacement_host, 'safe_path', side_effect=lambda path, **kw: path):
                    replacement_host.check_source_tree({str(template): digest(data)}, runtime)
                    generated.write_text('unredacted')
                    with self.assertRaises(ValueError):
                        replacement_host.check_source_tree({str(template): digest(data)}, runtime)
                template.write_bytes(data + b'changed')
                with self.assertRaises(ValueError): source.prepare('a' * 64, root / 'bad.json', runtime)
                for bad in (b'no anchor', data + data):
                    template.write_bytes(bad)
                    upstream['files']['volumes/api/envoy/lds.template.yaml'] = digest(bad)
                    upstream_file.write_bytes(encoded(upstream))
                    with self.assertRaises(ValueError): source.prepare('a' * 64, root / 'bad.json', runtime)

    def test_oci_index_keys_and_annotations_are_unambiguous(self):
        faults = ('upper-url', 'extra-annotation', 'upper-manifests', 'duplicate-digest', 'case-digest',
                  'unknown-index-key', 'extra-platform-key', 'platform-alias', 'wrong-index-media', 'layout-version', 'root-platform')
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); lock, index, _, _ = oci_fixture(root)
                entry = index['manifests'][0]
                if fault == 'upper-url': entry['URLs'] = ['https://example.invalid/blob']
                if fault == 'extra-annotation': entry['annotations']['io.containerd.image.name'] = 'docker.io/library/caddy:latest'
                if fault == 'upper-manifests': index['Manifests'] = []
                if fault == 'unknown-index-key': index['unexpected'] = True
                if fault == 'extra-platform-key': entry['platform'] = {'os': 'linux', 'architecture': 'amd64', 'Architecture': 'arm64'}
                if fault == 'platform-alias': entry['platform'] = {'os': 'linux', 'architecture': 'x86_64'}
                if fault == 'root-platform': entry['platform'] = {'os': 'linux', 'architecture': 'arm64'}
                if fault == 'wrong-index-media': index['mediaType'] = next(iter(transport.MANIFESTS))
                if fault == 'layout-version': (root / 'oci-layout').write_bytes(encoded({'imageLayoutVersion': '2.0.0'}))
                data = encoded(index)
                if fault in ('duplicate-digest', 'case-digest'):
                    key = 'digest' if fault == 'duplicate-digest' else 'Digest'
                    needle = ('"digest":"' + entry['digest'] + '"').encode()
                    data = data.replace(needle, needle + b',"' + key.encode() + b'":"' + entry['digest'].encode() + b'"', 1)
                (root / 'index.json').write_bytes(data)
                with self.assertRaises(ValueError): transport.verify(root, lock)

    def test_oci_content_and_platform_negatives_are_hash_consistent(self):
        faults = ('mixed-shape', 'media-mismatch', 'config-platform', 'config-variant', 'diff-count', 'diff-format',
                  'empty-layers', 'layer-media', 'rootfs', 'duplicate-config-key', 'config-media-mismatch')
        for fault in faults:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); lock, index, _, layer = oci_fixture(root)
                def mutate(manifest, config):
                    if fault == 'mixed-shape': manifest['manifests'] = []
                    if fault == 'media-mismatch': manifest['mediaType'] = next(iter(transport.INDEXES))
                    if fault == 'config-media-mismatch': config['mediaType'] = 'application/vnd.oci.image.manifest.v1+json'
                    if fault == 'config-platform': config['architecture'] = 'arm64'
                    if fault == 'config-variant': config['variant'] = 'v3'
                    if fault == 'diff-count': config['rootfs']['diff_ids'] = []
                    if fault == 'diff-format': config['rootfs']['diff_ids'] = ['invalid']
                    if fault == 'empty-layers':
                        manifest['layers'] = []; config['rootfs']['diff_ids'] = []
                        (root / 'blobs/sha256' / layer['digest'][7:]).unlink()
                    if fault == 'layer-media': manifest['layers'][0]['mediaType'] = 'application/vnd.oci.image.config.v1+json'
                    if fault == 'rootfs': config['rootfs']['type'] = 'other'
                    if fault == 'duplicate-config-key': config['Architecture'] = 'amd64'
                rewrite_image(root, lock, index, mutate)
                with self.assertRaises(ValueError): transport.verify(root, lock)

    def test_index_content_shape_media_and_alias_child(self):
        for fault in ('mixed', 'media', 'alias', 'child-name', 'annotation-type'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); lock, index, _, _ = oci_fixture(root)
                child = {k: v for k, v in index['manifests'][0].items() if k != 'annotations'}
                child['platform'] = {'os': 'linux', 'architecture': 'amd64'}
                parent = {'schemaVersion': 2, 'manifests': [child]}
                if fault == 'mixed': parent.update(config={}, layers=[])
                if fault == 'media': parent['mediaType'] = next(iter(transport.MANIFESTS))
                if fault == 'child-name': child['annotations'] = {'io.containerd.image.name': 'caddy:latest'}
                if fault == 'annotation-type': child['annotations'] = {'org.opencontainers.image.version': ['bad']}
                if fault == 'alias': parent['manifests'].append({**child, 'platform': {'os': 'linux', 'architecture': 'x86_64'}})
                data = encoded(parent); value = digest(data)
                (root / 'blobs/sha256' / value).write_bytes(data)
                for name, entry in zip(lock, index['manifests']):
                    lock[name]['image'] = name + '@sha256:' + value
                    entry.update(digest='sha256:' + value, size=len(data), mediaType='application/vnd.oci.image.index.v1+json')
                    entry['annotations']['org.opencontainers.image.ref.name'] = lock[name]['image']
                (root / 'index.json').write_bytes(encoded(index))
                with self.assertRaises(ValueError): transport.verify(root, lock)

    def test_packaging_refuses_input_change_after_archive_closes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); layout = root / 'layout'
            lock, _, _, layer = oci_fixture(layout)
            repo = root / 'repo/infra/selfhost'; repo.mkdir(parents=True)
            (repo / 'images.qa.lock.json').write_bytes(encoded({'services': lock}))
            original_open = tarfile.open
            @contextmanager
            def altered_after_close(*args, **kwargs):
                with original_open(*args, **kwargs) as archive:
                    yield archive
                if kwargs.get('mode') == 'w':
                    (layout / 'blobs/sha256' / layer['digest'][7:]).write_bytes(b'changed after packaging')
            with patch.object(transport, 'ROOT', root / 'repo'), patch.object(transport.tarfile, 'open', side_effect=altered_after_close):
                with self.assertRaises(ValueError): transport.prepare(layout, root / 'out')
            self.assertFalse((root / 'out/transport-analysis.json').exists())

    def test_archive_determinism_and_exact_twelve_service_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); layout = root / 'layout'
            lock, _, _, _ = oci_fixture(layout)
            repo = root / 'repo/infra/selfhost'; repo.mkdir(parents=True)
            lock_path = repo / 'images.qa.lock.json'; lock_path.write_bytes(encoded({'services': lock}))
            with patch.object(transport, 'ROOT', root / 'repo'):
                first = transport.prepare(layout, root / 'first')
                for file in layout.rglob('*'): os.utime(file, (1700000000, 1700000000))
                second = transport.prepare(layout, root / 'second')
                self.assertEqual(first['archive_sha256'], second['archive_sha256'])
                with tarfile.open(root / 'first/images.oci.tar') as tar:
                    self.assertTrue(all(m.mtime == 0 and m.uid == 0 and m.gid == 0 for m in tar))
                del lock['functions']
                # Keep index and lock internally consistent: only prepare's service-set check can refuse.
                index = json.loads((layout / 'index.json').read_bytes())
                index['manifests'] = [e for e in index['manifests'] if not e['annotations']['org.opencontainers.image.ref.name'].startswith('functions@')]
                (layout / 'index.json').write_bytes(encoded(index))
                lock_path.write_bytes(encoded({'services': lock}))
                with self.assertRaises(ValueError): transport.prepare(layout, root / 'wrong')


if __name__ == '__main__':
    unittest.main()
