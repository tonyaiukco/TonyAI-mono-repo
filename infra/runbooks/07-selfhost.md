# Azure self-hosted Supabase: owner-run host foundation

The additive `selfhost` Terraform root creates a VM, network, persistent disks and an owner-only recovery vault. It does **not** install Supabase, mount disks, configure backups, connect
applications or establish QA/production readiness. Do not point the existing
hosted Supabase helpers at this VM or weaken their Frankfurt/project validation.

## Operating constraints

The owner selected Sweden Central for QA and intended production on 2026-10-15.
QA (`staging`) and production use separate groups, networks, VMs, disks and secret sets.
The application layer has not been created. Production provisioning is also
blocked until owned-domain integration, recovery acceptance and the legacy-key
decision are complete; the currently executable bootstrap is QA-only. `deployment-policy.json` blocks the
legacy hosted/Germany foundation and application roots for this subscription,
in both Python and direct Terraform validation. Do not remove that gate until
the explicit Sweden VNet/selfhost integration is reviewed. The planning file and
CLAUDE.md are updated by the other lane after owner merge, not by this worktree. Pilot maintenance windows are acceptable.
Recovery targets are RPO 15 minutes and RTO 4 hours for **database and uploaded
bytes**, including evidence and import sources. Neither target is proven here.
LRS disks and Terraform deletion guards are not backups or availability guarantees.

The owner removed the former TRY 10,000 monthly limit and reports an expected
USD 25,000 Azure credit allocation. Activation, eligibility, expiration and
remaining balance of this new allocation are not yet verified. The QA target is
2026-11-15. Size for the workload and verify the chosen SKU is available to this
subscription; credit allocation does not remove regional/SKU restrictions.
Include VMs, Container Apps, disks, public IPs, registry, logs, email and backups
in the estimate. Configure a separately agreed operating alert threshold; alerts are not spending caps. Non-USD retail prices are indicative.

## Owner access and capacity

Use Azure CLI browser login with MFA and verify tenant/subscription. New tenants
may block device-code flow; do not disable security defaults to make it work.
Register Compute, Network, Storage, App, ContainerRegistry, KeyVault,
OperationalInsights, Insights, ManagedIdentity and Communication providers.
Registration does not create workloads.

Check Sweden Central regional and DASv7-family quotas, SKU restrictions,
and `Microsoft.Compute/EncryptionAtHost` registration. Resolve capacity/features
before applying; do not silently downgrade encryption or boot security. Resolve
an exact Canonical `ubuntu-24_04-lts:server` version compatible with Gen2/Trusted
Launch and NVMe. The host explicitly selects the NVMe disk controller. CLI image filters may also return daily/gen1 variants: filter returned
offer and SKU for equality.

No independent GitHub human reviewer is currently available. Use owner-run
deployment; do not enable unattended OIDC or remove existing reviewer gates.

## State, inputs and commands

Use the existing Entra-only backend bootstrap and owner-only `foundation`
container. No new access goes to the application deployer. Keys are
`staging-selfhost.tfstate` and `production-selfhost.tfstate`, distinct from both
existing roots. Follow existing backend firewall and state-recovery procedures.

Set backend `location` to `swedencentral` explicitly; the legacy hosted path
defaults to Germany West Central. Existing backend resources cannot change region.

Copy `infra/config/selfhost.example.json` to a private directory outside the repo.
Replace all placeholders; use a current public operator IPv4 `/32`, an exact
verified image version and a dedicated RSA public SSH key (2048+ bits, no comment).
Keep the private key in protected owner SSH storage. Never put passwords, JWT
keys, private keys, cloud-init secrets or SMTP credentials in these inputs.

With pinned Terraform on PATH, run from the reviewed checkout:

```sh
python3 infra/scripts/terraform_run.py selfhost plan \
  --backend /private/path/backend.json --inputs /private/path/selfhost.json
python3 infra/scripts/terraform_run.py selfhost apply \
  --backend /private/path/backend.json --inputs /private/path/selfhost.json
python3 infra/scripts/terraform_run.py selfhost output \
  --backend /private/path/backend.json --inputs /private/path/selfhost.json
```

