"""Verify signed Docker package provenance and exact offline package candidates."""
import json
import re
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_artifacts import ROOT, HELPERS, RUNTIME, clean_source, source_bytes, sha, verify_snapshot, write


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
    manifest, _, reviewed = verify_snapshot(directory)
    expected_hash = approved_lock_sha256 or sha(source_bytes(clean_source(), 'infra/selfhost/r3-toolchain.lock.json'))
    return verify_toolchain_snapshot(directory, manifest, reviewed, expected_hash)


def verify_toolchain_snapshot(directory, manifest, reviewed, expected_hash):
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


def verify_source_manifest(manifest, source):
    """Bind the complete staged file set to this commit, including hidden edits."""
    read = lambda name: source_bytes(source, name)
    lock_bytes = read('infra/selfhost/r3-toolchain.lock.json')
    lock = json.loads(lock_bytes)
    upstream = json.loads(read('infra/selfhost/upstream.lock.json'))
    expected = {'runtime/' + name: digest for name, digest in upstream['files'].items()}
    for name in RUNTIME:
        target = 'compose.images.json' if name == 'images.qa.lock.json' else name
        expected['runtime/' + target] = sha(read('infra/selfhost/' + name))
    for name in HELPERS:
        expected['helpers/' + name] = sha(read('infra/scripts/' + name))
    expected['r3-toolchain.lock.json'] = sha(lock_bytes)
    expected['database-image-policy.json'] = sha(read('infra/selfhost/database-image-policy.json'))
    for item in lock['packages'] + [lock['node']]:
        expected['artifacts/' + item['url'].rsplit('/', 1)[1]] = item['sha256']
    expected.update({'provenance/' + name: value for name, value in manifest['provenance'].items()})
    if manifest['files'] != expected:
        raise ValueError('Bundle files differ from the committed source and pins.')
    return lock_bytes


def install_argv(paths, simulate=False, transaction_log=None):
    options = [] if transaction_log is None else ['-o', 'Dpkg::Options::=--log=' + str(transaction_log)]
    # APT 2.7's default PTY path calls setsid() in its dpkg child. Disable it
    # explicitly so the observer's bound APT process group remains applicable.
    return ['apt-get', '-o', 'DPkg::Lock::Timeout=60', '-o', 'Dpkg::Use-Pty=0', '--no-download', '--no-remove', '--no-install-recommends'] + options + (['--simulate'] if simulate else ['--yes']) + ['install', *paths]


def dependency_plan(lock, paths, diagnostics=None):
    if diagnostics is None:
        output = capture(install_argv(paths, simulate=True))
    else:
        result = subprocess.run(install_argv(paths, simulate=True), capture_output=True,
                                timeout=120, stdin=subprocess.DEVNULL)
        diagnostics.update(stdout=result.stdout, stderr=result.stderr, returncode=result.returncode)
        if result.returncode:
            raise ValueError('Offline simulation failed.')
        output = result.stdout.decode()
    return validate_dependency_plan(lock, output)


def validate_dependency_plan(lock, output):
    """Validate retained C-locale native output using the same strict grammar."""
    # A name-only check can accept a different candidate or a replacement of
    # existing package state. APT's C-locale simulation has no old [version]
    # field for these fresh installations.
    lines = [line for line in output.splitlines() if line.startswith('Inst ')]
    planned = [re.fullmatch(r'Inst ([a-z0-9.+-]+) \(([^ ()]+)(?: [^()]*)?\)', line) for line in lines]
    expected = {(item['name'], item['version']) for item in lock['packages']}
    configured = [re.fullmatch(r'Conf ([a-z0-9.+-]+) \(([^ ()]+)(?: [^()]*)?\)', line)
                  for line in output.splitlines() if line.startswith('Conf ')]
    # Fail closed on every unrecognised line, including alternate APT actions.
    # Only reviewed C-locale informational prose is allowed beside Inst/Conf.
    informational = (
        r'', r'Reading package lists\.\.\.', r'Building dependency tree\.\.\.',
        r'Reading state information\.\.\.', r'The following NEW packages will be installed:',
        rf'0 upgraded, {len(expected)} newly installed, 0 to remove and [0-9]+ not upgraded\.',
        r'Need to get (?:0 B|0 B/[0-9.]+ [kMGT]?B) of archives\.',
        r'After this operation, [0-9.]+ [kMGT]?B of additional disk space will be used\.',
    )
    names = {name for name, _ in expected}
    for line in output.splitlines():
        if line.startswith(('Inst ', 'Conf ')):
            continue
        if any(re.fullmatch(pattern, line) for pattern in informational):
            continue
        if line.startswith('  ') and line.split() and set(line.split()) <= names:
            continue
        raise ValueError('Unreviewed APT action or informational line.')
    if (any(match is None for match in planned) or len(planned) != len(expected)
            or {match.groups() for match in planned if match} != expected
            or any(match is None for match in configured) or len(configured) != len(expected)
            or {match.groups() for match in configured if match} != expected
            or any(line.startswith('Remv ') for line in output.splitlines())):
        raise ValueError('Offline plan must install exactly the five pinned packages, with no removal or extra dependency.')
    return output


def provenance_receipt(directory, output):
    """Retain public vendor evidence only after verification against this commit."""
    directory = Path(directory).absolute()
    source = clean_source()
    manifest, manifest_bytes, lock_bytes = verify_snapshot(directory)
    if manifest['source_sha'] != source:
        raise ValueError('Vendor bundle source differs from the checked-out commit.')
    approved_lock = verify_source_manifest(manifest, source)
    lock, _ = verify_toolchain_snapshot(directory, manifest, lock_bytes, sha(approved_lock))
    report = {
        'format': 1, 'status': 'VENDOR_ARTIFACT_PROVENANCE_PASS',
        'evidence_kind': 'real-vendor-artifacts-not-ci-fixture',
        'source_sha': source,
        'manifest_sha256': sha(manifest_bytes),
        'lock_sha256': sha(lock_bytes),
        'docker_signing_fingerprint': lock['docker_signing_fingerprint'],
        'provenance_sha256': manifest['provenance'],
        'packages': [{key: item[key] for key in ('name', 'version', 'architecture', 'sha256')}
                     for item in lock['packages']],
        'node': {key: lock['node'][key] for key in ('version', 'sha256')},
        'qa_ready': False, 'install_authorized': False,
        'unproven': ['Target OS dependency closure', 'Pinned engine and image store',
                     'Offline installer lifecycle and reboot', 'Offline image transport',
                     'Private database regression', 'Realtime source and GCM consumer',
                     'Final host source map, SSH, disks and custody', 'R4 and application readiness'],
    }
    if clean_source() != source:
        raise ValueError('Source changed during verification.')
    write(Path(output), json.dumps(report, sort_keys=True, indent=2).encode())
    return report


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Bundle and new receipt path required.')
        provenance_receipt(sys.argv[1], sys.argv[2])
        print('PASS: real vendor provenance receipt; installation and QA remain unqualified.')
    except Exception:
        raise SystemExit('FAIL: vendor verification refused; no receipt accepted.')
