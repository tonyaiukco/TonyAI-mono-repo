# TonyAI cloud foundation (LP2-01)

Owner-run Terraform for Azure Germany West Central; coded Supabase Management API
operations for Frankfurt. **No resources or cloud evidence are implied by these
files.** LP2-01 closes only after the owner evidences fresh recreation. Inputs for
tenant, subscription, organization and budget remain placeholders.

Use Terraform **1.13.3**, AzAPI **2.6.1**, Node **22**, pnpm **11.9.0**, Python **3.10+**,
Azure CLI and Docker/buildx. Run from a clean, reviewed checkout. Terraform provider
locks belong with the two roots; no Supabase or secret-reading Terraform provider
is used. All secret payloads stay in helper memory and Key Vault, never tfvars,
state, plan files, logs, repository files or chat.

## Ordered owner path

1. [Restore a safe session](runbooks/00-session.md).
2. [Bootstrap backend, apply foundation, establish OIDC](runbooks/01-azure.md).
3. [Create/resume Supabase, configure Auth/JWKS and private buckets](runbooks/02-supabase.md).
4. [Build immutable images, migrate, deploy one release](runbooks/03-deploy.md).
5. [Collect live acceptance and fresh-recreation evidence](runbooks/04-verify.md).
6. [Rotate, roll back or recover state/vault](runbooks/05-rotation.md).

## Authoritative writers

| Surface | Sole writer | Access |
|---|---|---|
| Backend group/account, firewall, containers, recovery/lock and backend RBAC | `bootstrap_backend.py` | Owner only; no Terraform state needed |
| Azure resource group, registry, logs, environment, diagnostics, vault, managed identities, Azure role assignments | `terraform/foundation` | Owner; `foundation` blob container only |
| Entra app/SP/federation and RG `githubClientId`/`githubPrincipalId` recovery markers | Reviewed `configure_oidc.py` | Owner Graph access; these two tag fields are explicitly excluded from Terraform ownership |
| Both Container Apps, revisions, ingress, image digests, secret references | `terraform/application`, through `deploy-apps.sh` | First create by owner; then app-scoped deployer and `application` blob container |
| Supabase project, Auth/signing keys, buckets | `supabase_setup.py`, journaled Management API calls | Owner management token entered with hidden input |
| Key Vault secret **values** | Supabase transfer or explicit `release_secrets.py store` rotation | Owner; no Terraform secret resource/data source |
| Builds and Prisma migrations | Build/migration helpers | Outside Terraform |

One account per environment, two state containers, no workspaces as an isolation
boundary, no application remote-state data source. The deployer receives no
foundation-state access and cannot create arbitrary apps/jobs or change RBAC.
The owner exports a small public contract (resource names/domain/tenant) for the
application root. Deploy access is still access to runtime data: code replacing
the API can read its secrets. Enforced GitHub environment protections are required.

Bicep is retired from the active tree. Its reviewed baseline remains in Git at
`40ed0f9` (#139); there is no second Azure writer to apply. As no Bicep deployment
exists, this transition starts with empty remote state. Do not import arbitrary
existing resources or state; inspect provider read behavior and ownership first.

## Offline validation

```bash
python3 -m unittest discover -s infra/tests -v
python3 infra/tests/check_mutations.py
python3 infra/scripts/check_terraform_policy.py
terraform fmt -check -recursive infra/terraform
for root in foundation application; do
  terraform -chdir="infra/terraform/$root" init -backend=false -input=false -lockfile=readonly
  terraform -chdir="infra/terraform/$root" validate
  terraform -chdir="infra/terraform/$root" test
 done
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Terraform tests use **mock providers**. They test expressions/guards and do not
establish permissions, region availability, provisioning, pricing, OIDC, TLS,
secret resolution or health. Infrastructure CI has no cloud credentials and never
applies resources. D22 keeps per-PR E2E nongating; full release-candidate E2E and
flow-changing manual runs remain required elsewhere.

See [provider/state security review](terraform/README.md). API health currently
proves process liveness only; DB readiness is LP2-03. The included CA under
`infra/certs/` remains in the API Docker context; other infra files and all
Terraform/owner artifacts are excluded.