Apply is interactive; review source, target, costs and plan before approval.
`approved-apply` is prohibited. Direct Terraform invocation skips strict Python
field/public-key/IP checks and is not the supported cloud entrypoint. Mock tests
use synthetic key/image fixtures and do not prove live Azure acceptance.

After apply, repeat the plan and require no changes. Read back the VM size,
location, NVMe controller, Trusted Launch and encryption settings from Azure.
For first SSH trust, compare the host public-key fingerprint with Azure boot
diagnostics obtained through authenticated Azure access before accepting it.
Do not treat an unverified ssh-keyscan as authentication. The host guard
publishes public host fingerprints to the boot console for independent
comparison. On IP-only migration reuse the verified VM host keys, not new TOFU.
Connect with the dedicated owner SSH key and a persistent known-hosts file;
never disable host-key checking. Check `cloud-init status`, available memory
and `lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS`. NVMe device names are not stable
identifiers: identify data disks by their Azure LUN before any mount/format step.
Empty data disks at this stage are expected, not a running database.

Namecheap access is not a prerequisite for initial QA. The active public IP has an
Azure-managed `NoReuse` DNS label with a generated hash, exported as `public_hostname`. Use that hostname for
the temporary Supabase HTTPS origin after gateway/TLS verification. Preserve
the IP resource while clients reference this hostname. The original unscoped IP
is retained, detached and locked for rollback; do not release its label. DNS
label scope is creation-only. Scoped Azure DNS is a QA bridge, not a production
domain commitment; production requires the owned domain and a new acceptance pass. A later custom-domain
cutover also changes Auth redirects, JWT issuer, API configuration and the
environment-bound web build; retest login, password reset and signed downloads.

For the proposed permanent QA origin `supabase.qa.tonyai.io`, the DNS owner creates an A
record named `supabase.qa` in the `tonyai.io` zone using the exported public IP.
Confirm the name and inspect existing records before replacing any record.
Keep public HTTPS closed until the gateway configuration has been reviewed;
DNS resolution alone does not establish TLS or service readiness. Web/API DNS
targets come from the later Container Apps deployment, not this VM's public IP.

## Resource boundary

- Group `tonyai-<environment>-data` does not duplicate the app foundation group.
- Staging network is `10.80.0.0/16`, production `10.81.0.0/16`; host subnet
  `.0.0/24`, reserved app subnet `.2.0/23`, host IP `.0.4`.
- Standard static IPv4 supplies explicit outbound access and owner SSH. Inbound
  SSH permits only the operator `/32`; PostgreSQL 5432 permits only the app subnet.
  An explicit deny blocks other inbound traffic, including default VNet access.
  Studio, pooler and Docker ports are not public.
- Initial `https_enabled=false` closes public 443 until gateway authentication
  and TLS are verified. Port 80 stays closed; use a reviewed TLS-ALPN-01 challenge
  on 443 for the Azure hostname, or DNS validation for a controlled custom zone.
- D2as_v7/D4as_v7 uses Trusted Launch, secure boot, vTPM, encryption at host,
  public-key login and no extensions/custom data. Its identity has no grants.
- Separate 64-GiB database and 32-GiB object disks use Standard SSD LRS, prohibit
  public disk export and use no host caching. VM disks/NIC detach on deletion;
  Terraform guards protect host/network/IP/NIC/disks/group from destruction.
  These guards do not prevent deletion outside Terraform.
- Managed boot diagnostics is enabled. OS and data disks deny public export.
  Group-level and both-IP `CanNotDelete` locks protect portal/CLI deletion;
  removing a lock requires a reviewed recovery/decommission plan.
- OS patching is image-default, not an operational patch schedule. Establish
  owner maintenance/patch/reboot procedures before readiness.

Treat the pinned image and initial SSH public key as creation inputs; do not
assume Azure supports changing them in place. Plan a reviewed image replacement
or host-authorized key rotation rather than trying a speculative VM update.

