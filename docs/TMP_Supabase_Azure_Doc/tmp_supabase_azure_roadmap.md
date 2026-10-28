# TEMPORARY — Supabase Cloud + Azure through QA and the pilot, run by Codex

> **Temporary document — the hosted phase.** For roughly the next two to three
> months QA and the pilot run the database, Auth and Storage on **Supabase Cloud
> (Pro)** and the web and API on **Azure Container Apps**. After the pilot launch
> the Supabase side moves to Azure (the self-hosted route, paused today, resumes
> on the owner's word), the Supabase Cloud projects are closed and this folder is
> deleted (section 9). After the production launch, on-premises preparation
> follows. `docs/roadmap_docs/project_status_roadmap_phases.md` stays the one
> planning record (Decisions 2026-10-28; ledger row LP2-HQ). The paused
> self-hosted plan is [`Azure_roadmap_plan.md`](../roadmap_docs/Azure_roadmap_plan.md).

| | |
|---|---|
| Created | 2026-10-26 as the temporary QA bridge (PR-T0, #249); **re-scoped 2026-10-28** (owner, in chat): it now carries QA **and the pilot**, and Codex runs it |
| Runs it | **Codex** — every work package, PR, CI change and the status file. The owner reviews, merges and runs or approves every live cloud operation |
| Starting point | **Built from scratch.** Nothing of the hosted path has ever been applied: no Supabase Cloud schema, no hosted-phase Azure resource, no Terraform state. Every resource is created by the steps in section 5 |
| Database + Auth + Storage | **Supabase Cloud, Pro** (bought by the owner), region **North EU — Stockholm, Sweden (`eu-north-1`)** — decided 2026-10-28. PostgreSQL 17 expected; the version and project ref are read back at L4a, after script creation |
| Web + API | **Azure Container Apps**, **Sweden Central (`swedencentral`)** — decided 2026-10-28; the same subscription as the paused self-hosted resources, fenced into its own groups |
| Email | Azure Communication Services Email over SMTP (decided 2026-10-27) |
| Data | QA: synthetic only. Pilot production: the pilot holding's real data from G5 — which is why the later move to Azure is a real data migration (section 9) |
| Targets | QA handover **2026-11-06** (proposed; G2 stays 2026-11-15) · pilot **2027-02-01** (stretch 01-25, fallback 02-15) · migration to self-hosted Azure: after the pilot launch, on the owner's word |

## 1. What changed on 2026-10-28, and what does not

- **Hosted for QA and the pilot.** The bridge was a QA stopgap; it now carries the
  pilot too, so it needs a production project as well (section 7) and a planned
  exit (section 9).
- **The self-hosted route is paused, not removed.** R3, R4, the self-hosted
  application path (runbook 08 Units 0–8), the clean replacement (runbooks
  09/10), their code, workflows, runbooks, Terraform roots and Azure resources
  all stay. Nothing is deleted. Only their CI runs on every change stopped
  (section 3). They resume when the owner says so — after the pilot launch, to
  move the Supabase side to Azure, then towards on-premises servers after the
  production launch.
- **Codex runs everything.** The two-tool split of 2026-09-27 ends: Codex is the
  only implementer and the only writer of the status file. Claude Code joins only
  when the owner opens a session for it (section 8).
- **Unchanged — non-negotiable:** tenant isolation (the API guard and
  `accessibleSubsidiaryIds`), RLS enabled and never `FORCE`d, the `tonyai_runtime`
  login for the running API (never the owner `DIRECT_URL`), the append-only
  `audit_log`, RBAC, JWT verification (ES256 over JWKS), the seed never running
  against the cloud (`seed-guards.ts`), factors arriving only through the
  factor-release loader, no secret in git, chat, Terraform state or logs.
  `ALLOW_INSECURE_LOCAL_AUTH` and `ALLOW_PLACEHOLDER_FACTORS` are never set in the
  cloud (the API refuses the latter off loopback — `factor-policy.ts`), so under K3 the
  cloud prices **only authoritative** factor releases — QA calculates no figure until LP4-02's release (O6). **`infra/config/deployment-policy.json` is not edited** — its sha256 is
  bound into the self-hosted QA receipts that resume later — and
  `deployment_policy.py:9` stays verbatim (a mutation test pins it). Nothing here
  touches the self-hosted resources, their VNet/subnets (including the delegated
  `10.80.2.0/23`), NSGs, private DNS, backend storage account or Terraform state.

## 2. Target architecture

```
Users ──HTTPS──▶ ACA app: <prefix>-staging-web (Next.js, NEXT_PUBLIC_* baked at build)
                   │
                   ▼
                 ACA app: <prefix>-staging-api (NestJS, /api/v1)
                   ├─ Supavisor pooler (IPv4) ─▶ Postgres 17   ┐
                   ├─ Supabase Auth (ES256, JWKS)              │ Supabase Cloud, Pro
                   ├─ Supabase Storage: evidence · import-sources · report-artifacts (private)
                   └─ SMTP: ACS Email (smtp.azurecomm.net:587, STARTTLS)

Azure, Sweden Central, same subscription — hosted-phase resources only:
  tonyai-qatmp-tfstate → its OWN backend storage account (Terraform state)
  tonyai-qatmp-apps    → ACR · Log Analytics · ACA environment (Consumption, NO VNet)
                         · Key Vault · managed identities · the two apps
                         · ACS Email (data location Europe) + SMTP Username
Supabase Cloud: the QA project now; a separate pilot production project at LP2-04
```

- **Separate Terraform backend.** The self-hosted backend account must not get the
  hosted roots' state (`qa_network.py` forbids extra blobs there) and
  `bootstrap_backend.py` would otherwise adopt any `purpose=terraform-state`
  account and rewrite its firewall, so the hosted phase bootstraps its own backend
  group and account, and a guard pins `bootstrap_backend.py` to exactly that pair.
- **No VNet**, private endpoint or self-hosted runner: every dependency is a
  public, TLS-authenticated endpoint. `selfhost_app_network.py` refuses only
  environments on the QA subnet or in `tonyai-staging-apps`, so a non-VNet
  environment in another group passes.
- **Names (D1, 2026-10-27):** groups `tonyai-qatmp-tfstate` / `tonyai-qatmp-apps`,
  prefix `tonyaiqt` — never `tonyai` (the self-hosted application's). The path
  fixes the environment name `staging` and the apps `<prefix>-staging-api` /
  `<prefix>-staging-web`.
- **Database connections go through the Supavisor pooler**: ACA egress is IPv4 and
  Supabase's direct host is IPv6-only. `pooler.py` builds the URLs; the running API
  gets only the runtime `DATABASE_URL`.
- **Terraform scope stays option A (2026-10-27):** every Azure resource through
  AzAPI under `check_terraform_policy.py` (reviewed types only, no secret in
  state). Supabase Cloud stays on the reviewed Management API scripts: the official
  provider keeps the database password in state and cannot create buckets,
  signing keys or database roles.
- **Default ACA hostnames** for QA; custom domains with managed TLS for the pilot
  production (LP2-04).

### Isolation inside the shared subscription

| Fence | Rule |
|---|---|
| Resource groups | `tonyai-qatmp-tfstate` and `tonyai-qatmp-apps`. Never `tonyai-staging-apps` or `tonyai-staging-data*` |
| Name prefix | `tonyaiqt` — never `tonyai`; ACR and Key Vault names globally unique |
| Terraform state | The hosted phase's own backend account; the self-hosted account is never written or adopted |
| Network | No VNet, subnet, NSG, route table, private endpoint or private DNS zone |
| Role assignments | Scoped to the hosted groups and their resources; never at subscription scope |
| Subscription gate | **Narrowed by a new file**, `infra/config/hosted-qa-exception.json` (`subscription`, `resource_group`, `prefix`, `backend_resource_group`, `backend_storage_account`). `require_hosted_target(subscription, resource_group, prefix)` keeps line 9 verbatim and admits the listed subscription only on an exact match, never for the `tonyai-staging-*` groups or the `tonyai` prefix; the two legacy `variables.tf` validations mirror it; negative tests prove the self-hosted targets are still refused |
| Cost | A subscription budget alert covering the hosted phase |

## 3. CI review and the pause (2026-10-28)

`main` has no branch protection on this plan (rulesets return 403), so moving a
check breaks no merge gate. `infra/config/main-ruleset.json`,
`github_environment.py:29` and `release_checks.py:17` name only `build`,
`docker-build`, `rls-probe` (ci.yml) and green `ci.yml`, `e2e.yml`,
`integration.yml` runs — none of which changed.

**The unnecessary runs were the self-hosted gates firing on every
infrastructure change**: `infra.yml`'s four R3 mutation shards (up to 20 minutes
each — they ran even on the docs-only #249), its self-hosted steps, and the whole
`qa-infra.yml`. **Done in the 2026-10-28 change, nothing deleted:**

| Workflow | Before | Now |
|---|---|---|
| `infra.yml` | every `infra/**`, `.github/**`, Dockerfile change: unit tests, hosted and self-hosted Terraform, self-host mutations, 4 R3 mutation shards | same triggers, **hosted checks only**: unit tests, `check_mutations.py`, Terraform policy, the `foundation` and `application` roots, runtime/grant mutations, Docker context. The `infra` aggregator name is kept |
| `selfhost-checks.yml` *(new)* | — | **dispatch only**: the self-hosted steps and the R3 mutation shards moved unchanged from `infra.yml`, with their own aggregator |
| `qa-infra.yml` | every `infra/**` change | **dispatch only**; the old triggers are kept in a comment |
| `qa-candidate.yml`, five `r3-*.yml` | dispatch only | unchanged |
| `ci.yml`, `integration.yml`, `e2e.yml`, `candidate.yml`, `deploy-staging.yml` | — | unchanged (the last two change in WP-6) |

`infra/tests/test_ci_durations.py` pins the pause: both paused workflows are
dispatch-only, every check that left `infra.yml` is in `selfhost-checks.yml`, and
`infra.yml` keeps its hosted checks and runs no self-hosted step. **While paused,
run `selfhost-checks.yml` and `qa-infra.yml` by hand** (Actions → Run workflow, on
the PR's branch) before merging any change to `infra/scripts/**`, `infra/tests/**`, `infra/terraform/**`, `infra/config/**`, `infra/selfhost/**` or these two workflows —
the self-hosted scripts import most hosted modules (`pooler`, `bootstrap_backend`, …),
so WP-2 and WP-3 dispatch both. App-only and docs-only PRs do not. The selfhost
root's `terraform fmt` and its `check_terraform_policy.py` lane still run in
`infra.yml`. **To resume:** move the jobs back into `infra.yml`, restore
`qa-infra.yml`'s triggers from its comment, update that test, and add
`selfhost-checks.yml` to the bound sources in `infra/scripts/replacement_bundle.py`
(it hashes `infra.yml`, so a bundle bound before 2026-10-28 is stale).

The CI database image pin stays in `infra/selfhost/database-image-policy.json`
(read by `.github/actions/supabase-stack/action.yml`,
`infra/scripts/ci_database_image.py` and `integration.yml`'s paths); its
PostgreSQL major should match the Supabase Cloud project's (O1).

## 4. Work packages (Codex)

Every package: a feature branch from current `main`, green CI, a PR, the owner
merges, the status file updated in the same PR. Packages marked **review** get the
independent fresh-eyes pass of section 8 before the PR opens.

| WP | Branch | Scope | Review | Size |
|---|---|---|---|---|
| **WP-0** | `docs/supabase-cloud-codex-handover` | This re-scope; the CI pause (section 3); single-tool mode, the decision and the ledger in the status file; `CLAUDE.md`, `AGENTS.md`, `README.md`, `infra/README.md` pointers; "paused" banners on the self-hosted plan and runbooks 07–10. *Claude Code's last PR* | — | done in this change |
| **WP-2** | `feat/hosted-qa-retarget` | Dispatch `selfhost-checks.yml` + `qa-infra.yml` before merge (section 3). The bridge's PR-T1: regions to `eu-north-1` / `swedencentral` wherever the code still pins `eu-central-1` / `germanywestcentral` (inventory on `1063104`, outside the paused self-hosted files: `infra/scripts/{bootstrap_backend,candidate,check_browser_key,pooler,runtime_urls,session_resources,supabase_auth,supabase_project,supabase_setup,terraform_run}.py`, `loader-identity.mjs`, `smoke-contract.mjs`; `infra/terraform/{foundation,application}/{variables.tf,security.tftest.hcl}`, `application/main.tf`; `infra/config/{application,supabase}.example.json` (their `*.germanywestcentral.azurecontainerapps.io` origins are validated by `application/variables.tf` and read by `test_candidate_path.py` / `test_review_boundaries.py`); 27 files under `infra/tests/` — re-run `git grep -E 'eu-central-1|germanywestcentral|Frankfurt'` to confirm none is left); the hosted-QA exception file, `require_hosted_target`, the mirrored `variables.tf` validations, the `bootstrap_backend.py` pin, negative tests (self-hosted subscription without the exception, `tonyai-staging-*` groups, `tonyai` prefix, the self-hosted backend account — all refused; the line-9 mutant still killed); the ACS Email AzAPI resources in the foundation root (inputs: Entra client ID, service-principal object ID, tenant ID, optional custom domain; outputs: SMTP username, sender address) with their policy allow-list entries and `security.tftest.hcl` cases (data location Europe, nothing secret in state or outputs, the role scoped to the Communication Services resource); hosted-phase example inputs — `infra/config/hosted-qa-exception.example.json`, and backend/foundation/application/supabase examples carrying `tonyai-qatmp-tfstate` / `tonyai-qatmp-apps`, prefix `tonyaiqt`, `location: swedencentral`, the `tonyaiqt-staging-web` origin and the ACS mail block (`smtp.azurecomm.net`, `587`, `secure: false`, `<ACS SMTP Username>`); no project-adoption path (O1: `supabase_setup.py` creates the project; runbook 02) | **review** (deployment gate, auth, secrets) | 1–1.5 days |
| **WP-3** | `feat/hosted-qa-handover` | Dispatch `selfhost-checks.yml` + `qa-infra.yml` before merge (section 3). The `report-artifacts` bucket (20 MiB, PDF only) in `cloud_ops.py` with tests; the hosted `staging` smoke fixtures re-checked against the current schema (`smoke-fixtures.mjs` / `smoke-contract.mjs` are shared with the paused Sweden adapter — keep its `qa-sweden` target intact); runbooks 00–06 re-read for the new regions; the ACS Email owner steps written into runbooks 01/03 (L1b: Entra application + service principal before foundation; L7: client secret ≤ 90 days into the existing Key Vault as `smtp-password`; the domain's sender address; custom-domain DNS at Namecheap); new `infra/runbooks/11-qa-hosted.md` (URLs, account issuance, known limitations, reset policy, bug reporting) | review (storage) | 0.5–1 day |
| **WP-4** | — | **Not needed (O6):** QA follows K3 and calculates no figure until LP4-02's authoritative UK/TR release; that release reaches QA through the factor-release loader (dry run, then `--apply` as `tonyai_factor_loader`) when LP4-02 delivers it. D3's placeholder release is superseded | — | 0 |
| *Live* | — | Section 5, L1–L10 — owner-run, Codex prepares each command and reads the output with the owner | — | 2–3 days |
| **WP-5** | `fix/hosted-qa-*` | Fixes found during the live steps, if any | as the fix needs | — |
| **WP-6** | `feat/ci-deploy-oidc` | Later deploys from CI: GitHub OIDC federated credential (no client secret), the protected `staging` environment, `candidate.yml` and `deploy-staging.yml` able to run on a GitHub-hosted runner, `release_checks.py` still requiring green `ci.yml` / `e2e.yml` / `integration.yml` at the exact SHA; Log Analytics alerts on API 5xx and restarts | **review** | 1 day |
| **WP-8** | LP2-04 | Pilot production on the hosted route (section 7) | **review** | 2–3 days |

*(WP-1 — the CI pause — was done in WP-0. There is no WP-7: nothing is retired.)*

## 5. Live operations — QA (owner-run, each approved)

Codex prepares the exact command, its dry run and what to read in the output; the
owner runs it from a clean checkout on their machine, enters secrets at hidden
prompts and keeps them in the password manager. Codex never asks for a secret in
chat and never stores one in the repository.

| # | Operation | Go / no-go |
|---|---|---|
| L1 | Account/input preflight only: Supabase organisation ID/slug, Pro entitlement, MFA and token custody; Azure tenant/subscription/owner IDs, provider registrations, budget, owner IPv4 and the exact hosted exception/backend pair. No project exists yet; no project ref, version, pooler, CA or database privilege result can be claimed here | nonsecret inputs reviewed; placeholders refuse live use |
| L1b | Owner creates dedicated SMTP Entra application and service principal (runbook 01 §1.4); record client ID, service-principal object ID and tenant ID for foundation. Defer client-secret creation/storage until L7, after the vault exists | identities verified before L3; no secret in Terraform |
| L2 | Terraform backend bootstrap (`bootstrap_backend.py`, `location: swedencentral`, the hosted backend pair, the owner's /32) | backend pinned to the hosted pair |
| L3 | Foundation plan + apply (`runtime_secrets_ready=false`), ACS Email included — read the plan first | only hosted-phase resources in the plan |
| L4 | `supabase_setup.py`: create a fresh project from its journaled intent (resume only that creation; no dashboard adoption), Key Vault entries, `direct-url`, the three buckets, Auth policy (public sign-up off), ES256 signing key | completed creation journal and public project ref |
| L4a | **After L4, before L5/L6 or deployment:** read back `eu-north-1`, project ref and PostgreSQL 17 version; compare CI's `infra/selfhost/database-image-policy.json` pin and record any minor-version gap. Read the exact `aws-<n>-eu-north-1.pooler.supabase.com` host from Connect, verify the bundled CA through owner-psql, then run runbook 05's `rolcreaterole` / `rolbypassrls`, owner Storage USAGE/SELECT and rolled-back `CREATE ROLE lp1_probe BYPASSRLS` probe | **Mandatory go/no-go.** On failure stop and resolve with Supabase support; never weaken RLS, tenant guards or migration privileges |
| L5 | Runtime secret (`openssl rand -hex 32`, `release_secrets.py store`), images (`build-images.sh`, local Supabase stack stopped first on the 16 GB machine; `az acr build` if too slow), `candidate.py`, release manifest with `storage_cleanup_hold: true` | — |
| L6 | Migrations (`cloud_ops.py migrate` at the release's `source_sha`), then `\password tonyai_runtime`, `ALTER ROLE … LOGIN`, `runtime-role.mjs check` | `check` passes |
| L7 | With the L3 vault and valid L5 release manifest present, owner creates the Entra client secret (expiry ≤ 90 days), saves it in the password manager and enters it directly through the hidden `smtp-password` prompt; select the exact returned vault version and public ACS username/sender (runbooks 01/03); foundation re-apply with `runtime_secrets_ready=true`, `smtp_secret_ready=true` | — |
| L8 | `release_secrets.py verify`, `deploy-apps.sh` | apps healthy on `/api/v1/health` |
| L9 | No factor release yet (O6) — LP4-02's authoritative release is loaded the same way (dry run, then `--apply` as `tonyai_factor_loader`) when it exists; `pnpm onboarding provision --apply --allow-remote` for one synthetic holding and its first `super_admin`, who invites the second `super_admin`, `data_entry`, `consultant` and `executive_viewer` | invitation emails arrive |
| L10 | Smoke: `cloud_ops.py probe-storage`, `cloud_smoke.py`; by hand — login per role; create → submit → approve by the other `super_admin`; evidence upload and signed download; PDF and Excel export; a period-lock refusal; a cross-tenant read refused; one `audit_log` row per mutation; viewer and consultant cannot mutate; TR and EN render. Then monitoring (Supabase daily backups confirmed; a Log Analytics alert on API 5xx and restarts) and the **QA handover** with runbook 11 | QA starts |

**Tell QA:** no emission figure is calculated until the authoritative factor release arrives (entries show "Not calculated" / `no_factor`) — test the lifecycle, roles, evidence, locks, exports and TR/EN, not the numbers;
default Azure hostnames; the environment may be reset with notice.

**Dependency rule:** L1 → L1b → L2 → L3 → L4 → L4a → L5 → L6 → L7 → L8 → L9 → L10.
The IDs in L1b precede foundation; secret generation/storage in L7 follows vault
creation. Runbook numbers are topic references, not permission to bypass this
order. No step in this preparation has been executed. WP-6 is not needed for
the initial owner-run deployment; its CI adaptation remains a later package.

## 6. The paused self-hosted route

- Its code, tests, workflows, Terraform roots, runbooks 07–10, the plan
  [`Azure_roadmap_plan.md`](../roadmap_docs/Azure_roadmap_plan.md) and the
  continuation checkpoint [`Azure_roadmap_to_qa.md`](../roadmap_docs/Azure_roadmap_to_qa.md)
  stay as they are, marked paused. R3 and CL-P2-3 stay OPEN; no gate is waived.
- No R3/R4 work, dispatch or apply runs while paused. A change to the
  self-hosted files during the pause runs `selfhost-checks.yml` and `qa-infra.yml`
  by hand before merge.
- The Azure resources it created (the deallocated old QA VM, the R2 replacement
  generation of 2026-10-18 with its disks, network, recovery vault, Key Vault
  escrow and locks) stay. Stopping their compute spend for the months of the pause
  — for example deallocating a VM, which keeps its disks — is the owner's call
  (O3); nothing is deleted.
- The private R3 evidence outside the repository (`/private/tmp`,
  `~/.codex/worktrees`) is kept — `/private/tmp` does not survive a reboot, so
  the owner may want it copied somewhere durable (O3).

## 7. Pilot production (LP2-04, feeds G5 — 2027-01-22)

- A **separate Supabase Cloud project** (same organisation and region, Pro), with
  the PITR add-on decided against LP5-03's recovery target (O5); the same scripts,
  runbook 05 handoff and checks as QA.
- Separate Azure groups, Key Vault, identities and apps from the same Terraform
  roots with production parameters and its own names and exception entry (O2);
  custom domains with managed TLS for web and API; uptime monitors on
  `/api/v1/health` and `/login`.
- ACS Email on a verified custom sending domain (SPF/DKIM/DMARC; the
  Azure-managed domain's 5/min and 10/h are QA-only), data location Europe; the
  DPAs and subprocessor entries (Supabase, Microsoft) recorded with the lawyer
  (long-lead 2).
- Migrations and reviewed factor releases only — no demo tenants, users or
  `DEMO_SOURCE` rows; the RLS probes run against production with dedicated
  synthetic tenants.
- Restore drill (LP5-03) on the production project's backups before G5.
- **Residency and transfers:** both projects and every Azure resource stay in the EU
  (Stockholm, Sweden Central); ACS Email's data location is Europe. The pilot holding's
  data leaves Türkiye for the EU, so the KVKK cross-border transfer basis (and the UK
  GDPR position for UK data) must be cleared by the lawyer (long-lead 2) **before G5
  loads real data** — QA stays synthetic. Sentry stays off (`SENTRY_DSN` and
  `NEXT_PUBLIC_SENTRY_DSN` unset) until an EU-region Sentry organisation and its DPA
  are approved.
- **Sizing and spend (O7):** compute size, spend cap and backup retention per project
  (Pro includes daily backups kept 7 days; PITR is an add-on).
- **Design for the exit (section 9):** nothing in the pilot may depend on a
  Supabase-Cloud-only feature that the self-hosted stack lacks.

## 8. How Codex works here

- **Read first:** `AGENTS.md`, `CLAUDE.md` (the rulebook for every agent), Part A
  of the status file, this plan, then the task card.
- **Single-tool mode:** Codex owns every file, the local Supabase stack, CI and the
  status file (its update rules 1–6; rule 7 now records single-tool mode). Shared
  files, migrations and contracts no longer need a slot — but a contract or
  migration change still merges alone and first, and every generated migration is
  inspected for the spurious `DROP INDEX activity_records_reporting_entity_period_category_key`.
- **Independent review is still mandatory** for the calc path, factor immutability,
  RLS/auth, tenant isolation, the record lifecycle, CI gates, the deployment gate
  and secrets handling (`CLAUDE.md`, *Working mode*). Codex runs it as separate,
  fresh review sessions that did not write the change, briefed from
  `.claude/agents/security-rls.md`, `qa-auditor.md`, `architect.md` (schema or
  shared-types contract), `devops-cloud.md` (infrastructure) and
  `data-factors.md` (factor data), each reporting what it verified. The owner may
  ask Claude Code for a seat instead.
- **Skills:** `.claude/skills/*/SKILL.md` and `infra/azure-deploy/SKILL.md` are the
  house recipes — follow them rather than re-deriving.
- **Live cloud operations** are owner-run or owner-approved per operation. A
  merged PR or a passing mock never authorizes an apply, a deploy or a deletion.

## 9. Exit — moving the Supabase side to Azure (after the pilot launch)

Starts only on the owner's word. Then:

1. Resume the self-hosted route where it paused (R3 → R4 → the application path),
   with `selfhost-checks.yml` and `qa-infra.yml` back on every change and
   `replacement_bundle.py`'s bound sources updated (section 3).
2. Plan the **data migration** from the Supabase Cloud pilot project to the
   self-hosted stack — real pilot data by then: the database (schema, data,
   `_prisma_migrations`, roles and grants), Auth users with their password hashes
   and identities, Storage objects with their metadata and the storage intents,
   the JWT signing-key continuity (or a planned forced re-login), and a
   maintenance window with a verified rollback. Proven first on a copy.
3. Cut over, verify, keep the Supabase Cloud project read-only for the agreed
   period, then close the projects; revoke the Management API token; remove the
   hosted-QA exception file and the hosted-phase resources; delete this folder and
   its pointers (`CLAUDE.md`, `README.md`, `infra/README.md`).
4. After the production launch: on-premises preparation (a separate plan).

## 10. Owner decisions

All decided. **O1–O7 as recommended (owner, in chat, 2026-10-28).**

| # | Decision |
|---|---|
| D1, D2, D4, D5 | 2026-10-27: names `tonyai-qatmp-*` / `tonyaiqt`; ACS Email (sending domain: Azure-managed to start, a verified custom domain as soon as its DNS verifies); `build-images.sh`; Terraform scope A |
| D3 | 2026-10-27: a labelled placeholder release for QA — **superseded by O6**, because the cloud API prices only authoritative releases (K3) |
| O1 | Supabase `eu-north-1` (Stockholm) + Azure `swedencentral`. **`supabase_setup.py` creates the project from scratch** in `eu-north-1`; a project already made in the dashboard, if empty, is deleted by the owner first (no adoption path is built) |
| O2 | Pilot production's Azure names are chosen in LP2-04, in the same pattern (e.g. `tonyai-pilottmp-*`, prefix `tonyaipt`) |
| O3 | The paused self-hosted Azure resources and the private R3 evidence are **kept**. The owner may deallocate the self-hosted VMs for the pause (disks stay) and copies the `/private/tmp` R3 evidence somewhere durable |
| O4 | Claude Code has no role by default; a review seat only when the owner opens one |
| O5 | Pilot production's PITR add-on is decided in LP2-04 against LP5-03's recovery target |
| O6 | **QA calculates no figure until LP4-02's authoritative UK/TR release is loaded** (K3 unchanged; no placeholder exception, no WP-4 code). Until then entries answer `no_factor` / "Not calculated"; the release is loaded through the factor-release loader the moment it exists |
| O7 | QA: the Pro plan's included compute with the spend cap on; pilot production: compute size and PITR decided in LP2-04 with LP5-03's load and recovery results |

## 11. Owner prerequisites

1. **Supabase:** MFA on the account; the organisation ID and slug; Pro organisation billing entitlement (O1; the project does not exist until
   script creation at L4); a Management API personal access token in the password manager.
2. **Azure:** tenant ID, subscription ID, the owner's object ID with Owner (or
   Contributor + User Access Administrator) on the subscription; providers
   `Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.ContainerRegistry`,
   `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.Storage`,
   `Microsoft.Communication` registered; permission to create an Entra app
   registration; a budget alert; the owner's public IPv4.
3. **Email:** the sending domain — Azure-managed to start; a custom domain needs
   DNS access at Namecheap for its verification, SPF and DKIM records.
4. **Local tools** (runbook 00): `az` on the subscription, Terraform 1.13.3,
   Node 22, pnpm 11.9.0, Python 3.10+, Docker with buildx, `psql`.
5. **QA team:** testers' names, emails and the role each needs.
