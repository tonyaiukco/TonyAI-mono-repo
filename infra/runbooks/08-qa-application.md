# Sweden QA application integration

This runbook prepares the **Azure Sweden Central** application layer against the
accepted r02 self-hosted Supabase replacement. The additive Terraform roots,
public release validators and manual image workflow are offline preparation;
no cloud operation, R3/R4 acceptance or deployment is implied. The original
network-preflight/dashboard sections below retain their historical host scope.
Use [runbook 07](07-selfhost.md) for host ownership and recovery.

## Resume from existing resources

Use the private deployment contract, backend inputs and persistent SSH trust.
Verify CLI tenant/subscription against both contracts before querying resources.
If authentication expires, use browser login with MFA. Never use device code as
a workaround or weaken security defaults. Do not read credentials, `.env`, token
caches or private key contents. SSH uses the existing key with
`StrictHostKeyChecking=yes`, `UpdateHostKeys=no` and the existing known-hosts file.

Read-only discovery must cover the complete subscription resource inventory,
managed environments, VNet/subnets, peerings/routes, NSG rules, backend blob
metadata, cached backend binding and the existing state's contract. Do not run
`init -reconfigure`, create containers/state keys or overwrite private input
files during discovery. Empty application state does not authorize creating it.
Obtain host port mappings using a narrow Docker inspect format; never dump the
container environment or interpolated Compose configuration. Inspect listeners,
mounts and service status without running startup guards or synthetic-user smoke.

The 2026-10-15 discovery recorded in the B9 evidence found matching contracts and
the existing host state, an unused delegated app subnet, and no app environment,
registry or log workspace. PostgreSQL had no published port and no host 5432
listener; Supavisor was not running. These are timestamped observations, not
preconditions that may be assumed on a later run. Historical Stage A/B evidence
proves host/runtime acceptance and normal reboot only; preserve it unchanged.

## Resource ownership and regional boundary

All regional QA and planned production resources use **Sweden Central**. If a
SKU/quota is unavailable, stop and bring a Sweden-based alternative design to
the owner; do not switch regions. Provider registration is not SKU/capacity proof.

| Surface | Proposed owner / location / state boundary |
| --- | --- |
| Existing VM, VNet and both subnets, NSG, IPs, disks, recovery vault | Existing `selfhost` root; Sweden Central; existing `foundation/staging-selfhost.tfstate`, unchanged |
| Managed environment, ACR Basic, app Key Vault, API/web identities, Log Analytics and scoped RBAC | Additive `foundation/qa` root; proposed group `tonyai-staging-apps`; Sweden Central |
| API and web Container Apps, revisions, ingress and runtime references | Additive `application/qa` root; Sweden Central; one writer for release, rotation and rollback |
| Private DNS zone, VNet link and records | Nonregional Azure Private DNS resources, owned by the new foundation; group metadata location Sweden Central |
| Entra tenant, service principals, role definitions/assignments; GitHub and Namecheap DNS | Directory/control-plane or external global services, not Sweden regional workloads; separate residency/processor decisions apply |
| Recovery storage, backup jobs, alert delivery | Later reviewed Sweden design; no production or backup resources created by this preparation |

Reuse the existing Entra-only storage account and its `foundation`/`application`
containers. **Proposed, not initialized:** `foundation/staging-selfhost-apps.tfstate`
for the new foundation and `application/staging-selfhost-apps.tfstate` for the new
application writer. Before approving these keys, inventory both containers and
all existing app resources, confirm no competing state writer, and approve the
ownership split. Never import/move the data VNet into the app foundation. Recovery
vault and foundation state remain owner-only; app identities receive neither.
Resource-group location is metadata, not a substitute for each resource's location.

Keep every legacy hosted/Germany validator, subscription gate and workflow intact.
The new entrypoints must be explicit QA-only consumers of the verified selfhost
contract, not generic region overrides. No unattended OIDC until the independent
human approver, trust-root and ephemeral runner prerequisites are satisfied.

## Creation-time network boundary

The selfhost contract's `apps_subnet_id` identifies the only allowed subnet.
`infra/terraform/selfhost/variables.tf` defines QA `local.apps_net` as
`10.80.2.0/23`; the original host subnet is `10.80.0.0/24`, and r02 uses `10.80.1.0/24`, inside `10.80.0.0/16`. The QA app DNS record targets r02 at `10.80.1.4`, never the old host.
The existing root remains the only VNet/subnet writer. Require
`Microsoft.App/environments` delegation, no conflicting IP configurations/service
association links, and review peerings, custom DNS, routes and service CIDR
collisions separately. Keep the existing operator `/32` restrictions.

