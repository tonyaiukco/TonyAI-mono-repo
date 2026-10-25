"""Public-only fixture staging; never imports private target bundle contracts."""
import base64
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import time
import urllib.request

from r3_noble_common import digest, encoded, file_hash, read, run, write
from r3_toolchain import validate_lock, verify_index

ROOT = Path(__file__).resolve().parents[2]
HELPERS = ('r3_noble_common.py', 'r3_noble_guest.py', 'r3_noble_identity.py', 'r3_toolchain.py',
           'r3_artifacts.py', 'r3_package_state.py', 'r3_apt_observer.py',
           'r3_install_policy.py', 'r3_packagekit_state.py', 'r3_maintenance.py', 'r3_policy_capture.py', 'r3_policy_snap.py',
           'r3_policy_evidence.py', 'r3_policy_validate.py', 'r3_policy_scope.py', 'r3_snap_leaf.py')
WORKFLOW = '.github/workflows/r3-native-noble.yml'


def fetch(url, path, limit, deadline, expected=None):
    if not url.startswith('https://'):
        raise ValueError('HTTPS input required')
    count = 0
    with urllib.request.urlopen(url, timeout=30) as response, Path(path).open('xb') as out:
        if not response.url.startswith('https://'):
            raise ValueError('Insecure redirect')
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError('Input staging deadline')
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > limit:
                raise ValueError('Input size limit')
            out.write(chunk)
    if expected is not None and file_hash(path) != expected:
        raise ValueError('Input hash mismatch')


def recipient(text, expected):
    # Public key only. No comments, paths, plugin recipients or shell syntax.
    parts = text.strip().split()
    if len(parts) != 2 or parts[0] not in ('ssh-rsa', 'ssh-ed25519'):
        raise ValueError('One public SSH recipient without a comment is required')
    base64.b64decode(parts[1], validate=True)
    normalized = (' '.join(parts) + '\n').encode()
    if digest(normalized) != expected:
        raise ValueError('Recipient differs from approval')
    return normalized


def stage_age(work, lock, recipient_bytes, raw, deadline):
    archive = work / 'age.tar.gz'
    fetch(lock['age_url'], archive, 32 * 1024 * 1024, deadline, lock['age_archive_sha256'])
    with tarfile.open(archive, 'r:gz') as tar:
        matches = [m for m in tar.getmembers() if m.name == 'age/age']
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 32 * 1024 * 1024:
            raise ValueError('Unexpected age archive')
        write(work / 'age', tar.extractfile(matches[0]).read())
    (work / 'age').chmod(0o700)
    if run([str(work / 'age'), '--version'], raw, 'age-version', timeout=10).decode().strip() != lock['age_version']:
        raise ValueError('Encryption tool version differs')
    write(work / 'recipient.pub', recipient_bytes)
    run(['ssh-keygen', '-lf', str(work / 'recipient.pub'), '-E', 'sha256'], raw, 'recipient', timeout=10)


def verify_image_signature(work, lock, raw):
    key, sums, signature = (work / p for p in ('ubuntu.asc', 'SHA256SUMS', 'SHA256SUMS.gpg'))
    with tempfile.TemporaryDirectory(dir=work) as home:
        gpg = ['gpg', '--batch', '--no-options', '--homedir', home]
        listed = run(gpg + ['--with-colons', '--show-keys', str(key)], raw, 'image-key').decode()
        fps = [line.split(':')[9] for line in listed.splitlines() if line.startswith('fpr:')]
        if not fps or fps[0] != lock['image_signing_fingerprint']:
            raise ValueError('Image key fingerprint differs')
        keyring = str(Path(home) / 'trusted.gpg')
        run(gpg + ['--output', keyring, '--dearmor', str(key)], raw, 'image-keyring')
        status = run(gpg + ['--no-default-keyring', '--keyring', keyring, '--status-fd', '1',
                            '--verify', str(signature), str(sums)], raw, 'image-signature').decode()
        valid = [s.split() for s in status.splitlines() if s.startswith('[GNUPG:] VALIDSIG ')]
        if len(valid) != 1 or lock['image_signing_fingerprint'] not in (valid[0][2], valid[0][-1]):
            raise ValueError('Image signature differs')
    lines = read(sums).decode().splitlines()
    for name, key_name in ((lock['image'], 'image_sha256'), (lock['manifest'], 'manifest_sha256')):
        matches = [line for line in lines if line.endswith(' *' + name)]
        if matches != [lock[key_name] + ' *' + name]:
            raise ValueError('Signed image checksum differs')


