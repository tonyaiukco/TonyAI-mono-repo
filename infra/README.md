# TonyAI staging foundation (LP2-01)

These files implement the accepted Azure/Supabase design. They are not evidence that
an environment exists. The project owner executes every authenticated cloud step;
record actual results in the LP2-01 PR using the roadmap B9 handoff. Do not mark the
card DONE until recreation and cloud verification succeed on the integrated SHA.

Run from the repository root, in Bash. On later visits, [restore the session](runbooks/00-session.md); do not enable interactive `set -e`. Then run in order:

1. [Azure foundation and GitHub federation](runbooks/01-azure.md).
2. [Supabase, secrets, migrations and private buckets](runbooks/02-supabase.md).
3. [Build and deploy the staging containers](runbooks/03-deploy.md).
4. [Acceptance evidence and recovery boundaries](runbooks/04-verify.md).
5. When needed, [secret rotation and vault recovery](runbooks/05-rotation.md).

The design uses Germany West Central, a Consumption ACA environment, ACR Basic,
Log Analytics, two user-assigned runtime identities and Key Vault secret references.
Supabase is a separate Frankfurt (`eu-central-1`) project. Production requires a
separate resource group, identities, vault and Supabase project (LP2-04); these
staging-only templates deliberately reject another Azure region.

Bicep was chosen over Terraform to avoid introducing a state backend for these
Azure-only resources. Supabase project/Auth setup remains an explicit dashboard
procedure; bucket reconciliation and migrations use a small owner-only Python
standard-library tool. No new package or lockfile dependencies are required.

## Local checks (no cloud account or database)

Use Node 22, the repository-pinned pnpm, Python 3.10+ and the Bicep CLI. Compile
outside the checkout; no generated ARM files belong in git.

```bash
bicep build infra/azure/foundation.bicep --outfile /tmp/tonyai-foundation.json
bicep build infra/azure/apps.bicep --outfile /tmp/tonyai-apps.json
bicep build infra/azure/secret-access.bicep --outfile /tmp/tonyai-secret-access.json
bicep build infra/azure/deployer-access.bicep --outfile /tmp/tonyai-deployer-access.json
python3 -m unittest discover -s infra/tests -v
python3 infra/tests/check_mutations.py
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

The dedicated `.github/workflows/infra.yml` runs the Python suite, seven reported
regression mutations and pinned Bicep compilation on infra PRs, without cloud login.

These checks do not validate Azure quotas/RBAC propagation, Supabase settings,
image startup or tenant containment. Azure `validate`/`what-if` and actual apply
are owner-run checks below. Cloud acceptance requires Claude Code's `security-rls`
review under Part A, as well as the independent local security/QA pass.

## Security boundaries

- Never use local env files, `pnpm setup`, `db:seed`, `db:reset`, `migrate dev`,
  local E2E teardown or the existing demo-account `rls:probe` against staging.
  Never `supabase link` or `supabase config push` from this local-config checkout.
- Store service keys, passwords and pooler connection strings only in Key Vault.
  Do not paste them into command arguments, parameter files, tickets, screenshots
  or chat. Do not enable shell tracing, Azure debug output or terminal recording.
- `cloud_ops.py` retrieves secrets into memory, captures subprocess output and
  reports fixed messages. It does not write env files or print API error bodies.
  A failure withholds details intentionally; use the owner's private consoles to
  diagnose it, then rerun the step. No redirects are followed with credentials.
- The API identity reads only its two named secrets. Web reads no vault secrets.
  The migration URL is not injected into either app. Deployments pin exact Key Vault version IDs; follow [explicit rotation steps](runbooks/05-rotation.md) for
  backend keys, coupled legacy keys, both DB URLs and recovered vault contents.
- GitHub can publish images and replace staging code, which can use the API's
  identity. Treat deployment permission as access to staging data; protect the
  GitHub environment even though federation itself has no stored cloud secret.
- Public network endpoints are intentional for this Consumption/Basic foundation.
  TLS, RBAC and private buckets gate access; private networking/static egress
  requires a separately reviewed design. No customer inventory until launch gates.

The reusable [Azure deployment recipe](azure-deploy/SKILL.md) stays within this
assignment's `infra/**` reservation. It is a manually linked recipe, not an
auto-discovered installed skill; moving it into `.claude/skills/` requires that
lane's reservation. Root `.env.example` was explicitly allowed in this dispatch
and is a reference only, never a file to copy into `.env.staging`.

Key Vault and ACR remain public network endpoints. This foundation has no Key
Vault/ACR diagnostic settings, so it does not yet evidence secret-access auditing;
container Log Analytics is not a substitute. Retain this operational limitation
for owner review and the observability follow-up.
