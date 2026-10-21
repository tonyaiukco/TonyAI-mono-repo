#!/usr/bin/env python3
"""Create an immutable local transfer archive and exact offline install proposal.

This tool never contacts SSH or installs packages. The proposal is deliberately
not executable approval: dependency closure, signatures, image transport and
authenticated host identity require their own evidence before R3 execution.
"""
import argparse
import io
import json
import os
from pathlib import Path
import tarfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from r3_artifacts import ROOT, sha, verify, write
from r3_toolchain import install_argv


def prepare(directory, output):
    directory, output = Path(directory).absolute(), Path(output).absolute()
    manifest = verify(directory)
    lock = json.loads((directory / 'r3-toolchain.lock.json').read_bytes())
    reviewed = (ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes()
    if (directory / 'r3-toolchain.lock.json').read_bytes() != reviewed:
        raise ValueError('Toolchain lock differs from reviewed source.')
    expected = {item['url'].rsplit('/', 1)[1]: item['sha256'] for item in lock['packages'] + [lock['node']]}
    if {name.removeprefix('artifacts/'): value for name, value in manifest['files'].items() if name.startswith('artifacts/')} != expected:
        raise ValueError('Artifact set differs from toolchain lock.')
    os.umask(0o077)
    output.mkdir(mode=0o700)
    archive = output / 'transfer.tar'
    # Fixed regular entries only. No symlinks, traversal, ownership metadata,
    # interpolated shell commands, credentials or ambient filesystem files.
    with archive.open('xb') as stream, tarfile.open(fileobj=stream, mode='w') as tar:
        for name in sorted([*manifest['files'], 'manifest.json']):
            data = (directory / name).read_bytes()
            info = tarfile.TarInfo('r3/' + name)
            info.size, info.mode, info.mtime = len(data), 0o600, 0
            tar.addfile(info, io.BytesIO(data))
    archive.chmod(0o600)
    packages = ['/var/lib/tonyai-r3/r3/artifacts/' + item['url'].rsplit('/', 1)[1] for item in lock['packages']]
    proposal = {
        'format': 1, 'status': 'NOT_EXECUTABLE_APPROVAL', 'azure_mutations_authorized': False,
        'archive_sha256': sha(archive.read_bytes()),
        'manifest_sha256': sha((directory / 'manifest.json').read_bytes()),
        'toolchain_sha256': sha(reviewed), 'packages': lock['packages'], 'node': lock['node'],
        'proposed_install_argv': ['python3', '-I', '-B', '/var/lib/tonyai-r3/r3/helpers/r3_install.py',
            '--bundle', '/var/lib/tonyai-r3/r3', '--contract', '/etc/tonyai/replacement.json',
            '--approval', '/var/lib/tonyai-r3/install-approval.json',
            '--approved-sha256', '<SEPARATELY_APPROVED_INSTALL_APPROVAL_SHA256>'],
        'installer_internal_apt_argv': install_argv(packages, transaction_log='/etc/tonyai/r3-install.dpkg.log'),
        'install_approval_format': 2,
        'invocation_note': '-B prevents helper __pycache__ writes that invalidate the manifest; never invoke apt directly.',
        'required_before_install': [
            'Authenticate new SSH host key independently; strict known-host verification for transfer',
            'Bind new VM UUID, resource IDs, OS and data disk IDs to fresh readback and IMDS',
            'Verify Docker signing key fingerprint, InRelease signature and Packages hash chain',
            'Qualify exact .deb control metadata, signatures and offline dependency closure on agreed target',
            'Qualify r3_install.py against the transferred layout, root ownership and exclusive attempt journal',
            'Review separate apt isolation: five units persistently masked/inactive; no foreign package writer or lock owner',
            'Qualify full inventory comparison, native dpkg transaction log and observation sampling on the exact Noble target',
            'Resolve target man-db trigger interests, path exclusions and APT hooks against a real Noble fixture before any install; non-pin triggers refuse after mutation',
            'Suppress package auto-start; review and preserve any existing policy-rc.d and persistent systemd mask state',
            'Install r02 live-restore=false daemon and mount/firewall guards before any daemon start',
            'Bind every installed source file and Node binary to finalized host contract',
            'Qualify offline image transport retaining exact digest-addressable images and amd64 identity',
            'Separate explicit owner approval of exact install/transfer/format/start/custody operations'],
        'failure_action': 'Stop; preserve partial files, journal and isolation; no retry/reset/cleanup',
    }
    write(output / 'install-proposal.json', json.dumps(proposal, indent=2).encode())
    return proposal


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        prepare(args.bundle, args.output)
        print('PASS: local transfer archive and pinned install proposal prepared; no remote operation.')
    except Exception:
        raise SystemExit('FAIL: transfer preparation refused; partial output preserved.')
