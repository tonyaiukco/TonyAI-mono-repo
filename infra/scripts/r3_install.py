#!/usr/bin/env python3
"""Separately approved offline Docker/Node installation on the bound empty r02 host.

No disk formatting, credential generation, containers, Azure writes or daemon
activation. Failures preserve the attempt journal and service masks for review.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import subprocess
import sys
import tarfile
from urllib.request import Request, build_opener, ProxyHandler

# Support python3 -I -B on the transferred root-owned helper directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_bundle import encoded, write_new, private_read, digest
from replacement_host import validate_contract, validate_identity, safe_path
from r3_toolchain import verify_toolchain, dependency_plan, install_argv, capture

DAEMON = {'log-driver': 'local', 'log-opts': {'max-size': '10m', 'max-file': '3'},
          'live-restore': False, 'firewall-backend': 'iptables'}
SERVICES = ['docker.service', 'docker.socket', 'containerd.service']


def verify_masks(directory=Path('/etc/systemd/system')):
    for service in SERVICES:
        path = directory / service
        if not path.is_symlink() or os.readlink(path) != '/dev/null':
            raise ValueError('Persistent service mask missing.')


def check_node_archive(node):
    """Read every member before any host write; extraction repeats the data filter."""
    root = 'node-v22.23.3-linux-x64'
    with tarfile.open(node) as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if (name.is_absolute() or '..' in name.parts
                    or not (member.name == root or member.name.startswith(root + '/'))):
                raise ValueError('Node archive root differs.')
            if member.name == root and not member.isdir():
                raise ValueError('Node archive root must be a directory.')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError('Node archive special member refused.')
            if member.issym() or member.islnk():
                target = member.linkname
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), target) if member.issym() else target)
                if target.startswith('/') or not (resolved == root or resolved.startswith(root + '/')):
                    raise ValueError('Node archive link escapes its root.')
            # Validate Python's extraction safety policy without extracting.
            tarfile.data_filter(member, '/opt/tonyai-tools')


def install(bundle, contract_path, approval_path, approved_hash):
    if os.geteuid() != 0 or platform.machine() != 'x86_64' or platform.freedesktop_os_release().get('VERSION_ID') != '24.04' or platform.freedesktop_os_release().get('ID') != 'ubuntu':
        raise ValueError('Root on Ubuntu 24.04 amd64 required.')
    if any(k.startswith(('APT_', 'DPKG_', 'LD_')) or k in ('PYTHONPATH', 'PYTHONHOME', 'DEBIAN_FRONTEND') for k in os.environ):
        raise ValueError('Ambient installation overrides refused.')
    os.environ.clear()
    os.environ.update(PATH='/usr/sbin:/usr/bin:/sbin:/bin', HOME='/root', LANG='C', DEBIAN_FRONTEND='noninteractive')
    bundle = safe_path(Path(bundle).absolute(), directory=True)
    for path in bundle.rglob('*'):
        safe_path(path, directory=path.is_dir())
    approval_bytes = private_read(approval_path)
    if digest(approval_bytes) != approved_hash:
        raise ValueError('Exact separate install approval required.')
    approval = json.loads(approval_bytes)
    contract_bytes = private_read(contract_path)
    contract = validate_contract(json.loads(contract_bytes))
    expected = {'format': 1, 'action': 'r02-offline-toolchain-install',
                'contract_sha256': digest(contract_bytes),
                'manifest_sha256': digest((bundle / 'manifest.json').read_bytes()),
                'installer_sha256': digest(Path(__file__).read_bytes()),
                'toolchain_verifier_sha256': digest(Path(__file__).with_name('r3_toolchain.py').read_bytes()),
                'artifact_verifier_sha256': digest(Path(__file__).with_name('r3_artifacts.py').read_bytes()),
                'toolchain_lock_sha256': digest((bundle / 'r3-toolchain.lock.json').read_bytes()),
                'host_guard_sha256': digest(Path(__file__).with_name('replacement_host.py').read_bytes()),
                'bundle_helper_sha256': digest(Path(__file__).with_name('replacement_bundle.py').read_bytes()),
                'layout_sha256': digest(Path(__file__).with_name('replacement-source-layout.json').read_bytes())}
    if approval != expected:
        raise ValueError('Install approval binding differs.')
    if Path(__file__).resolve().parent != bundle / 'helpers':
        raise ValueError('Execute only the approved transferred helper directory.')
    request = Request('http://169.254.169.254/metadata/instance?api-version=2021-02-01', headers={'Metadata': 'true'})
    with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
        validate_identity(contract, json.load(response)['compute'])
    forbidden = ['/usr/bin/docker', '/usr/bin/containerd', '/etc/docker/daemon.json', '/usr/sbin/policy-rc.d',
                 '/opt/tonyai-tools', '/var/lib/docker', '/var/lib/containerd', '/etc/tonyai/r3-install-attempt.json']
    forbidden += ['/etc/tonyai/' + name for name in (
        'r3-installed-receipt.json', 'r3-install-complete.json', 'r3-install-plan.txt',
        'r3-install.stdout.log', 'r3-install.stderr.log', 'docker-packages.txt')]
    forbidden += [root + service for root in ('/run/systemd/system/', '/etc/systemd/system/') for service in SERVICES]
    if any(Path(p).exists() or Path(p).is_symlink() for p in forbidden):
        raise ValueError('Existing/partial installation refused; preserve and review.')
    # A dedicated toolchain install must not overwrite pre-existing package state.
    lock, paths = verify_toolchain(bundle, approval['toolchain_lock_sha256'])
    for item in lock['packages']:
        probe = subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', item['name']], capture_output=True)
        if probe.returncode == 0:
            raise ValueError('Existing Docker package state refused.')
    if capture(['dpkg', '--audit']).strip():
        raise ValueError('Pending or inconsistent package state refused.')
    plan = dependency_plan(lock, paths)
    node = bundle / 'artifacts' / lock['node']['url'].rsplit('/', 1)[1]
    check_node_archive(node)
    safe_path('/etc/tonyai', directory=True)
    write_new('/etc/tonyai/r3-install-attempt.json', encoded(expected))
    write_new('/etc/tonyai/r3-install-plan.txt', plan.encode())
    # Both dpkg maintainer scripts and systemd must be prevented from starting
    # daemons before the separately reviewed mount/firewall/source guards exist.
    write_new('/usr/sbin/policy-rc.d', b'#!/bin/sh\nexit 101\n')
    Path('/usr/sbin/policy-rc.d').chmod(0o755)
    capture(['systemctl', 'mask', *SERVICES])
    verify_masks()
    # Regular exclusive logs survive terminal/wrapper loss; no automatic retry.
    with open('/etc/tonyai/r3-install.stdout.log', 'xb') as out, open('/etc/tonyai/r3-install.stderr.log', 'xb') as err:
        process = subprocess.Popen(install_argv(paths), stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
        process.wait()
        if process.returncode:
            raise ValueError('Offline installation failed; attempt/masks retained.')
    installed = []
    for item in lock['packages']:
        actual = capture(['dpkg-query', '-W', '-f=${Package}\n${Version}\n${Architecture}\n${db:Status-Status}', item['name']]).splitlines()
        if actual != [item['name'], item['version'], 'amd64', 'installed']:
            raise ValueError('Installed package readback differs.')
        installed.append(dict(zip(('name', 'version', 'architecture', 'status'), actual)))
    verify_masks()
    Path('/opt/tonyai-tools').mkdir(mode=0o755)
    Path('/opt/tonyai-tools').chmod(0o755)
    with tarfile.open(node) as archive:
        archive.extractall('/opt/tonyai-tools', filter='data')
    for path in Path('/opt/tonyai-tools').rglob('*'):
        if path.is_dir() and not path.is_symlink():
            path.chmod(0o755)
    if capture(['/opt/tonyai-tools/node-v22.23.3-linux-x64/bin/node', '--version']).strip() != 'v22.23.3':
        raise ValueError('Installed Node differs.')
    Path('/etc/docker').mkdir(mode=0o755, exist_ok=True)
    Path('/etc/docker').chmod(0o755)
    write_new('/etc/docker/daemon.json', encoded(DAEMON))
    write_new('/etc/tonyai/docker-packages.txt', ''.join(item['name'] + '=' + item['version'] + '\n' for item in lock['packages']).encode())
    capture(['apt-mark', 'hold', *[item['name'] for item in lock['packages']]])
    node_binary = Path('/opt/tonyai-tools/node-v22.23.3-linux-x64/bin/node')
    safe_path(node_binary)
    info = node_binary.stat()
    receipt = {'format': 1, 'approval_sha256': approved_hash, 'binding': expected,
               'packages': installed, 'apt_plan_sha256': digest(plan.encode()),
               'node': {'path': str(node_binary), 'sha256': digest(node_binary.read_bytes()),
                        'version': '22.23.3', 'uid': info.st_uid, 'gid': info.st_gid,
                        'mode': oct(info.st_mode & 0o7777)},
               'services_masked': SERVICES, 'activation_authorized': False}
    write_new('/etc/tonyai/r3-installed-receipt.json', encoded(receipt))
    write_new('/etc/tonyai/r3-install-complete.json', encoded(expected))
    # Deliberately keep masks/policy until a distinct reviewed activation stage.
    print('PASS: pinned toolchain installed; daemons remain masked. Bootstrap is not authorized.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('bundle', 'contract', 'approval', 'approved-sha256'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        install(args.bundle, args.contract, args.approval, args.approved_sha256)
    except Exception:
        raise SystemExit('FAIL: offline installation refused/interrupted; preserve isolation and inspect privately.')
