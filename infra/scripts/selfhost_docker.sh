#!/usr/bin/env bash
# Owner-run Ubuntu 24.04 Docker installation after reviewed data-disk preparation.
set -euo pipefail
trap 'echo "FAIL: Docker bootstrap interrupted; use the recovery runbook before retrying." >&2' ERR
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && $(dpkg --print-architecture) == amd64 ]]
mountpoint -q /srv/tonyai/database
mountpoint -q /srv/tonyai/objects
cat > /etc/ssh/sshd_config.d/00-tonyai.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
chmod 0644 /etc/ssh/sshd_config.d/00-tonyai.conf
sshd -t
systemctl reload ssh
if command -v docker >/dev/null; then
  echo 'Docker already installed; verify recorded versions instead of rerunning bootstrap.' >&2
  exit 1
fi
[[ ! -f /etc/docker/daemon.json ]]
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq xz-utils iptables
bash "$(dirname "$0")/selfhost_host_guard.sh"
install -m 0755 -d /etc/apt/keyrings
keyfile=$(mktemp)
trap 'rm -f "$keyfile"' EXIT
curl --fail --silent --show-error --location --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o "$keyfile"
fingerprint=$(gpg --batch --show-keys --with-colons "$keyfile" 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}')
[[ "$fingerprint" == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]]
install -m 0644 "$keyfile" /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
chmod 0644 /etc/apt/sources.list.d/docker.sources
apt-get update -qq
install -d -m 0750 /etc/tonyai /etc/docker /etc/systemd/system/docker.service.d
# Resolve once, install exact versions, and retain the nonsecret package manifest.
packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
versions=()
for package in "${packages[@]}"; do
  version=$(apt-cache policy "$package" | awk '/Candidate:/ {print $2}')
  [[ -n "$version" && "$version" != '(none)' ]]
  versions+=("$package=$version")
done
printf '%s\n' "${versions[@]}" > /etc/tonyai/docker-packages.txt
cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":true,"firewall-backend":"iptables"}
EOF
cat > /etc/systemd/system/docker.service.d/tonyai-mounts.conf <<'EOF'
[Unit]
RequiresMountsFor=/srv/tonyai/database /srv/tonyai/objects
[Service]
ExecStartPre=/usr/local/sbin/tonyai-runtime-guard
EOF
chmod 0644 /etc/systemd/system/docker.service.d/tonyai-mounts.conf
systemctl daemon-reload
apt-get install -y -qq "${versions[@]}"
apt-mark hold "${packages[@]}" >/dev/null
systemctl enable --now docker
docker version --format 'Docker server: {{.Server.Version}}'
docker compose version
systemctl is-active docker
echo 'PASS: signed Docker packages installed with bounded logs and required persistent mounts.'
