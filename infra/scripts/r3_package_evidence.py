"""Inspect pinned public archives without executing them; dependency closure stays OPEN."""
import argparse
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_bundle import digest, write_new
from r3_artifacts import ROOT
from r3_toolchain import install_argv, validate_lock


def control_files(archive):
    # ar is a read-only system archive utility, not a downloaded package tool.
    names = subprocess.check_output(['ar', 't', str(archive)], timeout=30).decode().splitlines()
    if names != ['debian-binary', 'control.tar.xz', 'data.tar.xz']:
        raise ValueError('Unreviewed Debian archive layout.')
    data = subprocess.check_output(['ar', 'p', str(archive), 'control.tar.xz'], timeout=30)
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe control path.')
            if member.isdir() and path == PurePosixPath('.'):
                continue
            if not member.isfile() or len(path.parts) != 1 or path.name in result:
                raise ValueError('Unexpected control member.')
            result[path.name] = tar.extractfile(member).read()
    return result


def fields(data):
    result = {}
    key = None
    for line in data.decode().splitlines():
        if line.startswith((' ', '\t')) and key:
            result[key] += '\n' + line
            continue
        key, value = line.split(':', 1)
        if key in result:
            raise ValueError('Duplicate control field.')
        result[key] = value.strip()
    return result


def inspect(artifacts, output):
    lock_bytes = (ROOT / 'infra/selfhost/r3-toolchain.lock.json').read_bytes()
    lock = json.loads(lock_bytes)
    validate_lock(lock)
    artifacts, output = Path(artifacts).absolute(), Path(output).absolute()
    archives = {}
    for item in lock['packages'] + [lock['node']]:
        path = artifacts / item['url'].rsplit('/', 1)[1]
        if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != item['sha256']:
            raise ValueError('Pinned archive differs.')
        archives[item.get('name', 'node')] = path
    output.mkdir(mode=0o700)
    packages = []
    for item in lock['packages']:
        controls = control_files(archives[item['name']])
        metadata = fields(controls['control'])
        if [metadata[k] for k in ('Package', 'Version', 'Architecture')] != [item['name'], item['version'], 'amd64']:
            raise ValueError('Package control identity differs.')
        folder = output / item['name']
        folder.mkdir(mode=0o700)
        for name, data in controls.items():
            write_new(folder / name, data)
        packages.append({**{k: item[k] for k in ('name', 'version', 'architecture', 'sha256')},
                         'relationships': {k: metadata.get(k, '') for k in
                                           ('Depends', 'Pre-Depends', 'Provides', 'Conflicts', 'Breaks', 'Replaces')},
                         'control_files': {name: digest(data) for name, data in controls.items()}})
    node_path = 'node-v22.23.3-linux-x64/bin/node'
    with tarfile.open(archives['node']) as tar:
        matches = [m for m in tar if m.name == node_path]
        if len(matches) != 1 or not matches[0].isfile():
            raise ValueError('Exactly one regular Node binary required.')
        node_hash = digest(tar.extractfile(matches[0]).read())
    report = {'format': 1, 'status': 'PINNED_ARCHIVE_ANALYSIS_ONLY',
              'lock_sha256': digest(lock_bytes), 'packages': packages,
              'node': {'archive_sha256': lock['node']['sha256'], 'binary_sha256': node_hash,
                       'path': '/opt/tonyai-tools/' + node_path, 'executed': False},
              'no_download_plan_argv': install_argv(
                  ['/var/lib/tonyai-r3/r3/artifacts/' + p['url'].rsplit('/', 1)[1] for p in lock['packages']], simulate=True),
              'target_inventory': None, 'dependency_closure': 'OPEN',
              'signature_verification': 'Not performed by this reader; retained run provenance has its own source binding.',
              'required_guest_evidence': [
                  'IMDS and OS image identity, /etc/os-release, architecture and boot ID',
                  'Complete dpkg-query status/version/architecture/Depends/Pre-Depends/Provides/Essential inventory',
                  'dpkg --audit, apt configuration/hooks and installed Essential package health',
                  'Recursive dependency/provider/version resolution by native APT/dpkg on the exact image',
                  'Exact five-package no-download/no-remove plan, zero removals, no additional candidates',
                  'Qualify the installer full pre/post dpkg inventory diff and exact five-pin transaction on the target',
                  'Observed apt-daily/upgrade timers and unattended-upgrades state; reviewed transaction isolation',
                  'Actual APT stdout/stderr hashes and executed-versus-simulated transaction comparison',
                  'Maintainer-script and trigger effects under masks, interruption, lock failure and reboot'],
              'install_authorized': False, 'qa_ready': False}
    write_new(output / 'package-analysis.json', json.dumps(report, indent=2).encode())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifacts')
    parser.add_argument('output')
    args = parser.parse_args()
    try:
        inspect(args.artifacts, args.output)
        print('PASS: archive analysis only; target closure remains OPEN.')
    except Exception:
        raise SystemExit('FAIL: archive analysis refused; preserve partial output.')
