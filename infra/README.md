# TonyAI cloud foundation (LP2-01)

**Hosted phase (owner decision 2026-10-28).** For the next two to three months QA and
the pilot run the database, Auth and Storage on **Supabase Cloud (Pro), North EU —
Stockholm (`eu-north-1`)** and the web and API on **Azure Container Apps in Sweden Central
(`swedencentral`)**, built from scratch through the reviewed hosted
path (runbooks 00–06; the `terraform/foundation` and `terraform/application` roots, not
their `qa/` subfolders). Codex runs it; every live operation is owner-run or
owner-approved. Plan, work packages and live operations:
[`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](../docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md).
**The self-hosted route described below is paused, not removed:** nothing in it is
executed until the owner resumes it after the pilot launch (to move the Supabase side
to Azure). Its CI gates run only by hand — `selfhost-checks.yml` and `qa-infra.yml`
(Actions → Run workflow); run them before merging any change to `scripts/`, `tests/`,
`terraform/`, `config/` or `selfhost/` here — the self-hosted scripts import most hosted modules.

**Paused self-hosted route — as it stood on 2026-10-28.** It uses **Azure Sweden
Central** for both application and data layers, with self-hosted Supabase; start with
the [self-hosted host/runtime runbook](runbooks/07-selfhost.md) when it resumes. No
production resources are authorized. The former TRY 10,000 monthly cap is removed; the
owner's planning assumption for internal-QA credit is USD 5,000 (2026-10-18), its
balance, eligibility and expiry unverified.

When it resumes, the existing QA host, network, disks, recovery vault and runtime must be discovered
and reconciled before further rollout. Reuse the verified deployment contract,
backend and SSH host keys; never assume an empty subscription or initialize a
parallel state. Application integration is still unimplemented: the Sweden
Container Apps environment must include the reserved infrastructure subnet in
its creation request. See [runbook 07's integration prerequisites](runbooks/07-selfhost.md#application-integration-prerequisites-not-implemented). Runtime health
alone does not establish application QA or recovery acceptance.

[Runbook 08](runbooks/08-qa-application.md) defines the additive Sweden application
foundation/release design, private DB TLS and credential boundaries, and staged
approval/rollback plan. Its offline `selfhost_app_network.py` preflight checks the
existing reserved subnet against nonsecret ARM projections; it neither deploys
nor initializes state; that helper retains the historical two-subnet host contract.
The new deployment roots are offline preparation. API issuer
enforcement was integrated by #180. Deployment binding and live acceptance of the
selfhost issuer/JWKS remain open, alongside the self-hosted SMTP binding (the
provider is ACS Email, data location Europe — decided 2026-10-27), PD-3 and
recovery acceptance.

Runbook 08 also defines the dashboard-only credential transaction. Its separately
approved live rotation/custody completed on 2026-10-15, as did one format-1 I1
catalog inventory. The owner need not recover the old password. Only dashboard
credential rotation/custody is accepted; other DB-admin/Studio-reachable secrets
remain potentially exposed. Neither completed operation closes PD-3.

[Runbook 09](runbooks/09-qa-integrity.md) makes clean Sweden replacement with fresh
credentials, old-trust retirement and preservation the primary planned route.
Catalog consistency cannot prove no secret disclosure, and counts do not establish
disposable data. No rebuild, broad rotation or containment change is authorized
by this documentation. The format-2 collector adds connection-startup event-trigger
suppression and a separate login-trigger count; it is locally tested only, not a
retroactive property of the executed format-1 report or a deployed change.

[Runbook 10](runbooks/10-qa-clean-replacement.md) turns that direction into a
resource/state and maintenance design: one additive replacement generation in
the existing selfhost state, separate subnet and recovery custody, retained old
disks, explicit containment and staged trust acceptance. Its read-only Azure
observations and retail cost subtotals are dated evidence, not a saved plan or
live authorization. The local implementation adds exact R1/R2 saved-plan policy,
generation/source/disk guards, fresh template-wide credentials, two-stage recovery
custody and secret-safe consumer probes. `replacement_run.py` refuses backend
reconfiguration and applies only an explicitly hash-approved saved binary.
The separately approved R1 packet executed on 2026-10-15: one NSG update,
SIGTERM-only stop of ten bound containers, then old VM deallocation. Exact ARM
readback and nine fresh external TCP timeouts support the bounded operation;
retained disk/NIC/IP/vault/lock metadata and all fifteen state resource IDs are
unchanged. R2 subsequently created isolated replacement infrastructure on
2026-10-18, with accepted control-plane readback; consumed packet-02 must never
be replayed or regenerated. Private/VNet probing remains open. Old QA is
unavailable; R3/R4, credential rejection, database integrity and PD-3 closure
are not established.
Bootstrap qualification and full trust acceptance remain deployment gates; do
not invoke the legacy selfhost apply path as a clean rebuild. Runbook 10 lists
the private input and approval boundaries and the probes' incomplete coverage.

Host/runtime acceptance, including the 2026-10-15 corrections and normal reboot,
does not close LP2-01, LP2-02 or LP2-03; DONE requires application integration,
migration/runtime-role/bucket acceptance, fresh recreation and recovery evidence.

The **hosted reference** below (runbooks 00–06) targets Azure Sweden Central
(`swedencentral`) and Supabase North EU — Stockholm (`eu-north-1`). WP-2 adds the
exact hosted-QA exception and ACS Email foundation resources. Runbooks are updated
separately in WP-3; their historical region instructions are not live authority.
Example inputs remain placeholders, not live contracts.

**Hosted phase (owner decision 2026-10-26, extended to the pilot on 2026-10-28; Codex).**
The lane uses `tonyai-qatmp-apps`, `tonyai-qatmp-tfstate`, prefix `tonyaiqt` and
environment `staging`, with no VNet. `config/hosted-qa-exception.json` is a fail-closed
template: the owner must supply the confirmed subscription and dedicated, globally
unique backend account (a `tonyaiqt` name, at most 24 characters) before live use.
Both hosted Terraform roots and the Python entrypoints check the same exact tuple;
backend bootstrap and hosted Terraform invocation also bind the backend group/account.
The paused backend's shared shape validator remains available, but the hosted writer
refuses to adopt or reconfigure that backend. `config/deployment-policy.json` and the
original subscription-refusal condition stay unchanged. Plan:
[`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](../docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md).

