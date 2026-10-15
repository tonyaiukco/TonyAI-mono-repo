"""Root-only generation, source and persistent-path guard. Never reads credentials."""
import hashlib
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import re
import stat
import subprocess
from urllib.request import Request, build_opener, ProxyHandler

CONTRACT = Path('/etc/tonyai/replacement.json')
RUNTIME = Path('/opt/tonyai/supabase')
PATHS = {'database': ('postgres', 'db-config', 'caddy-data', 'caddy-config'), 'objects': ('storage',)}


def safe_path(path, directory=False):
    path = Path(path)
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe root-owned path chain.')
    info = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('Unsafe root-owned path.')
    return path


def validate_contract(data):
    required = {'format', 'generation', 'vm_id', 'vm_uuid', 'os_disk_id', 'subscription_id', 'tenant_id', 'location',
                'public_hostname', 'operator_email', 'recovery_vault_url', 'source_sha256', 'files', 'disks'}
    if set(data) != required or data['format'] != 2 or data['generation'] != 'r02' or data['location'] != 'swedencentral':
        raise ValueError('Exact r02 host contract required.')
    from uuid import UUID
    for key in ('subscription_id', 'tenant_id', 'vm_uuid'):
        if str(UUID(data[key])) != data[key]:
            raise ValueError('Canonical identity required.')
    group = '/subscriptions/' + data['subscription_id'] + '/resourceGroups/tonyai-staging-data'
    stem = 'tonyai-staging-data-r02'
    if (data['vm_id'] != group + '/providers/Microsoft.Compute/virtualMachines/' + stem
            or data['os_disk_id'] != group + '/providers/Microsoft.Compute/disks/' + stem + '-os'
            or not re.fullmatch(r'https://tonyai-qa-r02-[a-z0-9]{8}\.vault\.azure\.net', data['recovery_vault_url'])
            or not re.fullmatch(r'tonyai-staging-[a-z0-9-]+\.swedencentral\.sysgen\.cloudapp\.azure\.com', data['public_hostname'])
            or not re.fullmatch(r"[^\s'<>@]+@[^\s'<>@]+\.[^\s'<>@]+", data['operator_email'])):
        raise ValueError('Wrong generation target.')
    if set(data['disks']) != set(PATHS):
        raise ValueError('Both independent data disks are required.')
    for index, name in enumerate(PATHS):
        disk = data['disks'][name]
        if set(disk) != {'id', 'uuid', 'lun', 'size_gib'} or disk != dict(id=group + '/providers/Microsoft.Compute/disks/' + stem + '-' + name,
                uuid=disk['uuid'], lun=index, size_gib=64 if name == 'database' else 32) or str(UUID(disk['uuid'])) != disk['uuid']:
            raise ValueError('Wrong disk binding.')
    if len({v['uuid'] for v in data['disks'].values()}) != 2:
        raise ValueError('Disk UUIDs must differ.')
    from replacement_bundle import encoded, digest
    if digest(encoded(data['files'])) != data['source_sha256']:
        raise ValueError('Source manifest digest mismatch.')
    required_files = {str(RUNTIME / name) for name in ('docker-compose.yml', 'compose.qa.yml', 'compose.https.yml',
                      'compose.r02.yml', 'compose.images.json', '.env.example', 'Caddyfile', 'credential-template.json')}
    required_files |= {'/usr/local/lib/tonyai/' + name for name in ('replacement_host.py', 'replacement_bundle.py', 'replacement_custody.py', 'replacement_custody_host.py', 'replacement_start.py', 'selfhost_pin.py', 'selfhost_init.mjs', 'selfhost_db_config.py', 'selfhost_disks.py', 'selfhost_docker.sh', 'selfhost_host_guard.sh')}
    required_files |= {'/usr/local/sbin/tonyai-runtime-guard'}
    layout = json.loads((Path(__file__).resolve().parent / 'replacement-source-layout.json').read_bytes())
    required_files |= set(layout)
    if set(data['files']) != required_files or not all(re.fullmatch('[a-f0-9]{64}', h) for h in data['files'].values()):
        raise ValueError('Incomplete bootstrap source manifest.')
    return data


def capture(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30, check=True)
    return result.stdout.strip()


def validate_identity(contract, compute):
    if (compute['resourceId'] != contract['vm_id'] or compute['vmId'] != contract['vm_uuid']
            or compute['location'].lower() != 'swedencentral'
            or compute['storageProfile']['osDisk']['managedDisk']['id'] != contract['os_disk_id']):
        raise ValueError('Wrong Azure host identity.')
    actual = {disk['lun']: disk['managedDisk']['id'] for disk in compute['storageProfile']['dataDisks']}
    if actual != {str(d['lun']): d['id'] for d in contract['disks'].values()}:
        raise ValueError('Wrong Azure data disk identity.')


