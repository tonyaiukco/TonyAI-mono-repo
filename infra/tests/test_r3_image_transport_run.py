"""Fixture proof only: fake registry, fake Engine/ctr and a loopback resolver.

No Docker, containerd, namespace, registry or network is used. These tests cannot
qualify transport; they prove the fail-closed order and every readback check.
"""
import io
import json
import os
from pathlib import Path
import socket
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse
import urllib.request
import subprocess

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_image_acquire as acquire
import r3_image_import as imp
import r3_image_qualify as qualify
import r3_image_transport as transport
from replacement_bundle import digest, encoded

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
INDEX = 'application/vnd.oci.image.index.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYER = 'application/vnd.oci.image.layer.v1.tar'
SERVICES = sorted(transport.ACTIVE | {'caddy', 'functions', 'supavisor'})
TOKEN = 'fixture-token'


def described(objects, data, media):
    value = 'sha256:' + digest(data)
    objects[value] = (data, media)
    return {'mediaType': media, 'digest': value, 'size': len(data)}


def catalogue(*, index_service='realtime', extra_amd64=False):
    """Twelve distinct fixture images; one root is a multi-platform index."""
    objects, lock = {}, {}
    for service in SERVICES:
        layer = described(objects, b'layer for ' + service.encode(), LAYER)
        config = described(objects, encoded({'os': 'linux', 'architecture': 'amd64',
                                              'rootfs': {'type': 'layers', 'diff_ids': [layer['digest']]}}), CONFIG)
        root = manifest = described(objects, encoded({'schemaVersion': 2, 'mediaType': MANIFEST,
                                                      'config': config, 'layers': [layer]}), MANIFEST)
        if service == index_service:
            children = [{**manifest, 'platform': {'os': 'linux', 'architecture': 'amd64'}},
                        {'mediaType': MANIFEST, 'digest': 'sha256:' + 'b' * 64, 'size': 7,
                         'platform': {'os': 'linux', 'architecture': 'arm64'}}]
            if extra_amd64:
                children.append({**children[0], 'digest': 'sha256:' + 'c' * 64})
            root = described(objects, encoded({'schemaVersion': 2, 'mediaType': INDEX, 'manifests': children}), INDEX)
        lock[service] = {'image': 'fixture/' + service + '@' + root['digest'], 'platform': 'linux/amd64'}
    return lock, objects


class Response(io.BytesIO):
    def __init__(self, data, media, url):
        super().__init__(data)
        self.headers, self.url = {'Content-Type': media}, url


class Registry:
    def __init__(self, objects, tamper=None):
        self.objects, self.tamper, self.authorized = objects, tamper, []

    def open(self, request, timeout):
        url = request.full_url
        if url.startswith(acquire.AUTH):
            token = None if self.tamper == 'token' else TOKEN
            return Response(json.dumps({'token': token}).encode(), 'application/json', url)
        if self.tamper == 'http-final':
            url = 'http' + url[5:]
        self.authorized.append(request.unredirected_hdrs.get('Authorization') == 'Bearer ' + TOKEN
                               and 'Authorization' not in request.headers)
        kind, value = urllib.parse.urlsplit(url).path.rsplit('/', 2)[-2:]
        data, media = self.objects[value]
        if self.tamper == (kind, media) and kind == 'blobs':
            data = data[:-1] + bytes([data[-1] ^ 1])  # Same size: only the digest can catch it.
        elif self.tamper == (kind, media):
            # Another valid manifest: parses and has the right type, only its digest differs.
            data = next(d for k, (d, m) in sorted(self.objects.items()) if m == media and k != value)
        if kind == 'blobs' and self.tamper == 'long-blob' and media == LAYER:
            data += b'x'
        if kind == 'blobs':
            return Response(data, 'application/octet-stream', 'https://cdn.fixture.invalid/' + value)
        if self.tamper == 'content-type' and media == MANIFEST and request.headers.get('Accept') == acquire.ACCEPT:
            media = 'application/vnd.docker.distribution.manifest.v2+json'  # Body still says OCI.
        return Response(data, media, url)


def resolve(host, port, type=None):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('192.0.2.10', port))]


def selfhost_repo(root, lock, objects):
    """A repository copy whose pins are the fixture images."""
    selfhost = root / 'repo/infra/selfhost'
    selfhost.mkdir(parents=True)
    (selfhost / 'images.qa.lock.json').write_bytes(encoded({'services': lock}))
    (selfhost / 'daemon.r02.json').write_bytes((ROOT / 'infra/selfhost/daemon.r02.json').read_bytes())
    db_config = json.loads(objects[lock['db']['image'].split('@')[1]][0])['config']['digest']
    (selfhost / 'database-image-policy.json').write_bytes(encoded({'image': lock['db']['image'], 'config_digest': db_config}))
    packages, debs = [], root / 'debs'
    debs.mkdir()
    for name in imp.MEMBERS:
        data = b'fixture package ' + name.encode()
        (debs / (name + '.deb')).write_bytes(data)
        packages.append({'name': name, 'url': 'https://fixture.invalid/' + name + '.deb', 'sha256': digest(data)})
    (selfhost / 'r3-toolchain.lock.json').write_bytes(encoded({'packages': packages}))
    return root / 'repo', debs


def prepared(root, **options):
    lock, objects = catalogue(**options)
    repo, debs = selfhost_repo(root, lock, objects)
    acquire.acquire(lock, root / 'layout', acquire.Client(Registry(objects)), resolve)
    with patch.object(transport, 'ROOT', repo):
        transport.prepare(root / 'layout', root / 'transport')
    request = {'work': str(root / 'work'), 'run_dir': str(root / 'run'),
               'archive': str(root / 'transport/images.oci.tar'),
               'analysis': str(root / 'transport/transport-analysis.json'),
               'analysis_sha256': imp.file_hash(root / 'transport/transport-analysis.json'),
               'packages': str(debs), 'endpoints': {'registry-1.docker.io': ['192.0.2.10']}, 'owner': [1000, 1000]}
    return lock, objects, repo, request


def query(name, qid=0x1234, kind=1):
    labels = b''.join(bytes([len(part)]) + part.encode() for part in name.split('.'))
    return qid.to_bytes(2, 'big') + b'\x01\x00\x00\x01' + b'\0' * 6 + labels + b'\0' + kind.to_bytes(2, 'big') + b'\x00\x01'


