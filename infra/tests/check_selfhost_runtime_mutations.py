#!/usr/bin/env python3
"""Prove destructive disk and runtime boundary regressions fail offline tests."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTANTS = [
    ('format existing filesystem', 'selfhost_disks.py', "if not row['fstype']:", 'if True:'),
    ('skip signature detection', 'selfhost_disks.py', 'if signatures:', 'if False:'),
    ('skip target identity', 'selfhost_disks.py', "if not row['uuid'] or run('findmnt', '-n', '-o', 'UUID', '--mountpoint', target) != row['uuid']:", 'if False:'),
    ('duplicate data LUNs', 'selfhost_disks.py', 'if len({device for _, device, _, _ in checked}) != len(DISKS):', 'if False:'),
    ('public database binding', 'selfhost_pin.py', 'if expected is None and ports:', 'if False:'),
    ('skip port boundary', 'selfhost_pin.py', "if actual != [expected] or ports[0].get('protocol') != 'tcp':", 'if False:'),
    ('skip OTP and rate policy', 'selfhost_pin.py', 'if any(str(auth.get(key)) != value for key, value in policy.items()):', 'if False:'),
    ('allow implicit empty bind creation', 'selfhost_pin.py', "if volume.get('source', '').startswith('/srv/tonyai/') and volume.get('bind', {}).get('create_host_path') is not False:", 'if False:'),
    ('allow host privileges', 'selfhost_pin.py', "if service.get('privileged') or service.get('network_mode') == 'host' or service.get('pid') == 'host' or service.get('cap_add'):", 'if False:'),
    ('allow host socket', 'selfhost_pin.py', "if 'docker.sock' in volume.get('source', '') or volume.get('source') in ('/', '/proc', '/sys', '/dev'):", 'if False:'),
    ('allow wrong region', 'deployment_policy.py', "if str(subscription).lower() in policy['selfhost_sweden_subscriptions']:", 'if False:'),
    ('start escrow mismatch', 'selfhost_start.py', "if hashlib.sha256((root / '.env').read_bytes()).hexdigest() != marker['sha256']:", 'if False:'),
    ('start guard failure', 'selfhost_start.py', "subprocess.run(['/usr/local/sbin/tonyai-runtime-guard'], check=True)", 'pass'),
    ('start lock digest', 'selfhost_start.py', "if any(not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', service['image']) for service in locked['services'].values()):", 'if False:'),
    ('restore existing file', 'selfhost_restore_env.py', 'if target.exists() or target.is_symlink():', 'if False:'),
    ('restore exclusive create', 'selfhost_restore_env.py', 'os.O_WRONLY | os.O_CREAT | os.O_EXCL', 'os.O_WRONLY | os.O_CREAT'),
    ('restore mounts', 'selfhost_restore_env.py', "if os.geteuid() != 0 or not all(os.path.ismount('/srv/tonyai/' + name) for name in ('database', 'objects')):", 'if False:'),
    ('restore unsafe parent', 'selfhost_restore_env.py', 'if path.is_symlink() or not path.is_dir() or stat.st_uid != 0 or stat.st_mode & 0o022:', 'if False:'),
    ('escrow readback', 'selfhost_escrow.py', 'if current != data:', 'if False:'),
    ('escrow account', 'selfhost_escrow.py', "if account['id'] != contract['subscription_id'] or account['tenantId'] != contract['tenant_id']:", 'if False:'),
    ('escrow version', 'selfhost_escrow.py', "if not re.fullmatch('[a-f0-9]{32}', version):", 'if False:'),
    ('disk initialization consent', 'selfhost_disks.py', 'if not initialize or mounts:', 'if mounts:'),
    ('disk instance identity', 'selfhost_disks.py', "if compute['resourceId'].lower() != args.resource_id.lower():", 'if False:'),
    ('disk mounted UUID', 'selfhost_disks.py', "if run('findmnt', '-n', '-o', 'UUID', '--target', target) != expected_uuid:", 'if False:'),
    ('disk nofail', 'selfhost_disks.py', "MOUNT_OPTIONS = 'defaults,nodev,nosuid,nofail,x-systemd.device-timeout=30s'", "MOUNT_OPTIONS = 'defaults,nodev,nosuid,x-systemd.device-timeout=30s'"),
    ('disk timeout', 'selfhost_disks.py', "MOUNT_OPTIONS = 'defaults,nodev,nosuid,nofail,x-systemd.device-timeout=30s'", "MOUNT_OPTIONS = 'defaults,nodev,nosuid,nofail,x-systemd.device-timeout=60s'"),
    ('db marker', 'selfhost_db_config.py', 'if marker.read_text().strip() != image:', 'if False:'),
    ('db mount', 'selfhost_db_config.py', "if os.geteuid() != 0 or not os.path.ismount('/srv/tonyai/database'):", 'if False:'),
    ('db foreign config', 'selfhost_db_config.py', 'elif target.exists() and any(target.iterdir()):', 'elif False:'),
    ('runtime mounted UUID', 'selfhost_runtime_guard.py', "if not actual or matching[0][0] != 'UUID=' + actual:", 'if False:'),
    ('pin existing lock', 'selfhost_pin.py', 'if target.exists():', 'if False:'),
    ('pin pulled digest', 'selfhost_pin.py', 'if locked is not None and reference not in digests:', 'if False:'),
    ('gateway bind creation', 'selfhost_pin.py', "or gateway[0].get('bind', {}).get('create_host_path') is not False", 'or False'),
    ('gateway recovery generation', 'selfhost_start.py', '    redact_gateway()', '    pass'),
    ('gateway source verification', 'selfhost_pin.py', 'if hashlib.sha256(source).hexdigest() != GATEWAY_TEMPLATE_SHA256:', 'if False:'),
    ('WireServer ordering', 'selfhost_runtime_guard.py', 'for rule in reversed(required):', 'for rule in required:'),
    ('WireServer readback', 'selfhost_runtime_guard.py', 'if prefix() != expected:\n        raise ValueError', 'if False:\n        raise ValueError'),
    ('start omits image lock', 'selfhost_start.py', "'-f', 'compose.https.yml', '-f', 'compose.images.json']", "'-f', 'compose.https.yml']"),
    ('start skips composition validation', 'selfhost_start.py', '    validate(config)', '    pass'),
    ('start ignores guard exit', 'selfhost_start.py', "subprocess.run(['/usr/local/sbin/tonyai-runtime-guard'], check=True)", "subprocess.run(['/usr/local/sbin/tonyai-runtime-guard'], check=False)"),
    ('start omits health wait', 'selfhost_start.py', "['up', '-d', '--wait', '--wait-timeout', '240']", "['up', '-d', '--wait-timeout', '240']"),
    ('start ignores up failure', 'selfhost_start.py', 'if result.returncode:', 'if False:'),
    ('gateway retains tampered file', 'selfhost_pin.py', "    target.write_text(''.join(lines))", "    if not target.exists(): target.write_text(''.join(lines))"),
    ('gateway volume type', 'selfhost_pin.py', "or gateway[0].get('type') != 'bind'", 'or False'),
    ('gateway writable mount', 'selfhost_pin.py', "or gateway[0].get('read_only') is not True", 'or False'),
    ('gateway duplicate mounts', 'selfhost_pin.py', 'len(gateway) != 1', 'len(gateway) < 1'),
    ('restore checks only middle parent', 'selfhost_restore_env.py', "(Path('/opt'), root.parent, root)", '(root.parent,)'),
    ('restore allows group writable parent', 'selfhost_restore_env.py', 'stat.st_mode & 0o022', 'stat.st_mode & 0o002'),
    ('restore allows foreign parent owner', 'selfhost_restore_env.py', 'or stat.st_uid != 0', 'or False'),
    ('restore allows symlink parent', 'selfhost_restore_env.py', 'if path.is_symlink() or', 'if False or'),
    ('restore allows nondirectory parent', 'selfhost_restore_env.py', 'or not path.is_dir()', 'or False'),
    ('escrow omits restore payload', 'selfhost_escrow.py', "        capture(ssh + ['sudo python3 /home/tonyaiops/selfhost_restore_env.py'], data)", '        pass'),
    ('escrow ignores restore failure', 'selfhost_escrow.py', "        capture(ssh + ['sudo python3 /home/tonyaiops/selfhost_restore_env.py'], data)", "        try:\n            capture(ssh + ['sudo python3 /home/tonyaiops/selfhost_restore_env.py'], data)\n        except ValueError:\n            pass"),
    ('escrow follows vault redirects', 'selfhost_escrow.py', 'build_opener(NoRedirect())', 'build_opener()'),
    ('disk skips second destination preflight', 'selfhost_disks.py', 'for name, device, target, row in checked:\n        check_destination', 'for name, device, target, row in checked[:1]:\n        check_destination'),
    ('runtime skips mount check', 'selfhost_runtime_guard.py', 'or not os.path.ismount(target)', 'or False'),
    ('WireServer omits TCP DNS', 'selfhost_runtime_guard.py', "        ['-d', '168.63.129.16/32', '-p', 'tcp', '-m', 'tcp', '--dport', '53', '-j', 'ACCEPT'],\n", ''),
    ('WireServer omits UDP DNS', 'selfhost_runtime_guard.py', "        ['-d', '168.63.129.16/32', '-p', 'udp', '-m', 'udp', '--dport', '53', '-j', 'ACCEPT'],\n", ''),
    ('Node archive owner restoration', 'selfhost_host_guard.sh', 'tar --no-same-owner -xJf', 'tar -xJf'),
    ('Node ownership only on install', 'selfhost_host_guard.sh', 'fi\nchown -R root:root "$node_root"', 'chown -R root:root "$node_root"\nfi'),
]


def run(root):
    # The clean control must not leave bytecode that a same-size mutant can reuse.
    return subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(root / 'tests'), '-p', 'test_selfhost_*.py'],
                          capture_output=True, text=True,
                          env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})


def copy_fixture(project):
    """Preserve repository-relative CLI and Terraform references in disposable copies."""
    target = project / 'infra'
    for folder in ('scripts', 'tests', 'config', 'selfhost', 'terraform'):
        shutil.copytree(ROOT / folder, target / folder,
                        ignore=shutil.ignore_patterns('__pycache__', '.terraform'))
    return target


def main():
    if run(ROOT).returncode: raise SystemExit('FAIL: selfhost baseline failed.')
    for name, file, before, after in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='tonyai-runtime-mutant-') as directory:
            target = copy_fixture(Path(directory))
            baseline = run(target)
            if baseline.returncode:
                raise SystemExit('FAIL: unmodified disposable-copy baseline failed: ' + name + '\n' + baseline.stderr[-1500:])
            path = target / 'scripts' / file; source = path.read_text()
            if source.count(before) != 1: raise SystemExit('FAIL: mutation anchor drift: ' + name)
            path.write_text(source.replace(before, after))
            result = run(target)
            if result.returncode == 0 or 'FAIL:' not in result.stderr or 'ERROR:' in result.stderr or 'ImportError' in result.stderr:
                raise SystemExit('FAIL: mutant survived or failed outside assertions: ' + name + '\n' + result.stderr[-1500:])
            print('KILLED: ' + name)
    print('PASS: all selfhost runtime mutations detected.')


if __name__ == '__main__': main()
