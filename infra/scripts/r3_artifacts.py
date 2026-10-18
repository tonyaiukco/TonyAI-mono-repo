#!/usr/bin/env python3
"""Stage public, pinned R3 inputs locally. No SSH, install, cloud or secret access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, expected):
    if not re.fullmatch('[a-f0-9]{64}', expected):
        raise ValueError('An exact SHA256 is required.')
    with urllib.request.urlopen(url, timeout=120) as response:
        if not response.url.startswith('https://'):
            raise ValueError('Insecure redirect refused.')
        data = response.read()
    if sha(data) != expected:
        raise ValueError('Public artifact digest mismatch.')
    return data


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('xb') as stream:
        stream.write(data)
    path.chmod(0o600)


def stage(destination):
    os.umask(0o077)
    destination = Path(destination).absolute()
    destination.mkdir(mode=0o700)  # Refuse partial/reused bundles.
    upstream = json.loads((ROOT / 'infra/selfhost/upstream.lock.json').read_bytes())
    tools = json.loads((ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes())
    files = {}
    for name, expected in upstream['files'].items():
        data = fetch('https://raw.githubusercontent.com/supabase/supabase/' + upstream['commit'] + '/docker/' + name, expected)
        write(destination / 'runtime' / name, data)
        files['runtime/' + name] = expected
    for name in ('compose.qa.yml', 'compose.https.yml', 'compose.r02.yml', 'Caddyfile',
                 'credential-template.json', 'images.qa.lock.json', 'upstream.lock.json'):
        target = 'compose.images.json' if name == 'images.qa.lock.json' else name
        data = (ROOT / 'infra/selfhost' / name).read_bytes()
        write(destination / 'runtime' / target, data)
        files['runtime/' + target] = sha(data)
    for item in tools['packages'] + [tools['node']]:
        name = item['url'].rsplit('/', 1)[1]
        data = fetch(item['url'], item['sha256'])
        write(destination / 'artifacts' / name, data)
        files['artifacts/' + name] = sha(data)
    base = 'https://download.docker.com/linux/ubuntu/'
    for name, url, key in [('docker.asc', base + 'gpg', 'signing_key_sha256'),
                           ('InRelease', base + 'dists/noble/InRelease', 'InRelease_sha256'),
                           ('Packages', base + 'dists/noble/stable/binary-amd64/Packages', 'Packages_sha256')]:
        data = fetch(url, tools['provenance'][key])
        write(destination / 'provenance' / name, data)
        files['provenance/' + name] = sha(data)
    # Keep exact reviewed helpers as transfer inputs; this never executes them.
    for source in sorted((ROOT / 'infra/scripts').iterdir()):
        if source.is_file() and source.suffix in ('.py', '.mjs', '.sh', '.json'):
            data = source.read_bytes()
            write(destination / 'helpers' / source.name, data)
            files['helpers/' + source.name] = sha(data)
    for name in ('r3-toolchain.lock.json', 'database-image-policy.json'):
        data = (ROOT / 'infra/selfhost' / name).read_bytes()
        write(destination / name, data)
        files[name] = sha(data)
    manifest = {'format': 1, 'files': files, 'image_transport': 'UNQUALIFIED',
                'install_authorized': False, 'secrets_included': False}
    write(destination / 'manifest.json', json.dumps(manifest, sort_keys=True, indent=2).encode())
    return manifest


def verify(directory):
    directory = Path(directory).absolute()
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Regular bundle directory required.')
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('Symlinked manifest refused.')
    manifest = json.loads(manifest_path.read_bytes())
    if set(manifest) != {'format', 'files', 'image_transport', 'install_authorized', 'secrets_included'} or manifest['format'] != 1:
        raise ValueError('Unknown bundle format.')
    if manifest['install_authorized'] is not False or manifest['secrets_included'] is not False:
        raise ValueError('Preparation manifest cannot grant installation authority.')
    actual = set()
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlinked bundle entry refused.')
        if path.is_file() and path != manifest_path:
            if path.stat().st_nlink != 1:
                raise ValueError('Hardlinked bundle entry refused.')
            actual.add(path.relative_to(directory).as_posix())
    if actual != set(manifest['files']):
        raise ValueError('Unexpected or missing bundle file.')
    for name, expected in manifest['files'].items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not re.fullmatch('[a-f0-9]{64}', expected):
            raise ValueError('Unsafe bundle path or hash.')
        if sha((directory / path).read_bytes()) != expected:
            raise ValueError('Bundle digest mismatch.')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['stage', 'verify'])
    parser.add_argument('directory')
    args = parser.parse_args()
    try:
        (stage if args.action == 'stage' else verify)(args.directory)
        print('PASS: local artifact operation completed; no installation or transfer authorized.')
    except Exception:
        raise SystemExit('FAIL: artifact preparation refused; partial directory preserved.')
