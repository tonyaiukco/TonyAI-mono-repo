"""Render the offline r02 guard payload. Never install, download or activate it."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_bundle import digest, write_new

SSH = b'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n'
MOUNTS = b'''[Unit]
RequiresMountsFor=/srv/tonyai/database /srv/tonyai/objects
[Service]
ExecStartPre=/usr/local/sbin/tonyai-runtime-guard
'''
IDENTITY = b'''[Unit]
Description=Publish the public SSH host fingerprint to Azure boot diagnostics
After=ssh.service
[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ExecStart=/usr/bin/ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub
ExecStart=/usr/bin/ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub
StandardOutput=journal+console
[Install]
WantedBy=multi-user.target
'''


def payload():
    return {
        '/etc/ssh/sshd_config.d/00-tonyai.conf': (SSH, 0o644),
        '/etc/systemd/system/docker.service.d/tonyai-mounts.conf': (MOUNTS, 0o644),
        '/etc/systemd/system/tonyai-host-identity.service': (IDENTITY, 0o644),
        '/usr/local/sbin/tonyai-runtime-guard':
            (Path(__file__).with_name('selfhost_runtime_guard.py').read_bytes(), 0o755),
    }


def prepare(output):
    """Only new local directories; final absolute destinations are metadata."""
    output = Path(output).absolute()
    output.mkdir(mode=0o700)
    entries = {}
    for index, (target, (data, mode)) in enumerate(sorted(payload().items())):
        name = f'guard-{index}'
        write_new(output / name, data)
        entries[target] = {'payload': name, 'sha256': digest(data),
                           'uid': 0, 'gid': 0, 'mode': oct(mode)}
    report = {'format': 1, 'status': 'PREPARED_NOT_INSTALLED',
              'files': entries, 'install_authorized': False,
              'excluded_entrypoints': ['selfhost_docker.sh', 'selfhost_host_guard.sh'],
              'node': 'Use the receipt-bound absolute Node binary; no download or PATH symlink.',
              'activation': 'Separate approval; leave policy-rc.d and all persistent masks in place.'}
    write_new(output / 'guard-plan.json', json.dumps(report, indent=2).encode())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output')
    args = parser.parse_args()
    try:
        prepare(args.output)
        print('PASS: offline guard files prepared locally; no host operation.')
    except Exception:
        raise SystemExit('FAIL: preparation refused; preserve partial output.')
