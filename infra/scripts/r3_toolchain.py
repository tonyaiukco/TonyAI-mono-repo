"""Verify signed Docker package provenance and exact offline package candidates."""
import json
from pathlib import Path
import subprocess
import tempfile

from r3_artifacts import ROOT, sha, verify


def capture(argv):
    result = subprocess.run(argv, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
    if result.returncode:
        raise ValueError('Toolchain verification failed; diagnostics withheld.')
    return result.stdout.decode()


def verify_toolchain(directory, approved_lock_sha256=None):
    directory = Path(directory).absolute()
    verify(directory)
    reviewed = (directory / 'r3-toolchain.lock.json').read_bytes()
    expected_hash = approved_lock_sha256 or sha((ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes())
    if sha(reviewed) != expected_hash:
        raise ValueError('Different toolchain lock.')
    lock = json.loads(reviewed)
    provenance = directory / 'provenance'
    for name, key in [('docker.asc', 'signing_key_sha256'), ('InRelease', 'InRelease_sha256'), ('Packages', 'Packages_sha256')]:
        if sha((provenance / name).read_bytes()) != lock['provenance'][key]:
            raise ValueError('Provenance bytes differ.')
    with tempfile.TemporaryDirectory() as home:
        gpg = ['gpg', '--batch', '--no-options', '--homedir', home]
        keys = capture(gpg + ['--with-colons', '--show-keys', str(provenance / 'docker.asc')])
        fingerprints = [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')]
        if not fingerprints or fingerprints[0] != lock['docker_signing_fingerprint']:
            raise ValueError('Docker primary key differs.')
        capture(gpg + ['--import', str(provenance / 'docker.asc')])
        status = capture(gpg + ['--status-fd', '1', '--verify', str(provenance / 'InRelease')])
        valid = [line.split() for line in status.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
        if len(valid) != 1 or lock['docker_signing_fingerprint'] not in (valid[0][2], valid[0][-1]):
            raise ValueError('Release signature differs.')
    index = (provenance / 'Packages').read_bytes()
    expected = [sha(index), str(len(index)), 'stable/binary-amd64/Packages']
    release = (provenance / 'InRelease').read_text()
    if expected not in [line.split() for line in release.splitlines()]:
        raise ValueError('Package index not bound by signed release.')
    rows = []
    for stanza in index.decode().split('\n\n'):
        rows.append(dict(line.split(': ', 1) for line in stanza.splitlines() if ': ' in line and not line.startswith(' ')))
    paths = []
    for item in lock['packages']:
        archive = directory / 'artifacts' / item['url'].rsplit('/', 1)[1]
        matches = [r for r in rows if r.get('Package') == item['name'] and r.get('Version') == item['version'] and r.get('Architecture') == 'amd64']
        if len(matches) != 1 or matches[0].get('SHA256') != item['sha256'] or sha(archive.read_bytes()) != item['sha256']:
            raise ValueError('Package signature chain/hash mismatch.')
        metadata = capture(['dpkg-deb', '--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', str(archive)]).splitlines()
        if metadata != [item['name'], item['version'], 'amd64']:
            raise ValueError('Package control metadata differs.')
        paths.append(str(archive))
    node = directory / 'artifacts' / lock['node']['url'].rsplit('/', 1)[1]
    if sha(node.read_bytes()) != lock['node']['sha256']:
        raise ValueError('Node archive differs.')
    return lock, paths


def install_argv(paths, simulate=False):
    return ['apt-get', '--no-download', '--no-install-recommends'] + (['--simulate'] if simulate else ['--yes']) + ['install', *paths]


def dependency_plan(lock, paths):
    output = capture(install_argv(paths, simulate=True))
    planned = [line.split()[1] for line in output.splitlines() if line.startswith('Inst ')]
    if len(planned) != len(lock['packages']) or set(planned) != {item['name'] for item in lock['packages']} or any(line.startswith('Remv ') for line in output.splitlines()):
        raise ValueError('Offline plan must install exactly the five pinned packages, with no removal or extra dependency.')
