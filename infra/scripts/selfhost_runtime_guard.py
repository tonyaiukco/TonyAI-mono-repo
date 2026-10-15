#!/usr/bin/python3
"""Docker pre-start guard: real persistent mounts and no bridged-container IMDS access."""
import os
from pathlib import Path
import subprocess


def main():
    if os.geteuid() != 0:
        raise ValueError('Root required.')
    entries = [line.split() for line in Path('/etc/fstab').read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')]
    for name in ('database', 'objects'):
        target = '/srv/tonyai/' + name
        matching = [row for row in entries if len(row) > 2 and row[1] == target]
        if len(matching) != 1 or not matching[0][0].startswith('UUID=') or not os.path.ismount(target):
            raise ValueError('Required persistent disk is unavailable; Docker must stay stopped.')
        actual = subprocess.check_output(['findmnt', '-n', '-o', 'UUID', '--mountpoint', target], text=True).strip()
        if not actual or matching[0][0] != 'UUID=' + actual:
            raise ValueError('Persistent disk identity mismatch; Docker must stay stopped.')
    # Docker's iptables backend links DOCKER-USER during startup. Install before any container starts.
    if subprocess.run(['iptables', '-w', '-S', 'DOCKER-USER'], capture_output=True).returncode:
        subprocess.run(['iptables', '-w', '-N', 'DOCKER-USER'], check=True)
    # DNS must precede WireServer denial. Prefix insertion leaves unrelated rules intact.
    required = [
        ['-d', '169.254.169.254/32', '-j', 'DROP'],
        ['-d', '168.63.129.16/32', '-p', 'tcp', '-m', 'tcp', '--dport', '53', '-j', 'ACCEPT'],
        ['-d', '168.63.129.16/32', '-p', 'udp', '-m', 'udp', '--dport', '53', '-j', 'ACCEPT'],
        ['-d', '168.63.129.16/32', '-j', 'DROP'],
    ]
    def prefix():
        lines = subprocess.check_output(['iptables', '-w', '-S', 'DOCKER-USER'], text=True).splitlines()
        return [line for line in lines if line.startswith('-A ')][:len(required)]
    expected = ['-A DOCKER-USER ' + ' '.join(rule) for rule in required]
    if prefix() != expected:
        for rule in reversed(required):
            subprocess.run(['iptables', '-w', '-I', 'DOCKER-USER', '1', *rule], check=True)
    if prefix() != expected:
        raise ValueError('Container metadata firewall ordering did not read back.')



if __name__ == '__main__':
    main()