Check CIDR collisions before connecting networks. App-subnet delegation does not
connect Container Apps: add a reviewed VNet input to the existing foundation
**before** its managed environment is first created. Both app and data resources must be in Sweden Central; a Germany managed
environment cannot join this VNet. The current application root cannot yet
deploy against this host, and its legacy path is blocked for this subscription.
Do not create a managed environment until the same-region infrastructure subnet
ID is present in its creation request; this cannot be retrofitted safely.

## QA runtime bootstrap

The Terraform root remains host-only. The separate owner-run runtime helpers
under `infra/scripts/selfhost_*` install the reviewed official Supabase snapshot
in `infra/selfhost/upstream.lock.json`. Keep runtime files in the root-only
`/opt/tonyai/supabase` directory. Transfer helpers and overlays from the reviewed
checkout over host-key-verified SSH; do not run upstream reset/setup/update scripts.

1. Run `selfhost_disks.py --resource-id <exact-VM-ARM-ID>` as root. Only for new
   disks whose creation/identity and empty state were verified, add
   `--initialize-empty-disks`. Both LUNs, existing mounts and fstab entries are
   checked before formatting. Existing owned filesystems are reused; foreign
   filesystems, partitions, occupied destinations or signatures cause refusal.
   Owned entries migrate to `nofail,x-systemd.device-timeout=30s`, allowing SSH
   recovery when a disk is missing. Docker still requires both mounts and an
   exact UUID match via its pre-start guard; it must not start on OS directories.
2. Run `selfhost_docker.sh` once on the fresh Ubuntu 24.04 amd64 host. It verifies
   the official Docker signing key, installs exact resolved packages (recorded
   at `/etc/tonyai/docker-packages.txt`), bounds container logs and makes Docker
   depend on both persistent mounts. It disables direct root/password SSH.
   `selfhost_host_guard.sh` is independently rerunnable to repair SSH hardening,
   the mount/IMDS pre-start guard and the SHA256-pinned Node 22 installation.
   Docker packages are held for reviewed upgrades, not automatic version drift.
   After a partial install, inspect the recorded package manifest and installed
   versions before resuming; do not rerun fresh bootstrap over an existing Docker
   installation or delete its daemon configuration. Use the iptables backend;
   the DOCKER-USER prefix drops bridged-container IMDS traffic and WireServer traffic before startup, except TCP/UDP DNS port 53 to WireServer. DNS accepts precede the WireServer drop; the guard verifies the complete order.
   Privileged, host-network, capability-added and Docker-socket mounts are refused.
3. Reboot and rerun the disk helper without initialization; verify Docker and
   both mounts before creating runtime data.
4. Run `selfhost_fetch.py <upstream.lock.json> /opt/tonyai/supabase`; every source
   file must match its locked digest. Verified nonsecret source files are 0644
   and their nested directories 0755 so container users can read mounted SQL
   and config; the runtime root remains private and `.env` remains 0600.
   Copy `compose.qa.yml`, `compose.https.yml`
   and `Caddyfile` from `infra/selfhost/` into that directory.
5. Save the exact exported `public_hostname` and the operator email in root-owned
   `/etc/tonyai/host.json` (mode 0600). Run
   `selfhost_init.mjs /opt/tonyai/supabase` with Node 22 as root. It reads this
   reviewed contract rather than accepting a caller-supplied origin, requires
   both disks mounted and rejects writable/symlinked runtime parents. It refuses existing credentials/data and creates fresh secrets in
   `.env` mode 0600. Do not print/source this file or run upstream key generators:
   those generators print secret material. Host runtime files are a necessary
   exception to the hosted-helper memory/Key Vault transport; they must be
   included in encrypted recovery and never enter Terraform, logs or Git.
   Auth requires exactly one private ES256 key with `key_ops` containing `sign`;
   verification keys contain only `verify`. Preserve key material when repairing
   metadata; never rerun initialization over an existing environment.
