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
import time
from urllib.request import Request, build_opener, ProxyHandler

# Support python3 -I -B on the transferred root-owned helper directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_bundle import encoded, write_new, private_read, digest
from replacement_host import validate_contract, validate_identity, safe_path
from r3_toolchain import verify_toolchain, dependency_plan, install_argv, capture
from r3_package_state import INVENTORY_ARGV, inventory, require_absent, inventory_diff, held_inventory, transaction
from r3_apt_observer import observe, validate as validate_observation, process_identity
import r3_install_policy as install_policy
import r3_maintenance
from r3_noble_common import run as bounded_run

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


def install(bundle, contract_path, approval_path, approved_hash, policy_path=None):
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
    expected = {'format': 2, 'action': 'r02-offline-toolchain-install',
                'contract_sha256': digest(contract_bytes),
                'manifest_sha256': digest((bundle / 'manifest.json').read_bytes()),
                'installer_sha256': digest(Path(__file__).read_bytes()),
                'package_state_sha256': digest(Path(__file__).with_name('r3_package_state.py').read_bytes()),
                'apt_observer_sha256': digest(Path(__file__).with_name('r3_apt_observer.py').read_bytes()),
                'toolchain_verifier_sha256': digest(Path(__file__).with_name('r3_toolchain.py').read_bytes()),
                'artifact_verifier_sha256': digest(Path(__file__).with_name('r3_artifacts.py').read_bytes()),
                'toolchain_lock_sha256': digest((bundle / 'r3-toolchain.lock.json').read_bytes()),
                'host_guard_sha256': digest(Path(__file__).with_name('replacement_host.py').read_bytes()),
                'bundle_helper_sha256': digest(Path(__file__).with_name('replacement_bundle.py').read_bytes()),
                'layout_sha256': digest(Path(__file__).with_name('replacement-source-layout.json').read_bytes())}
    policy = None
    if policy_path is not None:
        policy_bytes = private_read(policy_path)
        policy = install_policy.load(policy_bytes, approval.get('policy_sha256'))
        expected.update(format=3, action='r02-maintenance-toolchain-install', policy_sha256=digest(policy_bytes))
        for name in ('r3_install_policy.py', 'r3_maintenance.py', 'r3_noble_common.py', 'r3_noble_identity.py'):
            expected[name + '_sha256'] = digest(Path(__file__).with_name(name).read_bytes())
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
        'r3-install.stdout.log', 'r3-install.stderr.log', 'docker-packages.txt',
        'r3-package-evidence', 'r3-install.dpkg.log')]
    forbidden += [root + service for root in ('/run/systemd/system/', '/etc/systemd/system/') for service in SERVICES]
    if any(Path(p).exists() or Path(p).is_symlink() for p in forbidden):
        raise ValueError('Existing/partial installation refused; preserve and review.')
    # A dedicated toolchain install must not overwrite pre-existing package state.
    lock, paths = verify_toolchain(bundle, approval['toolchain_lock_sha256'])
    initial_state = None
    if policy is None:
        initial_state = observe()
        validate_observation(initial_state)
    before_raw = capture(INVENTORY_ARGV)
    before = inventory(before_raw)
    require_absent(before, lock)
    for item in lock['packages']:
        probe = subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', item['name']], capture_output=True)
        if probe.returncode == 0:
            raise ValueError('Existing Docker package state refused.')
    if capture(['dpkg', '--audit']).strip():
        raise ValueError('Pending or inconsistent package state refused.')
    node = bundle / 'artifacts' / lock['node']['url'].rsplit('/', 1)[1]
    check_node_archive(node)
    evidence = Path('/etc/tonyai/r3-package-evidence')
    if policy is not None:
        policy_facts = install_policy.facts()
        config = capture(['apt-config', 'dump']).encode()
        units = capture(['systemctl', 'cat', *r3_maintenance.UNITS]).encode()
        cache_before = install_policy.cache_snapshot()
        install_policy.preflight(policy, (bundle / 'r3-toolchain.lock.json').read_bytes(), before, config, policy_facts, units, cache_before)
        install_policy.cache_effects(cache_before, cache_before)
        safe_path('/etc/tonyai', directory=True)
        write_new('/etc/tonyai/r3-install-attempt.json', encoded(expected))
        evidence.mkdir(mode=0o700)
        write_new(evidence / 'installation-policy.json', policy_bytes)
        write_new(evidence / 'policy-facts-before.json', encoded(policy_facts))
        write_new(evidence / 'policy-config.txt', config)
        write_new(evidence / 'policy-units.txt', units)
        write_new(evidence / 'cache-before.json', encoded(cache_before))
        write_new(evidence / 'inventory-before-isolation.txt', before_raw.encode())
        deadline = time.monotonic() + 180
        def maintenance_command(argv, label, **kwargs):
            return bounded_run(argv, evidence, label, **kwargs)
        initial_state = r3_maintenance.isolate(evidence, before,
            lambda phase, timeout: inventory(bounded_run(INVENTORY_ARGV, evidence,
                phase + '-isolation-inventory', timeout=timeout).decode()), maintenance_command, deadline)
        if install_policy.facts() != policy_facts:
            raise ValueError('Native policy files changed during isolation')
    simulation = {}
    plan = dependency_plan(lock, paths, simulation)
    safe_path('/etc/tonyai', directory=True)
    if policy is None:
        write_new('/etc/tonyai/r3-install-attempt.json', encoded(expected))
    write_new('/etc/tonyai/r3-install-plan.txt', plan.encode())
    if policy is None:
        evidence.mkdir(mode=0o700)
    write_new(evidence / 'inventory-before.txt', before_raw.encode())
    write_new(evidence / 'simulation.stdout.log', simulation['stdout'])
    write_new(evidence / 'simulation.stderr.log', simulation['stderr'])
    write_new(evidence / 'initial-state.json', encoded(initial_state))
    samples = []

    def sample(phase, child=None):
        # Persist each observation before accepting it. A failed read also leaves
        # a refusal record; a detached APT child is never presumed terminated.
        name = f'state-{len(samples):04d}.json'
        try:
            observed = observe(check_locks=child is None)
        except Exception:
            write_new(evidence / name, encoded({'phase': phase, 'observation_failed': True}))
            raise
        write_new(evidence / name, encoded({'phase': phase, 'monotonic_ns': time.monotonic_ns(),
                                          'child': child, 'observation': observed}))
        samples.append(name)
        validate_observation(observed, initial_state, child)

    # Both dpkg maintainer scripts and systemd must be prevented from starting
    # daemons before the separately reviewed mount/firewall/source guards exist.
    write_new('/usr/sbin/policy-rc.d', b'#!/bin/sh\nexit 101\n')
    Path('/usr/sbin/policy-rc.d').chmod(0o755)
    capture(['systemctl', 'mask', *SERVICES])
    verify_masks()
    sample('before-apt')
    pre_execute_raw = capture(INVENTORY_ARGV)
    write_new(evidence / 'inventory-pre-execute.txt', pre_execute_raw.encode())
    if inventory(pre_execute_raw) != before:
        raise ValueError('Package inventory changed after simulation.')
    sample('before-spawn')
    transaction_path = Path('/etc/tonyai/r3-install.dpkg.log')
    write_new(transaction_path, b'')
    executed_argv = install_argv(paths, transaction_log=transaction_path)
    # Regular exclusive logs survive terminal/wrapper loss; no automatic retry.
    with open('/etc/tonyai/r3-install.stdout.log', 'xb') as out, open('/etc/tonyai/r3-install.stderr.log', 'xb') as err:
        process = subprocess.Popen(executed_argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
        write_new(evidence / 'child.json', encoded({'pid': process.pid, 'argv': executed_argv}))
        try:
            child = process_identity(Path('/proc') / str(process.pid))
        except FileNotFoundError:
            child = None
        while True:
            try:
                process.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if child is None:
                    raise ValueError('Missing package-manager child identity.')
                sample('apt-running', child)
        if process.returncode:
            raise ValueError('Offline installation failed; attempt/masks retained.')
    sample('after-apt')
    if capture(['dpkg', '--audit']).strip():
        raise ValueError('Post-install package audit failed.')
    after_raw = capture(INVENTORY_ARGV)
    write_new(evidence / 'inventory-after.txt', after_raw.encode())
    after = inventory(after_raw)
    diff = inventory_diff(before, after, lock)
    if policy is None:
        observed_actions = transaction(private_read(transaction_path).decode(), lock)
    else:
        after_facts = install_policy.facts()
        write_new(evidence / 'policy-facts-after.json', encoded(after_facts))
        cache_after = install_policy.cache_snapshot()
        write_new(evidence / 'cache-after.json', encoded(cache_after))
        observed_actions = install_policy.trigger_transaction(private_read(transaction_path).decode(), lock, policy)
        write_new(evidence / 'cache-effects.json', encoded(install_policy.cache_effects(cache_before, cache_after, policy)))
        if after_facts != policy_facts or capture(['apt-config', 'dump']).encode() != config:
            raise ValueError('Native policy configuration drift after installation')
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
    sample('before-receipt')
    final_raw = capture(INVENTORY_ARGV)
    write_new(evidence / 'inventory-final.txt', final_raw.encode())
    final = inventory(final_raw)
    inventory_diff(before, final, lock, held=True)
    held_inventory(after, final, lock)
    if capture(['dpkg', '--audit']).strip():
        raise ValueError('Final package audit failed.')
    sample('receipt-boundary')
    verify_masks()
    node_binary = Path('/opt/tonyai-tools/node-v22.23.3-linux-x64/bin/node')
    safe_path(node_binary)
    info = node_binary.stat()
    evidence_hashes = {f.name: digest(private_read(f)) for f in evidence.iterdir()}
    receipt = {'format': expected['format'], 'approval_sha256': approved_hash, 'binding': expected,
               'packages': installed, 'apt_plan_sha256': digest(plan.encode()),
               'package_transaction': {'inventory_diff': diff, 'held': True, 'actions': observed_actions,
                   'executed_argv': executed_argv, 'returncode': process.returncode,
                   'stdout_sha256': digest(private_read('/etc/tonyai/r3-install.stdout.log')),
                   'stderr_sha256': digest(private_read('/etc/tonyai/r3-install.stderr.log')),
                   'dpkg_log_sha256': digest(private_read(transaction_path)), 'evidence_sha256': evidence_hashes,
                   'observation_limit': 'Sampled units/processes and boundary lock probes; not continuous exclusion of privileged writers.'},
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
    parser.add_argument('--policy', help='Separate private reviewed maintenance policy; requires format-3 approval')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        install(args.bundle, args.contract, args.approval, args.approved_sha256, args.policy)
    except Exception:
        raise SystemExit('FAIL: offline installation refused/interrupted; preserve isolation and inspect privately.')
