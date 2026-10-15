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