6. Before starting any runtime, save and verify the environment through the
   owner-only Key Vault escrow procedure below. From that directory, run `selfhost_pin.py <images.qa.lock.json>` as root,
   using the reviewed image lock from `infra/selfhost/`. It verifies effective
   private bindings, mounts and Auth policy, removes URL/Referer gateway access
   logging, pulls the exact recorded image digests and records them in
   `compose.images.json`. Retain this nonsecret image lock with release evidence.
   Default `COMPOSE_FILE` includes all safety/digest overlays; missing locks fail
   closed. Omitting the lock resolves upstream tags for a new reviewed upgrade
   only. Repinning an existing runtime lock is refused.
7. Run `selfhost_db_config.py` as root in the runtime directory before the first
   database start. Unlike a Docker named volume, a host bind mount does not copy
   image defaults. This helper seeds the empty persistent config directory from
   the pinned image, preserving all included configuration and extension files.
   Preserve the source directory's owner/group/mode as well: pgsodium must be
   able to create its encryption key there during first boot.
   It refuses unknown content and refuses fresh config seeding whenever PGDATA
   is nonempty. Existing configurations must retain the required static files,
   `conf.d` and the original nonempty `pgsodium_root.key`. Missing configuration
   or encryption material requires recovery, never regeneration beside a
   surviving cluster.
   `python3 selfhost_start.py` starts private services only after matching the
   environment to its verified escrow hash, checking mounts/UUIDs and validating
   the exact four-file composition including all immutable image overrides.
   Persistent bind mounts use `create_host_path: false`; a missing directory
   causes failure rather than creating an empty PostgreSQL cluster.
   Gateway binds loopback 8000; PostgreSQL has no published port yet. Supavisor
   and Functions are behind the unused profile. Auth signs ES256 user tokens;
   signup/anonymous/phone registration are disabled. OTP length is 10; verify
   and password/refresh endpoints have an explicit IP limit using the edge-owned
   X-Forwarded-For header. SMTP is not configured.
8. Run `selfhost_auth_smoke.mjs` as root. It checks public-only JWKS, disabled
   signup, denied anonymous administration, app-assigned user UUIDs, signed
   ES256 password login and AMR preservation through refresh, removing its
   synthetic Auth user. It sends no email and does not seed application data.
   `--edge` tests the real TLS/SNI proxy through loopback while the NSG remains
   closed. Service-role create/reconcile/delete always stay on loopback. It also
   checks forged JWT rejection, blocked/mixed-case/noncanonical routes and a
   rapid bounded burst reaching 429 despite changing spoofed forwarding headers.
   An ambiguous create timeout reports unresolved cleanup; reconcile its synthetic
   UUID before rerunning. Never interpret that failure as successful cleanup.
9. Validate Caddy with its pinned image before enabling the `https` profile and
   opening Terraform's explicit 443 rule. Only allowlisted Auth/Storage/REST routes pass;
   Studio, Meta, Functions and MCP are not public. Caddy uses TLS-ALPN-01 over
   TCP443, with no HTTP/UDP listener or access logging. Verify the issued
   certificate and denied routes from an external client. Repeat `--edge` Auth
   smoke and inspect status-only results. Caddy strips untrusted forwarding
   overrides, filters request objects from runtime error logs, and sends HSTS.
   After changing Caddyfile, validate then restart Caddy; its admin API is disabled.

Preserve PostgreSQL, its pgsodium config and Caddy state on the database disk;
object bytes live on the separate object disk. These mounts are not backups.
The temporary Auth site URL is the Supabase origin until the web URL exists;
update exact redirects and complete SMTP before invite/recovery acceptance.
Strict private database TLS, application migrations/buckets/roles, Container
Apps integration, backups and full QA acceptance remain separate required work.

## Apply the review corrections to an existing QA host

This procedure is documentation only. Local review evidence does not authorize
or establish a live rollout. Obtain separate owner approval for the maintenance
window, host changes, acceptance requests and reboot before executing any step.
Preserve the reviewed nonsecret rollback bundle and exact image lock. Do not
repin images, initialize disks, regenerate credentials or print the environment.

