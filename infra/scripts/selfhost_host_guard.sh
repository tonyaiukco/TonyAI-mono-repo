#!/usr/bin/env bash
# Idempotent host hardening, also used to complete a partially interrupted bootstrap.
set -euo pipefail
umask 077
trap 'echo "FAIL: host hardening interrupted; inspect the failed step before resuming." >&2' ERR
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
for disk in database objects; do mountpoint -q "/srv/tonyai/$disk"; done
cat > /etc/ssh/sshd_config.d/00-tonyai.conf <<'CONFIG'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONFIG
chmod 0644 /etc/ssh/sshd_config.d/00-tonyai.conf
sshd -t
systemctl reload ssh
cat > /etc/systemd/system/tonyai-host-identity.service <<'IDENTITY'
[Unit]
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
IDENTITY
chmod 0644 /etc/systemd/system/tonyai-host-identity.service
systemctl enable tonyai-host-identity.service >/dev/null
install -d -m 0750 /etc/tonyai /etc/systemd/system/docker.service.d
install -m 0755 "$(dirname "$0")/selfhost_runtime_guard.py" /usr/local/sbin/tonyai-runtime-guard
cat > /etc/systemd/system/docker.service.d/tonyai-mounts.conf <<'UNIT'
[Unit]
RequiresMountsFor=/srv/tonyai/database /srv/tonyai/objects
[Service]
ExecStartPre=/usr/local/sbin/tonyai-runtime-guard
UNIT
chmod 0644 /etc/systemd/system/docker.service.d/tonyai-mounts.conf
systemctl daemon-reload
/usr/local/sbin/tonyai-runtime-guard
# Use an exact official Node 22 distribution, not Ubuntu's Node 18 package.
node_root=/opt/tonyai-tools/node-v22.23.3-linux-x64
if [[ ! -x "$node_root/bin/node" ]]; then
  node_archive=$(mktemp)
  trap 'rm -f "$node_archive"' EXIT
  curl --fail --silent --show-error --location --proto '=https' https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz -o "$node_archive"
  printf '%s  %s\n' df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de "$node_archive" | sha256sum --check --status
  install -d -m 0755 /opt/tonyai-tools
  tar --no-same-owner -xJf "$node_archive" -C /opt/tonyai-tools
fi
chown -R root:root "$node_root"
ln -sfn "$node_root/bin/node" /usr/local/bin/node
[[ $(node --version) == v22.23.3 ]]
if command -v docker >/dev/null; then
  python3 - <<'PY'
import json
from pathlib import Path
p = Path('/etc/docker/daemon.json')
c = json.loads(p.read_text())
if c.get('firewall-backend', 'iptables') != 'iptables':
    raise SystemExit('Review firewall backend migration before restarting Docker.')
c['firewall-backend'] = 'iptables'
p.write_text(json.dumps(c) + '\n')
p.chmod(0o600)
PY
  apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
echo 'PASS: SSH, mounted-disk startup guard, container IMDS block and Node 22 installed.'