def check_source_tree(files, runtime=RUNTIME):
    """Directory bind mounts must not execute unlisted SQL/functions/config files."""
    root = runtime / 'volumes'
    allowed = {Path(path) for path in files if Path(path).is_relative_to(root)}
    generated = root / 'api/envoy/lds.qa.yaml'
    allowed.add(generated)
    directories = {root}
    for path in allowed:
        directories.update(parent for parent in path.parents if parent.is_relative_to(root))
    for path in root.rglob('*'):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            if path not in directories:
                raise ValueError('Unreviewed bootstrap source directory.')
            safe_path(path, directory=True)
        elif path not in allowed or info.st_nlink != 1:
            raise ValueError('Unreviewed bootstrap source entry.')
        else:
            safe_path(path)
    if generated.exists():
        # The only generated source is the reviewed gateway log redaction.
        lines = (root / 'api/envoy/lds.template.yaml').read_text().splitlines(keepends=True)
        anchors = [i for i, line in enumerate(lines) if 'inline_string:' in line and '%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%' in line]
        if len(anchors) != 1:
            raise ValueError('Gateway template anchor changed.')
        lines[anchors[0]] = '                        inline_string: "%RESPONSE_CODE% %BYTES_RECEIVED% %BYTES_SENT% %DURATION%\\n"\n'
        if generated.read_text() != ''.join(lines):
            raise ValueError('Generated gateway source differs.')


def check(fresh=False):
    if os.geteuid() != 0:
        raise ValueError('Root required.')
    contract = validate_contract(json.loads(safe_path(CONTRACT).read_bytes()))
    request = Request('http://169.254.169.254/metadata/instance?api-version=2021-02-01', headers={'Metadata': 'true'})
    with build_opener(ProxyHandler({})).open(request, timeout=10) as response:
        validate_identity(contract, json.load(response)['compute'])
    for name, disk in contract['disks'].items():
        mount = safe_path('/srv/tonyai/' + name, directory=True)
        if not os.path.ismount(mount):
            raise ValueError('Persistent disk is not mounted.')
        actual = capture('findmnt', '-n', '-o', 'UUID,FSTYPE,FSROOT', '--mountpoint', str(mount)).split()
        if actual != [disk['uuid'], 'ext4', '/']:
            raise ValueError('Wrong filesystem or bind mount.')
        if fresh:
            if set(p.name for p in mount.iterdir()) - {'lost+found'}:
                raise ValueError('Fresh generation requires empty whole disks.')
            lost = mount / 'lost+found'
            if lost.exists() and (not safe_path(lost, directory=True) or any(lost.iterdir())):
                raise ValueError('Recovered filesystem content is not a fresh baseline.')
    for path, digest in contract['files'].items():
        if not (path.startswith('/opt/tonyai/') or path.startswith('/usr/local/lib/tonyai/') or path.startswith('/usr/local/sbin/tonyai-') or path in json.loads((Path(__file__).resolve().parent / 'replacement-source-layout.json').read_bytes())):
            raise ValueError('Unreviewed bootstrap path.')
        expected_upstream = json.loads((Path(__file__).resolve().parent / 'replacement-source-layout.json').read_bytes()).get(path)
        if expected_upstream and expected_upstream != digest:
            raise ValueError('Upstream digest differs from the reviewed lock.')
        if hashlib.sha256(safe_path(path).read_bytes()).hexdigest() != digest:
            raise ValueError('Bootstrap source differs.')
    daemon = json.loads(safe_path('/etc/docker/daemon.json').read_bytes())
    check_source_tree(contract['files'])
    if daemon != {'log-driver': 'local', 'log-opts': {'max-size': '10m', 'max-file': '3'}, 'live-restore': False, 'firewall-backend': 'iptables'}:
        raise ValueError('R02 requires bounded logs and explicit guarded restart.')
    if fresh:
        for path in (RUNTIME / '.env', Path('/etc/tonyai/initialization-r02.json'), Path('/etc/tonyai/escrow-r02-environment.json'), Path('/etc/tonyai/escrow-r02-intrinsic.json')):
            if path.exists() or path.is_symlink():
                raise ValueError('Existing or interrupted generation; never reset automatically.')
    return contract


if __name__ == '__main__':
    import sys
    try:
        if sys.argv[1:] != ['fresh']:
            raise ValueError('Only fresh check is supported by this CLI.')
        check(fresh=True)
        print('PASS: generation identity, source and empty disks verified.')
    except Exception:
        sys.exit('FAIL: generation guard refused; sensitive diagnostics withheld.')