Foundation's `email` block accepts only the owner's existing Entra client ID,
service-principal object ID and tenant ID, plus optional domain settings. ACS Email
and Communication Services use `location = global`, `dataLocation = Europe`.
`email_contract` outputs the public SMTP username, sender and STARTTLS settings
(`smtp.azurecomm.net:587`); it never outputs credentials. The owner creates the
Entra client secret separately and stores it directly as Key Vault `smtp-password`.
The SMTP role has only the [three documented authentication actions](https://learn.microsoft.com/azure/communication-services/quickstarts/email/send-email-smtp/smtp-authentication)
and is assignable and assigned only on the hosted Communication resource, never the
subscription or group. Azure supports [resource-instance assignable scopes](https://learn.microsoft.com/azure/role-based-access-control/role-definitions#assignablescopes);
this single-purpose role deliberately uses that narrow scope.
Start with the Azure-managed sender. To add a custom domain, set `custom_domain`,
create it through the separately approved foundation operation, complete DNS
verification, then set `custom_domain_verified = true` in a reviewed follow-up input.
The service also enforces verification when linking; an unverified domain remains
unlinked. Entra provisioning, DNS and every cloud operation remain owner-run.

Offline checks include `python3 infra/tests/check_hosted_terraform.py` after both
hosted roots have been initialized with `-backend=false`: it tests the exact target,
six wrong-target cases per root and ACS residency/RBAC mutations in disposable copies.
`selfhost-checks.yml` and `qa-infra.yml` still require manual runs on the pushed PR
branch before merge; local mocks do not replace them or establish cloud acceptance.

Use Terraform **1.13.3**, AzAPI **2.6.1**, Node **22**, pnpm **11.9.0**, Python **3.10+**,
Azure CLI, GitHub CLI (`gh`) and Docker/buildx. Run from a clean, reviewed checkout. Terraform provider
locks belong with each root; no Supabase or secret-reading Terraform provider
is used. Hosted helper secrets stay in memory and Key Vault. Self-hosted services
also require protected root-only runtime files as described in runbook 07.
Secret payloads never enter tfvars, state, plan files, logs, repository files or chat.

## Sweden QA application preparation (paused)

The additive `terraform/foundation/qa` and `terraform/application/qa` roots are
independent from the hosted roots and from the paused R3 host.
The environment binds the existing app subnet at creation; private DB DNS points
only to r02. Workloads receive exact Key Vault runtime references, never the
migration owner or recovery escrow. OIDC starts disabled. The manual
`qa-candidate.yml` and `qa_*` helpers bind source, public inputs, provenance,
image digests and independent plan/readback policy. `qa-infra.yml` exercises both
new roots and their tests without cloud credentials.

See [runbook 08](runbooks/08-qa-application.md#application-preparation-and-owner-execution)
for the required placeholders and exact approval units. R3/R4, private DB TLS,
schema/runtime privileges and live acceptance are still required. No live step
is authorized by these files or by passing mock tests.

Units 0–2 have offline tooling in `qa_discovery.py`, `qa_network.py`,
`qa_foundation.py` and `qa_foundation_readback.py`: exact read-only command
manifests, complete hash/time-bound projection receipts, an r02 three-subnet
check, initial 15-create plan policy and protected before/after comparison.
Discovery/readback never execute Azure CLI. The saved-plan inspector only runs
local `terraform show` on its private copy after source/config/lock binding;
it never initializes a backend or applies. See runbook 08's
[offline Unit 0–2 tools](runbooks/08-qa-application.md#offline-unit-02-tools)
for schemas, commands, computed-field constraints and remaining owner gates.

Unit 4 uses `qa_runtime.py` with a separate `qa_runtime_plan.py` policy: exactly
15 existing foundation resources plus two API Secrets User creates on
`database-url` and `supabase-service-role-key`. Only the RG's exact old/new
`releaseSha` tag may update; other gates stay false. `qa_runtime_receipt.py`
prepares public metadata queries and checks complete fresh observations, exact
version metadata and the two-assignment delta. `qa_runtime_packet.py` always
returns `BLOCKED_DRAFT`, never live authority. No Terraform grant definition or
initial policy changed. See [offline Unit 4 tools](runbooks/08-qa-application.md#offline-unit-4-tools).
`qa_runtime_mock.py` rehearses the transition with installed mock providers in
a disposable copy; it removes only the five prevent-destroy guards for mock
teardown and does not initialize a backend or run a real plan/apply.

Unit 5 uses `qa_oidc.py` and its independent `qa_oidc_plan.py` oracle. It accepts
only `runtime=true, oidc=false, smtp=false, apps=false` → `true,true,false,false`,
plus an explicitly bound optional `releaseSha` tag change. All 17 Unit 4 resources
remain; only the release identity, exact staging federation and five narrow grants
are created (24 total). `qa_oidc_receipt.py` prepares complete public resource,
identity, federation and assignment snapshots; `qa_oidc_github.py` checks projected
admin prerequisites with pagination/failure/freshness bindings. Both are offline;
no caller JSON authenticates Azure/GitHub or proves effective/inherited access.
The owner packet stays `BLOCKED_DRAFT`, including with complete synthetic receipts.
`qa_oidc_mock.py` runs the installed-provider mock transition in a disposable copy,
with the same five teardown-only guard removals. No production Terraform changed.
See [offline Unit 5 tools](runbooks/08-qa-application.md#offline-unit-5-tools).

Unit 7 uses `qa_application.py` to derive JSON privately from the exact saved
application binary, retain the two-app body oracle and bind source/configuration,
provider lock, inputs and candidate hashes. `qa_application_receipt.py` prepares
read manifests and checks their source/release/plan/time binding, complete approved
revision sets and zero outgoing replicas. `qa_owner_packet.py` emits only a
`BLOCKED_DRAFT`: no offline receipt authenticates Azure and no local candidate
file authenticates GitHub. Optional `--github-run-id` explicitly performs the
existing authenticated GitHub artifact lookup; it is not part of offline tests.
See [offline Unit 7 tools](runbooks/08-qa-application.md#offline-unit-7-tools).
There is no apply executor, automatic promotion, retry or acceptance claim.

Unit 8 uses `qa_deployment.py` and its separate two-grant policy: only `apps_ready`
changes false to true, with an optional exact RG `tags.releaseSha` update. All 24
existing foundation resources remain; the resulting 26-resource state excludes
the two apps, whose sole writer is still `application/qa`. Historical Unit 5 and
Unit 7 evidence is checked against each source commit's public Git blobs, including
the historical candidate lockfile/migration fingerprint, never today's checkout.
Fresh public observations must prove both accepted apps exist and remain unchanged;
all prior resources/assignments/identities/federation are preserved. The existing
pure Unit 5 GitHub prerequisite policy is reused. `qa_deployment_mock.py` establishes
24 resources with the installed provider, then checks exactly two creates in a
disposable copy, removing only five teardown guards there. `qa_deployment_packet.py`
always returns `BLOCKED_DRAFT` and `authorization=false`. Container Apps Contributor
can replace API code and indirectly access runtime secrets. No live grant, automatic
deployment workflow or operational acceptance follows from offline success.
See [offline Unit 8 tools](runbooks/08-qa-application.md#offline-unit-8-tools).

`qa_cloud_smoke.py` is the separate (paused) Sweden smoke adapter; the hosted
`staging` smoke (`cloud_smoke.py`) and loopback CI remain distinct. Offline `prepare` binds the accepted Unit 5/7
history and creates only an ID journal with a `BLOCKED_DRAFT` response. A separately
approved owner run reauthenticates the candidate and collects fresh Unit 7 public
readbacks before any credential read or fixture write. Owner DB input uses a hidden
terminal prompt, never the app vault; the browser receives no DB/service credential.
Failure, drift, partial Auth creation or failed exact-ID cleanup cannot emit a passed
report. Application/audit rows remain. See the [invocation and failure contract](runbooks/08-qa-application.md#sweden-smoke-adapter).
Offline checks: `python3 -m unittest discover -s infra/tests -p 'test_qa_*.py'`
with `TERRAFORM_TEST_BINARY` unset, and `node --test infra/tests/*smoke*.test.mjs`
on Node 22. No live TLS, database, browser or Azure verification follows from these tests.

## Hosted route for QA and the pilot (00–06)

Supabase Cloud `eu-north-1` + Azure `swedencentral`, built from scratch; run nothing
before WP-2 merges (the code still pins Frankfurt / Germany West Central until then).

1. [Restore a safe session](runbooks/00-session.md).
2. [Bootstrap backend, apply foundation, establish OIDC](runbooks/01-azure.md).
3. [Create/resume Supabase, configure Auth/JWKS and private buckets](runbooks/02-supabase.md).
4. [Build immutable images, migrate, deploy one release](runbooks/03-deploy.md).
5. [Collect live acceptance and fresh-recreation evidence; restore a database](runbooks/04-verify.md).
6. [Rotate, roll back or recover state/vault; run the owner reconciliation check](runbooks/05-rotation.md).
7. [Prove readiness, alert delivery and staging acceptance](runbooks/06-operations.md).

## Authoritative writers: the hosted path

For the paused self-host writers and their boundaries, use [runbook 07](runbooks/07-selfhost.md#state-inputs-and-commands).

| Surface | Sole writer | Access |
|---|---|---|
| The hosted phase's own backend (`tonyai-qatmp-tfstate` and its account — never the paused self-hosted backend account): group/account, firewall, containers, recovery/lock and backend RBAC | `bootstrap_backend.py` (pinned to that pair by WP-2) | Owner only; no Terraform state needed |
| Azure resource group, registry, logs, environment, diagnostics, vault, managed identities, Azure role assignments | `terraform/foundation` | Owner; `foundation` blob container only |
| Scheduled verification job and operator alert delivery | `terraform/foundation` optional `config.monitoring` | Owner only; pinned runtime image/secret references, no deployer grant |
| Entra app/SP/federation and RG `githubClientId`/`githubPrincipalId` recovery markers | Reviewed `configure_oidc.py` | Owner Graph access; these two tag fields are explicitly excluded from Terraform ownership |
| Both Container Apps, revisions, ingress, image digests, secret references | `terraform/application`, through `deploy-apps.sh` | First create by owner; then app-scoped deployer and `application` blob container |
| Supabase project, Auth/signing keys, buckets | `supabase_setup.py`, journaled Management API calls | Owner management token entered with hidden input |
| Key Vault secret **values** | Supabase transfer or explicit `release_secrets.py store` rotation | Owner; no Terraform secret resource/data source |
| Builds and Prisma migrations | Build/migration helpers | Outside Terraform |

One account per environment, two state containers, no workspaces as an isolation
boundary, no application remote-state data source. The deployer receives no
foundation-state access and cannot create arbitrary apps/jobs or change RBAC.
The owner exports a small public contract (resource names/domain/tenant) for the
application root. `database-url` is the runtime role and `direct-url` is owner-only for migrations
and controlled fixture provisioning. Bootstrap writes only `direct-url`; runbook
05 activates runtime login before workload access. Rotate the credentials
independently and disable historical owner-backed runtime versions. Enforced GitHub environment protections are required.

Bicep is retired from the active tree. Its reviewed baseline remains in Git at
`40ed0f9` (#139); there is no second Azure writer to apply. The original Bicep-to-Terraform transition was designed for an empty legacy
state. **The hosted phase starts from that empty state** in its own new backend
account. The paused self-hosted QA's state (`foundation/staging-selfhost.tfstate` in
its verified backend) is never imported, replaced or reinitialized against another
backend; inspect ownership and provider read behavior first when it resumes.

## Offline validation

```bash
python3 -m venv /private/tmp/tonyai-infra-venv
source /private/tmp/tonyai-infra-venv/bin/activate
python3 -m pip install --only-binary=:all: --require-hashes -r infra/tests/requirements.txt
python3 -m unittest discover -s infra/tests -v
python3 infra/tests/check_selfhost_runtime_mutations.py
python3 infra/tests/check_mutations.py
python3 infra/scripts/check_terraform_policy.py
terraform fmt -check -recursive infra/terraform
for root in foundation application selfhost; do
  terraform -chdir="infra/terraform/$root" init -backend=false -input=false -lockfile=readonly
  terraform -chdir="infra/terraform/$root" validate
  terraform -chdir="infra/terraform/$root" test
done
python3 infra/tests/check_grant_mutations.py
python3 infra/tests/check_docker_context.py
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

The selfhost mutation runner preserves the repository's `infra/` layout and
Terraform source dependencies in each disposable copy. Each unmodified copy must
pass before a mutation is applied; setup/import errors are never valid kills.

`check_mutations.py` runs a full infrastructure baseline once, then uses the
relevant test module for each of its 119 regression mutants, retaining a clean
control in every disposable copy. This avoids repeatedly invoking unrelated
loader mutations and subprocess fixtures. Progress includes the mutant name,
test selector and control/mutant/total durations, flushed as each result arrives.
Syntax failures, process failures and test errors are invalid evidence; a mutant
must cause an assertion failure. The separate R3 and Terraform checks still run.

`r3_mutations.py --output <report.json> [--workers N]` copies `infra/scripts`,
`infra/tests`, `infra/selfhost` and `.github/workflows` once per worker
(default: the CPU count, never more than the mutants plus the two baselines)
and requires every copy to hash identically before any test runs. It checks
every anchor in registry order first, then runs the full R3
and Node baselines and the mutants on a shared pool; each mutant is applied only
in the copy its worker holds, runs its mapped suites with a 60-second timeout and
is restored there. The report lists results in registry order whatever order they
finished in, and is written only when both baselines pass and every copy still
hashes as it did before the run. Each worker also gets a short private fixture root
(`/tmp/r3mw-*/<n>`, passed as `R3_PK_FIXTURE_ROOT` to `r3_pk_fixtures.Host`) that the
runner sweeps after every run, a timed-out one included, so a killed suite leaves no
synthetic host behind (it refuses to sweep a root that is no longer its own real directory); a SIGTERM to the runner unwinds like Ctrl-C and removes the
worker copies and fixture roots.

Infrastructure CI calls the unchanged R3 runner through
`ci_mutation_shard.py --shard 0..3 --output <report.json>`. The four strided
partitions cover every registered mutant exactly once; each shard verifies its
complete ordered result set and retains both baselines. These jobs run alongside
the remaining checks. The final `infra` check requires successful validation and
all matrix jobs, including when a prerequisite fails, is cancelled or is skipped.
No successful test results are cached. This trades additional concurrent runner
capacity and repeated baselines for shorter elapsed time.

For a checkout already bound to a live backend, run offline init/validate/test
in a disposable source copy with a separate local `TF_DATA_DIR` and
`-backend=false`; preserve the original backend metadata and remote state.
This isolated test directory is not a deployment state.

Terraform tests use **mock providers**. They test expressions/guards and do not
establish permissions, region availability, provisioning, pricing, OIDC, TLS,
secret resolution or health. Infrastructure CI has no cloud credentials and never
applies resources. D22 keeps per-PR E2E nongating; full release-candidate E2E and
flow-changing manual runs remain required elsewhere.

See [provider/state security review](terraform/README.md). API `/health` is process liveness after Nest startup; `/health/ready` checks
bounded DB connectivity and both private Storage buckets. `/health/synthetic`
requires a real authenticated profile. Full lifecycle acceptance remains owner-run. The included CA under
`infra/certs/` remains in the API Docker context; other infra files and all
Terraform/owner artifacts are excluded.

R3 preparation uses `r3_artifacts.py`, `r3_transfer.py`, `r3_toolchain.py` and
`r3_install.py` for pinned offline inputs and a separately approved toolchain
stage, plus `r3-qualification.yml` for the agreed fresh GitHub Ubuntu 24.04 amd64
composition smoke target. Format-2 bundles bind a clean source commit and observed signed-index hashes; pinned-engine/install qualification remains open. No preparation command grants cloud or bootstrap authority;
[runbook 10](runbooks/10-qa-clean-replacement.md#accepted-r2-and-bounded-r3-preparation-2026-10-18) lists the outstanding proof and approval gates.
The package job retains only six explicit public provenance files for seven days,
including a receipt bound to the checked-out source and real vendor verification.
That binding compares the complete bundle map to committed source bytes and
upstream pins; Git status alone is insufficient. Receipt hashes use the exact
manifest/lock bytes verified, and the upload requires a nonempty receipt.
This evidence artifact contains no package archives and is not a transfer bundle.
For failures it handles, the composition helper reports only a fixed phase/cleanup
vocabulary, without exception text, commands or captured runtime output. Cancellation
or job timeout can instead end with a Python traceback containing source lines,
exception classes and public command arguments (not captured child stdout/stderr),
or with no status line. For handled failures, it preserves
the initial failing phase if cleanup also fails, and writes its success summary
only after project cleanup returns successfully. No failure report adds an upload
or grants retry authority.
Compose 2.38.2 omits a false `create_host_path` field in JSON. The smoke accounts
for this only for that exact reported version and a present dictionary on a bind
mount; explicit values are never overwritten. Unknown-version omissions, missing
bind objects and enabled path creation remain refused. The shared host validator
and explicit `create_host_path: false` source overlays are unchanged.
The r02 runtime contract rejects both legacy installation shells.
`r3_package_evidence.py`, `r3_guard_files.py` and `r3_source_plan.py` prepare public
archive analysis, offline guard payloads and a proposed source map.
`r3_realtime_gcm.mjs` (pure case machine), `r3_realtime_clients.mjs` (pinned
realtime-js/Phoenix/ws/jose/Prisma adapters) and `r3_realtime_gcm_run.mjs` (single-attempt
runner) are the offline Realtime GCM consumer harness for a two-service disposable fixture
(`infra/selfhost/r3-realtime-gcm.fixture.json`): real API writes of the JWT secret and five DB
fields, socket/broadcast/postgres_changes reads, cold-restart persistence, global and DB-only
wrong-key cases and ten validly encoded tamper cases, each with positive recovery. A refusal counts
only with the source's status/reason and a crypto.ex failure entry attributed to exactly that tenant.
`--execute` needs a canonical owner approval (its SHA-256 given separately) naming the manifest,
harness and evidence directory, consumed in a fixed ledger before any effect (on GitHub Actions it
must also name that exact run, first attempt, so a new dispatch or re-run cannot replay it); key
files stay on tmpfs, and signals or `--teardown --attempt <id>` remove only that attempt's labelled
objects.
Its Node tests use an AES-GCM model, a one-guard-at-a-time perturbation table and fakes; the
manifest is deliberately `executable: false` with its unbound inputs listed. It has never been
executed and is not consumer evidence.
`r3_image_transport.py` verifies/packages the selected-platform OCI closure retaining
the original root, without importing it. Duplicate/case-colliding keys, foreign
descriptor fields and conflicting document types are refused. Exact APT
install/configure candidates, `--no-remove` and observed package/Node receipts
strengthen the installer. `r3_package_state.py` checks complete pre/post inventories
and exact five-pin dpkg log actions; `r3_apt_observer.py` samples already-masked
apt units, process identity and boundary lock contention. The format-2 install
approval binds both new helpers; the format-2 receipt binds inventories, APT
stdout/stderr, the dedicated dpkg log and observations. Old approvals cannot be
reused. No apt timer/service mutation is performed. A real Noble fixture, reviewed
isolation procedure and lifecycle qualification remain required before any guest
proposal becomes executable. The dispatch-only `r3-offline-inputs.yml` runs public
input analysis alone. Target closure, actual import/digest resolution, guard
installation, unmask ordering and reboot proof remain separate gates; see the
[bounded proposal](runbooks/10-qa-clean-replacement.md#offline-input-qualification-and-host-installation-proposal).

### Native Noble diagnostic fixture (A)

`r3-native-noble.yml` prepares a disposable native VM on the selected fresh
GitHub-hosted `ubuntu-24.04` amd64 runner. It requires its own exact published
source/ref and single-dispatch approval. Local tests and publication alone do
not authorize it. See [the fixture procedure](runbooks/10-qa-clean-replacement.md#native-noble-fixture-a).
The controller stages only public pinned inputs, installs explicitly pinned
QEMU/ISO tools on that ephemeral runner, boots a pinned Canonical cloud image
without a NIC or host mounts, and retains encrypted diagnostics. This is separate
from Azure inventory packet B, production installation, and composition smoke.
No service/trigger disabling or strict-parser relaxation is included. A refusal
can be useful diagnostic evidence; it does not qualify the target.


### Registry-denied image transport run

`r3-image-transport.yml` (dispatch-only, attempt 1, `contents: read`, no secrets)
runs `r3_image_qualify.py` once on a fresh GitHub-hosted `ubuntu-24.04` amd64 runner.
Connected, it stages the hash-locked Docker packages, fetches the twelve locked roots
by digest with `r3_image_acquire.py` (hash-checked, no daemon) and packages them
with `r3_image_transport.py`. Then `r3_image_import.py` runs as root in a
loopback-only network namespace: denial probes and a loopback DNS observer, the
pinned containerd/Engine 29.9.1 extracted from those packages on new roots, an
observed empty containerd image store, one refused pull, `docker load` of only the
nine active roots, Docker API and content-store readback of every root, repo
digest, platform, config and diff ID, and `docker create` (never started), which
needs every layer unpacked (at load, or at create at the latest). Evidence is sealed to the owner's recipient. It
starts no service, so nine-service startup from a transported store stays a gate.
Its own exact source and single-dispatch approval are required; see
[the run](runbooks/10-qa-clean-replacement.md#offline-input-qualification-and-host-installation-proposal).

### Private DB candidate (replacement regression)

`infra/scripts/r3_db_candidate/` is the privately reviewed DB replacement-regression
candidate, published byte-identical to its reviewed files (six special-grantee
GRANT/REVOKE cases plus two named controls, each three times, on the pinned
`supabase/postgres` digest). It replaces nothing historical: the supautils SIG11 stays
`NOT_REPRODUCED` and R3 stays OPEN whatever it returns. `r3-db-candidate.yml`
(dispatch-only, attempt 1, `contents: read`, no secrets) runs `r3_db_candidate_run.py`
once on a fresh GitHub-hosted `ubuntu-24.04` amd64 runner in one of two modes:
`rehearsal` (same container argv, readiness, maps/log reads as postgres and teardown;
no attempt id, fixture or probe) or `attempt` (the single owner-approved run).
The controller binds the dispatched source, checks `infra/selfhost/r3-db-candidate.lock.json`
against the committed bytes, and stages at the fixed root `/private/tmp/tonyai-r3-db`:
Node 22.23.3's `bin/node` from the toolchain-locked tarball, and a model-free Prisma
6.19.3 client rebuilt from pinned inputs (the three generated text files vendored in
`infra/selfhost/r3-db-candidate-client/`, `runtime/library.js` from the
lockfile-integrity `@prisma/client` tarball plus Prisma's fixed header, and the
`debian-openssl-3.0.x` query engine from Prisma's binaries host). Every staged byte must
equal the lock's `client_artifacts`, whose canonical hash the owner's approval binds.
An attempt also needs its attempt id and owner-decision hash committed to the lock by a
reviewed PR, and derives the image's closure evidence from its by-digest OCI layout.
The candidate's own `attempt_entry.py` then re-verifies every file against the approved
manifest and seals its evidence to the owner's recipient; only that ciphertext,
`binding.json` and `summary.json` are uploaded. To regenerate the vendored client,
run `prisma generate` (6.19.3) from `/private/tmp/tonyai-r3-db` with `client/schema.prisma`
as `/private/tmp/tonyai-r3-db/schema.prisma` and `@prisma/client`/`prisma` linked into its
`node_modules`: the output is host-independent and must reproduce the lock's hashes.


The recovery renderer also supports `--identity-diagnostic` for a separate
`ONE_MANAGED_IDENTITY_DIAGNOSTIC` approval and `--phase diagnose` execution.
This metadata-only guest payload reports the failing IMDS/boot-ID stage and
bounded selected identity fields without opening an account or appending a key.
It requires a new source-bound packet, fresh observations, the exact retained
failed command, and private encrypted custody. See the
[identity diagnostic contract](runbooks/10-qa-clean-replacement.md#managed-identity-diagnostic-after-a-failed-repair).
It does not establish access or installation qualification.
The separate `purpose=snap-leaf-diagnostic` observes only `/usr/bin/snap`
metadata and uninterpreted symlink text, without opening or resolving the target.
It has a distinct three-file private frame and independent validation. A stable
observation is `DIAGNOSTIC_OBSERVED_REVIEW_REQUIRED`, never installation or policy
qualification. Existing pinned runner/image/artifact staging still occurs and
requires its own exact dispatch approval; package inputs remain inert in this
route. See the [snap diagnostic scope](runbooks/10-qa-clean-replacement.md#fixed-snap-leaf-diagnostic).
Collection evidence format 2 records the alias in its own `snap:/usr/bin/snap`
section (`r3_policy_snap.py`): absent, regular, or exactly `../lib/snapd/snapd`,
whose fixed target is opened independently with O_NOFOLLOW and hashed (at most
64 MiB). Section format 2 streams a regular alias under the same cap
(`REGULAR_UNSAFE`/`REGULAR_LIMIT`) and records drift as `CHANGED`. Other links,
types or drift are refused; the section never enters the policy-input hashes.
Format 1 evidence stays valid. A kernel's `linux-update-<version>` trigger file is
read only when the same inventory records `linux-image-<version>` installed.
Collection evidence format 3 (option C, PR-C1) adds the shared PackageKit sections
of `r3_packagekit_state.py`: one `observe` -> `normalize` -> `evaluate` domain that the
installer's facts and the validator both use, with no-follow reads and exactly three
fixed commands (two `systemctl show`, one `dpkg-query -W`) and no PackageKit or socket
contact. Its reviewed values are module literals in per-target profiles, none shipped
yet, so a run is `DISCOVERY_ONLY` (complete and sealed, never a policy input); the
installer's gate is not wired before PR-C2 (`PACKAGEKIT_GATE_WIRED`), so no host becomes
eligible. A unit root reached through a symlink (Noble's `/etc/xdg/systemd/user`) is
recorded as that link, never followed, and counts as covered only when it points at
another scanned, non-`/run` root of the same manager family with `..` only as a leading run.
PR-C1b adds snapd's servicedir (`C2`, `C9.servicedirs`), the reviewed offline-update link
rule (`C13`), four evidence sections that must be collected (`G7.evidence`), discovery
md5sums and a path-free `locus` on item errors; still no profile. No mask, stop or unmask exists in this code. See
[R3-POLICY-01-C1](runbooks/10-qa-clean-replacement.md#r3-policy-01-c1-shared-packagekit-state-option-c).
