#!/usr/bin/env bash
# The same application Terraform path serves first deployment, rotation and rollback.
set -euo pipefail
set +x
exec python3 "$(dirname "$0")/deploy_apps.py" "$@"
