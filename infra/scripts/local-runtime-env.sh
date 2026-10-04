#!/usr/bin/env bash
# Sourced by local container launchers from the repository root.
# Never use a forwarded database port; provision's loopback guard is not proof of locality.
prepare_local_runtime() {
  set +x
  : "${DIRECT_URL:?Set DIRECT_URL to the local owner connection}"
  export RUNTIME_DB_PASSWORD
  # Preserve the host .env credential; provision repairs LOGIN without rotating it.
  RUNTIME_DB_PASSWORD=$(node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { isLoopbackUrl, urlUser, RUNTIME_ROLE } from './packages/db/scripts/runtime-role.mjs';
const existing = process.env.DATABASE_URL;
let password = '';
try {
  if (existing && isLoopbackUrl(existing) && urlUser(existing) === RUNTIME_ROLE) {
    password = decodeURIComponent(new URL(existing).password);
  }
} catch { /* An invalid URL is not a reusable local credential. */ }
process.stdout.write(password || randomBytes(32).toString('hex'));
JS
  )
  # The existing provisioner validates loopback + query allowlist and sends SCRAM.
  # Suppress raw client errors too: some drivers include connection details.
  if ! node packages/db/scripts/runtime-role.mjs provision >/dev/null 2>&1; then
    unset RUNTIME_DB_PASSWORD
    echo 'Local runtime login provisioning failed; verify local setup privately.' >&2
    return 1
  fi
  export DATABASE_URL
  DATABASE_URL=$(node --input-type=module -e 'import { runtimeUrlFrom } from "./packages/db/scripts/runtime-role.mjs"; process.stdout.write(runtimeUrlFrom(process.env.DIRECT_URL, process.env.RUNTIME_DB_PASSWORD))')
  unset RUNTIME_DB_PASSWORD
}