class AcquisitionTests(unittest.TestCase):
    def test_layout_is_exactly_the_locked_amd64_closure_and_verifies(self):
        with tempfile.TemporaryDirectory() as temp:
            lock, objects = catalogue()
            registry = Registry(objects)
            receipt = acquire.acquire(lock, Path(temp) / 'layout', acquire.Client(registry), resolve)
            images, names, _ = transport.verify(Path(temp) / 'layout', lock)
            self.assertEqual(set(images), set(SERVICES))
            self.assertNotIn('blobs/sha256/' + 'b' * 64, names)  # arm64 child never fetched
            self.assertEqual(receipt['images']['realtime']['root'], lock['realtime']['image'].split('@')[1])
            self.assertIn('platform_manifest', receipt['images']['realtime'])
            self.assertEqual(receipt['endpoints'], {h: ['192.0.2.10'] for h in
                                                    ('auth.docker.io', 'cdn.fixture.invalid', 'registry-1.docker.io')})
            self.assertTrue(registry.authorized and all(registry.authorized))
            self.assertFalse(list((Path(temp) / 'layout').rglob('*.partial')))

    def test_changed_bytes_types_and_ambiguous_platforms_refuse(self):
        for tamper in (('manifests', MANIFEST), ('blobs', LAYER), ('blobs', CONFIG), 'content-type'):
            with self.subTest(tamper=tamper), tempfile.TemporaryDirectory() as temp:
                lock, objects = catalogue()
                with self.assertRaises(ValueError):
                    acquire.acquire(lock, Path(temp) / 'layout', acquire.Client(Registry(objects, tamper)), resolve)
        with tempfile.TemporaryDirectory() as temp:
            lock, objects = catalogue(extra_amd64=True)
            with self.assertRaisesRegex(ValueError, 'unambiguous'):
                acquire.acquire(lock, Path(temp) / 'layout', acquire.Client(Registry(objects)), resolve)

    def test_references_are_docker_hub_digests_only(self):
        value = 'sha256:' + 'a' * 64
        self.assertEqual(acquire.canonical('caddy@' + value), 'docker.io/library/caddy@' + value)
        self.assertEqual(acquire.canonical('supabase/gotrue@' + value), 'docker.io/supabase/gotrue@' + value)
        for image in ('supabase/gotrue:latest', 'localhost/foo@' + value, 'ghcr.io/x/y@' + value, 'registry.example/x@' + value,
                      'a/b/c@' + value, 'Supabase/gotrue@' + value, 'supabase/gotrue@sha256:abc'):
            with self.subTest(image=image), self.assertRaises(ValueError):
                acquire.repository(image)
        lock, objects = catalogue()
        lock['db'] = {**lock['db'], 'platform': 'linux/arm64'}
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(ValueError, 'linux/amd64'):
            acquire.acquire(lock, Path(temp) / 'layout', acquire.Client(Registry(objects)), resolve)

    def test_registry_attacks_refuse_with_their_own_reason(self):
        def rebuild(objects, lock, edit_manifest=None, edit_child=None):
            """Re-describe realtime's manifest and index after an edit, keeping digests honest."""
            index = json.loads(objects[lock['realtime']['image'].split('@')[1]][0])
            child = index['manifests'][0]
            manifest = json.loads(objects[child['digest']][0])
            if edit_manifest:
                edit_manifest(manifest)
                child.update(described(objects, encoded(manifest), MANIFEST))
            if edit_child:
                edit_child(child)
            root = described(objects, encoded(index), INDEX)
            lock['realtime'] = {**lock['realtime'], 'image': 'fixture/realtime@' + root['digest']}
        cases = {
            'token': ({'tamper': 'token'}, 'token refused'),
            'http-final': ({'tamper': 'http-final'}, 'Insecure registry response'),
            'long-blob': ({'tamper': 'long-blob'}, 'exceeds descriptor size'),
            'child-size': ({'child': lambda c: c.update(size=c['size'] + 1)}, 'manifest size differs'),
            'child-type': ({'child': lambda c: c.update(mediaType='application/vnd.docker.distribution.manifest.v2+json')},
                           'descriptor type differs'),
            'nested-index': ({'child': lambda c: c.update(mediaType=INDEX)}, 'Nested platform index'),
            'layer-urls': ({'manifest': lambda m: m['layers'][0].update(urls=['https://foreign.invalid/l'])},
                           'Unsupported blob descriptor'),
            'config-size': ({'manifest': lambda m: m['config'].update(size=acquire.DOCUMENT_LIMIT + 1)},
                            'Config descriptor too large'),
            'budget': ({'limit': ('TOTAL_LIMIT', 10)}, 'total limit'),
            'document-limit': ({'limit': ('DOCUMENT_LIMIT', 10)}, 'document limit')}
        for name, (fault, message) in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                lock, objects = catalogue()
                rebuild(objects, lock, fault.get('manifest'), fault.get('child'))
                limit = fault.get('limit', ('BLOB_LIMIT', acquire.BLOB_LIMIT))
                with patch.object(acquire, limit[0], limit[1]), self.assertRaisesRegex(ValueError, message):
                    acquire.acquire(lock, Path(temp) / 'layout', acquire.Client(Registry(objects, fault.get('tamper'))), resolve)

    def test_an_existing_blob_is_never_silently_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            layout = Path(temp)
            (layout / 'blobs/sha256').mkdir(parents=True)
            acquire.store(layout, b'kept')
            acquire.store(layout, b'kept')
            (layout / 'blobs/sha256' / digest(b'kept')).write_bytes(b'swapped')
            with self.assertRaisesRegex(ValueError, 'Existing blob differs'):
                acquire.store(layout, b'kept')

    def test_requests_identify_themselves(self):
        seen = []
        class Opener:
            def open(self, request, timeout):
                seen.append(request.headers.get('User-agent'))
                return Response(b'{}', 'application/json', request.full_url)
        acquire.Client(Opener()).open('https://registry-1.docker.io/v2/')
        self.assertEqual(seen, ['tonyai-r3-acquire/1'])

    def test_insecure_redirect_is_refused(self):
        handler = acquire.HTTPSRedirect()
        request = urllib.request.Request('https://registry-1.docker.io/v2/x/blobs/y')
        with self.assertRaisesRegex(ValueError, 'Insecure'):
            handler.redirect_request(request, None, 307, 'redirect', {}, 'http://cdn.invalid/blob')