1. Over host-key-verified SSH, stage the reviewed `Caddyfile` and `compose.qa.yml`
   from `infra/selfhost/`, and `selfhost_start.py`, `selfhost_pin.py`,
   `selfhost_auth_smoke.mjs`, `selfhost_smoke_expectations.mjs`,
   `selfhost_runtime_guard.py` and `selfhost_host_guard.sh` from `infra/scripts/`.
   Install the overlays in `/opt/tonyai/supabase`; keep the helpers together in
   `/home/tonyaiops`, including the new smoke expectation module. Preserve the
   root-only runtime directory and existing `.env`, `compose.images.json`,
   `compose.https.yml`, upstream template and data directories.
2. As root, rerun `bash /home/tonyaiops/selfhost_host_guard.sh`. This reinstalls
   `/usr/local/sbin/tonyai-runtime-guard`, applies the ordered IMDS/WireServer
   rules and normalizes Node ownership even when Node is already installed.
   It does not reinstall Docker or verify an existing Node tree's contents.
3. Inspect `/opt/tonyai/supabase/volumes/api/envoy/lds.qa.yaml`. If an earlier
   short bind left a directory there, stop and inspect its contents. Remove an
   empty leftover directory manually with `rmdir`; do not recursively delete
   unknown content. Resolve any symlink separately. Guarded start refuses these
   cases with an explicit instruction to inspect and manually remove the
   leftover directory or symlink. Keep `lds.template.yaml` intact. A missing or
   tampered regular `lds.qa.yaml` is regenerated from the digest-verified template
   without changing the image lock.
4. In a root shell, validate the actual Caddyfile through the locked composition,
   then start through the escrow/mount/composition guard:

   ```sh
   cd /opt/tonyai/supabase
   docker compose --env-file .env \
     -f docker-compose.yml -f compose.qa.yml -f compose.https.yml \
     -f compose.images.json --profile https run --rm --no-deps caddy \
     caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   python3 /home/tonyaiops/selfhost_start.py --https
   ```

   Require successful validation before starting. Caddy's admin API is disabled,
   and a changed bind-mounted Caddyfile alone does not make Compose restart an
   existing container. After guarded start succeeds, restart Caddy explicitly
   to load it, using the same four locked files:

   ```sh
   docker compose --env-file .env \
     -f docker-compose.yml -f compose.qa.yml -f compose.https.yml \
     -f compose.images.json --profile https restart caddy
   node /home/tonyaiops/selfhost_auth_smoke.mjs
   node /home/tonyaiops/selfhost_auth_smoke.mjs --edge
   ```

5. Both smoke modes must pass. The valid login token must reach Storage (200),
   the deliberately missing REST table (404 / `PGRST205`) and Auth user (200).
   Both forged tokens must produce Storage 400 / `statusCode: "403"` /
   `error: "Unauthorized"`, REST 401 / `PGRST301`, and Auth 403 / `bad_jwt`.
   A generic 400 or an Envoy RBAC 403 is not acceptance evidence.
6. From an external client, use `curl --path-as-is` against the reviewed HTTPS
   origin for each path below. Save response headers and body to separate
   temporary files; require HTTP 404, the exact bytes `Not found` (no newline),
   no `www-authenticate` and no `x-envoy-upstream-service-time`. No credentials
   are needed for these probes. Do not use `-k` or follow redirects.

   ```text
   /rest/v1/..;/..;/auth/v1/recover
   /rest/v1/..;/..;/project/default
   /Auth/v1/user
   /storage/v1/s3
   ```

   Example invocation with the owner-verified origin:

   ```sh
   curl --path-as-is --silent --show-error --max-time 15 \
     --dump-header /private/path/edge-headers --output /private/path/edge-body \
     --write-out '%{http_code}\n' \
     'https://<reviewed-public-hostname>/rest/v1/..;/..;/auth/v1/recover'
   ```

