"""Verify signed Docker package provenance and exact offline package candidates."""
import json
import re
from pathlib import Path
import subprocess
import tempfile

from r3_artifacts import ROOT, sha, verify


def capture(argv):
    result = subprocess.run(argv, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
    if result.returncode:
        raise ValueError('Toolchain verification failed; diagnostics withheld.')
    return result.stdout.decode()


def verify_index(directory, lock):
    """Authenticate current metadata; immutable package pins remain authoritative."""
    provenance = Path(directory) / 'provenance'
    armored = (provenance / 'InRelease').read_bytes()
    begin = b'-----BEGIN PGP SIGNED MESSAGE-----'
    sig = b'-----BEGIN PGP SIGNATURE-----'
    end = b'-----END PGP SIGNATURE-----'
    if (not armored.startswith(begin + b'\n') and not armored.startswith(begin + b'\r\n')
            or any(armored.count(marker) != 1 for marker in (begin, sig, end))
            or armored[armored.index(end) + len(end):] not in (b'', b'\n', b'\r\n')):
        raise ValueError('Exactly one signed block with no outer bytes required.')
    with tempfile.TemporaryDirectory() as home:
        gpg = ['gpg', '--batch', '--no-options', '--homedir', home]
        key = str(provenance / 'docker.asc')
        keys = capture(gpg + ['--with-colons', '--show-keys', key])
        fingerprints = [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')]
        if not fingerprints or fingerprints[0] != lock['docker_signing_fingerprint']:
            raise ValueError('Docker primary key differs.')
        keyring, plaintext = str(Path(home) / 'docker.gpg'), Path(home) / 'Release'
        capture(gpg + ['--output', keyring, '--dearmor', key])
        status = capture(gpg + ['--no-default-keyring', '--keyring', keyring,
            '--status-fd', '1', '--output', str(plaintext), '--decrypt', str(provenance / 'InRelease')])
        valid = [line.split() for line in status.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
        if len(valid) != 1 or lock['docker_signing_fingerprint'] not in (valid[0][2], valid[0][-1]):
            raise ValueError('Release signature differs.')
        release = plaintext.read_text()
    if [line for line in release.splitlines() if line.startswith('Suite:')] != ['Suite: noble']:
        raise ValueError('Release suite differs.')
    sections, current = {}, None
    for line in release.splitlines():
        if line and not line[0].isspace():
            current = line.split(':', 1)[0]
            if current in sections:
                raise ValueError('Duplicate Release field.')
            sections[current] = []
        elif line.strip() and current:
            sections[current].append(line.split())
    index = (provenance / 'Packages').read_bytes()
    matches = [row for row in sections.get('SHA256', []) if row[-1:] == ['stable/binary-amd64/Packages']]
    if matches != [[sha(index), str(len(index)), 'stable/binary-amd64/Packages']]:
        raise ValueError('Package index not bound by signed SHA256 section.')
    rows = [dict(line.split(': ', 1) for line in stanza.splitlines() if ': ' in line and not line.startswith(' '))
            for stanza in index.decode().split('\n\n')]
    for item in lock['packages']:
        matches = [r for r in rows if r.get('Package') == item['name'] and r.get('Version') == item['version']
                   and r.get('Architecture') == item['architecture']]
        if len(matches) != 1 or matches[0].get('SHA256') != item['sha256']:
            raise ValueError('Pinned package differs from signed index.')
    return {name: sha((provenance / name).read_bytes()) for name in ('docker.asc', 'InRelease', 'Packages')}


def validate_lock(lock):
    if (lock.get('format') != 2 or set(lock) != {'format', 'os', 'architecture', 'docker_signing_fingerprint', 'packages', 'node'}
            or lock['os'] != 'ubuntu-24.04' or lock['architecture'] != 'amd64'
            or not re.fullmatch('[A-F0-9]{40}', lock['docker_signing_fingerprint'])
            or len(lock['packages']) != 5 or len({p['name'] for p in lock['packages']}) != 5
            or any(p['architecture'] != 'amd64' for p in lock['packages'])):
        raise ValueError('Unsupported immutable toolchain lock.')


def verify_toolchain(directory, approved_lock_sha256=None):
    directory = Path(directory).absolute()
    manifest = verify(directory)
    reviewed = (directory / 'r3-toolchain.lock.json').read_bytes()
    expected_hash = approved_lock_sha256 or sha((ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes())
    if sha(reviewed) != expected_hash:
        raise ValueError('Different toolchain lock.')
    lock = json.loads(reviewed)
    validate_lock(lock)
    if verify_index(directory, lock) != manifest['provenance']:
        raise ValueError('Observed metadata hashes differ from manifest.')
    paths = []
    for item in lock['packages']:
        archive = directory / 'artifacts' / item['url'].rsplit('/', 1)[1]
        if sha(archive.read_bytes()) != item['sha256']:
            raise ValueError('Package archive hash mismatch.')
        metadata = capture(['dpkg-deb', '--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', str(archive)]).splitlines()
        if metadata != [item['name'], item['version'], 'amd64']:
            raise ValueError('Package control metadata differs.')
        paths.append(str(archive))
    node = directory / 'artifacts' / lock['node']['url'].rsplit('/', 1)[1]
    if sha(node.read_bytes()) != lock['node']['sha256']:
        raise ValueError('Node archive differs.')
    return lock, paths


def install_argv(paths, simulate=False):
    return ['apt-get', '-o', 'DPkg::Lock::Timeout=60', '--no-download', '--no-install-recommends'] + (['--simulate'] if simulate else ['--yes']) + ['install', *paths]


def dependency_plan(lock, paths):
    output = capture(install_argv(paths, simulate=True))
    planned = [line.split()[1] for line in output.splitlines() if line.startswith('Inst ')]
    if len(planned) != len(lock['packages']) or set(planned) != {item['name'] for item in lock['packages']} or any(line.startswith('Remv ') for line in output.splitlines()):
        raise ValueError('Offline plan must install exactly the five pinned packages, with no removal or extra dependency.')