class CheckTests(unittest.TestCase):
    LINKS = [{'ifname': 'lo', 'link_type': 'loopback'}]
    ADDRESSES = [{'ifname': 'lo', 'addr_info': [{'local': '127.0.0.1'}, {'local': '::1'}]}]
    ROUTES = [{'type': 'local', 'dst': '127.0.0.0/8', 'dev': 'lo'}, {'type': 'broadcast', 'dst': '127.255.255.255', 'dev': 'lo'},
              {'dst': '::1', 'dev': 'lo', 'protocol': 'kernel'}, {'type': 'multicast', 'dst': 'ff00::/8', 'dev': 'lo'}]

    def test_namespace_is_loopback_only(self):
        self.assertEqual(imp.check_namespace(self.LINKS, self.ADDRESSES, self.ROUTES, 2, 1)['links'], ['lo'])
        # Reject-type routes carry no packet; a kernel that dumps one must not refuse a good run.
        rejects = [{'type': kind, 'dst': 'default'} for kind in ('unreachable', 'prohibit', 'blackhole')]
        self.assertEqual(imp.check_namespace(self.LINKS, self.ADDRESSES, self.ROUTES + rejects, 2, 1)['links'], ['lo'])
        faults = {
            'host-namespace': (self.LINKS, self.ADDRESSES, self.ROUTES, 1, 1),
            'uplink': (self.LINKS + [{'ifname': 'eth0', 'link_type': 'ether'}], self.ADDRESSES, self.ROUTES, 2, 1),
            'dummy': (self.LINKS + [{'ifname': 'd0', 'link_type': 'ether'}], self.ADDRESSES, self.ROUTES, 2, 1),
            'address': (self.LINKS, [{'addr_info': [{'local': '10.0.0.2'}]}], self.ROUTES, 2, 1),
            'default': (self.LINKS, self.ADDRESSES, self.ROUTES + [{'dst': 'default', 'dev': 'lo'}], 2, 1),
            'gateway': (self.LINKS, self.ADDRESSES, self.ROUTES + [{'dst': '10.0.0.0/8', 'dev': 'lo', 'gateway': '10.0.0.1'}], 2, 1),
            'device': (self.LINKS, self.ADDRESSES, self.ROUTES + [{'dst': '10.0.0.0/8', 'dev': 'eth0'}], 2, 1),
            'reject-via-gateway': (self.LINKS, self.ADDRESSES, self.ROUTES + [{'type': 'unreachable', 'dst': 'default', 'gateway': '10.0.0.1'}], 2, 1)}
        for name, arguments in faults.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                imp.check_namespace(*arguments)

    def test_resolver_files_must_be_the_staged_bind_even_through_a_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'netns').mkdir()
            (root / 'run').mkdir()
            (root / 'etc').mkdir()
            staged = root / 'netns/resolv.conf'
            staged.write_bytes(imp.RESOLV_CONF)
            os.link(staged, root / 'run/stub-resolv.conf')  # A bind mount shows the staged inode.
            (root / 'etc/resolv.conf').symlink_to('../run/stub-resolv.conf')
            seen = imp.check_resolver_file(str(root / 'etc/resolv.conf'), str(staged), imp.RESOLV_CONF)
            self.assertEqual(seen['target'], os.path.realpath(root / 'run/stub-resolv.conf'))
            (root / 'etc/hosts').write_bytes(imp.HOSTS)  # Same bytes, not the staged file.
            (root / 'netns/hosts').write_bytes(imp.HOSTS)
            with self.assertRaisesRegex(ValueError, 'bind mount'):
                imp.check_resolver_file(str(root / 'etc/hosts'), str(root / 'netns/hosts'), imp.HOSTS)
            with self.assertRaisesRegex(ValueError, 'differ'):
                imp.check_resolver_file(str(root / 'etc/resolv.conf'), str(staged), imp.HOSTS)

    def test_resolver_answers_refused_and_records_windows(self):
        resolver = imp.Resolver('127.0.0.1', 0)
        try:
            resolver.window = 'probe-name'
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                udp.settimeout(5)
                udp.sendto(query('registry-1.docker.io'), resolver.address)
                reply = udp.recv(512)
            self.assertEqual((reply[:2], reply[2] & 0x80, reply[3] & 0x0f), (b'\x12\x34', 0x80, 5))
            self.assertEqual(reply[12:], query('registry-1.docker.io')[12:])
            resolver.window = 'none'
            with socket.create_connection(resolver.address, timeout=5) as tcp:
                packet = query('Auth.Docker.IO', kind=28)
                tcp.sendall(len(packet).to_bytes(2, 'big') + packet)
                size = int.from_bytes(tcp.recv(2), 'big')
                self.assertEqual(tcp.recv(size)[3] & 0x0f, 5)
            log = resolver.snapshot()
            self.assertEqual([(r['window'], r['transport'], r['name'], r['type']) for r in log],
                             [('probe-name', 'udp', 'registry-1.docker.io', 1), ('none', 'tcp', 'auth.docker.io', 28)])
            self.assertEqual(imp.dns_violations(log), [log[1]])
        finally:
            resolver.close()

    def test_malformed_questions_are_recorded_and_refused(self):
        for packet in (b'\x00\x01', query('x')[:-3], query('a' * 64), b'\x00' * 12):
            with self.subTest(packet=packet):
                with self.assertRaises(ValueError):
                    imp.question(packet)
                self.assertEqual(imp.refused(packet)[3] if len(packet) > 2 else 5, 5)

    def store(self, **changes):
        info = {'Driver': 'overlayfs', 'DriverStatus': [['driver-type', 'io.containerd.snapshotter.v1']],
                'RegistryConfig': {'Mirrors': []}, 'HttpProxy': '', 'HttpsProxy': '', 'Images': 0, 'Containers': 0}
        values = {'info': info, 'images': [], 'containers': [], 'volumes': [], 'content': [], 'names': []}
        for key, value in changes.items():
            if key in info:
                info[key] = value
            else:
                values[key] = value
        return values

    def test_empty_store_requires_containerd_store_and_nothing_present(self):
        self.assertEqual(imp.check_store(**self.store()), {'images': 0, 'content': 0})
        for change in ({'Driver': 'overlay2', 'DriverStatus': [['Backing Filesystem', 'extfs']]},
                       {'DriverStatus': []}, {'Mirrors': None, 'RegistryConfig': {'Mirrors': ['https://m.invalid']}},
                       {'HttpsProxy': 'http://proxy.invalid'}, {'Images': 1}, {'Containers': 1},
                       {'images': [{'ID': 'x'}]}, {'content': ['sha256:x']}, {'names': ['x']},
                       {'containers': ['c']}, {'volumes': ['v']}):
            change.pop('Mirrors', None)
            with self.subTest(change=change), self.assertRaises(ValueError):
                imp.check_store(**self.store(**change))

    def test_populated_store_must_equal_the_nine_roots_names_and_closure(self):
        expected = {'images': {'db': {'id': 'sha256:1', 'name': 'docker.io/f/db@sha256:1'}}, 'blobs': ['sha256:1', 'sha256:2']}
        good = self.store(Images=1, images=[{'ID': 'sha256:1'}], content=['sha256:2', 'sha256:1'],
                          names=['docker.io/f/db@sha256:1'])
        self.assertEqual(imp.check_store(**good, expected=expected), {'images': 1, 'content': 2})
        for change in ({'images': [{'ID': 'sha256:1'}, {'ID': 'sha256:9'}]}, {'images': [{'ID': 'sha256:9'}]},
                       {'content': ['sha256:1']}, {'content': ['sha256:1', 'sha256:2', 'sha256:3']},
                       {'names': ['f/db@sha256:1']}, {'names': ['docker.io/f/db@sha256:1', 'docker.io/f/db:latest']}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                imp.check_store(**{**good, **change}, expected=expected)

    ITEM = {'image': 'fixture/db@sha256:' + 'a' * 64, 'id': 'sha256:' + 'a' * 64, 'media_type': MANIFEST,
            'size': 10, 'config': 'sha256:' + 'c' * 64, 'diff_ids': ['sha256:' + 'd' * 64]}

    def inspect(self, **changes):
        image = {'Id': self.ITEM['id'], 'Descriptor': {'digest': self.ITEM['id'], 'mediaType': MANIFEST, 'size': 10},
                 'RepoDigests': [self.ITEM['image']], 'RepoTags': [], 'Os': 'linux', 'Architecture': 'amd64',
                 'RootFS': {'Type': 'layers', 'Layers': self.ITEM['diff_ids']}}
        image.update(changes)
        return [image]

    def test_image_readback_binds_target_repo_digest_platform_and_diff_ids(self):
        self.assertEqual(imp.check_image(self.inspect(), self.ITEM)['repo_digests'], [self.ITEM['image']])
        for change in ({'Id': self.ITEM['config']}, {'Descriptor': {}}, {'Descriptor': {'digest': self.ITEM['id'], 'mediaType': INDEX, 'size': 10}},
                       {'Descriptor': {'digest': self.ITEM['id'], 'mediaType': MANIFEST, 'size': 11}},
                       {'RepoDigests': []}, {'RepoDigests': [self.ITEM['image'], 'other/db@' + self.ITEM['id']]},
                       {'RepoTags': ['fixture/db:latest']}, {'Architecture': 'arm64'}, {'Variant': 'v8'},
                       {'RootFS': {'Type': 'layers', 'Layers': []}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                imp.check_image(self.inspect(**change), self.ITEM)
        with self.assertRaises(ValueError):
            imp.check_image(self.inspect() * 2, self.ITEM)

    def test_created_container_was_never_started(self):
        container = {'Name': '/tonyai-r3-transport-db', 'Image': self.ITEM['id'], 'Config': {'Image': self.ITEM['image']},
                     'State': {'Status': 'created', 'Running': False, 'Pid': 0, 'StartedAt': '0001-01-01T00:00:00Z'}}
        self.assertFalse(imp.check_created(container, self.ITEM, 'tonyai-r3-transport-db')['started'])
        for key, value in (('Status', 'running'), ('Running', True), ('Pid', 42), ('StartedAt', '2026-10-25T00:00:00Z')):
            changed = {**container, 'State': {**container['State'], key: value}}
            with self.subTest(key=key), self.assertRaises(ValueError):
                imp.check_created(changed, self.ITEM, 'tonyai-r3-transport-db')
        for change in ({'Image': 'sha256:' + 'c' * 64}, {'Name': '/other'}, {'Config': {'Image': 'fixture/db:latest'}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                imp.check_created({**container, **change}, self.ITEM, 'tonyai-r3-transport-db')


class ArchiveTests(unittest.TestCase):
    def test_extract_subset_and_load_archive_carry_only_the_nine_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock, objects, repo, request = prepared(root)
            analysis = json.loads(Path(request['analysis']).read_bytes())
            imp.safe_extract(Path(request['archive']), root / 'extracted')
            self.assertEqual(transport.verify(root / 'extracted', lock)[0], analysis['images'])
            roots, blobs, names = imp.subset(root / 'extracted', root / 'nine', lock, analysis)
            self.assertEqual(len(roots), 9)
            inactive = {analysis['images'][s][k] for s in ('caddy', 'functions', 'supavisor')
                        for k in ('config_digest', 'platform_manifest_digest')}
            self.assertFalse(inactive & set(blobs))
            index = imp.load_archive(root / 'nine.oci.tar', roots, root / 'nine', names)
            with tarfile.open(root / 'nine.oci.tar') as tar:
                members = {m.name: tar.extractfile(m).read() for m in tar}
            self.assertEqual(set(members), names)
            for name, data in members.items():
                if name != 'index.json':
                    self.assertEqual(data, (root / 'nine' / name).read_bytes())
            self.assertEqual(json.loads(members['index.json']), index)
            for entry in index['manifests']:
                ref = entry['annotations']['org.opencontainers.image.ref.name']
                self.assertEqual(entry['annotations'], {'org.opencontainers.image.ref.name': ref,
                                                        'io.containerd.image.name': acquire.canonical(ref)})
                self.assertEqual(ref.split('@')[1], entry['digest'])
            documents = imp.closure_documents(root / 'extracted', analysis)
            self.assertEqual(documents['realtime']['root_media_type'], INDEX)
            expected = imp.expected_images(lock, analysis, documents)
            self.assertEqual(set(expected), transport.ACTIVE)

    def test_extraction_refuses_links_traversal_extras_and_duplicates(self):
        def archive(path, members):
            with tarfile.open(path, 'w') as tar:
                for name, kind in members:
                    info = tarfile.TarInfo(name)
                    info.type, info.size = kind, 0 if kind != tarfile.REGTYPE else 1
                    info.linkname = 'index.json' if kind != tarfile.REGTYPE else ''
                    tar.addfile(info, io.BytesIO(b'x') if kind == tarfile.REGTYPE else None)
        cases = {'symlink': [('index.json', tarfile.SYMTYPE)],
                 'hardlink': [('index.json', tarfile.REGTYPE), ('oci-layout', tarfile.LNKTYPE)],
                 'traversal': [('../index.json', tarfile.REGTYPE)], 'extra': [('extra.json', tarfile.REGTYPE)],
                 'suffix': [('index.jsonx', tarfile.REGTYPE)],
                 'duplicate': [('index.json', tarfile.REGTYPE), ('index.json', tarfile.REGTYPE)],
                 'nested': [('blobs/sha256/' + 'a' * 64 + '/x', tarfile.REGTYPE)]}
        for name, members in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                archive(Path(temp) / 'a.tar', members)
                with self.assertRaises(ValueError):
                    imp.safe_extract(Path(temp) / 'a.tar', Path(temp) / 'out')


class FakeProcess:
    def __init__(self, name, killed=False):
        self.name, self.pid, self.returncode, self.killed = name, 4000 + len(name), None, killed

    def poll(self):
        return self.returncode

    def send_signal(self, _):
        if not self.killed:
            self.returncode = 0

    def wait(self, timeout=None):
        if self.returncode is None:
            raise imp.subprocess.TimeoutExpired('fake', timeout)
        return self.returncode

    def kill(self):
        self.returncode = -9


class FakeResolver:
    def __init__(self):
        self.window, self.log = 'none', []

    def snapshot(self):
        return list(self.log)

    def close(self):
        pass


class FakeSession(imp.Session):
    """Simulates the pinned Engine/ctr against the real fixture archive bytes."""

    def __init__(self, request, evidence, **faults):
        super().__init__(request, evidence)
        self.faults, self.calls = faults, []
        self.images, self.content, self.containers = {}, {}, {}
        self.processes = {}

    def command(self, argv, label, timeout=300, limit=0):
        self.calls.append(label)
        tool = Path(argv[0]).name
        if tool == 'ip':
            return self.ip(argv)
        if tool == 'ctr':
            return self.ctr_fake(argv[5:])
        if tool == 'docker':
            return self.docker_fake(argv[5:])
        raise AssertionError(argv)

    def ip(self, argv):
        if 'link' in argv:
            links = list(CheckTests.LINKS)
            if self.faults.get('uplink'):
                links.append({'ifname': 'eth0', 'link_type': 'ether'})
            return json.dumps(links).encode()
        if 'address' in argv:
            return json.dumps(CheckTests.ADDRESSES).encode()
        return json.dumps(CheckTests.ROUTES[:2] if '-4' in argv else CheckTests.ROUTES[2:]).encode()

    def ctr_fake(self, args):
        if args == ['version']:
            return b'fixture containerd\n'
        if args == ['content', 'ls', '--quiet']:
            return '\n'.join(sorted(self.content)).encode()
        if args == ['images', 'ls', '--quiet']:
            return '\n'.join(sorted(self.images)).encode()
        if args[:2] == ['content', 'get']:
            data = self.content[args[2]]
            kind = self.faults.get('content_tamper')
            children = {c['digest'] for d in self.content.values() if b'"manifests"' in d
                        for c in json.loads(d)['manifests']}
            if ((kind is True and b'rootfs' in data) or (kind == 'root' and args[2] in self.images.values())
                    or (kind == 'child' and args[2] in children)):
                return data + b' '
            return data
        raise AssertionError(args)

    def lookup(self, ref):
        name = acquire.canonical(ref)
        if self.faults.get('excluded_inspectable') and ref.split('/')[1].split('@')[0] == 'caddy':
            return next(iter(self.images.values()))
        if name not in self.images:
            raise ValueError('No such image')
        return self.images[name]

    def docker_fake(self, args):
        if args[0] == 'version':
            return encoded({'Client': {'Version': '29.9.1'},
                            'Server': {'Version': self.faults.get('engine', '29.9.1'),
                                       'Components': [{'Name': 'containerd', 'Version': 'v2.4.2'}]}})
        if args[0] == 'info':
            return encoded({'Driver': 'overlayfs', 'DriverStatus': [['driver-type', 'io.containerd.snapshotter.v1']],
                            'RegistryConfig': {'Mirrors': []}, 'HttpProxy': '', 'HttpsProxy': '',
                            'Images': len(self.images), 'Containers': len(self.containers)})
        if args[:2] == ['image', 'ls']:
            return '\n'.join(json.dumps({'ID': root}) for root in sorted(self.images.values())).encode()
        if args[:2] == ['container', 'ls']:
            return '\n'.join(self.containers).encode()
        if args[:2] == ['volume', 'ls']:
            return b''
        if args[0] == 'pull':
            self.resolver.log.append({'window': self.resolver.window, 'name': 'registry-1.docker.io'})
            if self.faults.get('pull_succeeds'):
                return b'pulled'
            if self.faults.get('pull_timeout'):
                raise TimeoutError('Fixture command deadline')
            raise ValueError('denied')
        if args[0] == 'load':
            with tarfile.open(args[-1]) as tar:
                members = {m.name: tar.extractfile(m).read() for m in tar}
            for name, data in members.items():
                if name.startswith('blobs/'):
                    self.content['sha256:' + name.rsplit('/', 1)[1]] = data
            for entry in json.loads(members['index.json'])['manifests']:
                self.images[entry['annotations']['io.containerd.image.name']] = entry['digest']
            if self.faults.get('inactive_present'):
                caddy = json.loads((Path(self.request['analysis'])).read_bytes())['images']['caddy']['image']
                self.images[acquire.canonical(caddy)] = 'sha256:' + 'e' * 64
            if self.faults.get('dns_leak'):
                self.resolver.log.append({'window': self.resolver.window, 'name': 'registry-1.docker.io'})
            return b'Loaded'
        if args[:2] == ['image', 'inspect']:
            root = self.lookup(args[2])
            document = json.loads(self.content[root])
            if document.get('mediaType') == INDEX:
                document = json.loads(self.content[document['manifests'][0]['digest']])
            config = json.loads(self.content[document['config']['digest']])
            return encoded([{'Id': root, 'Descriptor': {'digest': root, 'mediaType': json.loads(self.content[root])['mediaType'],
                                                        'size': len(self.content[root])},
                             'RepoDigests': [name.removeprefix('docker.io/').removeprefix('library/')
                                             for name, target in self.images.items() if target == root],
                             'RepoTags': ['x:latest'] if self.faults.get('tag') else [],
                             'Os': 'linux', 'Architecture': 'amd64',
                             'RootFS': {'Type': 'layers', 'Layers': config['rootfs']['diff_ids']}}])
        if args[0] == 'create':
            if args[1:3] != ['--pull', 'never']:
                raise AssertionError('create must never pull')
            root = self.lookup(args[-1])
            identifier = format(len(self.containers) + 1, '064x')
            self.containers[identifier] = {'Name': '/' + args[args.index('--name') + 1], 'Image': root,
                                           'Config': {'Image': args[-1]},
                                           'State': {'Status': 'created', 'Running': False, 'Pid': 0,
                                                     'StartedAt': '2026-10-25T00:00:00Z' if self.faults.get('started')
                                                     else '0001-01-01T00:00:00Z'}}
            return identifier.encode() + b'\n'
        if args[:2] == ['container', 'inspect']:
            return encoded([self.containers[args[2]]])
        if args[:2] == ['container', 'rm']:
            del self.containers[args[-1]]
            return b''
        raise AssertionError(args)

    def spawn(self, argv, label, env):
        self.calls.append('spawn-' + label)
        self.assertion_env = env
        process = FakeProcess(label, killed=self.faults.get('stop_killed') and label == 'dockerd')
        self.processes[process.pid] = label
        return process

    def probe_name(self, name):
        if not self.faults.get('unobserved'):
            self.resolver.log.append({'window': self.resolver.window, 'name': name})
        return {'name': name, 'resolved': bool(self.faults.get('resolves')), 'error': -3}

    def probe_address(self, address):
        if self.faults.get('connects'):
            return {'address': address, 'connected': True}
        return {'address': address, 'connected': False, 'errno': 111 if self.faults.get('refused_errno') else 101}

    def start_resolver(self):
        return FakeResolver()

    def namespace_inodes(self):
        return (3 if self.faults.get('inode_change') and self.phase == 'namespace-after' else 2), 1

    def resolver_file(self, name, expected):
        if self.faults.get('nsswitch') and name == 'nsswitch.conf':
            raise ValueError('Namespace resolver files differ.')
        return {'path': '/etc/' + name}

    def process_namespace(self, pid):
        name = self.processes[pid]
        exe = '/usr/bin/' + name if self.faults.get('wrong_exe') else str(self.bin / name)
        return 1 if self.faults.get('daemon_outside') else 2, exe

    def mount_cgroup(self):
        self.calls.append('cgroup')

    def fsys_tarfile(self, deb, target):
        package = deb.name[:-4]
        with tarfile.open(target, 'x') as tar:
            for member in imp.MEMBERS[package]:
                if self.faults.get('member_missing') and member == 'usr/bin/runc':
                    continue
                info = tarfile.TarInfo('./' + member)
                info.size = 4
                tar.addfile(info, io.BytesIO(b'fake'))


class SessionFlowTests(unittest.TestCase):
    def execute(self, **faults):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        lock, objects, repo, request = prepared(root)
        if faults.pop('tamper_archive', False):
            with open(request['archive'], 'ab') as stream:
                stream.write(b'\0' * 512)
        analysis_path = Path(request['analysis'])
        analysis = json.loads(analysis_path.read_bytes())
        change = faults.pop('analysis', None)
        if change == 'lock':
            analysis['image_lock_sha256'] = '0' * 64
        elif change == 'images':
            analysis['images']['db']['layers'] = analysis['images']['db']['layers'] * 2
        if change:
            analysis_path.write_bytes(encoded(analysis))
            request['analysis_sha256'] = imp.file_hash(analysis_path)
        if faults.pop('analysis_sha', False):
            request['analysis_sha256'] = '0' * 64
        if faults.pop('deb_hash', False):
            next(Path(request['packages']).iterdir()).write_bytes(b'changed package')
        if faults.pop('stale_root', False):
            Path(request['work']).mkdir()
            (Path(request['work']) / 'docker-root').mkdir()
        if faults.pop('db_policy', False):
            policy = repo / 'infra/selfhost/database-image-policy.json'
            policy.write_bytes(encoded({**json.loads(policy.read_bytes()), 'config_digest': 'sha256:' + 'f' * 64}))
        (root / 'evidence').mkdir()
        Path(request['work']).mkdir(exist_ok=True)
        session = FakeSession(request, root / 'evidence', **faults)
        with patch.object(imp, 'ROOT', repo), patch.object(transport, 'ROOT', repo):
            result = session.execute()
        self.assertEqual(json.loads((root / 'evidence/result.json').read_bytes()), json.loads(encoded(result)))
        return result, session

    def test_pass_observes_denial_and_empty_store_before_import(self):
        result, session = self.execute()
        self.assertEqual(result['status'], 'TRANSPORT_IDENTITY_PASS', result.get('failure'))
        calls = session.calls
        self.assertLess(calls.index('namespace-before-links'), calls.index('spawn-containerd'))
        self.assertLess(calls.index('store-before-info'), calls.index('daemon-probe'))
        self.assertLess(calls.index('daemon-probe'), calls.index('store-after-probe-info'))
        self.assertLess(calls.index('store-after-probe-info'), calls.index('import'))
        self.assertNotIn('pull', [c for c in calls if c.startswith('create')])
        for label in ('store-final-info', 'namespace-after-links', 'excluded-caddy', 'excluded-functions', 'excluded-supavisor'):
            self.assertIn(label, calls)
        self.assertEqual(set(result['images']), transport.ACTIVE)
        self.assertEqual(result['store_before'], {'images': 0, 'content': 0})
        self.assertEqual(result['store_final']['images'], 9)
        self.assertEqual(set(result['materialized']), transport.ACTIVE)
        self.assertFalse(session.containers)
        self.assertEqual(session.assertion_env['PATH'].split(':')[0], str(session.bin))
        daemon = json.loads((session.evidence / 'daemon.json').read_bytes())
        self.assertEqual((daemon['live-restore'], daemon['iptables'], daemon['bridge'], daemon['registry-mirrors']),
                         (False, False, 'none', []))
        self.assertNotIn('firewall-backend', daemon)
        self.assertNotIn('features', daemon)  # Engine 29's default store is the one under test.
        self.assertFalse(result['qa_ready'])

    def test_each_fault_refuses_at_its_phase_without_later_steps(self):
        cases = {  # fault: (value, phase, a step that must not run, failure message)
            'uplink': (True, 'namespace-before', 'spawn-containerd', 'non-loopback interface'),
            'nsswitch': (True, 'namespace-before', 'spawn-containerd', 'resolver files differ'),
            'resolves': (True, 'denial-probes', 'spawn-containerd', 'denial not proven'),
            'unobserved': (True, 'denial-probes', 'spawn-containerd', 'denial not proven'),
            'connects': (True, 'denial-probes', 'spawn-containerd', 'denial not proven'),
            'refused_errno': (True, 'denial-probes', 'spawn-containerd', 'denial not proven'),
            'tamper_archive': (True, 'archive', 'spawn-containerd', 'binding differs'),
            'analysis_sha': (True, 'archive', 'spawn-containerd', 'binding differs'),
            'analysis': ('lock', 'archive', 'spawn-containerd', 'binding differs'),
            'deb_hash': (True, 'toolchain', 'spawn-containerd', 'package digest'),
            'member_missing': (True, 'toolchain', 'spawn-containerd', 'member missing'),
            'stale_root': (True, 'daemon-start', 'spawn-containerd', 'must be new'),
            'engine': ('29.9.0', 'daemon-start', 'import', 'Engine version'),
            'daemon_outside': (True, 'daemon-start', 'store-before-info', 'outside the denied namespace'),
            'wrong_exe': (True, 'daemon-start', 'store-before-info', 'not the pinned binary'),
            'pull_succeeds': (True, 'daemon-probe', 'import', 'not observed refused'),
            'tag': (True, 'readback', 'create-db', 'tag exists'),
            'inactive_present': (True, 'readback', 'create-db', 'Image inventory'),
            'db_policy': (True, 'readback', 'create-db', 'Database image policy'),
            'content_tamper': (True, 'readback', 'create-db', 'Stored config'),
            'excluded_inspectable': (True, 'excluded', 'create-db', 'inactive service image'),
            'started': (True, 'materialize', 'store-final-info', 'was started'),
            'inode_change': (True, 'namespace-after', None, 'Namespace changed'),
            'dns_leak': (True, 'namespace-after', None, 'outside the probe windows')}
        for fault, (value, phase, absent, message) in cases.items():
            with self.subTest(fault=fault):
                result, session = self.execute(**{fault: value})
                self.assertEqual(result['status'], 'REFUSED')
                self.assertEqual(result['phase'], phase, result.get('failure'))
                self.assertIn(message, result.get('failure', {}).get('message', 'no refusal'))
                if absent:
                    self.assertNotIn(absent, session.calls)
        for value, message in (('root', 'Stored root'), ('child', 'Stored platform manifest')):
            result, _ = self.execute(content_tamper=value)
            self.assertIn(message, result.get('failure', {}).get('message', 'no refusal'))
        result, _ = self.execute(analysis='images')
        self.assertIn('differs from its analysis', result.get('failure', {}).get('message', 'no refusal'))
        result, _ = self.execute(pull_timeout=True)  # A hung but refused pull is still a refusal.
        self.assertEqual(result['status'], 'TRANSPORT_IDENTITY_PASS', result.get('failure'))
        result, _ = self.execute(stop_killed=True)
        self.assertEqual((result['status'], result['daemon_stop']['dockerd']), ('REFUSED', 'killed'))

    def test_daemon_logs_are_capped_and_stop_records_exit_codes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            session = imp.Session({'work': str(root / 'work'), 'run_dir': str(root / 'run')}, root)
            session.daemons = {'dockerd': FakeProcess('dockerd'), 'containerd': FakeProcess('containerd')}
            (root / 'dockerd.log').write_bytes(b'x' * 100)
            (root / 'containerd.log').write_bytes(b'y' * 10)
            with patch.object(imp, 'DAEMON_LOG_LIMIT', 50):
                result = session.stop_daemons()
            self.assertEqual(result, {'dockerd': 0, 'containerd': 0, 'dockerd_log_truncated': True})
            self.assertEqual((root / 'dockerd.log').stat().st_size, 50)
            self.assertEqual((root / 'containerd.log').stat().st_size, 10)


class SubsetAndRequestTests(unittest.TestCase):
    def test_subset_refuses_missing_roots_foreign_blobs_and_analysis_drift(self):
        for fault in ('missing-root', 'foreign-blob', 'drift'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                lock, objects, repo, request = prepared(root)
                analysis = json.loads(Path(request['analysis']).read_bytes())
                imp.safe_extract(Path(request['archive']), root / 'extracted')
                if fault == 'missing-root':
                    lock = {**lock, 'db': {**lock['db'], 'image': 'fixture/db@sha256:' + '9' * 64}}
                    message = 'Nine active roots'
                elif fault == 'foreign-blob':
                    analysis['images']['db']['layers'].append(analysis['images']['caddy']['layers'][0])
                    message = 'Unlisted OCI content'
                else:
                    analysis['images']['db'] = {**analysis['images']['db'], 'platform': 'linux/arm64'}
                    message = 'differs from the transport analysis'
                with self.assertRaisesRegex(ValueError, message):
                    imp.subset(root / 'extracted', root / 'nine', lock, analysis)

    def test_load_request_is_exact(self):
        good = {'work': '/mnt/w', 'run_dir': '/run/r', 'archive': '/mnt/a.tar', 'analysis': '/mnt/a.json',
                'analysis_sha256': 'a' * 64, 'packages': '/mnt/p', 'endpoints': {'h': ['192.0.2.1']}, 'owner': [1001, 118]}
        cases = {'extra': {**good, 'x': 1}, 'missing': {k: v for k, v in good.items() if k != 'owner'},
                 'relative': {**good, 'work': 'w'}, 'digest': {**good, 'analysis_sha256': 'A' * 64},
                 'no-endpoints': {**good, 'endpoints': {}}, 'empty-endpoint': {**good, 'endpoints': {'h': []}},
                 'root-owner': {**good, 'owner': [0, 118]}, 'owner-shape': {**good, 'owner': [1001]},
                 'owner-type': {**good, 'owner': ['1001', 118]}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'request.json'
            path.write_bytes(encoded(good))
            self.assertEqual(imp.load_request(path), good)
            for name, value in cases.items():
                with self.subTest(name=name):
                    path.unlink()
                    path.write_bytes(encoded(value))
                    with self.assertRaises((ValueError, KeyError)):
                        imp.load_request(path)


class ControllerTests(unittest.TestCase):
    ENV = {'R3_SOURCE_SHA': 'a' * 40, 'GITHUB_SHA': 'a' * 40, 'GITHUB_WORKFLOW_SHA': 'a' * 40,
           'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_RUN_ATTEMPT': '1', 'RUNNER_ENVIRONMENT': 'github-hosted',
           'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_REF': 'refs/heads/feat/x', 'GITHUB_RUN_ID': '7',
           'GITHUB_REPOSITORY': 'o/r', 'GITHUB_WORKFLOW_REF': 'o/r/' + qualify.WORKFLOW + '@refs/heads/feat/x'}

    def test_dispatch_binding_refuses_reruns_other_events_and_workflows(self):
        for key, value in (('GITHUB_RUN_ATTEMPT', '2'), ('GITHUB_EVENT_NAME', 'push'), ('GITHUB_WORKFLOW_SHA', 'b' * 40),
                           ('GITHUB_WORKFLOW_REF', 'o/r/.github/workflows/r3-native-noble.yml@refs/heads/feat/x'),
                           ('RUNNER_ENVIRONMENT', 'self-hosted'), ('GITHUB_REF', 'refs/tags/v1'), ('R3_SOURCE_SHA', 'a' * 39)):
            with self.subTest(key=key), patch.object(qualify, 'git', side_effect=AssertionError('no git before binding')):
                with self.assertRaisesRegex(ValueError, 'binding differs'):
                    qualify.source_binding({**self.ENV, key: value})

    def flow(self, import_status='TRANSPORT_IDENTITY_PASS', fail=None, exit_refusal=True, lingering=0, images=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        work = Path(temp.name)
        raw = work / 'raw'
        raw.mkdir()
        order = []
        def step(name, value=None):
            def call(*args, **kwargs):
                order.append(name)
                if fail == name:
                    raise ValueError(name + ' failed')
                return value(*args, **kwargs) if callable(value) else value
            return call
        receipt = {'images': {}, 'endpoints': {'registry-1.docker.io': ['192.0.2.10']}}
        def fake_prepare(layout, output):
            output.mkdir()
            (output / 'transport-analysis.json').write_bytes(b'{}')
            return {'archive_sha256': '0' * 64}
        def fake_run(argv, directory, label, **kwargs):
            order.append(label)
            if label == 'isolated-import':
                self.assertEqual(argv[:6], ['sudo', '-n', 'ip', 'netns', 'exec', qualify.NETNS])
                self.assertIn('-I', argv)
                (raw / 'isolated').mkdir()
                (raw / 'isolated/result.json').write_bytes(encoded({
                    'status': import_status, 'phase': 'namespace-after', 'load_archive_sha256': '1' * 64,
                    'images': {name: {'id': 'sha256:' + name} for name in (images or transport.ACTIVE)}}))
                if import_status != 'TRANSPORT_IDENTITY_PASS' and exit_refusal:
                    raise ValueError('refused')
            if label == 'netns-pids-after':
                return b'4242\n' if lingering else b''
            if label == 'netns-kill':
                self.assertEqual(argv, ['sudo', '-n', 'kill', '-KILL', '4242'])
            if label == 'netns-pids-final':
                return b'4242\n' if lingering > 1 else b''
            if label == 'isolated-chown':
                self.assertEqual(argv[:5], ['sudo', '-n', 'chown', '-R', '--no-dereference'])
            return b''
        summary, source = {'phase': 'start'}, {'sha': 'a', 'run_id': '7'}
        with patch.object(qualify, 'preflight', step('preflight', {})), \
                patch.object(qualify, 'stage_toolchain', step('toolchain', {})), \
                patch.object(qualify, 'acquire', step('acquire', receipt)), \
                patch.object(qualify, 'documents', step('documents')), \
                patch.object(qualify, 'prepare', step('archive', fake_prepare)), \
                patch.object(qualify, 'isolate', step('isolate')), \
                patch.object(qualify, 'source_binding', step('source-recheck', source)), \
                patch.object(qualify, 'run', fake_run), patch.object(qualify.time, 'sleep'):
            try:
                qualify.transport(work, raw, source, summary, {})
            except ValueError as exc:
                summary['error'] = str(exc)
        return order, summary

    def test_connected_phases_complete_before_isolation_and_import(self):
        order, summary = self.flow()
        self.assertEqual(order, ['preflight', 'toolchain', 'acquire', 'documents', 'archive', 'isolate',
                                 'source-recheck', 'isolated-import', 'netns-pids-after', 'netns-pids-final',
                                 'isolated-chown'])
        self.assertEqual(summary['containment'], {'killed': 0, 'remaining': 0})
        self.assertEqual((summary['status'], summary['phase']), (qualify.PASS, 'complete'))
        self.assertEqual(set(summary['images']), transport.ACTIVE)

    def test_any_earlier_failure_or_refused_import_never_reports_pass(self):
        for name in ('preflight', 'toolchain', 'acquire', 'archive', 'isolate', 'source-recheck'):
            with self.subTest(name=name):
                order, summary = self.flow(fail=name)
                self.assertNotIn('isolated-import', order)
                self.assertNotEqual(summary.get('status'), qualify.PASS)
        order, summary = self.flow(import_status='REFUSED')
        self.assertEqual((summary['import_status'], summary.get('status')), ('REFUSED', None))
        # A lingering namespace process is killed before sealing; one that survives refuses.
        order, summary = self.flow(lingering=1)
        self.assertEqual((summary['containment'], summary.get('status')), ({'killed': 1, 'remaining': 0}, qualify.PASS))
        self.assertEqual([l for l in order if l in ('netns-kill', 'isolated-chown')], ['netns-kill', 'isolated-chown'])
        order, summary = self.flow(lingering=2)
        self.assertEqual((summary.get('error'), summary.get('status')), ('Denied namespace not contained', None))
        order, summary = self.flow(images=transport.ACTIVE - {'studio'})
        self.assertEqual((summary.get('error'), summary.get('status')), ('Isolated import refused', None))
        # A zero exit with a refused result is still a refusal.
        order, summary = self.flow(import_status='REFUSED', exit_refusal=False)
        self.assertEqual((summary.get('error'), summary.get('status')), ('Isolated import refused', None))

    def test_preflight_refuses_missing_tools_space_and_reused_namespaces(self):
        class Usage:
            f_frsize = 4096
            def __init__(self, free):
                self.f_bavail = free // 4096
        def attempt(which=lambda tool, path=None: '/usr/bin/' + tool, free=qualify.FREE_BYTES, netns=b'', etc=False):
            with tempfile.TemporaryDirectory() as temp:
                if etc:
                    (Path(temp) / qualify.NETNS).mkdir()
                with patch.object(qualify.shutil, 'which', which), patch.object(qualify.os, 'statvfs', lambda _: Usage(free)), \
                        patch.object(qualify, 'run', lambda *a, **k: netns), patch.object(qualify, 'NETNS_ETC', Path(temp)):
                    return qualify.preflight(Path(temp))
        self.assertEqual(attempt(), {'scratch_free_bytes': qualify.FREE_BYTES})
        for kwargs, message in (({'which': lambda tool, path=None: None if tool == 'ip' else '/x'}, 'tool missing'),
                                ({'free': qualify.FREE_BYTES - 4096}, 'scratch space'),
                                ({'netns': b'other\n'}, 'already exists'), ({'etc': True}, 'already exists')):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, message):
                attempt(**kwargs)

    def test_isolation_stops_loaded_units_and_builds_a_loopback_namespace(self):
        def attempt(loaded=b'loaded\nloaded\nnot-found\n', states=b'inactive\nfailed\ninactive\n'):
            calls = []
            def fake_run(argv, directory, label, **kwargs):
                calls.append((label, argv))
                return {'hosted-engine-units': loaded, 'hosted-engine-state': states}.get(label, b'')
            with tempfile.TemporaryDirectory() as temp, patch.object(qualify, 'run', fake_run):
                (Path(temp) / 'raw').mkdir()
                qualify.isolate(Path(temp), Path(temp) / 'raw')
            return calls
        calls = attempt()
        labels = [label for label, _ in calls]
        self.assertEqual(dict(calls).get('hosted-engine-stop'), ['sudo', '-n', 'systemctl', 'stop', 'docker.socket', 'docker.service'])
        self.assertEqual([l for l in labels if l in ('hosted-engine-state', 'netns-tunnels', 'netns-add')],
                         ['hosted-engine-state', 'netns-tunnels', 'netns-add'])
        self.assertEqual(dict(calls).get('netns-tunnels', [''])[-1], 'net.core.fb_tunnels_only_for_init_net=2')
        self.assertEqual(dict(calls)['netns-loopback'], ['sudo', '-n', 'ip', '-n', qualify.NETNS, 'link', 'set', 'lo', 'up'])
        self.assertEqual({argv[-1] for label, argv in calls if label.startswith('netns-') and label.endswith(('conf', 'hosts'))},
                         {'/etc/netns/' + qualify.NETNS + '/' + n for n in ('resolv.conf', 'hosts', 'nsswitch.conf')})
        self.assertNotIn('hosted-engine-stop', [l for l, _ in attempt(loaded=b'not-found\nnot-found\nnot-found\n')])
        for states in (b'active\ninactive\ninactive\n', b'inactive\ninactive\n'):
            with self.subTest(states=states), self.assertRaisesRegex(ValueError, 'still active'):
                attempt(states=states)

    def test_source_binding_hashes_a_clean_tracked_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            env = {**os.environ, 'GIT_AUTHOR_NAME': 'fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                   'GIT_COMMITTER_NAME': 'fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
            git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], check=True, capture_output=True, env=env).stdout
            git('init', '-q')
            (repo / qualify.WORKFLOW).parent.mkdir(parents=True)
            (repo / qualify.WORKFLOW).write_text('name: fixture\n')
            (repo / 'tool.py').write_text('print(1)\n')
            git('add', '.')
            git('commit', '-q', '-m', 'fixture')
            sha = git('rev-parse', 'HEAD').decode().strip()
            bound = {**self.ENV, 'R3_SOURCE_SHA': sha, 'GITHUB_SHA': sha, 'GITHUB_WORKFLOW_SHA': sha}
            with patch.object(qualify, 'ROOT', repo):
                source = qualify.source_binding(bound)
                self.assertEqual(set(source['files']), {qualify.WORKFLOW, 'tool.py'})
                self.assertEqual(source['workflow_sha256'], digest(b'name: fixture\n'))
                (repo / 'untracked').write_text('x')
                with self.assertRaisesRegex(ValueError, 'clean source'):
                    qualify.source_binding(bound)
                (repo / 'untracked').unlink()
                git('update-index', '--skip-worktree', 'tool.py')
                (repo / 'tool.py').write_text('print(2)\n')
                with self.assertRaisesRegex(ValueError, 'Tracked source bytes differ'):
                    qualify.source_binding(bound)

    def test_main_refuses_on_source_drift_and_never_publishes_a_partial_ciphertext(self):
        def attempt(drift=False, seal_fails=False):
            temp = tempfile.TemporaryDirectory()
            self.addCleanup(temp.cleanup)
            root = Path(temp.name)
            (root / 'runner').mkdir()
            source = {'sha': 'a' * 40, 'ref': 'refs/heads/feat/x', 'run_id': '7', 'workflow_sha256': '1' * 64}
            bindings = iter([source, {**source, 'sha': 'b' * 40} if drift else source])  # start, final recheck
            def fake_seal(work, raw, publish, binding):
                (publish / 'transport-evidence.tar.age').write_bytes(b'partial')
                if seal_fails:
                    raise ValueError('encryption failed')
                return {'ciphertext_sha256': '0' * 64}
            def fake_transport(work, raw, src, summary, env):
                summary['status'], summary['phase'] = qualify.PASS, 'complete'
            environment = {**self.ENV, 'R3_RECIPIENT': 'ssh-ed25519 AAAA', 'R3_RECIPIENT_SHA256': '2' * 64,
                           'RUNNER_TEMP': str(root / 'runner')}
            with patch.dict(qualify.os.environ, environment, clear=True), \
                    patch.object(qualify, 'source_binding', lambda env: next(bindings)), \
                    patch.object(qualify, 'recipient', lambda *a: b'key'), patch.object(qualify, 'stage_age', lambda *a: None), \
                    patch.object(qualify, 'transport', fake_transport), patch.object(qualify, 'seal', fake_seal), \
                    patch.object(qualify, 'SCRATCH', root / 'scratch'), \
                    patch.object(qualify.subprocess, 'run', lambda argv, **k: Path(argv[-1]).mkdir(parents=True)), \
                    patch.object(qualify, 'file_hash', lambda path: '3' * 64):
                code = qualify.main()
            publish = root / 'runner/r3-image-transport-publish'
            return code, json.loads((publish / 'summary.json').read_bytes()), publish
        code, summary, publish = attempt()
        self.assertEqual((code, summary['status'], summary['sealed'], summary['source_recheck']), (0, qualify.PASS, True, True))
        code, summary, publish = attempt(drift=True)
        self.assertEqual((code, summary['status'], summary['source_recheck']), (1, 'REFUSED', False))
        code, summary, publish = attempt(seal_fails=True)
        self.assertEqual((code, summary['status'], summary['sealed']), (1, 'REFUSED', False))
        self.assertFalse((publish / 'transport-evidence.tar.age').exists())
        self.assertTrue((publish / 'binding.json').exists())

    def test_documents_retain_manifests_and_configs_never_layers(self):
        with tempfile.TemporaryDirectory() as temp:
            lock, objects = catalogue()
            receipt = acquire.acquire(lock, Path(temp) / 'layout', acquire.Client(Registry(objects)), resolve)
            qualify.documents(Path(temp) / 'layout', receipt, Path(temp) / 'documents')
            kept = {'sha256:' + p.name for p in (Path(temp) / 'documents').iterdir()}
            layers = {layer for item in receipt['images'].values() for layer in item['layers']}
            self.assertFalse(kept & layers)
            self.assertIn(receipt['images']['realtime']['platform_manifest'], kept)
            self.assertIn(receipt['images']['db']['config'], kept)

    def test_seal_covers_nested_evidence_and_refuses_links(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            raw, publish = work / 'raw', work / 'publish'
            (raw / 'isolated').mkdir(parents=True)
            publish.mkdir()
            (raw / 'isolated/result.json').write_bytes(b'{}')
            def fake_age(argv, directory, label, **kwargs):
                Path(argv[argv.index('-o') + 1]).write_bytes(Path(argv[-1]).read_bytes())
                return b''
            with patch.object(qualify, 'run', fake_age):
                retention = qualify.seal(work, raw, publish, {'run_id': '7'})
                manifest = json.loads((raw / 'retention-manifest.json').read_bytes())
                self.assertEqual(set(manifest['files']), {'isolated/result.json'})
                with tarfile.open(publish / 'transport-evidence.tar.age') as tar:
                    self.assertIn('isolated/result.json', tar.getnames())
                self.assertEqual(retention['plaintext_sha256'], retention['ciphertext_sha256'])
                (raw / 'link').symlink_to(raw / 'isolated/result.json')
                (raw / 'retention-manifest.json').unlink()
                (work / 'private-evidence.tar').unlink()
                with self.assertRaisesRegex(ValueError, 'raw evidence type'):
                    qualify.seal(work, raw, publish, {})
                (raw / 'link').unlink()
                (raw / 'isolated').chmod(0)  # Root-owned evidence left unreadable must not seal as empty.
                try:
                    with self.assertRaisesRegex(ValueError, 'Unreadable'):
                        qualify.seal(work, raw, publish, {})
                finally:
                    (raw / 'isolated').chmod(0o700)

    def test_isolated_resolver_files_are_the_controller_staged_files(self):
        self.assertEqual(qualify.RESOLV_CONF, imp.RESOLV_CONF)
        self.assertEqual(imp.RESOLV_CONF.split(b'\n')[0], b'nameserver ' + imp.RESOLVER.encode())
        self.assertIn(b'hosts: files dns\n', imp.NSSWITCH)
        self.assertNotIn(b'resolve', imp.NSSWITCH)


class WorkflowTests(unittest.TestCase):
    def test_dispatch_only_single_attempt_no_secrets_and_ciphertext_upload(self):
        text = (ROOT / qualify.WORKFLOW).read_text()
        workflow = yaml.load(text, Loader=yaml.BaseLoader)
        self.assertEqual(list(workflow['on']), ['workflow_dispatch'])
        self.assertEqual(set(workflow['on']['workflow_dispatch']['inputs']), {'source_sha', 'recipient', 'recipient_sha256'})
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        self.assertEqual(workflow['concurrency'], {'group': 'r3-image-transport', 'cancel-in-progress': 'false'})
        self.assertEqual(set(workflow['jobs']), {qualify.JOB})
        job = workflow['jobs'][qualify.JOB]
        self.assertEqual(job['if'], "github.event_name == 'workflow_dispatch' && github.run_attempt == 1")
        self.assertEqual((job['runs-on'], job['permissions']), ('ubuntu-24.04', {'contents': 'read'}))
        self.assertNotIn('secrets.', text)
        self.assertNotIn('id-token', text)
        checkout, controller, upload = job['steps']
        self.assertEqual(checkout['uses'], 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09')
        self.assertEqual(checkout['with'], {'ref': '${{ github.sha }}', 'persist-credentials': 'false'})
        self.assertEqual(controller['run'], 'python3 -I -B infra/scripts/r3_image_qualify.py')
        self.assertEqual(set(controller['env']), {'R3_SOURCE_SHA', 'R3_RECIPIENT', 'R3_RECIPIENT_SHA256'})
        self.assertNotIn('continue-on-error', controller)
        self.assertEqual(upload['uses'], 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
        self.assertEqual(upload['if'], 'always()')
        self.assertEqual(upload['with']['path'].splitlines(), [
            '${{ runner.temp }}/r3-image-transport-publish/' + name
            for name in ('transport-evidence.tar.age', 'binding.json', 'summary.json')])
        self.assertEqual((upload['with']['retention-days'], upload['with']['if-no-files-found']), ('7', 'error'))


if __name__ == '__main__':
    unittest.main()