7. Check `iptables -S DOCKER-USER`. Ignoring the chain declaration (`-N`), the
   first four rule lines must be exactly these, before any existing RETURN:

   ```text
   -A DOCKER-USER -d 169.254.169.254/32 -j DROP
   -A DOCKER-USER -d 168.63.129.16/32 -p tcp -m tcp --dport 53 -j ACCEPT
   -A DOCKER-USER -d 168.63.129.16/32 -p udp -m udp --dport 53 -j ACCEPT
   -A DOCKER-USER -d 168.63.129.16/32 -j DROP
   ```

   From a container on the actual Supabase bridge, require bounded TCP probes
   to `169.254.169.254:80` and `168.63.129.16:80` to fail, and DNS resolution to
   succeed through WireServer (both UDP and TCP 53). Do not request or print a
   metadata token. Verify every entry under
   `/opt/tonyai-tools/node-v22.23.3-linux-x64` is owned by root:root, including an
   already installed tree.
8. During the separately approved reboot, verify both persistent mount UUIDs
   against fstab, the Docker unit's `RequiresMountsFor`/`ExecStartPre`, and boot
   journal ordering: Docker may start only after both correct disks are mounted
   and the runtime guard succeeds. Repeat smoke and firewall checks afterwards.
   A negative missing-disk boot rehearsal belongs on an isolated recovery host;
   do not detach a live QA disk to manufacture evidence.

Record live results separately from local tests. Stop acceptance on any failure;
do not call the host ready or bypass the guard to continue. Restrictions to public
HTTPS or rollback changes require the owner's approved remediation plan.

## Secret escrow and OS recovery

The recovery vault is separate from application secret stores: only the named
owner has Secrets Officer access, through the operator firewall address. VM and
container identities receive no vault rights. Never put secret values in
Terraform, CLI arguments, logs, shell history or repository files.

Keep the nonsecret `selfhost_contract` output in a protected local deployment
JSON. The owner CLI account must match its tenant and subscription. With the
verified SSH key and known-hosts file, run locally:

```sh
python3 infra/scripts/selfhost_escrow.py save \
  --contract /private/path/deployment.json \
  --key /private/path/id_rsa --known-hosts /private/path/known_hosts
```

The helper captures the root-only environment over SSH, sends it directly from
memory to Key Vault, reads the exact returned version and compares every byte.
It saves a nonsecret `runtime-escrow.json` next to the local deployment contract
and on the host. Retain the version URI outside the VM. Repeat after each
reviewed environment change; `selfhost_start.py` refuses a hash mismatch.
A failed/ambiguous save is not evidence of recovery readiness.

For OS recovery, preserve the original OS disk and both data disks. The current
VM template has a fixed OS-disk name; never delete that disk to resolve a naming
collision. Review either reattachment of the original OS disk or a separately
named recovery VM before applying any replacement. Restore the locked source,
Compose overlays and exact image lock, mount the existing owned data disks
without initialization and create the protected runtime parent directory. On a
fresh recovery OS, run `selfhost_docker.sh` to install the pinned Docker engine
and host guard; `selfhost_host_guard.sh` alone does not install Docker. Restore the exact host contract, including the original
origin while clients depend on it. Keep the digest-verified upstream
`volumes/api/envoy/lds.template.yaml`. `selfhost_start.py` regenerates
`lds.qa.yaml` independently of the existing image lock before Compose starts;
do not rerun image pinning over that lock. The gateway bind refuses missing
files instead of creating a directory. Transfer `selfhost_restore_env.py` to the
reviewed host. Then run locally:

```sh
python3 infra/scripts/selfhost_escrow.py restore \
  --contract /private/path/deployment.json \
  --key /private/path/id_rsa --known-hosts /private/path/known_hosts \
  --version <32-character-verified-version>
```

Restoration refuses an existing environment file and uses exclusive mode 0600
creation. If transfer fails, leave services stopped, inspect any partial file
privately and retry only after reconciling it. Never regenerate credentials
against existing PostgreSQL data. Start through `selfhost_start.py --https`,
then repeat health/Auth/storage acceptance. An environment restore rehearsal
proves credential recovery only; it does not prove database/object backups or
the RPO/RTO target. Keep the latter as unmet until a full isolated restore passes.

## Key rotation and retained legacy compatibility

