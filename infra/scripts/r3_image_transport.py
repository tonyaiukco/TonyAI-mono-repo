"""Verify and archive an OCI image layout; never import images or start a daemon.

Require one root descriptor per locked original repository digest. Retain a
locked multi-platform index unchanged and its unique linux/amd64 child closure.
Other platforms are deliberately absent; importer compatibility remains unproven.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
import tarfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_bundle import digest, write_new
from r3_artifacts import ROOT

MANIFESTS = {'application/vnd.oci.image.manifest.v1+json',
             'application/vnd.docker.distribution.manifest.v2+json'}
INDEXES = {'application/vnd.oci.image.index.v1+json',
           'application/vnd.docker.distribution.manifest.list.v2+json'}
CONFIGS = {'application/vnd.oci.image.config.v1+json',
           'application/vnd.docker.container.image.v1+json'}
LAYERS = {'application/vnd.oci.image.layer.v1.tar',
          'application/vnd.oci.image.layer.v1.tar+gzip',
          'application/vnd.oci.image.layer.v1.tar+zstd',
          'application/vnd.docker.image.rootfs.diff.tar.gzip'}
ACTIVE = {'api-gw', 'auth', 'db', 'imgproxy', 'meta', 'realtime', 'rest', 'storage', 'studio'}


def unique_object(pairs):
    result = {}
    folded = set()
    for key, value in pairs:
        if key.casefold() in folded:
            raise ValueError('Duplicate or case-colliding OCI key.')
        folded.add(key.casefold())
        result[key] = value
    return result


def document(data):
    return json.loads(data, object_pairs_hook=unique_object)


def keys(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise ValueError('Unsupported OCI keys.')


UPSTREAM_ANNOTATIONS = {
    'vnd.docker.reference.digest', 'vnd.docker.reference.type',
    'com.docker.official-images.bashbrew.arch', 'org.opencontainers.image.source',
    'org.opencontainers.image.base.digest', 'org.opencontainers.image.revision',
    'org.opencontainers.image.url', 'org.opencontainers.image.base.name',
    'org.opencontainers.image.created', 'org.opencontainers.image.version',
    'org.opencontainers.image.description', 'org.opencontainers.image.licenses',
    'org.opencontainers.image.title',
}


def upstream_annotations(value):
    # Metadata in a pinned upstream blob is not the untrusted layout name map.
    # Retain only observed descriptive/attestation keys, never importer names.
    keys(value, (), UPSTREAM_ANNOTATIONS)
    if any(not isinstance(item, str) for item in value.values()):
        raise ValueError('Annotation values must be strings.')


def descriptor_keys(value, root=False):
    keys(value, ('digest', 'size', 'mediaType'), ('annotations', 'platform'))
    if root:
        keys(value.get('annotations'), ('org.opencontainers.image.ref.name',))
    elif 'annotations' in value:
        upstream_annotations(value['annotations'])
    if root and 'platform' in value and value['platform'] != {'os': 'linux', 'architecture': 'amd64'}:
        raise ValueError('Root descriptor platform differs.')
    if 'platform' in value:
        keys(value['platform'], ('os', 'architecture'), ('variant', 'os.version', 'os.features'))
        if (value['platform']['os'] not in ('linux', 'windows', 'unknown')
                or value['platform']['architecture'] not in
                ('amd64', 'arm64', 'arm', '386', 'ppc64le', 's390x', 'riscv64', 'unknown')):
            raise ValueError('Noncanonical platform alias.')


def image_document(value, media):
    required = ('schemaVersion', 'manifests') if media in INDEXES else ('schemaVersion', 'config', 'layers')
    keys(value, required, ('mediaType', 'annotations'))
    if 'annotations' in value:
        upstream_annotations(value['annotations'])
    if value.get('schemaVersion') != 2 or value.get('mediaType', media) != media:
        raise ValueError('Content media type differs from descriptor.')


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(layout, lock):
    layout = Path(layout).absolute()
    if layout.is_symlink() or not layout.is_dir():
        raise ValueError('Regular OCI layout directory required.')
    actual = set()
    for path in layout.rglob('*'):
        mode = path.lstat().st_mode
        name = path.relative_to(layout).as_posix()
        if stat.S_ISDIR(mode) and name in ('blobs', 'blobs/sha256'):
            continue
        if not stat.S_ISREG(mode) or path.stat().st_nlink != 1:
            raise ValueError('Linked or special transport entry.')
        actual.add(name)
    layout_bytes = (layout / 'oci-layout').read_bytes()
    if document(layout_bytes) != {'imageLayoutVersion': '1.0.0'}:
        raise ValueError('Unsupported OCI layout.')
    index_bytes = (layout / 'index.json').read_bytes()
    index = document(index_bytes)
    keys(index, ('schemaVersion', 'manifests'), ('mediaType',))
    if index.get('schemaVersion') != 2 or index.get('mediaType', 'application/vnd.oci.image.index.v1+json') != 'application/vnd.oci.image.index.v1+json':
        raise ValueError('Unsupported OCI index.')
    used = {'oci-layout', 'index.json'}
    hashes = {'oci-layout': digest(layout_bytes), 'index.json': digest(index_bytes)}

    def blob(descriptor, allowed, read=False, root=False):
        descriptor_keys(descriptor, root=root)
        value = descriptor['digest']
        if (not re.fullmatch(r'sha256:[a-f0-9]{64}', value)
                or descriptor.get('mediaType') not in allowed or descriptor.get('urls')
                or type(descriptor.get('size')) is not int or descriptor['size'] < 0):
            raise ValueError('Unsupported descriptor.')
        name = 'blobs/sha256/' + value[7:]
        path = layout / name
        if name not in actual:
            raise ValueError('Missing OCI blob.')
        data = path.read_bytes() if read else None
        observed_size = len(data) if read else path.stat().st_size
        observed_hash = digest(data) if read else file_hash(path)
        if observed_size != descriptor['size'] or observed_hash != value[7:]:
            raise ValueError('Missing or changed OCI blob.')
        used.add(name)
        hashes[name] = value[7:]
        return document(data) if read else None

    by_ref = {}
    for entry in index['manifests']:
        descriptor_keys(entry, root=True)
        ref = entry.get('annotations', {}).get('org.opencontainers.image.ref.name')
        if ref in by_ref or ref not in {v['image'] for v in lock.values()}:
            raise ValueError('Duplicate or unlocked original repository reference.')
        if ref.split('@')[-1] != entry['digest']:
            raise ValueError('Original repository digest lost.')
        manifest = blob(entry, MANIFESTS | INDEXES, read=True, root=True)
        image_document(manifest, entry['mediaType'])
        platform_digest = entry['digest']
        if entry['mediaType'] in INDEXES:
            if manifest.get('schemaVersion') != 2:
                raise ValueError('Unsupported platform index.')
            for child in manifest['manifests']:
                descriptor_keys(child)
            children = [child for child in manifest.get('manifests', [])
                        if child.get('platform', {}).get('os') == 'linux'
                        and child.get('platform', {}).get('architecture') == 'amd64']
            if len(children) != 1 or children[0]['platform'] != {'os': 'linux', 'architecture': 'amd64'}:
                raise ValueError('Exactly one unambiguous linux/amd64 child required.')
            platform_digest = children[0]['digest']
            manifest = blob(children[0], MANIFESTS, read=True)
            image_document(manifest, children[0]['mediaType'])
        if manifest.get('schemaVersion') != 2:
            raise ValueError('Unsupported image manifest.')
        config = blob(manifest['config'], CONFIGS, read=True)
        if config.get('mediaType', manifest['config']['mediaType']) != manifest['config']['mediaType']:
            raise ValueError('Config media type differs from descriptor.')
        if (config.get('os'), config.get('architecture'), config.get('variant', '')) != ('linux', 'amd64', ''):
            raise ValueError('Wrong image platform.')
        if config.get('rootfs', {}).get('type') != 'layers' or not manifest['layers']:
            raise ValueError('Invalid image rootfs.')
        diff_ids = config['rootfs'].get('diff_ids', [])
        if len(diff_ids) != len(manifest['layers']) or any(not re.fullmatch(r'sha256:[a-f0-9]{64}', x) for x in diff_ids):
            raise ValueError('Layer/config correspondence differs.')
        for layer in manifest['layers']:
            blob(layer, LAYERS)
        by_ref[ref] = {'image': ref, 'platform': 'linux/amd64',
                       'platform_manifest_digest': platform_digest,
                       'config_digest': manifest['config']['digest'],
                       'layers': [layer['digest'] for layer in manifest['layers']]}
    if set(by_ref) != {v['image'] for v in lock.values()} or any(v['platform'] != 'linux/amd64' for v in lock.values()):
        raise ValueError('Incomplete locked image set.')
    if used != actual:
        raise ValueError('Unlisted OCI content.')
    return {service: by_ref[item['image']] for service, item in sorted(lock.items())}, used, hashes


def prepare(layout, output):
    lock_bytes = (ROOT / 'infra/selfhost/images.qa.lock.json').read_bytes()
    lock = json.loads(lock_bytes)['services']
    if set(lock) != ACTIVE | {'caddy', 'functions', 'supavisor'}:
        raise ValueError('Reviewed twelve-service lock required.')
    images, names, hashes = verify(layout, lock)
    output = Path(output).absolute()
    output.mkdir(mode=0o700)
    archive = output / 'images.oci.tar'
    with archive.open('xb') as stream, tarfile.open(fileobj=stream, mode='w') as tar:
        for name in sorted(names):
            path = Path(layout) / name
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = path.stat().st_size, 0o600, 0
            with path.open('rb') as data:
                tar.addfile(info, data)
    # Revalidate input after packaging; concurrent input edits invalidate output.
    if verify(layout, lock) != (images, names, hashes):
        raise ValueError('OCI layout changed during packaging.')
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) != len(names) or {m.name for m in members} != names:
            raise ValueError('Packaged file set differs.')
        for member in members:
            if not member.isfile() or hashlib.file_digest(tar.extractfile(member), 'sha256').hexdigest() != hashes[member.name]:
                raise ValueError('Packaged bytes differ.')
    report = {'format': 1, 'status': 'TRANSPORT_BYTES_VERIFIED_NOT_IMPORTED',
              'closure': 'Original root plus selected linux/amd64 manifest/config/layers; other platforms absent',
              'archive_sha256': file_hash(archive), 'image_lock_sha256': digest(lock_bytes),
              'images': images, 'active_services': sorted(ACTIVE), 'install_authorized': False,
              'unproven': ['Empty target store', 'Registry denial', 'Original digest resolution after import',
                           'Pinned Engine/store interoperability', 'Exact nine-service --pull never --no-build startup',
                           'Layer decompression/diff-id validation by the importing engine'],
              'qa_ready': False}
    write_new(output / 'transport-analysis.json', json.dumps(report, indent=2).encode())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('layout')
    parser.add_argument('output')
    args = parser.parse_args()
    try:
        prepare(args.layout, args.output)
        print('PASS: offline image bytes bound; import and startup remain unqualified.')
    except Exception:
        raise SystemExit('FAIL: image transport refused; partial output is not accepted.')