The initial managed-environment PUT must include
`properties.vnetConfiguration.infrastructureSubnetId` and an explicit Consumption
workload profile. Use external HTTPS ingress for temporary platform web/API
hostnames; do not confuse external ingress with public DB access. Before app
deployment, ARM readback must match the exact environment ID, Sweden location,
subnet and workload profile. An incompatible pre-existing environment requires
an owner reconciliation decision; never attempt to retrofit its VNet.
See Microsoft's [networking boundary](https://learn.microsoft.com/en-us/azure/container-apps/networking)
and [dedicated subnet requirements](https://learn.microsoft.com/en-us/azure/container-apps/vnet-custom).

### Offline network preflight

This historical helper accepts the old host and exactly two subnets. It is not
the r02 Unit 0 gate; never omit `supabase-r02` to obtain PASS. Use the
[three-subnet QA preparation below](#offline-unit-02-tools) for the active r02 path.

The preflight reads the existing exported host contract and two **nonsecret,
privately stored projections**. The network projection has exactly:

```text
id, location, prefixes[], subnets[]
each subnet: id, prefix, delegations[], ip_configuration_count, association_count
```

Populate these from VNet `id`, `location`, `addressSpace.addressPrefixes`, and
each subnet's `id`, `addressPrefix`, delegation service names, and lengths of
`ipConfigurations`/`serviceAssociationLinks`. Obtain all managed environments in
the subscription, without filtering to Sweden; project each to exactly `id`,
`location`, `infrastructure_subnet_id` (empty string when absent). Failed or
partial queries must not become an empty list. Save query provenance/time privately.

```sh
python3 infra/scripts/selfhost_app_network.py \
  --contract /private/path/deployment.json \
  --network /private/path/network.json \
  --environments /private/path/environments.json
```

Output is status-only. It checks shape, known QA subnet identity/ranges,
delegation/occupancy and pre-existing environment conflicts. The Python function
returns a **partial creation body**, not a deployable environment resource; the
future Terraform writer must carry and test those fields in its first PUT.
It does not authenticate snapshots, verify account/state binding, validate the
unused host-contract fields, check peering/route/service CIDRs, prove freshness or
capacity, or approve deployment. Those checks remain required outside this offline
validator. No future deployment gate may rely on a caller-supplied PASS alone.

## Database, secrets and immutable release design

**Recommended first QA path:** direct private PostgreSQL TLS with the API's bounded
Prisma pool, initially one API replica and the existing five-connection limit.
Budget all API/reconciliation/migration/internal Supabase sessions against the
measured server capacity before raising concurrency. Keep Supavisor disabled.
The alternative is a separately qualified private session/transaction pooler;
it adds client-to-pooler and pooler-to-DB TLS and role-mapping acceptance. A public
DB port or an SSH tunnel as the application's permanent transport is not proposed.

Propose private name `db.qa.tonyai.internal` mapped to the contract's host address
in a VNet-linked private zone. A dedicated private CA issues a server certificate
with that DNS SAN. Keep the CA private key outside the application and Terraform;
mount the server key root-only. Put only the public trust chain in the reviewed
API/migration image, bind its SHA256 in the release, and test the actual Prisma
engine's hostname/chain verification. The hosted Supabase CA is not this trust
chain. Reusing the public edge certificate inside Postgres is not assumed.

The separately reviewed host patch must bind only the private host address on
5432, enforce encrypted remote access, preserve internal Supabase connections,
and make Compose/startup guards understand exactly that listener and TLS mounts.
Retain apps-subnet-only NSG access and verify Docker forwarding/firewall behavior;
NSG configuration alone is insufficient. Reject URL query overrides of host,
credentials or TLS settings. Valid TLS, wrong CA, wrong SAN, plaintext and
non-app-subnet negative controls must run from the actual deployed image/network.
See [Supabase's connection modes](https://supabase.com/docs/guides/self-hosting/accessing-postgres).

| Credential / material | Consumer and boundary |
| --- | --- |
| `tonyai_runtime` DB URL | API and reviewed storage verification only; exact application-vault secret version; bounded Prisma pool |
| Migration owner and factor loader | Separate owner-operated channels and privileges; never workload identities, app environment, runtime grant or Terraform values |
| Supabase backend service key | API-only exact secret version; never web or browser; this key's existing broad capability remains a recorded risk |
| Public browser key | Build input bound to origin and digest; key values are not reviewed or printed during this preparation |
| DB CA certificate | Public material only in image; hash in release; no CA/server private keys in images |
| Recovery escrow | Existing recovery vault; no API, web or application-deployer access |

For migrations, propose an owner SSH tunnel over the existing verified SSH path
to the private listener, with a client that preserves the certificate DNS name.
Prove actual Prisma strict TLS through that route before adopting it; a localhost
URL with hostname checking disabled is unacceptable. A short-lived owner runner
inside the VNet is a separate Sweden alternative if this cannot be qualified.
Schema/role/migration changes require the API/DB lane's explicit reservation.

The QA release contract binds full source SHA, lockfile and ordered migration
hashes, both image digests, environment/region/subnet IDs, exact Key Vault versions,
Supabase public origin, JWKS URL, expected issuer, browser key binding, DB trust
hash, runtime limits, and storage cleanup hold. Reject unknown/secret-value fields,
hosted project refs, mutable tags and unversioned secret URIs. Build the web with
its actual target origins; reusing a hosted bundle is not integration. Require
exact-source CI/E2E/integration qualification and actual-image smoke before release.
The owner release procedure must independently read back images, references, ingress and identity;
it is the only application writer for deployment, rotation and compatible rollback.

**API dependency integrated; deployment acceptance pending:** #180 (`83715fe`)
implements expected-issuer validation in `apps/api/src/auth/token-verifier.ts`,
including correctly signed wrong-issuer and missing-issuer refusals. By default,
the expected issuer is `SUPABASE_URL`'s origin plus `/auth/v1`; set
`SUPABASE_JWT_ISSUER` to the exact Auth issuer when the API reaches JWKS through
another origin. The Sweden release contract must bind that value and verify it
against the deployed Auth configuration and exact candidate. Keep
`SUPABASE_JWT_SCHEME=jwks`; no insecure-local-auth flag or master-secret shortcut.
Verify exact Auth redirects, server/browser origins and CORS together. This merge
is code evidence, not deployed acceptance. No API file is changed in this patch.

## Required decisions before live integration

- **PD-3:** historical generation/access remains UNKNOWN; the owner did not
  observe installation, so do not request another unsupported attestation or
  any credential value. The accepted dashboard-only rotation/custody does not
  cover other potentially reachable DB-admin/Studio credentials. Before app
  integration or real data, satisfy runbook 09's comprehensive credential/host-
  trust gate: primary clean Sweden replacement with fresh credentials,
  preservation/containment and old-trust retirement, or an explicitly selected
  comprehensive rotation/revocation and trusted-host reconciliation path.
  I3 consistency or dashboard rotation alone cannot close this condition.
  It blocks QA acceptance, not documentation/PR publication. See the
  [resolution procedure below](#pd-3-resolution-without-finding-the-old-password).
- **SMTP remains undecided:** runbook 07 previously prescribed ACS Email while
  LP2-04 prescribes Resend. Neither is selected by this runbook. ACS uses a data
  geography, not a Sweden Central deployment selection; its global services and
  delivery events require a separate data-location review. Resend's sending
  region does not determine storage residency. Do not configure either provider
  until the owner resolves the processor and data-location requirement; no other
  region is an implicit fallback. If Sweden-only processing/storage is mandatory,
  first evaluate a Sweden-operated mail design, delivery limits and reputation
  without creating it. Recipient mail systems are outside application hosting.
  Sources: [ACS data location](https://learn.microsoft.com/en-us/azure/communication-services/concepts/privacy),
  [Resend residency](https://resend.com/security). Include current lifecycle/support
  terms in provider selection. Domain/sender SPF, DKIM, DMARC and invitation/reset
  delivery still need Namecheap access and explicit acceptance.
- **Recovery:** measured database **and object-byte** restore, configuration/secret
  recovery and reconciliation remain launch blockers under LP5-03 and the pilot
  Recoverability gate. RPO 15 minutes / RTO 4 hours are unproven targets. Disk
  retention, secret escrow and the normal reboot are not backup recovery.

### PD-3 resolution without finding the old password

The owner need not locate, reveal or remember the old password. The runtime
design stores it as `DASHBOARD_PASSWORD` in the root-only host environment and
includes that environment in owner-only recovery escrow. Knowing that storage
path does not prove the live value's generation method. Never show the complete
environment or escrow payload to recover one dashboard credential, and never
paste a password into chat or a strength-checking website. Credential retrieval
alone cannot resolve PD-3's historical exposure question.

Use [runbook 09](09-qa-integrity.md) for the staged metadata inventory,
independent reference, preservation and full integrity-review scope. Its initial
catalog inventory is not a clean-baseline comparison or permission to discard data.

When original generation provenance cannot be established, prepare a separate
remediation package instead of waiting indefinitely for an owner attestation.
UNKNOWN is not demonstrated compromise, but it must not be converted into PASS.
The primary planned route is **clean Sweden replacement with fresh credentials
and old-trust retirement**, following the preservation/containment plan in
runbook 09. A separately approved comprehensive credential rotation plus trusted-
host reconciliation is an exceptional alternative. Dashboard-only rotation and
catalog comparison cannot close PD-3. Neither route is authorized here.

1. **Baseline and preservation.** Privately bind the exact VM, runtime composition,
   pinned images, escrow version and relevant timestamps. Review what data must
   be retained before any rebuild; absence of an application is not proof that
   the database or object disk is disposable. Preserve existing evidence. The
   clean comparison baseline must use the same pinned upstream version and
   approved configuration changes; the potentially affected database cannot
   establish its own baseline. Do not use the Claude lane's local Supabase stack.
2. **Bounded maintenance target.** The rotation changes only the dashboard
   credential and its gateway consumer, together with versioned escrow and its
   startup marker. The pinned Envoy entrypoint derives its basic-auth file from
   the dashboard environment variables. A plain container restart does not load
   a changed Compose environment: the reviewed plan must recreate the gateway
   from the locked composition after escrow verification. Allow a short Auth,
   REST and Storage interruption; name every affected container in the final
   approval package. Retain edge denials and operator `/32`; do not reopen Studio
   publicly. Identify any temporary containment explicitly for owner approval.
   Existing `selfhost_start.py` runs a mutating guard and starts the entire
   composition; it is not a narrow rotation helper. A dashboard-only change does
   not require a database restart. Do not include one without a separate reason
   and explicit approval.
3. **Generate without disclosure.** The helper below generates 32 random bytes
   using the OS-backed cryptographic generator,
   replace only the dashboard field atomically with root-only permissions, and
   preserve all other runtime secrets **within this dashboard-only transaction**.
   That preserves its narrow authorization, not trust in those other secrets.
   DB-admin/Studio-reachable credentials remain potentially exposed and require
   comprehensive replacement/retirement under runbook 09. Never run the fresh
   initializer against the existing runtime or disks. Secret
   bytes stay within the approved host/escrow transport and must not enter tool
   output, command arguments, logs, patch files or this document. Record the
   reviewed helper hash and execution result as new generation provenance.
4. **Custody and recovery.** Save/read back an exact new recovery-vault version
   before guarded recreation. Existing `selfhost_escrow.py save` and even `verify`
   write host/local markers; neither belongs in read-only discovery. Retain an
   owner-only record of the credential's purpose, vault/version reference,
   generation procedure and recovery instructions, without its value. If human
   Studio login is needed, separately prepare an owner-operated selective transfer
   to the owner's password manager; do not expose the complete runtime environment
   or pass the credential through the agent. Password retrieval is not an
   application-deployment prerequisite; the API does not use dashboard basic auth.
5. **Optional private consistency review.** This is supporting preservation
   evidence, not the primary rebuild route or proof against exfiltration. Under
   separate approval and containment of potentially valid old credentials, compare roles, grants,
   extensions, schemas, functions, triggers and Auth users/settings against the
   clean baseline plus approved changes. Use read-only inspection, exclude
   password hashes/key material, and keep identities and differences private.
   An independent security reviewer must resolve every unexplained difference
   and state coverage/limits. A partial diff or missing baseline is inconclusive; even a complete match is
   scoped consistency, not an integrity PASS. Prepare the primary clean rebuild
   with explicit data-preservation, resource/state ownership and cutover plans;
   do not erase or repurpose existing disks automatically.
6. **Acceptance and safe stop.** After separately approved credential processing,
   status-only checks must prove the new credential works on the private admin
   path, the old credential is refused, public admin paths remain denied, escrow
   matches and affected services recover. The human does not need to supply the
   old credential; the approved helper must handle comparison privately without
   displaying either value. Do not add user-creating smoke without authorization.
   On failure, keep admin access contained and stop the affected service if
   needed; never restore the unknown-strength password as the accepted rollback.
   Preserve configuration/evidence for reconciliation rather than bypassing the
   escrow guard. Close PD-3 only under runbook 09's comprehensive credential/host-trust gate:
   independently accepted clean replacement with fresh credentials and old-trust
   retirement, or an explicitly approved comprehensive rotation/revocation and
   trusted-host reconciliation. Dashboard credential rotation/custody is only one
   completed substep. A newly strong password or I3 match cannot settle historical
   exposure; residual access/exfiltration uncertainty remains recorded.

### Dashboard rotation execution package (separate approval required)

`selfhost_dashboard_rotation.py` is a QA-only, root-operated transaction with
`prepare`, `activate` and `finalize` actions. Synthetic tests exercise local files,
mocked Docker calls and mocked HTTP responses; they are not live rotation evidence.
The helper never prints credentials or rendered configuration. After explicit
approval it processes secret bytes privately in memory and protected host files.
It requires Linux Python 3.10+, isolated Python, the existing Docker daemon and
Compose version supporting `--wait`, and the unchanged pinned images already
present. Do not install or pull dependencies during this maintenance window.

**Source and target binding:** before approval, hash the exact patch and the nine
bundle files below. Install into a new root-owned, mode-0700 directory
`/usr/local/lib/tonyai/dashboard-rotation`, with root-owned mode-0600 files. Refuse
an existing destination; reconcile partial installation privately instead of
overwriting it. Verify every installed hash against the reviewed manifest before
executing any helper. Do not execute scripts from operator-writable paths.

| Bundle filename | Reviewed repository source |
| --- | --- |
| `selfhost_dashboard_rotation.py` | `infra/scripts/selfhost_dashboard_rotation.py` |
| `dashboard_rotation_store.py` | `infra/scripts/dashboard_rotation_store.py` |
| `dashboard_rotation_runtime.py` | `infra/scripts/dashboard_rotation_runtime.py` |
| `selfhost_pin.py` | `infra/scripts/selfhost_pin.py` |
| `upstream.lock.json` | `infra/selfhost/upstream.lock.json` |
| `images.qa.lock.json` | `infra/selfhost/images.qa.lock.json` |
| `compose.qa.yml` | `infra/selfhost/compose.qa.yml` |
| `compose.https.yml` | `infra/selfhost/compose.https.yml` |
| `Caddyfile` | `infra/selfhost/Caddyfile` |

The private approval record must bind the existing QA VM, recovery vault, current
gateway container ID, operator SSH trust, source/bundle hashes and maintenance
window. Only `supabase-envoy` (Compose service `api-gw`) is stopped/recreated.
Caddy, Studio, Auth, REST, Storage and the database containers are not restarted;
their public API traffic is interrupted while the gateway is down. Reserve a
15-minute operator window as a planning allowance, not a measured RTO. On failure,
the outage may continue until reconciliation. No firewall, DNS, user, image,
database, state or production resource change is included.

The approved operator procedure is sequential:

1. Recheck target/account/escrow ownership, source hashes, pinned images, all
   container identities and public admin denial paths. Capture only nonsecret
   metadata privately. Freeze other runtime writers and prohibit reboot or
   whole-composition startup during the transaction. Keep strict SSH host-key
   checking and the existing `/32`. Source transfer/install requires approval.
2. Stop the exact privately recorded gateway ID with
   `/usr/bin/docker --host unix:///var/run/docker.sock stop --time 30 <bound-id>`;
   verify that exact container is stopped. Do not remove it. Its old environment
   is required for the helper's baseline check.
3. Run on the host:
   `sudo /usr/bin/python3 -I -B /usr/local/lib/tonyai/dashboard-rotation/selfhost_dashboard_rotation.py prepare`.
   This requires the old environment to match its escrow marker and the stopped
   gateway's complete environment to match the rendered composition plus locked
   image defaults. It stages a 256-bit random hex password, changes only that
   field atomically, and records a durable transaction. It does not start Docker.
4. Run the reviewed existing `selfhost_escrow.py save` from the owner machine,
   using the same verified deployment contract, key and known-hosts arguments as
   [runbook 07](07-selfhost.md#secret-escrow-and-os-recovery).
   Keep its version URI in the private custody record. The operation reads back
   and compares the new exact vault version and writes both markers; do not
   replace it with a fabricated marker. A failed or ambiguous save blocks activation.
5. Run the same installed command with `activate`. It requires a matching new
   escrow version and unchanged sources, effective configuration and dependencies.
   Its only recreation is `compose up -d --no-deps --force-recreate --pull never
   --no-build --wait --wait-timeout 240 api-gw`, with explicit project, daemon,
   environment file and all four reviewed Compose files. Private loopback checks
   require unauthenticated=401, old credential=401 and new credential=200 on
   `/project/default`. No proxy, redirects, response bodies or user creation.
6. Independently check public admin denials and non-user-creating service health,
   exact new escrow custody, unchanged dependency IDs/start times, and accepted
   edge/loopback behavior. Do not regenerate historical Stage A/B evidence. Only
   then run `finalize`: it repeats private credential checks and removes temporary
   `previous-password`/`next.env` files, retaining a private nonsecret journal.
   File removal is not secure erasure of disk blocks or old vault versions.
   Retention/revocation of historical escrow versions needs its own recovery review.

**Failure and interruption:** the root-only journal is at
`/etc/tonyai/dashboard-rotation/journal.json`; never publish it or its configuration
hash. `prepared`/`awaiting-escrow` may resume `prepare` without regeneration when
their bound files agree. `activating` is never acceptance: after process/host loss,
inspect and, when needed, stop the exact bound gateway before reconciling source,
environment hashes and escrow; then resume `activate` within the same approval.
Ordinary recreation/verification failures request an exact-ID stop, even if image
or port properties are wrong. SIGKILL, power loss, preflight failure, daemon failure
or ambiguous identity cannot guarantee automatic containment; confirm it manually
through the private operator channel. Do not accept a running service as proof.

Partial `journal.next`, `.dashboard-next.env`, orphan staging files, changed
dependencies/sources or missing credentials require private reconciliation; the
helper deliberately refuses to overwrite them. Keep the gateway stopped and the
new environment/escrow intact; do not delete journals, rerun initialization, bypass
the escrow guard or roll back to the unknown-strength password. After
`credential-verified`, partial cleanup can resume `finalize`. This is one recorded
rotation, not a general scheduler; a future rotation needs a new reviewed lifecycle.

Dashboard credential rotation can be approved as a bounded substep while the
comprehensive PD-3 gate remains open. Before app integration or real data, prepare
and accept the primary clean replacement package defined in runbook 09: complete
credential/consumer inventory, preservation, containment, fresh generation/trust,
old-credential rejection and independent cutover acceptance. Optional I3 is only
scoped consistency evidence; it is not a mandatory intermediate comparator or a
substitute for that gate. No baseline host, integrity query, rebuild or live
credential processing is authorized by this runbook or by local test success.

## Staged approval and validation plan

No stage below is authorized by this document. Before requesting live approval,
finish the corresponding code/review, save its exact SHA/patch hashes, privately
record resource IDs, attach the concrete diff/plan and rollback package, recheck
state ownership and dependencies, and specify the maintenance window. Do not
request approval for an unspecified future `apply`.

| Stage / target | Dependencies and impact | Validation and bounded rollback |
| --- | --- | --- |
| C: app foundation in `tonyai-staging-apps` and linked private DNS | Reviewed new roots/writer, approved state keys, Sweden capacity and cost estimate, existing subnet readback. Creates paid app resources; no host restart. Preserve owner `/32` and data state. | Inspect saved plan: no data resource mutation/deletion, first environment PUT has subnet, no recovery grants. Read back region/subnet/identities/RBAC. On failure stop before app deployment; review any cleanup separately, never destroy shared VNet/state. |
| D: private DB TLS on the existing QA host | PD-3 handled, reviewed TLS/listener/guard patch, private trust custody, backup/maintenance decision. DB restart may interrupt all Supabase services. | Preserve nonsecret source, image lock and private config backups securely. Check actual-image positive/negative TLS, network boundary and all internal services. Restore reviewed previous no-published-DB composition/config on failure; stop apps first. Do not restore obsolete firewall guards, replace credentials or claim data rollback. |
| E: schema, runtime/loader roles and buckets | Owner-approved API/DB slot and migration chain, TLS accepted, owner credential path, private integrity baseline. Maintenance for incompatible changes; no demo seed. | `runtime-role.mjs check`, reconciliation, private bucket policies and owner/runtime exclusion. Inspect migration risk before execution; image rollback does not undo schema/data. Restore only under a separate proven DB/object recovery plan. |
| F: immutable QA images and application release | Issuer fix integrated; reviewed new build/release/secret paths, E accepted, browser origin binding and artifact gates. Owner-run; no new OIDC grant. | Startup, readiness, login, factorless entry/no-factor refusal, evidence, review, report, tenant negatives and scoped cleanup on exact images. Temporary-user operations need explicit approval. Roll back only to an identified schema-compatible manifest with exact image/secret versions; on first release stop traffic if no accepted predecessor exists. |
| G: mail/domain and operational acceptance | Processor/residency and Namecheap decisions, alert recipient privately recorded; separate backup/recovery implementation. | Invitation/reset delivery, dependency-loss/recovery, alert acknowledgement, rotation/rollback and isolated DB+byte restore. Keep LP2-01/02/03 INTEGRATED until full criteria pass; production requires separate authorization. |

Keep #175/#178 Open questions open, including L1/L3/L7/L8/L9/L10/L11/L12, escrow
bypass, published subscription identifier, legacy-key rotation, GraphQL RPC and
Node integrity, root-owned helper placement, and missing offline-check documentation.
Do not turn this integration into their cleanup. Obtain independent security/QA
review of this boundary and the other lane's security review before merging
executable secrets/auth integration. The B9 handoff records evidence and proposed
ledger updates; the central roadmap remains the sole planning/status file.


## Application preparation and owner execution

**This section authorizes nothing.** Every remote discovery, secret operation,
state initialization, apply, workflow dispatch, image push, migration and DNS
change requires a separate exact owner approval. A denied, failed or interrupted
attempt consumes that approval: inspect the result and request a new bounded
attempt. Never combine the steps below into an unattended script. Production is
not accepted by these QA-only roots; it requires separately reviewed Sweden inputs.

### Inputs that remain deliberately unresolved

The `inputs.example.json` files inside each QA root and
`application/qa/target.example.json` contain **invalid `REQUIRED_*` placeholders**.
They are not runnable tfvars. After the accepted R3/R4 handoff, the owner prepares
private copies outside the checkout. No password, token or private key goes into
those files, a workflow input, a plan, an artifact, Git or chat.

| Input | Source / boundary |
| --- | --- |
| Tenant/owner UUIDs, ACR/vault names, source SHA | Owner-selected, reviewed nonsecret identifiers; only Sweden QA subscription/group accepted |
| Default ACA domain and app subnet | Foundation output independently checked against ARM; environment must have its subnet bound at creation |
| Supabase HTTPS origin / issuer | Accepted scoped r02 hostname, exact `/auth/v1` issuer and derived `/auth/v1/.well-known/jwks.json`; no guessed hostname or hosted project ref |
| Public browser key / SHA256 | R3 owner handoff; actual key only in protected build environment, hash in public target/candidate; live invalid-key and Auth-settings controls still required |
| Public DB CA / SHA256 | Reviewed r02 private-DB TLS handoff; **certificate only**, no private key; copied into API image at `/app/infra/certs/qa-db-ca.crt` with hash-dependent cache invalidation |
| API/web digests, lockfile and ordered migrations | Successful exact-source `qa-candidate.yml` artifact; never tag lookup or hand-authored provenance |
| `database_secret_version` | App-vault `database-url`, authenticating **tonyai_runtime**, private `db.qa.tonyai.internal:5432`, strict TLS |
| `backend_secret_version` | App-vault `supabase-service-role-key`, API only; no web secret or recovery-vault access |
| `DIRECT_URL` | Separate owner-controlled Key Vault/custody channel, using owner role for `pnpm db:deploy`; never app tfvars/env, candidate artifact, app identity or deployer grant |
| Optional `mail` | Complete provider-approved public SMTP parameters and exact app-vault `smtp-password` version; no provider is selected here |

The new `qa_database_url.py` is an owner-run **syntax check only**, before an
individually approved secret upload. It never contacts a database or vault and
never prints its input. Its accepted URL query is exactly
`sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/qa-db-ca.crt`.
It rejects host/role/TLS overrides. The runtime role and real Prisma TLS behavior
still require positive and wrong-CA/wrong-SAN/plaintext/network-negative tests.
The CA path must exist in the separately reviewed owner migration execution image
too; do not rewrite the hostname to localhost or disable hostname verification.

```bash
# Owner only, after permission to read this exact credential file; no value output.
python3 infra/scripts/qa_database_url.py --private-file "$QA_DIR/runtime-url"
# Separately approved owner credential inspection, never supplied to Container Apps.
python3 infra/scripts/qa_database_url.py --private-file "$QA_DIR/owner-url" --owner
```

Secret transfer examples below are **not authorized now**. Each line needs its
own exact credential/file/vault approval; only a version URI may leave the owner
channel. These protected source files are never read by the coding agent.
`QA_OWNER_VAULT` is a separately approved owner-only custody vault, not a workload
grantee or a request to reuse the R3 recovery vault.

```bash
# Runtime URL: after syntax validation and real role/TLS acceptance.
az keyvault secret set --vault-name "$QA_APP_VAULT" --name database-url \
  --file "$QA_DIR/runtime-url" --query id -o tsv
# Separate approval: r02 backend service key, API-only reference.
az keyvault secret set --vault-name "$QA_APP_VAULT" --name supabase-service-role-key \
  --file "$QA_DIR/backend-key" --query id -o tsv
# Separate owner custody approval: never add this secret to application inputs/grants.
az keyvault secret set --vault-name "$QA_OWNER_VAULT" --name direct-url \
  --file "$QA_DIR/owner-url" --query id -o tsv
```

### Ordered approval units

Before proposing an actual operation, replace every placeholder privately and
attach its reviewed source SHA, resource IDs, input/plan hashes, exact command,
expected writes, preconditions and failure stop. A document placeholder is never
a sufficient apply request. Use Node 22, pnpm 11.9.0 and Terraform 1.13.3.

| Unit | Exact scope and consumed authority | Required evidence / stop |
| --- | --- | --- |
| 0 — R3/R4 and resource discovery | Owner-approved read-only ARM projections of r02, all three subnets, NSGs/routes/DNS, all managed environments and both backend containers; no credential reads | Accepted R3 plus full R4/PD-3; fresh unused delegated `10.80.2.0/23` subnet, Sweden capacity, no competing app writer. Bootstrap alone is insufficient. |
| 1 — bind new state keys | Owner Entra data-plane access to the **existing** backend; `foundation/staging-selfhost-apps.tfstate` and `application/staging-selfhost-apps.tfstate` only | Owner approves new keys after inventory. No bootstrap recreation, import, migration of state, or `-reconfigure` of another root. |
| 2 — app foundation | Saved `foundation/qa` plan creates `tonyai-staging-apps` RG, Sweden ACR Basic, Log Analytics, ACA environment, app vault, API/web identities, scoped grants; also global private DNS zone/link/r02 A record | Plan has no VNet/subnet/NSG/VM/disk/old-state writes or deletes. First apply has OIDC/runtime/SMTP/app grants disabled. Private DNS is part of this separate DNS approval. Verify region, subnet, profile, identities, vault and diagnostics after apply. |
| 3 — host TLS/schema/runtime | Claude/API-DB lane's separately reviewed host TLS/listener/NSG patch and migration slot; owner `DIRECT_URL` channel | TLS negative controls using the separately reviewed **owner migration execution image**; only `pnpm db:deploy`, never seed/reset/migrate-dev. `runtime-role.mjs check`, buckets, storage/reconciliation and Auth issuer acceptance. Codex does not patch or run R3 here. |
| 4 — versioned runtime secrets | Separate approved reads/transfers into the named app-vault `database-url` and `supabase-service-role-key` secrets; optional `smtp-password` only after provider approval | Values stay in the owner's secure channel. Record only exact version IDs. Next reviewed foundation plan enables API grants on those names; no owner/recovery grant. |
| 5 — federation | Saved foundation plan enables `tonyai-staging-release` managed identity, exact GitHub staging federation and ACR push/identity-operator/environment-read/join grants | Immediately before enabling, owner runs the full GitHub admin preflight below, verifies independent reviewer and fresh JIT host destruction. No app-wide/group Contributor, Graph credential or static client secret. `apps_ready` stays false until owner creates both apps. |
| 6 — image candidate | One exact-main `qa-candidate.yml` dispatch, staging reviewer approval, fresh `tonyai-staging-eu` JIT host; pushes two ACR images and provenance/SBOM, exports the candidate artifact | Full admin preflight before **each** dispatch; exact-source CI/E2E/integration green. Node image digest and public CA/key/origins bound. Both digests from build metadata; extracted API CA and exact web bundle checked. After this build, prove strict TLS and wrong-CA/wrong-SAN/plaintext/network negatives using the **exact API digest**, before Unit 7. Startup/login/export acceptance remains separate. |
| 7 — application release | Owner approves one saved `application/qa` plan and its hash; API revision deactivation/drain plus apply writes only the two Container Apps | Authenticate candidate artifact, validate source/inputs/plan, accept schema compatibility and hold setting, then drain old API. Re-read ARM and active revisions. An unsuccessful first release stays unaccepted; no implicit retry. |
| 8 — app-scoped deployment grants and acceptance | Later separate foundation plan with `apps_ready=true`; grants Container Apps Contributor on only the two existing apps | This principal can replace API code and indirectly access runtime secrets. It never gets foundation/recovery state, migration secrets or role-assignment write. No new automated deployment workflow is enabled by this preparation. |

Unit 1's explicit initialization commands (owner only after state-key approval):

```bash
# QA_DIR is a private directory outside the repository; these variables contain IDs only.
terraform -chdir=infra/terraform/foundation/qa init -input=false -lockfile=readonly \
  -backend-config=use_azuread_auth=true -backend-config="tenant_id=$QA_TENANT_ID" \
  -backend-config="subscription_id=$QA_SUBSCRIPTION_ID" \
  -backend-config="storage_account_name=$QA_STATE_ACCOUNT" \
  -backend-config=container_name=foundation -backend-config=key=staging-selfhost-apps.tfstate
terraform -chdir=infra/terraform/application/qa init -input=false -lockfile=readonly \
  -backend-config=use_azuread_auth=true -backend-config="tenant_id=$QA_TENANT_ID" \
  -backend-config="subscription_id=$QA_SUBSCRIPTION_ID" \
  -backend-config="storage_account_name=$QA_STATE_ACCOUNT" \
  -backend-config=container_name=application -backend-config=key=staging-selfhost-apps.tfstate
```

Do not inherit `TF_VAR_*`, `TF_CLI_ARGS*`, `TF_LOG*`, `AZAPI_LOG*`, a different
`TF_WORKSPACE`/`TF_DATA_DIR`, automatic tfvars/override files, Shared Key, SAS or
client-secret environment variables. Verify account tenant/subscription and
cached backend binding before each unit; only the default Terraform workspace
is used. State key initialization itself needs approval even though resource
planning is non-mutating. Never print a state file or raw secret response.

Units 2/4/5/8 each use a new reviewed **foundation** saved plan:

```bash
terraform -chdir=infra/terraform/foundation/qa plan -input=false -lock-timeout=60s \
  -var-file="$QA_DIR/foundation.json" -out="$QA_DIR/foundation.tfplan"
terraform -chdir=infra/terraform/foundation/qa show -no-color "$QA_DIR/foundation.tfplan"
# Only after the owner approves this exact plan/hash and its resource changes:
terraform -chdir=infra/terraform/foundation/qa apply -input=false "$QA_DIR/foundation.tfplan"
```

Unit 6 requires this **owner/admin** check immediately before every dispatch:

```bash
python3 infra/scripts/github_environment.py --repo tonyaiukco/TonyAI-mono-repo
# Only after that PASS, independent-reviewer/JIT proof and explicit dispatch approval:
gh workflow run qa-candidate.yml --ref main
```

`GITHUB_TOKEN` cannot read all Administration/Variables settings used by that
preflight; the workflow deliberately does not pretend otherwise. A refusal,
unreadable setting, unenforceable protection or absent independent reviewer
blocks dispatch/federation. Do not add a long-lived admin token to the workflow
or skip the check. The workflow only checks the accessible exact-source release
gates and public build bindings before federation. Set reviewed public GitHub
variables `QA_TARGET_JSON`, `QA_PUBLIC_DB_CA`, `QA_PUBLIC_BROWSER_KEY`,
`QA_AZURE_CLIENT_ID`, `QA_AZURE_TENANT_ID`, `QA_AZURE_SUBSCRIPTION_ID` in a separately
approved configuration step. `QA_TARGET_JSON` follows `target.example.json`; it
must name the exact selected `main` SHA. Browser key text is not requested in chat.
BuildKit provenance/SBOM is attached to OCI output; no independent signature
verification or bit-for-bit reproducibility is claimed.

Unit 7's owner-reviewed application commands:

```bash
# Authenticates run identity, repository, workflow, SHA, status and artifact ZIP digest.
python3 infra/scripts/qa_candidate_artifact.py --sha "$QA_SOURCE_SHA" \
  --run-id "$QA_CANDIDATE_RUN_ID" --output "$QA_DIR/candidate.json"
python3 infra/scripts/qa_release.py --inputs "$QA_DIR/release.json" --candidate "$QA_DIR/candidate.json"
terraform -chdir=infra/terraform/application/qa plan -input=false -lock-timeout=60s \
  -var-file="$QA_DIR/release.json" -out="$QA_DIR/application.tfplan"
terraform -chdir=infra/terraform/application/qa show -json "$QA_DIR/application.tfplan" > "$QA_DIR/application-plan.json"
python3 infra/scripts/qa_release.py --inputs "$QA_DIR/release.json" \
  --candidate "$QA_DIR/candidate.json" --plan "$QA_DIR/application-plan.json"
shasum -a 256 "$QA_DIR/application.tfplan"
```

The offline validator binds inputs and **independently computed** app bodies;
it does not authenticate an arbitrary caller-supplied candidate JSON. The preceding
artifact retrieval and private run/approval record are mandatory. If a previous
candidate file exists, reconcile its exact recorded artifact identity; never
silently overwrite it or hand-edit it. A new rollout/rollback uses a new
`release_id`. First creation keeps `storage_cleanup_hold=true`; any removal of a
hold needs reviewed reconciliation reports and separate owner approval before
using `qa_release.py --ack-clear-storage-hold`.

After approval of the saved plan, explicitly drain/deactivate prior API revisions
using the existing bounded drain helper **before** applying it. `Single` revision
mode and max one replica do not prevent rollout overlap of process-local quotas.
This creates a maintenance window; no zero-downtime claim is made.

```bash
# Separate approved API revision mutation; consumes the exact release approval.
PYTHONPATH=infra/scripts python3 - "$QA_DIR/release.json" <<'PYDRAIN'
import sys
from qa_contract import load, foundation
from drain_api import drain
from runtime_limits import validate_limits
value = load(sys.argv[1])
foundation(value['foundation'])
grace = validate_limits(value['release']['runtime_limits'])['SHUTDOWN_GRACE_MS']
drain(value['foundation'], value['release']['release_id'], attempts=(grace + 31999) // 2000)
PYDRAIN
# Apply only the exact approved, unchanged saved-plan hash; never silently re-plan.
terraform -chdir=infra/terraform/application/qa apply -input=false -lock-timeout=60s "$QA_DIR/application.tfplan"
```

Capture **public** ARM projections privately: the managed environment resource,
both Container App resources keyed by `api`/`web`, and both complete revision
lists keyed by `api`/`web`. Use ordinary `show`/revision-list reads, never
`listSecrets`, vault value reads or full Terraform state. Then:

```bash
python3 infra/scripts/qa_readback.py --inputs "$QA_DIR/release.json" \
  --candidate "$QA_DIR/candidate.json" --environment "$QA_DIR/environment.json" \
  --apps "$QA_DIR/apps.json" --revisions "$QA_DIR/revisions.json"
```

A readback PASS is not application acceptance. Verify actual-image startup,
readiness and recovery, login → factorless entry/no-factor refusal → evidence →
review → report, API/PostgREST cross-tenant negatives, private buckets, exact-ID
synthetic cleanup, runtime privilege exclusion, alert delivery and compatible
rollback. Temporary tenants and email delivery need their own write approval.
The existing resource/runtime limits stay: API 1 CPU/2Gi, exactly one replica and
five DB connections; web 0.5 CPU/1Gi, 0–2 replicas. Raising them needs capacity proof.

Rollback uses this same application root with an authenticated previous candidate,
a new revision suffix and exact compatible secret versions, followed by drain
and readback. Check the previous source from its clean reviewed checkout; do not
relabel an old candidate as the current source. Image rollback never reverses
schema, data, secrets or Auth settings. On failure preserve evidence/state and
request a new specific recovery approval; do not destroy shared infrastructure.

### SMTP, Auth and operational acceptance

`APP_URL` and exact CORS `WEB_ORIGIN` always equal the web origin. Optional API
mail parameters are `host`, `port`, `secure`, `user`, `from`, and
`password_secret_version`; password resolution is API-only through Key Vault.
The same provider must also be configured separately on self-hosted GoTrue for
password reset; an API SMTP setting does **not** configure GoTrue. The R3/host
owner supplies that reviewed configuration and exact redirect allow-list.
Sender/processor/residency, SPF/DKIM/DMARC and invitation/reset delivery remain
owner decisions and acceptance; no ACS/Resend or production deployment is implied.

The foundation routes ACA console/system logs to the Sweden Log Analytics
workspace by ARM ID, without workspace keys. Named-operator alert delivery,
secret rotation, dependency-loss/recovery and DB **plus object-byte** restore
are still live gates, not a consequence of successful log routing.

### Offline Unit 0–2 tools

These tools prepare and inspect **offline evidence**. They neither establish
R3/R4 acceptance nor authorize discovery, backend initialization or apply. The
discovery/readback tools generate argv manifests but **do not execute Azure CLI**.
There is no hidden collector, credential read, state download, init, mutation or
retry. Executing the generated reads later requires the accepted gates and the
owner's separately bounded discovery approval. Do not pipe a manifest into a shell.

#### Discovery request and receipt

Prepare a nonsecret request outside the checkout, replacing all invalid fields
from accepted owner metadata, never by inference:

```json
{
  "source_sha": "REQUIRED_REVIEWED_MAIN_SHA",
  "tenant_id": "REQUIRED_OWNER_TENANT_UUID",
  "backend_account": "REQUIRED_EXISTING_BACKEND_ACCOUNT",
  "backend_group": "REQUIRED_EXISTING_BACKEND_GROUP",
  "dns_zones": []
}
```

`dns_zones` must eventually enumerate **all** existing subscription private DNS
zones as `{"group":"...","name":"..."}`. First prepare the base manifest for
inventory; after the separately approved zone-list read, regenerate the complete
manifest including every zone's VNet links and A records. Empty `dns_zones` is
valid evidence only if the complete zone inventory is empty. The complete
inventory and environment lists are subscription-wide, never filtered to Sweden.
No TXT values, VM userData/customData, Key Vault secret endpoints, storage keys,
SAS, blob bodies or raw backend cache/state are queried. NSGs, routes, VNet DNS
and peerings remain explicit review material. Storage lists use Entra
`--auth-mode login` and `--num-results '*'`; the CLI documents that `*` retrieves
[all blobs](https://learn.microsoft.com/en-us/cli/azure/storage/blob#az-storage-blob-list).

```bash
python3 infra/scripts/qa_discovery.py manifest --request "$QA_DIR/discovery-request.json" > "$QA_DIR/discovery-manifest.json"
python3 infra/scripts/qa_discovery.py verify --request "$QA_DIR/discovery-request.json" --bundle "$QA_DIR/discovery-bundle.json"
python3 infra/scripts/qa_network.py --request "$QA_DIR/discovery-request.json" --bundle "$QA_DIR/discovery-bundle.json"
```

The owner-controlled receipt assembler stores only the selected output fields.
The bundle schema is strict:

```text
schema: 1; source_sha; manifest_sha256; started_at; completed_at; records[]
record: key; complete: true; pages[]
page: argv_sha256; exit_code: 0; started_at; completed_at; result; result_sha256
```

Hashes use SHA256 of UTF-8 JSON with sorted keys, compact separators and no NaN
(`qa_discovery.digest`). Times are `YYYY-MM-DDTHH:MM:SSZ`. All command records
must exist exactly once; failed results cannot become empty arrays. ARM list
results preserve `{items: [...], next_link: ...}`. A following page must use the
exact `next_link` in the same query's argv; `next_command` refuses foreign hosts,
paths, versions or filters. The final marker must be null. Single/SDK-all commands
have exactly one receipt page. Collection lasts at most 30 minutes and its start
must be within the last hour. An incomplete/expired collection needs a fresh
bounded proposal; this tool never retries. `qa_discovery_shapes.py` defines exact
projected fields; unprojected/unknown fields refuse at every level.

Hashes, timestamps and `complete` are consistency checks, **not authenticated
provenance**. The operator must attest actual command execution, CLI version,
complete SDK pagination and source custody. These tools cannot validate state
lineage/ownership, effective inherited permissions, Sweden capacity, NSG/route
semantics, service CIDR conflicts or full R4. Keep those gates open. Source-wide
NSG/route changes may conservatively refuse comparison while another lane works;
reconcile the observation, never suppress the difference.

`qa_network.py` checks the r02 VM/NIC/IP binding, the exact three subnet IDs and
CIDRs, data NSG associations, delegation, zero app IP/service-association/resource-
navigation occupancy and conflicting managed environments (case-insensitive IDs).
It does not reuse or modify the old two-subnet helper or any R3 executor.

#### Initial foundation saved-plan policy

`qa_foundation.py` accepts only the initial foundation with all four readiness
flags explicitly false. After separately approved state initialization and plan
creation, use the trusted absolute Terraform 1.13.3 path:

```bash
python3 infra/scripts/qa_foundation.py --inputs "$QA_DIR/foundation.json" \
  --saved-plan "$QA_DIR/foundation.tfplan" --terraform "$TERRAFORM_1_13_3"
```

The CLI requires a clean checkout at `release_sha`. It checks the saved binary's
embedded root configuration byte-for-byte against the seven QA `.tf` files and
provider lock; extra files/modules/overrides refuse. It reads no embedded state
entry directly. It invokes only `terraform show -json` on a private copied plan,
with a sterile environment. Plan source binding uses the pinned Terraform
[1.13.3 config snapshot format](https://github.com/hashicorp/terraform/blob/v1.13.3/internal/plans/planfile/config_snapshot.go);
unknown archive layouts refuse. Raw show output stays in memory and is never
printed. Keep the input and plan under owner custody; plans may contain sensitive
information if created outside the required nonsecret-input procedure.

The independent oracle requires exactly 15 create actions: RG, ACR, logs,
environment, diagnostics, vault, two identities, DNS zone/link/A, three grants
and the unassigned custom environment-join role. It rejects replay/update/delete/
replace/import/move, extra resources, drift/deferred work, incorrect regions,
subnet/DNS targets, widened bodies/RBAC, sensitive bodies, headers and exports.
The owner Secrets Officer grant is present; workload runtime secret grants are
absent. ACR/vault public access and DNS's VNet effect remain explicit approval
items, not private-endpoint claims.

Create-time IDs and principal IDs can be unknown. Only enumerated individual
reference leaves are permitted after embedded source binding; an unknown whole
body or security setting refuses. This preserves the actual initial-plan shape
without treating unknown scope/principal expressions as a blanket exception.
After apply, validate the resolved IDs and principal grants independently.
The result reports exact binary/input/normalized-input/provider-lock hashes,
not an apply authorization. Backend ownership, approval freshness and independent
human/cross-lane plan review remain mandatory.

`qa_foundation_mock.py` is a **CI-only adapter** for Terraform test JSON. It adds
synthetic plan metadata solely to exercise the oracle; it cannot validate a saved
binary. The new `initial.tftest.hcl` uses no resource overrides, preserving
computed references rather than replacing them with known fixture IDs.

#### Post-apply readback preparation and comparison

```bash
python3 infra/scripts/qa_foundation_readback.py manifest --inputs "$QA_DIR/foundation.json" > "$QA_DIR/readback-manifest.json"
python3 infra/scripts/qa_foundation_readback.py verify --inputs "$QA_DIR/foundation.json" \
  --receipt "$QA_DIR/foundation-readback.json" \
  --before-request "$QA_DIR/discovery-before-request.json" --before "$QA_DIR/discovery-before.json" \
  --after-request "$QA_DIR/discovery-after-request.json" --after "$QA_DIR/discovery-after.json" \
  --before-roles "$QA_DIR/roles-before.json"
```

The readback receipt uses `source_sha`, `manifest_sha256`, UTC start/end and the
same record/page schema, without the discovery bundle's `schema` field. The
separate before-roles receipt contains `started_at`, `completed_at`, `record`,
bound to the readback manifest's `roles` command and the before discovery window.
Collect it before apply. After discovery must include the new private DNS zone.
All receipts must remain within the freshness window when compared. The readback
receipt interval must lie inside the after discovery collection window, which
must follow the before window; include all these reads in the approved window.

The checker validates narrow projected settings, identities and exact new role
assignments, preserves old grants, and compares existing VM/NIC/VNet/NSG/routes,
VM OS/data disk attachments, image reference, disk identity metadata, NIC-level
NSG/public-IP references, backend/container metadata and old state-blob metadata.
Only the new app state
keys and service-managed app-subnet occupancy changes are exempted from equality.
State metadata equality is not proof of state ownership. Existing DNS links/A
records and inventory are preserved; extra direct app-group resources refuse.
New inventory outside the expected 15 IDs returns `REVIEW_REQUIRED` with the
unreviewed IDs: ACA service-managed infrastructure must be reconciled by the
owner, never silently accepted. A narrow projection does not prove every ARM
field or effective inherited permission; source-plan review and live acceptance
remain separate. A failed/partial apply consumes approval; no tool here retries,
destroys, repairs state or changes DNS.

### Offline verification

Run the Python commands in an isolated environment installed from the hash-pinned
`infra/tests/requirements.txt` (PyYAML and JMESPath). Set
`TERRAFORM_TEST_BINARY` to the trusted absolute Terraform 1.13.3 path to also run
the provider-free, output-only saved-plan archive test. Without it, that one test
is explicitly skipped. This archive-format test uses no init or cloud; the
computed QA foundation oracle is exercised separately below.

```bash
python3 infra/scripts/check_terraform_policy.py
python3 infra/scripts/qa_policy.py
python3 -m unittest discover -s infra/tests -p 'test_qa_*.py' -v
terraform fmt -check -recursive infra/terraform
for root in foundation/qa application/qa; do
  terraform -chdir="infra/terraform/$root" init -backend=false -input=false -lockfile=readonly
  terraform -chdir="infra/terraform/$root" validate
  terraform -chdir="infra/terraform/$root" test
done
terraform -chdir=infra/terraform/application/qa test -json -verbose > "$TMPDIR/qa-plan.jsonl"
python3 infra/scripts/qa_plan_contract.py "$TMPDIR/qa-plan.jsonl"
terraform -chdir=infra/terraform/foundation/qa test -json -verbose > "$TMPDIR/qa-foundation-plan.jsonl"
python3 infra/scripts/qa_foundation_mock.py "$TMPDIR/qa-foundation-plan.jsonl"
```

These mock/synthetic checks use no R3 host or local Supabase stack and do not
prove live networking, TLS, effective Azure grants or tenant isolation.