ES256 protects user-session verification, but the upstream-compatible HS256
`JWT_SECRET`, anon/service-role JWTs and internal oct JWK remain powerful shared
credentials. This is not a completed opaque/asymmetric API-key migration and is
not an accepted production-risk decision. The current QA has no application
users. Production approval requires either the separately tested upstream
opaque/asymmetric-key migration or explicit owner acceptance of the documented
legacy-service-key risk and a successful rotation rehearsal.

For any rotation: schedule maintenance, close public HTTPS, drain dependent
applications, retain the previous immutable vault version and snapshot the
nonsecret image/source lock. Prepare changes in a root-only file without echoing
values or passing credentials in arguments. Apply only after identifying every
consumer, save/read back the new vault version, use the guarded startup and
repeat positive/negative Auth and storage tests before reopening. On failure,
restore the previous consistent configuration and vault version; do not roll
back one field while leaving consumers or database roles on another version.

- **EC session signing key:** generate a new P-256 key/kid with private `sign`
  and public `verify` metadata. Update Auth private JWK and verification JWKS
  together. For planned overlap, retain only the old public verification key;
  never retain two signers. For compromise, remove the old key immediately and
  invalidate affected sessions. Verify old/new token behavior explicitly.
- **Legacy JWT/API service keys:** generate a new random JWT secret and matching
  anon/service-role JWTs; update the internal oct JWK and every Auth, gateway,
  REST, Storage, Realtime, Studio and application consumer together. Existing
  browser builds containing anon keys must be rebuilt. The rotation is not
  complete while any old service-role token is accepted. Never merely change
  one `.env` variable or run an upstream generator that prints keys.
- **Database role passwords:** initialized role passwords are stored in the
  database, not synchronized by `.env` edits. Inventory actual roles/consumers,
  rotate through a reviewed authenticated SQL session with secret values kept
  out of arguments and logs, then change matching DSNs/credentials and verify
  reconnects. Never rerun initdb, seed or delete PGDATA to rotate a password.
- **Encryption keys (pgsodium/vault/storage/meta):** do not replace blindly.
  Preserve them in encrypted backups and follow the extension/service's explicit
  re-encryption procedure. Validate decryption of existing objects before any
  old-key removal; otherwise the result can be permanent data loss.

Before connecting the API, require `SUPABASE_JWT_SCHEME=jwks`, the exact reviewed
issuer and public JWKS origin. Do not use the legacy master secret as an API
session-verification shortcut. The blocked legacy deployment roots cannot
establish this selfhost contract.

## Before QA delivery

1. Pin/review official Supabase Docker distribution and images. Install runtime
   and host hardening, safely identify/mount disks and verify reboot persistence.
   Never automatically format an existing data disk.
2. Configure HTTPS Auth/Storage, private DB DNS and strict TLS, JWT/JWKS, and
   owner/runtime/loader roles. Preserve signup-off, password/link policies,
   tenant guards, RLS and append-only audit. No owner credentials in workloads.
3. Integrate the app subnet and a separate selfhost release/build/migration/
   secret/readback contract. Hosted project-ref, Management API, pooler and CA
   assumptions do not apply to this deployment.
4. Implement monitored WAL/base backups **and versioned object-byte backups** to
   separate Azure storage. Azure Blob is not a drop-in S3 endpoint. Qualify the
   backend and restore order; demonstrate <=15-minute recovery-point lag and
   <=4-hour full recovery. Daily storage verification is not a backup.
5. Configure Azure Communication Services Email, verified domain/sender and the
   API's versioned SMTP secret. Verify invitation/reset delivery.
6. Run exact-deployment health, session-lifecycle, cross-tenant API/PostgREST,
   private upload/download/digest, factor provenance, restoration and alert
   checks. Provision the first organisation through the supported owner flow;
   never run demo seed or assign one email to multiple organisations.

Independent security/QA review, owner merge and cloud acceptance remain required.

References: [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting),
[official Docker installation](https://supabase.com/docs/guides/self-hosting/docker),
[Entra security defaults](https://learn.microsoft.com/en-us/entra/fundamentals/security-defaults),
[Azure retail prices](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices).
