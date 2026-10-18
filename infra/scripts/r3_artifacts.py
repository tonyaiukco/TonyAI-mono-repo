#!/usr/bin/env python3
"""Stage public, pinned R3 inputs locally. No SSH, install, cloud or secret access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
HELPERS = ('r3_artifacts.py', 'r3_toolchain.py', 'r3_install.py', 'replacement_host.py',
           'replacement_bundle.py', 'replacement-source-layout.json', 'selfhost_init.mjs', 'selfhost_pin.py')
RUNTIME = ('compose.qa.yml', 'compose.https.yml', 'compose.r02.yml', 'Caddyfile',
           'credential-template.json', 'images.qa.lock.json', 'upstream.lock.json')


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], stderr=subprocess.DEVNULL)


def clean_source():
    if git('status', '--porcelain', '--untracked-files=normal').strip():
        raise ValueError('A clean committed source tree is required.')
    return git('rev-parse', 'HEAD').decode().strip()


def source_bytes(source_sha, name):
    path = ROOT / name
    if not path.is_file() or path.is_symlink():
        raise ValueError('Regular tracked source required.')
    data = git('show', source_sha + ':' + name)
    if data != path.read_bytes():
        raise ValueError('Source changed during staging.')
    return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, expected=None):
    if not url.startswith('https://'):
        raise ValueError('HTTPS source required.')
    if expected is not None and not re.fullmatch('[a-f0-9]{64}', expected):
        raise ValueError('An exact SHA256 is required.')
    with urllib.request.urlopen(url, timeout=120) as response:
        if not response.url.startswith('https://'):
            raise ValueError('Insecure redirect refused.')
        data = response.read()
    if expected is not None and sha(data) != expected:
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
    source_sha = clean_source()
    read = lambda name: source_bytes(source_sha, name)
    upstream = json.loads(read('infra/selfhost/upstream.lock.json'))
    tools = json.loads(read('infra/selfhost/r3-toolchain.lock.json'))
    from r3_toolchain import validate_lock, verify_index
    validate_lock(tools)
    files = {}
    for name, expected in upstream['files'].items():
        data = fetch('https://raw.githubusercontent.com/supabase/supabase/' + upstream['commit'] + '/docker/' + name, expected)
        write(destination / 'runtime' / name, data)
        files['runtime/' + name] = expected
    for name in RUNTIME:
        target = 'compose.images.json' if name == 'images.qa.lock.json' else name
        data = read('infra/selfhost/' + name)
        write(destination / 'runtime' / target, data)
        files['runtime/' + target] = sha(data)
    for item in tools['packages'] + [tools['node']]:
        name = item['url'].rsplit('/', 1)[1]
        data = fetch(item['url'], item['sha256'])
        write(destination / 'artifacts' / name, data)
        files['artifacts/' + name] = sha(data)
    base = 'https://download.docker.com/linux/ubuntu/'
    for name, url in [('docker.asc', base + 'gpg'),
                       ('InRelease', base + 'dists/noble/InRelease'),
                       ('Packages', base + 'dists/noble/stable/binary-amd64/Packages')]:
        data = fetch(url)
        write(destination / 'provenance' / name, data)
        files['provenance/' + name] = sha(data)
    observed = verify_index(destination, tools)
    # An explicit reviewed allowlist, read from this clean commit, never globbed
    # local scripts. The final runtime source map remains a separate R3 gate.
    for name in HELPERS:
        data = read('infra/scripts/' + name)
        write(destination / 'helpers' / name, data)
        files['helpers/' + name] = sha(data)
    for name in ('r3-toolchain.lock.json', 'database-image-policy.json'):
        data = read('infra/selfhost/' + name)
        write(destination / name, data)
        files[name] = sha(data)
    if clean_source() != source_sha:
        raise ValueError('Source changed during staging.')
    manifest = {'format': 2, 'source_sha': source_sha, 'provenance': observed,
                'files': files, 'image_transport': 'UNQUALIFIED', 'install_authorized': False}
    write(destination / 'manifest.json', json.dumps(manifest, sort_keys=True, indent=2).encode())
    return manifest


def verify(directory):
    directory = Path(directory).absolute()
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('Regular bundle directory required.')
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_symlink() or not stat.S_ISREG(manifest_path.lstat().st_mode) or manifest_path.stat().st_nlink != 1:
        raise ValueError('Symlinked manifest refused.')
    manifest = json.loads(manifest_path.read_bytes())
    if (set(manifest) != {'format', 'source_sha', 'provenance', 'files', 'image_transport', 'install_authorized'}
            or manifest['format'] != 2 or not re.fullmatch('[a-f0-9]{40}', manifest['source_sha'])):
        raise ValueError('Unknown bundle format.')
    if manifest['install_authorized'] is not False or manifest['image_transport'] != 'UNQUALIFIED':
        raise ValueError('Preparation manifest cannot grant installation authority.')
    if (set(manifest['provenance']) != {'docker.asc', 'InRelease', 'Packages'}
            or any(manifest['files'].get('provenance/' + name) != value
                   for name, value in manifest['provenance'].items())):
        raise ValueError('Observed provenance binding differs.')
    allowed_dirs = {str(parent) for name in manifest['files'] for parent in Path(name).parents if str(parent) != '.'}
    actual = set()
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('Symlinked bundle entry refused.')
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise ValueError('Special bundle entry refused.')
        if path.is_dir() and path.relative_to(directory).as_posix() not in allowed_dirs:
            raise ValueError('Unlisted bundle directory refused.')
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
