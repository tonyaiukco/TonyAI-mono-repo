# TonyAI cloud foundation (LP2-01)

The active QA and planned production direction is **Azure Sweden Central** for
both application and data layers, with self-hosted Supabase. Start with the
[self-hosted host/runtime runbook](runbooks/07-selfhost.md). QA comes first; no
production resources are authorized. QA target: **2026-11-15**. The former
TRY 10,000 monthly cap is removed; the reported USD 25,000 credit allocation's
activation, eligibility, expiry and balance remain unverified.

The existing QA host, network, disks, recovery vault and runtime must be discovered
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
nor initializes state. The new deployment roots remain unimplemented. API issuer
enforcement was integrated by #180. Deployment binding and live acceptance of the
selfhost issuer/JWKS remain open, alongside SMTP provider/residency, PD-3 and
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

The **legacy hosted path** below uses Azure Germany West Central and Supabase
Management API operations for Frankfurt. Its region/project checks remain intact;
the foundation and application roots are blocked for the selected self-host
subscription. Do not remove that gate or substitute region text to deploy the
application. Generic example inputs remain placeholders, not live contracts.

Use Terraform **1.13.3**, AzAPI **2.6.1**, Node **22**, pnpm **11.9.0**, Python **3.10+**,
Azure CLI, GitHub CLI (`gh`) and Docker/buildx. Run from a clean, reviewed checkout. Terraform provider
locks belong with each root; no Supabase or secret-reading Terraform provider
is used. Hosted helper secrets stay in memory and Key Vault. Self-hosted services
also require protected root-only runtime files as described in runbook 07.
Secret payloads never enter tfvars, state, plan files, logs, repository files or chat.

## Legacy hosted owner path (00–06)

1. [Restore a safe session](runbooks/00-session.md).
2. [Bootstrap backend, apply foundation, establish OIDC](runbooks/01-azure.md).
3. [Create/resume Supabase, configure Auth/JWKS and private buckets](runbooks/02-supabase.md).
4. [Build immutable images, migrate, deploy one release](runbooks/03-deploy.md).
5. [Collect live acceptance and fresh-recreation evidence; restore a database](runbooks/04-verify.md).
6. [Rotate, roll back or recover state/vault; run the owner reconciliation check](runbooks/05-rotation.md).
7. [Prove readiness, alert delivery and staging acceptance](runbooks/06-operations.md).

## Authoritative writers: shared backend and legacy hosted path

For self-host writers and their boundaries, use [runbook 07](runbooks/07-selfhost.md#state-inputs-and-commands).

| Surface | Sole writer | Access |
|---|---|---|
| Shared backend (Sweden self-host and legacy hosted): group/account, firewall, containers, recovery/lock and backend RBAC | `bootstrap_backend.py` | Owner only; no Terraform state needed |
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
state; that historical assumption does not describe current self-hosted QA. Its
existing state is `foundation/staging-selfhost.tfstate` in the verified backend.
Do not import arbitrary existing resources, replace state or reinitialize against
a new backend; inspect ownership and provider read behavior first.

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
`r3_image_transport.py` verifies/packages the selected-platform OCI closure retaining
the original root, without importing it. Duplicate/case-colliding keys, foreign
descriptor fields and conflicting document types are refused. Exact APT
install/configure candidates, `--no-remove` and observed package/Node receipts
strengthen the installer. The dispatch-only `r3-offline-inputs.yml` runs public
input analysis alone. Target closure, actual import/digest resolution, guard
installation, unmask ordering and reboot proof remain separate gates; see the
[bounded proposal](runbooks/10-qa-clean-replacement.md#offline-input-qualification-and-host-installation-proposal).