def stage(work, raw, lock, source, deadline, policy_bytes=None, collection_only=False, *, snap_leaf=False):
    if snap_leaf and (collection_only or policy_bytes is not None):
        raise ValueError('Snap diagnostic cannot use collection or installation policy')
    if collection_only and policy_bytes is not None:
        raise ValueError('Collection cannot use installation policy')
    for name in ('SHA256SUMS', 'SHA256SUMS.gpg'):
        fetch(lock['image_base'] + name, work / name, 1_000_000, deadline)
    fp = lock['image_signing_fingerprint']
    fetch('https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x' + fp,
          work / 'ubuntu.asc', 1_000_000, deadline)
    verify_image_signature(work, lock, raw)
    for name, hash_name, limit in ((lock['image'], 'image_sha256', 4 * 1024**3),
                                    (lock['manifest'], 'manifest_sha256', 1_000_000)):
        fetch(lock['image_base'] + name, work / name, limit, deadline, lock[hash_name])
    inputs = work / 'input'
    inputs.mkdir(mode=0o700)
    for name in ('artifacts', 'helpers', 'provenance'):
        (inputs / name).mkdir(mode=0o700)
    package_lock = read(ROOT / 'infra/selfhost/r3-toolchain.lock.json')
    tools = json.loads(package_lock)
    validate_lock(tools)
    write(inputs / 'r3-toolchain.lock.json', package_lock)
    write(inputs / 'r3-noble-fixture.lock.json', encoded(lock))
    for item in tools['packages']:
        fetch(item['url'], inputs / 'artifacts' / item['url'].rsplit('/', 1)[1],
              250 * 1024**2, deadline, item['sha256'])
    base = 'https://download.docker.com/linux/ubuntu/'
    for name, suffix in (('docker.asc', 'gpg'), ('InRelease', 'dists/noble/InRelease'),
                         ('Packages', 'dists/noble/stable/binary-amd64/Packages')):
        fetch(base + suffix, inputs / 'provenance' / name, 32 * 1024**2, deadline)
    provenance = verify_index(inputs, tools)
    for name in ('docker.asc', 'InRelease', 'Packages'):
        write(raw / ('docker-' + name), read(inputs / 'provenance' / name, 32 * 1024**2))
    for name in HELPERS:
        write(inputs / 'helpers' / name, read(ROOT / 'infra/scripts' / name))
    if policy_bytes is not None:
        write(inputs / 'installation-policy.json', policy_bytes)
    files = {str(p.relative_to(inputs)): file_hash(p) for p in inputs.rglob('*') if p.is_file()}
    manifest = {'format': 1, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY', 'source': source,
                'image_sha256': lock['image_sha256'], 'fixture_uuid': lock['fixture_uuid'],
                'provenance': provenance, 'files': files}
    if snap_leaf:
        manifest['purpose'] = 'FIXTURE_SNAP_LEAF_DIAGNOSTIC'
    if collection_only:
        manifest['purpose'] = 'FIXTURE_POLICY_COLLECTION_ONLY'
    if policy_bytes is not None:
        manifest.update(purpose='FIXTURE_MAINTENANCE_ONLY', policy_sha256=digest(policy_bytes))
    write(inputs / 'manifest.json', encoded(manifest))
    write(raw / 'input-manifest.json', encoded(manifest))
    # Keep the signed image metadata and public artifact hashes inside encryption.
    for name in ('SHA256SUMS', 'SHA256SUMS.gpg', 'ubuntu.asc', lock['manifest']):
        write(raw / name, read(work / name))
    return inputs


def seed(directory, source):
    directory.mkdir(mode=0o700)
    user = {'runcmd': [['mkdir', '-m', '0700', '/mnt/r3-input'],
                      ['mount', '-o', 'ro', '/dev/disk/by-label/R3INPUT', '/mnt/r3-input'],
                      ['/usr/bin/python3', '-I', '-B', '/mnt/r3-input/helpers/r3_noble_guest.py']]}
    write(directory / 'user-data', b'#cloud-config\n' + encoded(user) + b'\n')
    write(directory / 'meta-data', encoded({'instance-id': 'r3-' + source['run_id'],
                                          'local-hostname': 'r3-noble-fixture', 'dsmode': 'local'}))
