# Sweden QA application integration

This is the integration design and approval boundary for the existing self-hosted
QA host. The **offline network creation preflight** and a **locally tested dashboard
rotation helper** are implemented by this change; neither authorizes live execution.
The additive `foundation/qa` application foundation is prepared and mock-tested;
the QA release writer and public offline validators are also prepared. Image
building and private database TLS remain separate implementation/review work. OIDC and runtime/app grants start disabled. This runbook is
not an apply command, an approval, or evidence that the application is deployed.
Use [runbook 07](07-selfhost.md) for existing host ownership and runtime recovery.

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
| API and web Container Apps, revisions, ingress and runtime references | New, additive `selfhost-application` root; Sweden Central; one writer for release, rotation and rollback |
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
`10.80.2.0/23`; the host subnet is `10.80.0.0/24` inside `10.80.0.0/16`.
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

The new release contract must bind full source SHA, lockfile and ordered migration
hashes, both image digests, environment/region/subnet IDs, exact Key Vault versions,
Supabase public origin, JWKS URL, expected issuer, browser key binding, DB trust
hash, runtime limits, and storage cleanup hold. Reject unknown/secret-value fields,
hosted project refs, mutable tags and unversioned secret URIs. Build the web with
its actual target origins; reusing a hosted bundle is not integration. Require
exact-source CI/E2E/integration qualification and actual-image smoke before release.
The future release writer must read back images, references, ingress and identity;
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


## Additive QA application foundation preparation

The prepared root is `infra/terraform/foundation/qa`; use its invalid-placeholder
`inputs.example.json` only as a template for owner-selected nonsecret identifiers.
It is QA-only in Sweden Central. The first environment PUT carries the exact
reserved app subnet and Consumption profile. Private DNS maps
`db.qa.tonyai.internal` to the accepted r02 address `10.80.1.4`, never the old host.
The existing selfhost root remains the only VNet/subnet/NSG/VM writer.

No live unit is authorized. Before any state initialization or plan/apply,
require accepted R3/R4/PD-3, fresh resource/subnet/backend inventory, approved
state keys and capacity/cost review. The separate DNS creation needs explicit
approval. First foundation inputs keep `oidc_enabled`, `runtime_secrets_ready`,
`smtp_secret_ready` and `apps_ready` false. Runtime grants can later name only the
API's exact app-vault secrets; DIRECT_URL and recovery escrow never reach workloads.
Federation requires the existing full owner/admin GitHub preflight, independent
reviewer and verified ephemeral JIT host destruction. Production is not supported
by this QA-only root. The final execution sequence follows with the release/image
preparation; do not use the legacy hosted apply helpers for this root.

Offline checks only:

```bash
terraform -chdir=infra/terraform/foundation/qa init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/terraform/foundation/qa validate
terraform -chdir=infra/terraform/foundation/qa test
```


## QA application release contract preparation

`infra/terraform/application/qa` is the sole application writer for both QA apps;
its public foundation contract never reads foundation state. Only exact image
digests and Key Vault secret versions are accepted. APP_URL/WEB_ORIGIN match the
web origin; Supabase origin/issuer are r02-specific and JWKS-only. API is bounded
to one replica, 1 CPU/2Gi and five DB connections; web uses 0.5 CPU/1Gi and 0–2
replicas. Startup, liveness and dependency readiness remain separate probes.
Optional API SMTP needs complete public parameters and an API-only password
reference; it does not configure GoTrue password-reset delivery.

The root's invalid-placeholder `inputs.example.json` and `target.example.json`
are templates only. `qa_release.py` checks the clean source, public release and
local candidate binding. Its saved-plan oracle independently computes expected
app bodies and rejects unknown writers, deletes, owner credentials, sidecars,
insecure ingress, identity drift and revision reuse. Hold removal requires explicit
acknowledgement. `qa_readback.py` checks public environment/app/revision projections
and rejects unreviewed executable surfaces; neither tool authenticates arbitrary
caller-supplied evidence. The authenticated image artifact pipeline and final
owner execution sequence follow in the next PR. No live release is authorized.

`qa_database_url.py` is an owner-only, status-only syntax check on a separately
approved private file: runtime uses `tonyai_runtime`; owner uses `postgres`;
both bind private DB DNS/5432 and strict CA verification without URL overrides.
It never connects or uploads secrets. Actual Prisma TLS, privileges and host
readiness remain required. DIRECT_URL never reaches app env, tfvars or identities.
The eventual release must authenticate its image artifact, drain prior API
revisions before an unchanged saved-plan apply, preserve cleanup hold and use
only schema-compatible rollback. No seed/reset or migration is included here.

Offline checks (no cloud):

```bash
python3 infra/scripts/qa_policy.py
python3 -m unittest discover -s infra/tests -p 'test_qa_*.py' -v
terraform -chdir=infra/terraform/application/qa init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra/terraform/application/qa validate
terraform -chdir=infra/terraform/application/qa test
terraform -chdir=infra/terraform/application/qa test -json -verbose > "$TMPDIR/qa-plan.jsonl"
python3 infra/scripts/qa_plan_contract.py "$TMPDIR/qa-plan.jsonl"
```
