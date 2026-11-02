# TEMPORARY — Supabase Cloud + Azure through QA and the pilot, coordinated by Codex

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
| Runs it | Codex coordinates acceptance/status; owner/Claude deployed r004 from7d3e2e9 using helper c8ca4af. Preparationmain is88b80b4, runtime source unchanged. Next deploy ownership is undecided. Owner approves each notification/live step/QA handover; Codex does not operate application state or Container Apps |
| Starting point | Built from scratch; L1–L8 completed for controlled synthetic QA. L9 synthetic onboarding COMPLETE from combined provisioning/delivery/readback/owner5 role evidence. r004 live acceptance/L10 and full LP4-01 remain OPEN; no more L9 live test needed |
| Database + Auth + Storage | **Supabase Cloud, Pro** (bought by the owner), region **North EU — Stockholm, Sweden (`eu-north-1`)** — decided 2026-10-28. PostgreSQL 17 expected; the version and project ref are read back at L4a, after script creation |
| Web + API | **Azure Container Apps**, **Sweden Central (`swedencentral`)** — decided 2026-10-28; the same subscription as the paused self-hosted resources, fenced into its own groups |
| Email | Azure Communication Services Email over SMTP (decided 2026-10-27) |
| Data | QA: synthetic only. Pilot production: the pilot holding's real data from G5 — which is why the later move to Azure is a real data migration (section 9) |
| Targets | QA handover **2026-11-06** (proposed; G2 stays 2026-11-15) · pilot **2027-02-01** (stretch 01-25, fallback 02-15) · migration to self-hosted Azure: after the pilot launch, on the owner's word |

> **Release/source distinction:** Owner selected/deployed r004 from7d3e2e9; exact-source main CI/E2E/Integration run metadata verified. Helperc8ca4af and preparation main 88b80b4 change tools/documentation only, with identical Terraform; neither is the deployed app source. Next deploy ownership undecided; no silent retarget.

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
- **Codex coordinates under the owner's assignments.** The 2026-10-28 default
  supersedes the old two-tool split; Codex remains the status writer. The owner
  opened the current Claude Code candidate/deployment assignment on2026-11-02;
  the ownership table and central Decisions log govern that exception.
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
| L6 | `hosted_migrate.py verify` with separate helper/application SHAs; separately approved `probe`, then `migrate`; owner reconciliation, saved-password `\password tonyai_runtime` / LOGIN and runtime checks are separate approvals | Strict TLS, exact migration history and owner/runtime checks pass |
| L7 | With the L3 vault and valid L5 release manifest present, owner creates the Entra client secret (expiry ≤ 90 days) and transfers it directly to `smtp-password` without exposing the value; select the exact returned vault version and public ACS username/sender in a new release manifest (runbooks 01/03). Separately approve the runtime-grant PLAN (exactly two creates), then its APPLY; separately approve the SMTP-grant PLAN (one create), then its APPLY. Keep `apps_ready=false` | Exact plan deltas accepted; no automatic readiness transition or app rollout |
| L8 — COMPLETE (2026-11-01) | Separately approved configuration readback, exact-secret verification, then deployment: see the L8 preparation boundary below. `release_secrets.py verify` includes a Supabase authenticated bucket-list GET; `deploy-apps.sh` is a separate mutation | Findings assessed; secret verification accepted separately; exact deployed revisions and dependency readiness evidenced |
| L9 | No factor release yet (O6) — LP4-02's authoritative release is loaded the same way (dry run, then `--apply` as `tonyai_factor_loader`) when it exists; `pnpm onboarding provision --apply --allow-remote` for one synthetic holding and its first `super_admin`, who invites the second `super_admin`, `data_entry`, `consultant` and `executive_viewer` | **COMPLETE (2026-11-02, combined evidence):** invitation emails arrived; five accounts/roles/access established, later r004 positive reads owner-observed. Authoritative-factor loading remains conditional/deferred O6; full lifecycle/QA acceptance stays L10/LP4-01 |
| L10 | Smoke: `cloud_ops.py probe-storage`, `cloud_smoke.py`; by hand — login per role; create → submit → approve by the other `super_admin`; evidence upload and signed download; PDF and Excel export; a period-lock refusal; a cross-tenant read refused; one `audit_log` row per mutation; viewer and consultant cannot mutate; TR and EN render. Then monitoring (Supabase daily backups confirmed; a Log Analytics alert on API 5xx and restarts) and the **QA handover** with runbook 11 | QA starts |

**Tell QA:** no emission figure is calculated until the authoritative factor release arrives (entries show "Not calculated" / `no_factor`) — test the lifecycle, roles, evidence, locks, exports and TR/EN, not the numbers;
default Azure hostnames; the environment may be reset with notice.

**Dependency rule:** L1 → L1b → L2 → L3 → L4 → L4a → L5 → L6 → L7 → L8 → L9 → L10.
The IDs in L1b precede foundation; secret generation/storage in L7 follows vault
creation. Runbook numbers are topic references, not permission to bypass this
order. L1 evidence and operation approvals are recorded in the central plan's
LP2-HQ entry: the 2026-10-28 preflight includes one separately approved monthly
GBP 1,000 subscription budget alert, verified by readback. L1b completed on 2026-10-29 after the owner reconciled
the existing application provenance; its explicitly approved service principal
was created and independently read back without credentials. L2 completed on
2026-10-29 through the owner-run backend bootstrap and independent readback.
L3's first apply on `ae21469` stopped at the SMTP child. The separately approved
recovery on `6bceba82` completed (18 resources, unlocked lease); diagnostics
destination `null` and missing vault `networkAcls` remain open. L4 and L4a were
verified, including the real PostgreSQL 17.11 owner privilege/TLS probe. L5's
owner-approved build/secret preparation completed with immutable image digests
and candidate binding. The initial L6 TLS failure led to the transport repair
(#257, merged as `afe55152`). Separately approved L6 operations subsequently
passed strict TLS, all 42 migrations and owner/runtime checks; the owner accepted
the recorded platform-default privilege findings. The saved L5 runtime password
and immutable `6bceba82` application candidate remain unchanged.
L7's owner-run SMTP credential creation and separate Key Vault write completed;
the verified `r002` release changes only the release ID and adds the mail block. The first runtime-grant PLAN
returned 2 creates/2 updates/0 destroys and was rejected without APPLY. PR #258
merged as `a9476eb` after automatic CI and both required manual workflows passed; it normalizes the seven diagnostic log entries
and canonical SMTP role reference without ignoring drift or changing permissions.
It does not resolve the diagnostic destination or vault network-ACL findings.
A fresh private source-bound PLAN packet was prepared from the merge; the old
unpublished draft remains preserved and must not run. The owner separately approved
one init + PLAN: L7-RG-P2 exited 0 with exactly two runtime-secret grant creates,
zero updates/destroys and no output changes. Full grant identities/scopes matched
the packet. That PLAN approval was consumed. The owner then separately approved
L7-RG-A1 once: its complete refreshed plan matched the accepted execution section
before yes in the same waiting process, with no extra action, drift or output delta.
Terraform APPLY exited 0 and reported 2 added, 0 changed, 0 destroyed; both exact
runtime-secret assignment IDs and the final public outputs matched the protected
foundation contract and immutable r002 mail fields. No independent ARM readback,
lease readback or functional secret-access probe ran. Runtime readiness is recorded
applied in a separate receipt; at that checkpoint SMTP/app readiness remained false. Protected original
inputs (still all false), all 17 protected hashes/modes and immutable candidate/releases
are unchanged. The one APPLY approval is consumed; no retry, SMTP mutation or deployment
is authorized. Diagnostic destination and vault network-ACL findings remain open.
The central plan holds the private execution evidence; no seed or deployment has run.
The owner separately approved L7-SG-P1 once. Its init + PLAN exited 0 and was
accepted for exactly one secret-smtp-password grant create, zero updates/destroys,
no output changes and unchanged runtime grants. Full fields and all 20 refresh
targets matched; independent local QA confirmed acceptance. The owner then
separately approved L7-SG-A1: the complete refreshed plan matched before yes in
the same waiting process. APPLY/log capture exited 0 with exactly one create,
zero updates/destroys; the completed assignment ID matched and final public
outputs equalled the successful runtime APPLY outputs. Runtime and SMTP readiness
are now recorded applied in separate receipts; apps_ready remains false. Protected
original inputs, all 17 protected hashes/modes and immutable candidate/releases
remain unchanged. Both approvals are consumed; no retry or deployment is authorized.
No independent ARM/lease readback, functional secret access, credential validity,
SMTP authentication/delivery check or deployment ran. Diagnostics destination and
vault network-ACL findings remain open. The recorded credential expires 2027-01-27,
before the planned pilot; later rotation requires a separate operation. Next is
separately scoped L8 preparation; no secret verification or deployment is authorized.
**L8 preparation boundary (2026-10-30; no live authority):** offline inspection
confirmed that `release_secrets.py verify` reads the exact database-url, backend
key and SMTP password values into memory; between the backend and SMTP reads it
uses that key for `GET /storage/v1/bucket` on the selected Supabase project. It
checks secret identity/enabled status, the runtime pooler URL/TLS contract,
backend-key acceptance by that endpoint and a nonempty single-line SMTP password.
It does not check secret expiry/nbf, Entra credential validity, SMTP authentication
or delivery, a live database connection, API managed-identity access or the two
open foundation findings. The later secret packet must explicitly include all
four reads, source/candidate/release seals and operator/tenant binding.

**L8-M1 completed once under separate owner approval (2026-10-30).** The
private packet `/private/tmp/tonyai-l8-metadata-76va_5_d`, seal
`17f084dfee833dd98aff706038dcc54a0c32db9662a89f9eeb5f787866eeaee6`, acquired
an owner ARM token and collected exactly three configuration GETs for
`tonyaiqt-staging-env`, its `container-logs` diagnostic setting and `tonyai-kv`.
Runner exit 0; execution evidence:
`/private/tmp/tonyai-l8-metadata-76va_5_d-execution/acceptance-receipt.json`.
Environment azure-monitor, domain, workspace and all seven log categories match
the selected source/release; only Console/System are enabled. The diagnostic
`logAnalyticsDestinationType` is explicitly null. Vault tenant, RBAC, public
access, soft-delete/purge protection and empty accessPolicies match; networkAcls
is absent, not an explicit policy readback. Both findings remain OPEN; no effective
ACL defaults or working log ingestion are inferred. The environment's key-bearing
logging subtree is discarded; only destination/presence flags are retained.
This was a chosen evidence prerequisite, not a check enforced by the existing
secret helper. No secret/version, Supabase, role or lease read, Terraform operation,
deployment, email test, rotation or recovery ran. Approval is consumed; no automatic
continuation or retry is authorized. A changed vault tenant/RBAC/network posture stops subsequent secret work
pending assessment. The source requests public access with defaultAction Allow;
missing networkAcls must not be described as verified AzureServices bypass or
private-only access. Actual log ingestion/table routing remains later workload
acceptance. Successful L7 grants close neither finding.

**L8-SV1 approved once, then failed before its first recorded GET (2026-10-30).** Packet
`/private/tmp/tonyai-l8-secret-verify-zush6bnj` binds helper `a9476eb`, immutable
application `6bceba82`, candidate/r002, the application lockfile/42 migration hashes
and the L7/L8-M1 evidence. The approved scope was one owner Vault-token acquisition,
followed by exactly database-url GET, backend-key GET, authenticated Supabase
bucket-list GET and SMTP-password GET at the r002 versions. The new private wrapper invokes
the unchanged `release_secrets.verify` validators through bound transport hooks;
it pins operator/tenant/audience, origins, sequence and response bounds, discards
values/bucket rows and refuses expired/future Vault timestamps when supplied.
Missing timestamps do not prove credential validity. No direct-url, SQL, SMTP
authentication/delivery, ARM refresh, Terraform, deployment or retry is included.

The absent networkAcls finding may remain open for this owner diagnostic only if
the new approval explicitly accepts that uncertainty for these exact reads.
L8-M1's intended tenant/RBAC/public-access readback is evidence for scoping, not
proof of effective network policy. A refusal stops without remediation. This
limited acceptance does not waive the separate vault disposition for deployment,
managed-identity access proof or diagnostic ingestion/table-routing acceptance.
No new live authority follows from offline preparation or successful tests.

The owner approved final seal
`01f5efc8d380852b3c2ba8e27c71e50ae0dbf1a0ff625c856be37b1911fd1cd6`, including
the diagnostic-only vault-policy uncertainty. One invocation exited 1 with a fixed
failure message; only attempt/failure receipts exist, with no request-start or
success receipt. Source writes each request marker before HTTP dispatch. Local
evidence therefore supports a stop before the first data-plane GET, not zero
network activity: Entra/cache activity from token acquisition is unknown. The
receipt does not distinguish local setup, token acquisition/claims, verifier setup
or request-journal failure; no particular cause is established. Secret verification
is NOT accepted. Failure evidence:
`/private/tmp/tonyai-l8-secret-verify-zush6bnj-execution/failure-assessment.json`.
Preserve the original packet and once-only attempt marker. No retry, login or
recovery is authorized. Next preparation is offline and should separate a
fixed-outcome, token-only diagnostic from any later secret-verification retry;
each requires a new concrete packet and explicit owner approval.

**L8-TD1 diagnostic completed; local audience guard rejected (2026-10-31).** Packet
`/private/tmp/tonyai-l8-token-diagnostic-emo6_cty` binds the failed L8-SV1 package
and evidence, protected files, exact owner/subscription/Vault token argv and
interpreter/CLI-launcher hashes. The separately approved scope was one invocation
of the same token command with the same sanitized environment and timeout, then only local
fixed-code/boolean claim diagnosis. It imports no project helper, makes no
resource API request and never invokes the secret verifier. Token acquisition
may contact Entra and refresh the existing CLI cache; the wrapper does not inspect
credential files. No raw token/claims/CLI error, hash or length is saved.

Public phase receipts distinguish local setup, CLI invocation attempted/returned,
output presence, parsing and individual target/time comparisons. Runner exit 0
means the diagnostic classified its observation; inspect the outcome and guard
boolean, not just the exit code. Local guard acceptance is not cryptographic
validation, secret access or a retrospective explanation of the original failure.
The once-only marker prevents automatic replay. Local core-limit and environment
setup rehearsed successfully without any token command; this is current offline
evidence only. Every live token diagnostic or later secret retry still needs
its own explicit approval. Both findings and the deployment boundary remain open.

The owner approved final seal
`c8631d950ab803a4a08abb65e245016f869f29cb41dad4b470c3c076404d5d62` on
2026-10-31. One invocation completed with runner exit 0 and outcome
`LOCAL_TARGET_GUARD_REJECTED`. Seven phase receipts show successful CLI return,
no stderr and nonempty output. Among the seven target/time comparisons, only
`audience_matches` is false; tenant, owner, expiration type/lifetime and nbf checks
pass. Actual audience presence/type/value is unknown from the boolean evidence.
No cryptographic validation, resource request, secret verification or deployment.
Receipt: `/private/tmp/tonyai-l8-token-diagnostic-emo6_cty-execution/acceptance-receipt.json`.
Independent QA/DevOps accept the diagnostic classification, not the token guard.
The original SV1 cause remains unknown. Approval is consumed; preserve the current
guard and inspect the expected audience contract/CLI resource mapping offline.
Do not admit an alternative audience from this boolean mismatch. Any further
token diagnostic or secret retry requires another separately approved scope.

**L8-SV2 approved and passed once (2026-10-31); approval consumed.** Installed Azure CLI
2.91.0 passes the explicit Vault resource through `resource_to_scopes` as
`https://vault.azure.net/.default` and returns MSAL's access token unchanged.
There is no source evidence of resource substitution. Microsoft's
[claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)
allows an API client ID as audience (v2 always; v1 may also use the resource URI).
Microsoft's [API permissions table](https://github.com/microsoft/mcp/blob/main/servers/Azure.Mcp.Server/azd-templates/api-permissions.md)
maps Azure Key Vault to `cfa8b339-82a2-471a-a3c9-0fc0be7a4093`.
This supports a precise additional local targeting representation; it does not
establish TD1's actual audience, old SV1's cause or service-side token acceptance.
Microsoft [advises clients to treat access tokens as opaque](https://devblogs.microsoft.com/identity/access-tokens-and-id-tokens/).
The private guard remains a conservative operational restriction, not a reusable
authentication implementation: unsupported/encrypted formats stop, and the server
still validates credentials. No signature-validation claim is made.

New packet `/private/tmp/tonyai-l8-secret-verify2-ipvqsn1z` preserves all prior
packets/receipts and binds helper `a9476eb`, application `6bceba82`, candidate/r002,
1,435 external hash/mode pairs and two tool paths. Only the documented Key Vault
API ID is added to the two prior literal URI audiences. Tenant/owner/time checks,
one CLI invocation and the same four exact GETs remain: database-url version
`9e58a8cedfe04d138893bdc031eb2ce3`, backend-key version
`cb2bcf7ce50649c9bfe7eb01e87db497`, that project's authenticated bucket-list,
then SMTP version `c69df9aa69a546e2ae7dbca261fa4bc7`.
The original source validators run through the same constrained transport hooks.
New fixed phases and boolean receipts locate a failed attempt without storing
raw token/claims, CLI output/errors, secret values/hashes or response bodies.
CLI/MSAL may internally retry or refresh its cache within the single invocation.

Seventeen offline tests passed on Python 3.12 and 3.14 with warnings enabled.
Independent security, QA and DevOps review passed; security independently checked
the primary public sources. QA also exercised 60 invalid identity/time combinations
and eight journal-failure boundaries. Node 22 lint/typecheck/build/test passed
(lint: eight existing warnings; other tasks used Turbo cache), evidence:
`/private/tmp/tonyai-l8-local-checks-4g38qam_/results.json`. No API integration/RLS,
full infrastructure suite or CI dispatch ran: no repository implementation changed.
The approved scope required the owner to identify the final seal and accept
unresolved vault-policy uncertainty for these exact reads only. Diagnostics destination=null and absent networkAcls remain OPEN; neither
successful RBAC nor a later verification pass closes them. No runtime managed-
identity access, grant/lease readback, SMTP authentication/delivery, SQL connection,
credential live-validity or deployment acceptance follows from this diagnostic.
No retry, PLAN/APPLY, deployment, seed, rotation or recovery is authorized.

The owner separately approved final seal
`d92e4a211bbd37817b59afaee43faa7d2a5e9bac9362c2a729eb206197c69473`,
including unresolved vault-policy uncertainty for these exact reads only.
Preflight passed; one invocation exited 0 with
`EXACT_VERSION_OWNER_DIAGNOSTIC_PASSED`: four requests/four responses and all
original source validators passed. Seven local target/time comparisons passed;
the actual audience representation was not retained and the original SV1 cause
remains unknown. No secret value, raw token/claims, response body or value hash
was retained. Receipt:
`/private/tmp/tonyai-l8-secret-verify2-ipvqsn1z-execution/acceptance-receipt.json`.
Independent QA and DevOps accepted the bounded result. Post-run Node 22 checks
also passed at `/private/tmp/tonyai-l8-local-checks-b0q4n9xx/results.json`
(lint: eight warnings, zero errors; typecheck/build/test cached). All 536 prepared
files, 1,435 external
bindings, the 17 protected files and immutable candidate/r002 remain unchanged.
This proves owner exact-version retrieval and authenticated backend bucket-list
access only. Database URL validation is syntactic, SMTP validation is shape only;
no runtime managed-identity access, SQL connection, SMTP auth/delivery or credential
live-validity proof follows. Both findings remain OPEN. The one-attempt approval
is consumed; no repeat or deployment authority exists.

**L8-PRE1 approved and collected once (2026-10-31); approval consumed.** The application
root contains only `azapi_resource.app["api"]` and `["web"]`; there are no data
sources or outputs. Source `terraform_run.py application plan` performs remote
backend init and does not save a binary plan. `deploy_apps.py` combines plan,
possible drain, apply and readback; it is not a PLAN-only command. A later exact
saved-plan package must preserve Terraform 1.13.3, AzAPI 2.6.1, provider lock,
source/config hashes, immutable candidate/r002 and cleanup hold. Its initial-create
review criterion is exactly two app creates and zero updates/destroys, with full
resource-body comparison; this is an expectation, not an observed plan.

Terraform's pinned [Azure backend implementation](https://raw.githubusercontent.com/hashicorp/terraform/v1.13.3/internal/backend/remote-state/azure/backend_state.go)
can initialize absent state under a lease. Its [client](https://raw.githubusercontent.com/hashicorp/terraform/v1.13.3/internal/backend/remote-state/azure/client.go)
can create the blob and write lock metadata. Thus remote init/PLAN is not a
read-only cloud operation. AzAPI's [2.6.1 provider documentation](https://raw.githubusercontent.com/Azure/terraform-provider-azapi/v2.6.1/docs/index.md)
confirms `ARM_SKIP_PROVIDER_REGISTRATION`; the default is false. A later PLAN
package must suppress registration explicitly and disclose backend reads plus
possible initialization/lease writes. `enable_preflight=false` alone is insufficient.

Before PRE1, no local receipt established the application state blob's absence,
contents or lease. The selected risk control was a separate metadata observation, not a gate
already enforced by repository code. Packet
`/private/tmp/tonyai-l8-plan-prereq-s4i5863p` binds the successful SV2 evidence,
1,992 external hash/mode pairs and two tool paths. Its approved scope was two fixed CLI token
invocations (ARM and Storage), then exactly four requests: GET status of
`tonyaiqt-staging-api` and `tonyaiqt-staging-web` in `tonyai-qatmp-apps`; HEAD
properties of `tonyaiqtqabe/application`; HEAD properties of
`tonyaiqtqabe/application/staging.tfstate`. Subscription/tenant/owner are fixed.
ARM GET bodies are not consumed; Storage HEAD returns no state body. Retained
observations are fixed status/service-code enums, bounded size and lease enums;
no arbitrary headers, user metadata, ETags, lock IDs, tokens or raw claims.
No Terraform, state content GET, secret access, lease mutation, app mutation or
provider registration. CLI may refresh its own cache/contact Entra; internal
retries within each invocation are disclosed.

Fifteen mocked offline tests passed on Python 3.12/3.14 with warnings enabled;
security, QA and DevOps review passed. QA independently exercised 15 journal-failure
boundaries and nine malformed-header cases; security checked 40 status/target
cases. Node22.23.3 lint/typecheck/build/test passed (lint eight warnings/zero errors;
other tasks cached), evidence `/private/tmp/tonyai-l8-local-checks-mli0w_2_/results.json`.
No API integration/RLS, full infra suite or CI dispatch ran; no repository
implementation changed. Container HEAD must return 200 to continue. ARM404
is only a not-found response; Storage404 is classified without reading its body.
Only an exact `BlobNotFound` response with an accessible container can support a
point-in-time missing-blob assessment. Any existing blob, including byte-length
zero, existing app, active lease or ambiguous response needs separate offline
assessment before an initial-create PLAN packet. These observations do not reserve
resources or eliminate a race before later Terraform reads. No state content is
read or adopted automatically; no lease is broken.

Both findings remain OPEN. Missing vault networkAcls needs an explicit deployment
disposition; prior diagnostic-only acceptance does not transfer. Destination=null
needs workload ingestion/table-routing acceptance under runbook 01. Neither blocks
these metadata-only reads, and neither is closed by successful grants, SV2 or a
later PLAN. No private cloud access occurred during preparation. The later approval of
the final PRE1 seal authorized only these observations, never PLAN or deployment.

The owner approved PRE1 final seal
`98a774d90cc9a533fa5a0e9b64af76932052c32c8616925a6df1f1e72917ce25`.
One invocation after successful preflight exited 0 and collected four observations:
both exact app endpoints returned ARM404; application-container HEAD returned 200
with lease status `unlocked` and state `available`; state-blob HEAD returned
404 with service code `BlobNotFound`. The accessible container plus exact blob
code supports missing state at observation time. Container response length 0
is not a measurement of state-blob length or safe state contents. The ARM error
bodies were not consumed, so their exact causes remain unclassified.
Two CLI invocations and both owner/tenant/audience/time guards succeeded; raw
credentials, bodies and arbitrary headers were not retained. Receipt:
`/private/tmp/tonyai-l8-plan-prereq-s4i5863p-execution/acceptance-receipt.json`.
Independent QA/DevOps accepted the four bounded observations. Post-run Node22
lint/typecheck/build/test passed at `/private/tmp/tonyai-l8-local-checks-ao4xqj0w/results.json`
(lint eight warnings/zero errors; other tasks cached). All 18 prepared files, 1,992 external
bindings, 17 protected files and immutable candidate/r002 remain unchanged.
No Terraform, state-content read, lease/state write or deployment. Approval is
consumed. Observation does not reserve the blob or prove write/lease permissions;
it supports the next offline saved-PLAN preparation, with separate live approval
and explicit backend effects. Both findings remain OPEN. A separate PLAN packet can be prepared
without automatically requiring another metadata operation. Neither ARM404 nor
a two-create plan proves the absence of unmanaged apps; any absence requirement
for subsequent APPLY remains a separate gate.

**L8-AP1 saved PLAN prepared, then explicitly approved and completed once (2026-10-31); approval consumed.**
Private packet `/private/tmp/tonyai-l8-app-plan-1ftnnret` binds source
`a9476eb735cad53aa7091932dd02b38a4070cefb`, immutable candidate
`6bceba82a762d5a657510c107df0a31c6e4c7b8e` / release r002, the application
Terraform root and config dependencies, Terraform1.13.3, AzAPI2.6.1 and lockfile,
2,037 external hash/mode bindings and three tool paths. The reviewed core is
`39c819472468b76686e1689907e3d229cc74664de30b06b100bc44cd7c237227`.
Security, QA and DevOps accepted the corrected core. Final packaging preserves
that core and adds their reviews, repository checks and documentation snapshots.
Those were the preparation records; the separately approved execution is recorded below.

The one proposed operation consists of two explicit owner token guards (ARM and
Storage), exact application-container/blob HEAD prechecks, one remote AzureAD
backend init, one saved application PLAN, local binary/JSON inspection and one
post-plan exact blob HEAD. Terraform/backend/provider may independently authenticate,
refresh CLI credentials, read/list state/workspaces and perform provider reads or
internal retries; the two guards are not a total request count. Registration is
suppressed; MSI/OIDC/AKS/alternate credentials, endpoint lookup and snapshots are
disabled. No apply, drain, import, grant mutation, secret GET, SQL/SMTP test, seed,
rotation, force unlock, retry or recovery is included.

The expected result is exactly two creates, zero updates/destroys, complete and
applyable with no errors/drift/extra outputs, exact full bodies, identities, image
digests, secret-version URLs and input values. The saved ZIP must contain only the
bound source/lock/config manifest and empty embedded resource/output/check state.
Pinned Azure initialization source supports current state UUID-shaped lineage /
serial1 and previous state empty-lineage / serial0. A local builtin-provider saved
plan corroborates the previous stub only; its never-persisted current state differs
and is not evidence of Azure behavior. The hosted provider rehearsal uses real
mock resource changes with an explicitly synthetic envelope/planned-values fixture;
no real hosted saved plan has been observed.

Remote init/PLAN can initialize the missing backend blob and write leases/lock
metadata. HEAD does not reserve it: concurrent unexpected state can enter the
private saved binary before inspection. Explicit owner acceptance of backend effects
AND transient private-plan custody is mandatory; no zero-persistence/secure-erasure
claim is made. Bounded process capture never prints or saves raw output/show JSON.
Unexpected plans are rejected; only the new attempt's private work is cleaned.
If process termination cannot be confirmed, private work is retained for separate
recovery. Publication failures report promoted-plan custody as absent/present/unknown
where filesystem writes permit. Acceptance needs observed executor exit0/PASS,
valid result receipt and no failure receipt; a filename alone is not acceptance.
Every attempt consumes its approval, including failure. No automatic retry.

The initial review found an incorrect previous-state header assumption, post-spawn
cleanup exposure and incomplete receipt/retained-plan handling; all were corrected
and regression-tested. Nineteen offline tests pass on Python3.12/3.14 with warnings
enabled. Security independently exercised partial receipt-write failure. Independent QA also exercised partial result writes, failed result deletion, failed
work cleanup and unknown retained-plan custody. Node22.23.3 lint/typecheck/build/test
passed at `/private/tmp/tonyai-l8-local-checks-ci5gki1i/results.json` (lint eight
warnings/zero errors; other tasks cached), on a9476eb plus the three documentation
edits. git diff --check passed. API integration/RLS, full infra suites and CI
dispatches were not run; no repository implementation changed.
Only the existing three documentation files change in the worktree; no repository
implementation, protected input, immutable artifact or prior evidence is changed.
Both diagnostics destination=null and missing vault networkAcls remain OPEN.
A successful PLAN does not prove unmanaged-app absence, runtime access, SMTP
validity/delivery or observability, and grants no deployment authority. Deployment
still needs its own vault disposition, log acceptance and explicit operation approval.

The owner explicitly approved final AP1 seal
`01842acf9adff15dabe7c15aadc667bb7103ca06dc4c65798458623113235f0e`,
including backend initialization/lease effects and transient private-plan custody.
One authorized invocation after offline preflight exited0/PASS: init0, plan2,
show0. The executor accepted exactly two app creates and zero updates/destroys,
full body/input/source/lock/embedded-state comparisons, with no extra changes,
outputs, drift or nonempty prior resources. Accepted plan SHA256:
`4bd9c92bd0d238c64839e37378d324aed45c04ec2bf3af56e99788fbaa9b76b3`,
mode0400, at `/private/tmp/tonyai-l8-app-plan-1ftnnret-execution/accepted.tfplan`.
Current embedded state has the required UUID-shaped lineage/serial1; previous
state has the empty-lineage/serial0 stub; both have empty resources/outputs/checks.

The container precheck returned200/unlocked/available; exact blob precheck returned
404/BlobNotFound; post-plan blob HEAD returned200/unlocked/available. This records
before/after observations consistent with initial-state creation, not an independent
lease-operation audit or post-plan state-body read. No unmanaged-app absence proof
follows. New private work was removed; no failure receipt exists. All514 prepared
files,2,037 external bindings,three tools,17 protected inputs and immutable
candidate/r002 remain unchanged. DevOps independently accepted actual ZIP/header/source/lock/custody evidence.
QA independently opened the actual saved binary with offline Terraform show and
the sealed inspector: exact2creates/0updates/0destroys, full bodies/inputs and empty
prior state passed. Its disposable scratch used an empty HOME, disabled Azure
authentication, backend=false and the sealed local provider mirror; local provider
IPC required sandbox escalation, with no cloud request. Raw JSON stayed in memory
and scratch was removed. Both outcome reviews accepted the bounded result.
Post-run Node22.23.3 lint/typecheck/build/test passed at
`/private/tmp/tonyai-l8-local-checks-jfj7j6cu/results.json` (lint eight warnings/zero
errors; other tasks cached), on a9476eb plus the three documentation edits.
git diff --check passed; no API integration/RLS, full infra suite or CI dispatch
ran because repository implementation is unchanged.
Acceptance receipt: `/private/tmp/tonyai-l8-app-plan-1ftnnret-execution/acceptance-receipt.json`;
raw execution summary `result.json`, observed exit record `observed-execution.json`
and independent outcome reviews are retained alongside it. Approval is consumed. No APPLY/deploy, secret access,
email/SQL test, recovery, retry, seed or grant mutation occurred or is authorized.
Both findings remain OPEN; Terraform-reported runtime/SMTP readiness stays true,
apps=false. A later APPLY package requires separate offline gate assessment and
explicit owner approval, including vault-finding disposition and observability
acceptance; this PLAN does not supply either.

**L8-AA1 prepared offline, then approved once and stopped at the GitHub gate (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-app-apply-9mb7no43` preserves AP1 and its accepted
binary;2,586 external hash/mode bindings and three tools include all prior sealed
source/evidence,17 protected inputs and immutable candidate/r002. The code/runbook
assessment found no mandatory extra repeat-M1 or inventory-only approval round:
a fresh successful inventory can guard the single future APPLY operation. Both
findings remain OPEN. An explicit initial-QA vault disposition is needed; actual
workload log ingestion/table-routing acceptance follows workload creation, per
runbook01. Repeating an identical metadata GET cannot guarantee either finding
will resolve. The source imposes no application saved-plan TTL or calendar-day
replan requirement; stale state must refuse, not trigger an automatic replan.

The proposed invocation first checks three public GitHub workflow-run endpoints
for exact candidate6bceba82/main, using the existing latest-run/attempt semantics
for ci.yml,e2e.yml,integration.yml. Incomplete pages or a newer pending/failed run
stop before Azure authentication. Current live results are unproven; no GitHub
metadata request or workflow dispatch has run during preparation. Initial owner
rollout does not require the deferred WP-6 workflow to retarget today's main.
Two explicit owner ARM/Storage CLI guards then precede one complete ARM Container
Apps inventory in tonyai-qatmp-apps. Either target app present, malformed/incomplete
inventory or pagination stops before Terraform. The proposed one remote init,
local saved-plan show/inspection and one exact saved-binary APPLY retain locking
and stale-state checks, registration suppression, AzureAD backend and pinned local
provider mirror. There is no new PLAN, drain, import/adoption or force unlock.
Three bounded ARM reads (API, API revisions, web) check the source deployment
contract. Failure remains incomplete even if APPLY returned0; no retry or recovery.
No post-APPLY blob HEAD is included; do not infer independent unlocked-lease proof.

The existing deploy-apps.sh path would make another plan and can drain, so it is
not invoked to apply AP1. A new private source tree preserves exact byte copies of
runtime-limits.json,deployment-policy.json,hosted-qa-exception.json beside the
application root. Independent pinned-Terraform builtin-only relocation probes
passed with identical bytes and refused missing/changed dependencies; this proves
local file resolution, not Azure apply success. Read-only Git-object verification
binds all42 committed migrations, pnpm lockfile and candidate/release target fields.
This is explicitly equivalent provenance checking, not calling candidate.py's
clean-checkout CLI against dirty infrastructure HEADa9476eb.

The approval includes four scoped acceptances: backend/state/lease and transient
private-file custody; unknown vault networkAcls for this one initial hosted QA
deployment; destination=null remaining open with actual log ingestion/routing as
a later acceptance gate; and public HTTPS workload startup before functional/log
acceptance. Cleanup hold is not a traffic barrier. Managed identities resolve
versioned secrets and pull images; API readiness automatically performs SQL and
authenticated Supabase bucket metadata reads. No operator secret GET or separately
invoked SQL/email test, seed, fixture, rotation, grant mutation or recovery is
included. Runtime readiness, SMTP delivery, live credential validity, QA account
handover and L8/L10 completion remain separate. No production waiver is proposed.

GitHub/inventory observations are point-in-time and do not reserve resources.
No fresh comprehensive drift/grant/vault/secret-validity/image-rescan check is
included; saved-plan state staleness checks do not prove unchanged external
resources. A failed or partial apply can leave billable resources/state changes.
Only NEW work is cleaned, and uncertain process shutdown preserves it for separate
recovery. Raw GitHub/ARM/show/process payloads stay out of evidence and logs;
inventory may include unrelated app configuration, discarded in memory. Success
requires observed exit0/PASS, valid receipt and no failure receipt, plus independent
outcome review. Prior approvals remain consumed; AA1 needs its own final seal and
all four explicit owner acceptances. Sixteen mocked tests passed on Python3.12/3.14;
independent Security, QA and DevOps implementation reviews accepted core
`ca53f4054974981c0c2d02a4c193f9f2583721d4e53da453fe8bff116f27f084`.
Additional independent checks covered transport/redaction/HTTPError cleanup,
ten journal-failure boundaries, one-shot invocation and twelve readback mutants.
Node22.23.3 lint/typecheck/build/test passed at
`/private/tmp/tonyai-l8-local-checks-f_uhdrqe/results.json` (lint eight warnings,
zero errors; other tasks cached), on a9476eb plus the three documentation edits.
git diff --check passed. No API integration/RLS, full infra suite or CI dispatch
ran; repository implementation is unchanged. Final packet preparation grants no
live authority; no owner authorization or execution directory existed at preparation.
The subsequent explicitly approved attempt is recorded below.

The owner subsequently approved final AA1 seal
`516890c49b20d41f0892f267621354b5d362c148b1ca21ca4da7cb43d7cb352c`
and all four operation-specific conditions. Offline preflight passed; one invocation
exited1 at GITHUB_GATE. Original execution evidence consists of attempt.json,
failure.json,github-ci.yml-attempt.json and github-e2e.yml-attempt.json in
`/private/tmp/tonyai-l8-app-apply-9mb7no43-execution`.

The sealed sequential source can reach the E2E attempt marker only after the CI
response passes completeness and the latest qualifying exact-SHA/main run is
accepted completed/success in memory. No CI run ID or response was retained for
independent re-evaluation. The E2E attempt marker is written BEFORE its HTTP call;
it establishes entry into that fetch stage, not request issuance, HTTP completion,
response shape or workflow failure. Exact cause remains unknown. Do not report
that the E2E test failed. The integration stage, Azure token guards/inventory,
Terraform init/show/APPLY and deployment readback were not reached. No new private
work or success receipt remains. The generic failure flag remote_changes_possible=true
is unconditional conservative schema text, not evidence of Azure writes in this
pre-authentication stop. Neither application was deployed by this attempt.

Independent QA/DevOps reviewed the bounded failure classification and source path.
Post-attempt Node22.23.3 lint/typecheck/build/test passed at
`/private/tmp/tonyai-l8-local-checks-ftlulxy_/results.json` (lint eight warnings/zero
errors; other tasks cached), on a9476eb plus the same three documentation edits.
git diff --check passed. API integration/RLS, full infra suites and CI dispatches
were not run; no repository implementation changed. Outcome receipt:
`/private/tmp/tonyai-l8-app-apply-9mb7no43-execution/outcome-receipt.json`;

all21 prepared files,2,586 external bindings,three tools,17 protected inputs,
immutable candidate/r002 and the AP1 accepted plan remain unchanged. The four scoped
acceptances belonged to this one attempt; approval is consumed and supplies no
retry/recovery or follow-on authority. Both findings and all workload acceptance
gates remain OPEN. Next prepare only a single exact unauthenticated public E2E
workflow-runs metadata diagnostic, with bounded fixed-stage/status classifications,
then request its separate approval. A new observation will not retroactively prove
this attempt's discarded error; any later APPLY must reevaluate all three current
release gates. Do not dispatch workflows, weaken gates or replay AA1 automatically.

**Owner-requested AA1 retry1 stopped before Azure (2026-11-01); renewed approval consumed.**
After the failure report the owner explicitly requested a retry. The retry used
an independently checked byte-identical21-file copy at
`/private/tmp/tonyai-l8-aa1-retry1-t47r8rex`, retaining the original finalseal516890c4
and all four previously approved scoped conditions. No code, endpoint, gate or
old attempt marker changed. A fresh authorization and exclusive execution journal
were used; this was a new human-authorized attempt, not automatic recovery.
The single retry exited1 again at GITHUB_GATE with only CI/E2E attempt markers.
CI acceptance is inferred from sealed sequential control flow; E2E request
completion and exact cause remain unknown. No integration, Azure auth/inventory,
Terraform or APPLY was reached. Independent QA accepted the bounded outcome.
Retry receipt: `/private/tmp/tonyai-l8-aa1-retry1-t47r8rex-execution/outcome-receipt.json`;
its9-file execution seal is
`6301da087658722741e4a8a1a785b6ce3a93d79614d325ecc72e7df5c92aaa3f`.
Explicit parent linkage binds the original failed executionsealbab6d0bf; both
packets, prior journals, immutable artifacts and17protected inputs remain intact.
No further deployment retry or live diagnosis is authorized.

**L8-E2E-D1 prepared offline, then separately approved and collected once (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-e2e-diagnostic-pr8mvr7o` binds both failed attempts,
2,660 external hash/mode pairs and the pinned Python tool. The approved scope was one
unauthenticated public GitHub E2E workflow-runs GET for exact candidate
6bceba82a762d5a657510c107df0a31c6e4c7b8e/main, at the same endpoint as the stopped
AA1 stage. No CLI/token/cache/Azure/Terraform/secret/dispatch/application action.
Proxy, redirects, pagination and automatic retries are disabled. Maximum body
is4MiB;60second socket timeout is not an overall wall-clock guarantee.

The diagnostic retains only fixed transport/HTTP/body/JSON/schema/completeness
classifications, bounded counts and, for the latest qualifying run, numeric
ID/number/attempt and allowlisted status/conclusion. Raw errors, headers, titles,
actors, credentials and response bodies are not retained or printed. Exact
SHA/main/repository/event filters and latest run_number/run_attempt ordering remain;
no gate is weakened. A non-success classification can be a successful diagnostic
collection, never release success. LATEST_SUCCESS would prove only a current E2E
observation; it cannot establish all three release gates or deployment authority.
Neither this read nor repeated AA1 attempts can reconstruct discarded historical
errors. All three gates must be current for any later separately approved APPLY.

Twelve mocked tests pass on Python3.12/3.14 with warnings enabled. Security, QA
and DevOps accepted core
`33b191d25e1816fbd25e4c8a2c18e416100dcdf8d3f4ad74c45359e932bfffa0`.
Additional probes covered16 malformed-field cases,six HTTP-error statuses,partial
result deletion failure and256 synthetic comparisons against the source gate.
Node22.23.3 lint/typecheck/build/test passed at
`/private/tmp/tonyai-l8-local-checks-go8a3qrq/results.json` (lint eight warnings/zero
errors; other tasks cached), on a9476eb plus the same three documentation edits.
git diff --check passed. No API integration/RLS, full infra suite or CI dispatch
ran; no repository implementation changed. The original
sourcea9476eb, candidate/r002, AP1 binary, both infrastructure findings and prior
readiness limits remain unchanged. The preparation packet remains immutable;
its historical authorized/executed=false fields are superseded only by separate
authorization and execution receipts, not by editing the packet.

**E2E-D1 bounded execution outcome.** Owner approved final packet seal
`3d48ee199e5b5f96e4249e3e122afa79ffcdaddf79332198300faceae4b0f83a`.
The single unauthenticated public GET completed with HTTP 200 at
2026-11-01T00:15:16Z: total_count=0, returned_rows=0, qualifying_rows=0,
no pagination header, classification `NO_QUALIFYING_RUN`. Executor exit 0 means
bounded collection completed, not release-gate success. Independent QA verified
authorization, all four original receipts, unchanged packet/external/tool seals
and the bounded interpretation. Evidence:
`/private/tmp/tonyai-l8-e2e-diagnostic-pr8mvr7o-execution/outcome-receipt.json`.
No Azure, Terraform, workflow dispatch, secret access or deployment occurred.
The approval is consumed and authorizes no retry or follow-on operation. Neither
historical AA1 failure cause is established; integration remains unobserved.

Post-outcome Node22.23.3 pnpm lint/typecheck/build/test passed on a9476eb plus
these three documentation edits; results:
`/private/tmp/tonyai-l8-local-checks-_hnc8var/results.json`. Lint reported eight
warnings and zero errors; other tasks were cached. git diff --check passed.
No API integration/RLS, full infra suite or CI dispatch ran.

**Qualification constraint and next scope decision.** Offline DevOps review of
candidate and source workflows found E2E manual dispatch has no inputs and uses
default checkout; integration also has no candidate override. The release gate
requires both exact candidate SHA and head_branch=main. Dispatch accepts a branch
or tag and runs its tip: dispatching main cannot select an earlier candidate
when main has advanced, and a candidate branch/tag does not establish main
provenance. Local main/origin-main point at a9476eb; this is not a fresh remote
head observation. No supported path has been verified that qualifies old 6bceba82
while preserving all existing constraints. Do not rewind main, weaken gates or
blindly dispatch/retry APPLY. Owner subsequently chose new-candidate qualification under the existing gates
for offline preparation only (L8-NC-G1 below). Preserve
old candidate/r002/AP1; reuse is not automatically authorized. A further integration
metadata read alone cannot resolve this E2E constraint. Diagnostics destination=null,
absent vault networkAcls and runtime/SMTP/log acceptance remain open.

**New-candidate scope selected; L8-NC-G1 prepared, separately approved and collected once (2026-11-01).**
The owner selected a new candidate under the existing CI/E2E/integration gates;
this does not authorize live metadata access, workflow dispatch, build or deploy.
The offline proposal was `a9476eb735cad53aa7091932dd02b38a4070cefb`; its
subsequent main-reference observation is recorded below. Offline Git-object comparison confirms old6bceba82 is its ancestor;
20 changed files cover documentation, migration helpers, foundation and tests.
Application/packages, all42 migrations, lockfile, workflows/actions, application
Terraform and candidate/build/release-gate/secret-verifier sources are unchanged.
That equality never permits relabelling old images or changing old candidate/r002.

Packet `/private/tmp/tonyai-l8-candidate-gates-ewar03wd` prepares one invocation
with at most four public unauthenticated GETs. First read exact Git reference
`refs/heads/main` in `tonyaiukco/TonyAI-mono-repo`; require commit SHAa9476eb in full.
Mismatch, malformed data or HTTP/transport failure stops before the other GETs;
no automatic SHA selection. On match, observe ci.yml, e2e.yml and integration.yml
for exact a9476eb/main, with the existing repository/event filters and latest
run_number/run_attempt selection. Collect all three even if one is missing,
pending, non-successful or unreadable; only three successful complete observations
can set all_three_gates_observed_successfully. Reads are non-atomic and do not
reserve main. No CLI/auth/token, Azure, secret, TF, dispatch/rerun, build/push,
candidate creation, migration, email, rotation, recovery or deployment occurs.
No proxy/redirect/pagination/retry;4MiB body limit,60second socket timeout per GET
(not an overall deadline); safe metadata only, no raw payload/error retention.
The source,2715external hash/mode pairs, pinned Python and old protected evidence
are bound. Eighteen mocked tests pass on Python3.12/3.14; independent
Security/QA/DevOps accepted core
`eead3be75cb389baf16ca1b5fd97ff0871c926925480480fd801536b08623a3d`.
Extra probes covered27 three-gate combinations and10 receipt-write failure
boundaries. Node22.23.3 pnpm lint/typecheck/build/test passed on a9476eb plus the
same three documentation edits; results:
`/private/tmp/tonyai-l8-local-checks-swi20s3p/results.json`. Lint eight warnings,
zero errors; other tasks cached. git diff --check passed. API integration/RLS,
full infra suite and CI dispatch were not run; no repository implementation
changed. The preparation packet remains immutable; its historical authorized/
executed=false fields are superseded only by separate execution receipts.

**NC-G1 execution outcome (approval consumed).** Owner approved final seal
`b39dd013bc424c5bb2d5a5bbe9cec29742f37b52ed620d4558af8ab148c4591b`.
One invocation exited0, with four HTTP200 observations, no pagination:

| Observation | Time (UTC, 2026-11-01) | Result |
|---|---|---|
| main reference | 01:47:59 | Exact a9476eb735cad53aa7091932dd02b38a4070cefb match |
| CI | 01:47:59 | 1 qualifying row; latest run40968399879, number709, attempt1, completed/success |
| E2E | 01:48:00 | 2 qualifying rows; latest run41186929348, number120, attempt1, completed/success |
| Integration | 01:48:00 | total_count=0, returned_rows=0, qualifying_rows=0; NO_QUALIFYING_RUN |

Integration evidence is missing for the proposed exactSHA/main. This is not an
Integration test failure and does not establish either historical AA1 cause.
The observations are non-atomic, reserve no branch and are not perpetual gate
acceptance. No workflow dispatch, candidate/image creation, Azure, Terraform or
deployment occurred. No follow-on action is authorized. Evidence:
`/private/tmp/tonyai-l8-candidate-gates-ewar03wd-execution/outcome-receipt.json`.
Independent QA accepted authorization, ten original receipts,37 packet files,
2715external bindings, Python and17protected inputs. Post-outcome Node22.23.3
pnpm lint/typecheck/build/test passed on a9476eb plus these three documentation
edits; results `/private/tmp/tonyai-l8-local-checks-63mjj3ff/results.json`.
Lint eight warnings/zero errors; other tasks cached. git diff --check passed.
No API integration/RLS, full infra suite or CI dispatch ran; no repository
implementation changed.

After observations, any missing gate needs separately scoped qualification.
A subsequent dispatch/build must recheck the exact source; new remote main drift
requires reselection, not silent retargeting. candidate.py requires a clean exact
source checkout; retain the current three dirty documents. Standard build-images
performs Supabase public-browser-key authentication checks, ACR login, two builds
with new revision labels and push, exact web digest pull/extract/scan, and candidate
creation using those builds' digests. These effects need their own approval.
A new immutable release with new source/release ID/image binding requires a new
reviewed application PLAN; AP1 cannot deploy that release. AP1 already initialized
the backend state, so old BlobNotFound prerequisites must not be reused. The equal
migration chain permits offline correspondence to prior evidence, not a new live
migration claim or automatic migration/rotation/grant replay. New manifest secret
version checks remain separately scoped. Preserve old candidate/r002/AP1 and all
historical receipts; diagnostics/vault and runtime/SMTP/log findings remain open.

**L8-INT-D1 prepared, separately approved and completed once (2026-11-01); approval consumed.** Packet
`/private/tmp/tonyai-l8-integration-dispatch-ezjmtfzs` targets only the missing
Integration qualification for a9476eb735cad53aa7091932dd02b38a4070cefb. The full
committed source archive binds1316 files and transitive local workflow dependencies;
2781external hash/mode pairs and Python/gh binaries bind prior evidence and tools.

Scope: public exact-main and empty exactSHA/main Integration prechecks; one local
`gh auth token --hostname github.com` acquisition for the configured active account,
held in memory only; one authenticated /user GET for actor binding; another exact
main GET; at most one API2026-03-10 POST with {"ref":"main"}. Require HTTP200 and
validated workflow_run_id/fixed repository URLs. Only that returned run ID may be
observed, at most60 public GETs,30seconds apart within1800seconds, with strict
SHA/main/path/event/repository/actor/attempt1 checks. An exact-run success permits
one final Integration latest-run check; another run/attempt cannot substitute.
Maximum66 HTTP requests including1POST. Existing/unconfirmed initial Integration
evidence stops before credential access; drift/errors/mismatch stop without retry.
HTTP204/timeout/malformed POST response means unconfirmed effect, never permission
to repeat. No automatic rerun/cancel, logs download, build, Azure/hosted Supabase,
Terraform, candidate/release creation, deployment or recovery. CI/E2E are not
refreshed; Integration success does not re-accept all release gates.

Three explicit owner acceptance flags are required. First, main-check and dispatch
are non-atomic; another commit/workflow could begin before readback rejects it.
The owner must avoid main changes and accept this residual race; upstream action
tags/downloads are also not made immutable by the source archive. Second, the
existing workflow applies migrations and demo seed only to disposable local
Supabase on the GitHub-hosted runner, with source local-target guards. Because
cloud seed was prohibited, this runner-local fixture scope requires explicit
acceptance; the hosted Supabase project remains forbidden. Third, the existing
workflow installs dependencies, logs into GHCR with the job token, downloads/caches
images, runs Docker and integration fixtures; its bounded GHCR retries remain.
Manual dispatch does not request running-run cancellation, but concurrency may
supersede an older pending run. The job timeout is20minutes; monitoring count/window
and60second socket timeouts are not an overall wall-clock guarantee.

Initial Security/QA review found credential-subprocess setup outside cleanup guards.
Corrected before execution: setup is guarded, process-group absence checked,
kill/wait bounded, pipes closed; uncertain cleanup refuses subsequent requests.
Twenty-eight offline tests pass on Python3.12/3.14 (network blocked, synthetic
credential subprocesses only). Corrected core
`a80b0b34776e48c517c692c592acd8ae3d065cd3e1d8693e0f4f86a92a2ef5ec`
was accepted by Security, QA and DevOps after re-review; the cleanup P2 is closed.
Additional probes verified the66-request/one-POST cap, refusal of request67,
ten journal-failure boundaries, cleanup uncertainty and each required acceptance
flag. Node22.23.3 pnpm lint/typecheck/build/test passed on a9476eb plus the same
three documentation edits; results:
`/private/tmp/tonyai-l8-local-checks-5adpm170/results.json`. Lint eight warnings,
zero errors; other tasks cached. git diff --check passed. No API integration/RLS,
full infra suite or CI dispatch ran; no repository implementation changed.
The owner subsequently approved this operation and all three conditions; execution
is recorded below. Historical authorized/executed=false preparation fields remain
unchanged; separate authorization and execution receipts carry applied evidence.
Oldcandidate/r002/AP1 and17protected inputs remain unchanged; all diagnostics/vault
and runtime/SMTP/log findings remain open. No commit/push.

**INT-D1 accepted-scope execution outcome.** Final packet seal
`e8e2dbaed8e45223d792ee0c90fa9822f9108993dae772d97c1bc13b03a96b79`
was explicitly approved with all three acceptance flags. One invocation started
2026-11-01T09:37:57Z and exited0 after bounded observation. Both main guards matched
exact a9476eb; initial Integration list was complete/empty. One configured-account
credential acquisition and authenticated actor binding preceded one POST, which
returned run41293973321. Thirteen observations bound SHA/main, Integration path,
workflow_dispatch, actor297710583/tonyaiukco and attempt1. At09:44:03Z run number171
completed/success; the final exactSHA/main Integration list contained one qualifying
row and selected the same run/attempt as latest success, without pagination.

Total19 HTTP requests,1POST; result EXACT_SOURCE_INTEGRATION_SUCCESS_OBSERVED.
This establishes the missing Integration evidence at that time. CI/E2E were not
refreshed; all_release_gates_accepted remains false. No branch is reserved and no
candidate/image build, Azure, Terraform or deployment followed. Approval is consumed;
no retry/cancel/recovery or follow-on authority. The approved fixture-seed exception
was confined to the reviewed runner-local Supabase workflow; hosted Supabase seed
remains forbidden. No job logs were fetched, so no independent test-count or runtime
fixture audit is claimed. Evidence:
`/private/tmp/tonyai-l8-integration-dispatch-ezjmtfzs-execution/outcome-receipt.json`.
Independent QA accepted the bounded outcome:60original0600 receipts, ordered
19HTTP/1POST evidence,13exact-run observations and final same-run latest success;
all29packet files/2781external/two tools/17protected inputs remain unchanged.
Post-outcome Node22.23.3 pnpm lint/typecheck/build/test passed on a9476eb plus
these three documentation edits; results:
`/private/tmp/tonyai-l8-local-checks-g03tyauw/results.json`. Lint eight warnings,
zero errors; other tasks cached. git diff --check passed. No local API integration,
RLS probes or full infra suite ran; the approved remote Integration workflow is
recorded above. Repository implementation is unchanged.

Next prepare a new clean-source candidate/image-build package, including fresh
source and all-three-gate checks before any live build/authentication. Do not
relabel old digests, reuse r002/AP1 for a new source, or replay grants/migrations
merely because the application source changes. New release/secret binding and
application PLAN/APPLY remain separately scoped. Diagnostics/vault and runtime/
SMTP/log acceptance remain open.

**L8-IB1 local image-build packet prepared offline, subsequently approved and attempted once (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-image-build-x2zlho72` binds exact source
`a9476eb735cad53aa7091932dd02b38a4070cefb` in the new clean managed checkout
`/Users/denizb/.codex/worktrees/hosted-l8-candidate/TonyAI-mono-repo-codex`.
The planning tree and its three existing document edits remain separate and intact.
The packet binds 1,316 tracked source files, 4,234 external evidence/source files,
six tool binaries/launchers and the old 17 protected inputs. No new candidate exists.
At 09:52:57 UTC, a local Unix-socket read found zero running containers; this is
historical local evidence, not a live build authorization or future stack guarantee.

The proposed one-attempt operation checks source seals/cleanliness and local Docker
(no running containers, without implicit stop), then performs four public GitHub
GETs for main and the exact-source CI/E2E/Integration latest qualifying successes.
One explicit-subscription ARM token command and three fixed metadata GETs bind the
resource group, registry and Container Apps environment. Two Supabase Auth settings
GETs use an invalid-key control and an owner-entered public browser key, with the
original Auth validator. These nine direct GETs exclude Azure CLI/Docker internal
network activity. A private owner terminal supplies the key with echo disabled;
echo-control failure refuses input. No old image/cache/file is mined for a key.

An adapter of the existing build-images recipe then performs explicit-subscription
ACR login using an isolated registry-specific osxkeychain configuration, two local
linux/amd64 buildx builds and pushes the full-source-SHA API/web tags. Approval must
cover the ACR Keychain update, upstream downloads, tag replacement and partial
push/cache effects. No automatic retry, logout/restore, remote ACR build fallback,
image deletion or recovery is included. Client shutdown does not prove daemon work
has ended. The public key is intentionally embedded in web assets and may occur in
Docker build metadata/cache; it is not printed or stored in operation logs.

Digests come only from these build invocations, differ from the previous candidate's
respective digests and are pulled/inspected for both images: linux/amd64, exact source
revision and RepoDigest. One stopped network-none web container supplies static
assets. Reject symlinks/special files and traversal errors, bound count/file/total
size, then run the unchanged limited sb_secret_/service_role scanner. Remove only
the returned container ID; custody remains explicit if cleanup is uncertain.
Source/preservation checks precede candidate creation. Candidate plus receipt are
staged under `.candidate-pending`; only after temporary-work cleanup are they
atomically promoted to `accepted`. A failure invalidates all outputs and quarantines
any promoted result, recording observed custody. The accepted candidate must have
a matching receipt and no failure receipt. Old candidate/release-r002/AP1 stay sealed.

Initial independent review found hidden-input fallback, candidate/container custody,
authorization receipt and exported-asset traversal issues. Corrections now have
43 socket-blocked offline tests, including the full mocked execution pipeline and
negative finalization paths. Independent Security, QA and DevOps accepted corrected core
`6feb090b2ce637e247438402afe9ad1fd91dcc9c868b964e19a126449bd9d8de`.
All 43 tests passed on Python 3.12/3.14; QA added seven failure-path probes.
Node 22.23.3 lint/typecheck/build/test passed on planning HEAD a9476eb plus the
three documentation edits: eight lint warnings, zero errors, other tasks cached.
Check receipt: `/private/tmp/tonyai-l8-local-checks-ad4vtcl2/results.json`.
No local API integration, RLS, full infra suite or CI dispatch ran for this packet;
repository implementation is unchanged. Final packaging audit is separate from
core acceptance and grants no live authority. This preparation performs no live credential/cloud
operation, build, seed, migration, Terraform, app start/deployment, SMTP test, rotation
or release binding. Diagnostics destination=null and absent vault networkAcls remain
OPEN; runtime MI/SQL/SMTP/log acceptance is unproven. RBAC/build success does not
close those findings. A later new release/secret binding and application PLAN/APPLY
need separately reviewed scopes and approval; no previous live authority transfers.

**IB1 execution stopped before build.** Owner approved final seal
`6db4f3a79461c05244128dec37f13ae9b565cd4ef131e0dc25884cec3710584d`
and all three conditions. Private-terminal execution began at 10:15:53 UTC; the
owner supplied the hidden public browser key. At 10:18:00–10:18:01 UTC main matched
exact a9476eb and the complete latest qualifying gate results were CI40968399879,
E2E41294897048 and Integration41293973321, all attempt1 completed-success. Local
Docker showed zero running containers. The ARM token command exited0 and every
local claim guard passed; group and registry GET200/binding receipts passed.

The seventh direct GET (third ARM read), for the exact managed environment,
returned HTTP200, parsed JSON and no pagination header at 10:18:05 UTC. Execution
then recorded ARM_TARGETS failure before an environment-binding receipt. This
bounds the stop to shape/ID/location/tags/provisioning/domain validation or local
receipt publication/interruption; the exception and response body were not retained.
Do not infer a specific current field, credential/RBAC failure or HTTP rejection.
The terminal reported completion; no independent terminal exit-code capture exists
(the sealed failure path returns1). The public key was not live-tested in this attempt.

Offline comparison found the same environment's preserved L3 readbacks use location
`Sweden Central`; IB1 requires literal `swedencentral`. That historical value would
fail the new predicate, but is not proof of the unretained current response or cause.
Preserve this distinction. Independent outcome QA accepted the bounded failure and
verified that Supabase Auth requests, ACR login/Keychain update, build/push/pull,
inspection-container creation, candidate/release/TF/deployment/seed were not reached.

Evidence: `/private/tmp/tonyai-l8-image-build-x2zlho72-execution/` with 26 original
receipts, original-manifest hash
`5cef8d763d1f57efff58e6789aaf3764e1927f5db6853147a3c6b2b0c1d44feb`.
Private work remains at `/private/tmp/tonyai-ib1-work-o47ytgo9`; no cleanup/recovery
or credential/cache read is implied. Old packet/core/17 inputs/candidate/release/AP1
remain unchanged. Approval is consumed despite failure; no replay authorization.
Next prepare an exact-environment predicate diagnostic offline, with a separately
reviewed one-token/one-GET scope and safe per-predicate classifications. Do not fold
it into a build retry or silently weaken the guard. Diagnostics/vault and runtime/
SMTP/log findings remain open. Post-outcome Node22.23.3 lint/typecheck/build/test passed on planning a9476eb plus
the three docs: eight lint warnings/zero errors, other tasks cached. Receipt:
`/private/tmp/tonyai-l8-local-checks-o_q55ux6/results.json`. No local API integration,
RLS, full infra suite or new CI dispatch; repository implementation is unchanged.

**L8-ED1 exact-environment diagnostic prepared, separately approved and completed once (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-environment-diagnostic-fpy1fduv` binds source a9476eb,
1,316 clean checkout files, 4,317 external source/evidence files and three active
tool launchers/binaries. Old IB1 packet, its 41-file sealed failed execution,
26 original receipts, 17 protected inputs and private work remain untouched.
A standard-library-only bootstrap verifies module hashes/modes and the exact
packet path before importing packet modules; copied packets cannot replay.

The proposed operation performs one explicit-subscription ARM token invocation,
with unchanged tenant/owner/audience/time guards and bounded private capture,
then exactly one GET of the same managed environment/API2025-01-01. Owner approval
must include Azure CLI credential-cache read/refresh effects. No browser key is
needed and no GitHub/Supabase/Key Vault/Docker/build path exists. One direct resource
GET excludes CLI-internal authentication traffic. Redirects/proxies/retries are
disabled; socket timeout60s, response bound4MiB; error bodies remain unread.

The full environment response is parsed only in memory and may include key-bearing
logging configuration. No logging subtree is inspected or retained. Output is fixed
shape booleans, seven IB1 predicate booleans (ID, canonical region, three tags,
provisioning and domain), plus CANONICAL_MATCH / KNOWN_DISPLAY_MATCH /
OTHER_OR_ABSENT for region. Display-form detection leaves the canonical predicate
false; the old build guard is unchanged. Even exit0 means only diagnostic collection,
not target/deployment acceptance or retrospective proof of IB1's failure cause.
Malformed shapes yield safe classifications; HTTP/JSON/claim/publication failures
stop without retry. Result promotion/quarantine and observed custody prevent a
failed journal from qualifying a partial result. All attempts consume approval.

Initial Security review caught a pre-seal local-module import; corrected bootstrap
and import-sentinel regressions close that path. The 28 socket-blocked tests pass
on Python3.12/3.14, including transport, predicate, publication, replay and cleanup
cases. Independent Security, QA and DevOps accepted corrected core
`78e6696cccad34f897d7dc262f2d1607df67ba2195bb56cd9240dbafb8cf3f34`;
QA additionally compared 1,296 metadata combinations against IB1 and tested nine
journal boundaries, while Security checked 72 predicate mutations and a logging
subtree access trap. Node22.23.3 lint/typecheck/build/test passed on planning a9476eb
plus three docs: eight lint warnings/zero errors, other tasks cached; receipt
`/private/tmp/tonyai-l8-local-checks-ku9bymhx/results.json`. No local API integration,
RLS, full infra suite or CI dispatch ran; repository implementation is unchanged.
Final seal/preflight/packaging review is separate and grants no live authority. No real authentication, metadata read, build, seed, Terraform, migration,
SMTP test, recovery or deployment ran during preparation. Diagnostics/vault and
runtime/SQL/SMTP/log findings remain open; no grant replay or old readiness reset.

**ED1 accepted-scope execution outcome.** Owner explicitly approved final seal
`f8aec1de42afcd402f9e9cebdca04e173b51423158d603de01eb5d26e4addae0`
and token/cache effects. One executor invocation (session46279, completion61d4e3)
exited0. Start10:32:58 UTC; one pinned token command exited0, local claim guards
passed; one exact environment GET returned HTTP200/no-pagination at10:32:59 UTC.
The diagnostic classified `ONLY_KNOWN_LOCATION_REPRESENTATION_DIFFERS`: root/tags/
properties shapes true; ID, three tags, provisioning state and domain all matched.
Location was `KNOWN_DISPLAY_MATCH`, whose fixed meaning is exact `Sweden Central`;
canonical-location matching stayed false. No response field values/body, token or
logging subtree were retained. No pending/quarantined/failure result remained;
only the new temporary work was cleaned by the success path.

This proves the current representation would fail the unchanged IB1 region check.
It does not prove the cause of the older unretained failure, change the old guard,
qualify a candidate/deployment or authorize a build retry. Independent QA/DevOps
accepted only the diagnostic observation. Evidence:
`/private/tmp/tonyai-l8-environment-diagnostic-fpy1fduv-execution/diagnostic.json`.
The nine original receipts are frozen by manifest
`db652f51b5e655c2aca401c2ebff8e735898eef4a639a17664d8e16370f1ff60`.

Approval is consumed; no follow-on live operation. Old IB1/private work/candidate/
release/AP1/17 inputs remain unchanged; no rollback or grant replay. Next prepare
a new build packet offline, with exact environment-only canonical-or-known-display
matching (`swedencentral` or `Sweden Central`), all other guards unchanged and safe
per-predicate receipts. Do not broaden to arbitrary case/whitespace/region aliases.
Independent review, final sealing and separate build approval are required; the
old packet is immutable. Diagnostics/vault/runtime/SQL/SMTP/log findings remain open.
Post-outcome Node22.23.3 lint/typecheck/build/test passed on planning a9476eb plus
the three docs: eight lint warnings/zero errors, other tasks cached. Receipt:
`/private/tmp/tonyai-l8-local-checks-47g35as8/results.json`. No local API integration,
RLS, full infra suite or CI dispatch; repository implementation remains unchanged.

**L8-IB2 revised local build packet prepared, separately approved and completed once (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-image-build2-6lovgq6b` retains exact a9476eb source in
its clean existing checkout. It binds 1,316 source files, 4,378 external files and
six active tools, including immutable IB1/ED1 packets and outcome evidence. No
private-work/credential/cache read or live operation occurred during preparation.

The only target-acceptance change from IB1 is environment location: exact
`swedencentral` or `Sweden Central`. Group and registry remain canonical-only.
ID, tags, provisioning state, group prefix/repository, registry host and environment
domain comparisons are unchanged. There is no general case/whitespace normalization
or other region alias. ED1 supports this current representation mapping, not a
retrospective determination of IB1's unretained failure cause.

All three ARM targets now produce fixed shape/predicate booleans and a location
classification before enforcement. A predicate observation is not a binding pass;
a separate pass receipt is written only after every condition passes. Distinct
per-target GET/pagination/classify/predicate-receipt/enforce/binding-receipt phases
make rejected values and local publication failures distinguishable. Raw response
fields, body and key-bearing logging subtrees are never logged. A standard-library
seal check plus exact packet_path binding precede all live packet/source imports.
Operation, owner launcher, authorization path, temporary-work prefix and inspection
container name belong to IB2; old journals cannot be reused.

The live scope remains nine wrapper GETs (fresh main/CI/E2E/Integration, three ARM
targets, two public-key Auth checks), one ARM token invocation, explicit-subscription
ACR login, two sequential local linux/amd64 build/push operations, both exact-digest
pull/inspection, stopped network-none web scan/container removal and atomic candidate
publication. build_steps/process_capture/claim_guard/gate modules are byte-identical
to reviewed IB1. Source recipe/lock/migrations and all candidate provenance, safe
asset traversal, bounded output, cleanup uncertainty/quarantine and exclusive-attempt
guards remain. No remote ACR-build fallback, secret extraction, seed, migration,
Terraform, release binding, app start/deploy, SMTP test, rotation or recovery.

Fresh approval must cover the two build/push/tag effects, Azure CLI/ACR Keychain
credential-store effects, and upstream downloads/partial build/cache/push effects.
The owner enters the public browser key again only at the private hidden terminal
prompt; no key is recovered from prior files/images/cache or chat. The public key
is intentionally part of browser artifacts, not operation logs. Any failure consumes
the attempt and never authorizes retry. Old17 inputs/candidate/release/AP1/private
work remain unchanged. Diagnostics/vault/runtime/SQL/SMTP/log findings remain open.

55 socket-blocked tests pass on Python3.12/3.14, including the prior IB1 custody/
scan regressions and new region/other-predicate/receipt-phase/no-follow-on cases.
Independent Security, QA and DevOps accepted core
`d16f185f99ff60979dec9c350b8a5b0037c1e2140dbaf8519ee29e905967ac15`.
QA independently compared3,888 predicate combinations and eight extra pipeline
failures; Security compared407 differential cases. Node22.23.3 lint/typecheck/
build/test passed on planning a9476eb plus the three docs: eight lint warnings,
zero errors and remaining tasks cached. Receipt:
`/private/tmp/tonyai-l8-local-checks-8kscjo9a/results.json`. No local API integration,
RLS, full infra suite or CI dispatch; repository implementation is unchanged.
Final packaging audit/preflight is separate from core acceptance and authorizes no
live action.

**IB2 accepted-candidate execution outcome.** Owner approved final seal
`cc9528259eb1e8c3213eaa06c0b00b0e0548d49358d508c6ce793071a16aaf64`
and all three build/credential-store/partial-effect conditions. One private-terminal
attempt began10:44:12 UTC and wrote its outcome record at10:46:14 UTC, before
cleanup and candidate promotion. Exact promotion/terminal-exit time was not captured. At10:44:25–27 UTC,
main matched exact a9476eb and complete latest qualifying CI40968399879,
E2E41294897048 and Integration41293973321 all passed. Nine direct GETs completed:
eight200s and the expected invalid-key401 control. Local Docker preconditions,
token claim guards, all three ARM targets, public-key binding and original Auth
policy validator passed. Environment accepted only its exact known display form.

All11 captured commands returned0: ARM token, ACR login, two build/push commands,
two exact-digest pulls, two image inspections, stopped-container create/copy/remove.
API digest: `sha256:e9ba267817667e8580afc39bfd1ace12f62cf012e044abe77ba30f4d8446495d`.
Web digest: `sha256:15f41c1b2cb86fbf357d8507e259a257cd04b1202a8215508cf3e9fd53b7a0f3`.
Both digests came from these builds' metadata and differed from the old candidate;
inspection confirmed linux/amd64, exact source revision and RepoDigest. This is
local build/provenance evidence, not independent remote-builder attestation.

The web inspection container was never started and its exact ID removal returned0.
The asset-tree guard accepted72 entries/4,363,327 regular-file bytes; original
sb_secret_/service_role scanner passed. This is limited marker coverage, not proof
that all possible secrets are absent. The public browser key is intentionally
embedded in the web artifact; raw command output and metadata body were not logged.
After final source/preservation checks, the candidate and outcome were atomically
promoted together; no failure/pending/quarantine remains. Success-path cleanup
removed only this attempt's temporary work. No independent terminal exit capture
exists; the accepted sealed path returns0 and all11 command codes are recorded.

New candidate:
`/private/tmp/tonyai-l8-image-build2-6lovgq6b-execution/accepted/candidate-r002.json`,
mode0400, SHA256 `e0dcf59698f7642b5c531c63caddf2bf5cb042c4f8f80c3208ab4a64a8cc86a8`,
source `a9476eb735cad53aa7091932dd02b38a4070cefb`,42 migration fingerprints and
committed lockfile fingerprint. Original65 files are frozen by manifest
`01ff511d52e3d9a42d8889b6bc5e481a349842eb996b2c4d033c476c249cae24`.
Independent QA and DevOps accepted the bounded new-candidate evidence; QA
independently reproduced candidate.create output exactly, including the lockfile
and42 migration fingerprints. Post-outcome Node22.23.3 lint/typecheck/build/test
passed on planning a9476eb plus three docs: eight lint warnings/zero errors, other
tasks cached. Receipt: `/private/tmp/tonyai-l8-local-checks-tmqv9zhz/results.json`.
No local API integration/RLS/full infra suite or new CI dispatch; repository
implementation is unchanged. Final packaging audit remains separate.

Approval is consumed. No new release, Terraform init/PLAN/APPLY, migration, seed,
app deployment, SMTP test, rotation or recovery followed. Old6bce candidate,
release-r002, AP1 saved plan, failed IB1/private work, ED1 evidence and17 protected
inputs remain unchanged. The old application plan cannot deploy this new candidate.
Next prepare a new candidate/release binding offline, preserving exact secret-version
references and using applied readiness receipts rather than historical false flags;
any later secret verification and new application PLAN/APPLY require separately
reviewed approval. No automatic re-grant/migration/secret rotation is implied by
new source provenance. Diagnostics/vault and runtime/SQL/SMTP/log findings stay open.

`deploy-apps.sh` delegates to application Terraform init/plan, drain, saved apply
and ARM readback; `--verify-only` also accesses ARM. Deployment therefore needs
its own concrete reviewed scope and approval after secret verification and a
vault-finding disposition. Preserve immutable `6bceba82`/`r002`, exact image and
secret versions and `storage_cleanup_hold=true`. `apps_ready=false` refers to
later app-scoped deployer grants and does not prevent an initial owner-run deploy.
Never use historical all-false foundation inputs to revert applied grants.
WP-6 is not needed for the initial owner-run deployment; its CI adaptation
remains a later package.

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
   `Microsoft.Communication`, `Microsoft.Insights` registered; permission to create an Entra app
   registration; a budget alert; the owner's public IPv4.
3. **Email:** the sending domain — Azure-managed to start; a custom domain needs
   DNS access at Namecheap for its verification, SPF and DKIM records.
4. **Local tools** (runbook 00): `az` on the subscription, Terraform 1.13.3,
   Node 22, pnpm 11.9.0, Python 3.10+, Docker with buildx, `psql`.
5. **QA team:** testers' names, emails and the role each needs.


**L8-SV3 prepared offline, then separately approved and completed once (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-release-r003-4_h5u93k` binds source
`a9476eb735cad53aa7091932dd02b38a4070cefb` and accepted IB2 candidate
`e0dcf59698f7642b5c531c63caddf2bf5cb042c4f8f80c3208ab4a64a8cc86a8`.
New mode0400 release-r003 SHA256
`1f2fb638d273e46c361ab9291d9bd2eb059a9d03e23f18be2aa21687e0820417`
changes only release ID, source SHA and the two image digests. Foundation, exact
secret versions, mail settings, cleanup hold=true and sweep settings stay intact.
Original schema/candidate validators pass offline; old r002/AP1 remain immutable.

The reviewed live unit was one explicit-subscription owner Vault token, then
four ordered GETs: database-url version9e58a8cedfe04d138893bdc031eb2ce3;
backend versioncb2bcf7ce50649c9bfe7eb01e87db497; the project's authenticated
`/storage/v1/bucket`; SMTP versionc69df9aa69a546e2ae7dbca261fa4bc7.
These read three SECRET VALUES in memory. Original release_secrets.verify checks
pooler URL/project/TLS shape, backend key and bucket-list shape, and SMTP password
shape; bounded transport seams enforce exact IDs/versions, enabled/present time
attributes, no proxy/redirect/pagination/retry, 2 MiB bodies and four direct GETs.
One CLI invocation may refresh the owner's cache/Entra token; its internal traffic
is outside that GET limit. Token capture has a120s/64KiB bound; HTTP60s is a socket
timeout, not a whole-response deadline. Raw responses/values/claims/value hashes
are not persisted. Local claim matching is not independent signature validation.
Success stages a result, cleans only new private work, then promotes; pending or
quarantined results and any failure receipt are unaccepted. Outcome record time
precedes promotion and is not an exit timestamp. No automatic retry/recovery.

28 offline tests pass Python3.12/3.14; they invoke the unchanged source verifier
with synthetic credentials and blocked sockets, probe fail-closed scope/custody/
redaction and exercise bounded subprocess capture. Independent review found the
candidate binding's inherited Git PATH/config; contracts now fixes the local
Git path/environment and restores the prior environment after binding.
Security/QA/DevOps accepted core3b36201e; QA independently added40 journal and
post-promotion fault probes. Acceptance explicitly requires observed runner exit0,
result.json, no pending/quarantined/failure file and successful preservation checks;
a result alone is insufficient. Node22.23.3 lint/typecheck/build/test passed on
planning a947 plus three docs, with eight lint warnings/zero errors and other tasks
cached; receipt `/private/tmp/tonyai-l8-local-checks-6e40y0r2/results.json`.
No API integration/RLS/full infra suite/new CI dispatch ran. Final packaging QA
is separate; these checks precede final documentation receipt wording only.

Owner approval bound finalseal12fa71a5/source and accepted secret VALUE plus
backend-bucket reads, unresolved vault policy for diagnostics only, and owner
CLI token/cache activity. That one-attempt authorization is now consumed. Applied L7
runtime/SMTP readiness remains true and apps=false from execution receipts;
historical false foundation inputs are not replayed. Diagnostics destination=null
and absent networkAcls stay OPEN. Owner reads do not prove runtime MI/SQL access,
SMTP authentication/delivery/live credential validity or logging acceptance.
SMTP's recorded expiry2027-01-27 is not a live validity test. No ARM readback,
Terraform init/PLAN/APPLY, deployment, seed, migration, rotation or recovery is
included. New candidate needs a fresh separately reviewed plan; old AP1 cannot
be used. The17 protected files and all old candidate/release/evidence remain intact.


**SV3 execution outcome.** Owner approved the final30-file packet SHA256
`12fa71a501e9f53d6e131eb7d6d0a0bb8ca7b1d2f743bdab665d664107742118`.
One invocation started2026-11-01T11:15:01Z and its runner return was observed at
11:15:05Z with exit0, recorded separately in
`/private/tmp/tonyai-l8-sv3-runner-exit.json`. Token command exit0, no stderr,
all five local claim guards true. Database/backend/bucket/SMTP GETs each returned
HTTP200 without pagination; exact versions, enabled/present validity attributes
and the unchanged source verifier passed. Result recording at11:15:05Z preceded
cleanup/promotion; no independent exact promotion timestamp is claimed.
Execution `/private/tmp/tonyai-l8-release-r003-4_h5u93k-execution` has20 original
safe receipts, frozen by `/private/tmp/tonyai-l8-sv3-original-receipts.json`
SHA256`e3d42efde007479b0edd3f9f834bc50416610c7bec03aab3c1f1c2329985aa39`.
No failure/pending/quarantine exists. Success-path cleanup removed only new work.
Original packet/source/candidate/r003,17 protected files and prior evidence stay
unchanged. Independent outcome QA/DevOps accepted the bounded diagnostic.
Node22.23.3 lint/typecheck/build/test passed on planning a947 plus three docs:
eight lint warnings/zero errors, other tasks cached; receipt
`/private/tmp/tonyai-l8-local-checks-tffb8mzt/results.json`. No local API integration,
RLS probes, full infra suite or new CI dispatch; checks precede only this final
documentation receipt wording. Final packaging QA is separate. No Terraform, deployment, seed, SMTP test, rotation or recovery followed;
findings and functional acceptance limits above remain open. Approval consumed.


**L8-AP2 prepared offline, separately approved and completed once for r003 (2026-11-01); approval consumed.**
Packet `/private/tmp/tonyai-l8-app-plan2-jz4fmiht` binds source/application
`a9476eb735cad53aa7091932dd02b38a4070cefb`, new candidatee0dcf596, r0031f2fb638
and accepted SV3 execution732463c3. The old AP1 binary remains historical evidence.
AP1 already initialized application/staging.tfstate: AP2 requires a fresh
containerHEAD200/unlocked/available and blobHEAD200/unlocked/available/BlockBlob.
BlobNotFound, a lock or another blob type stops before init. A saved plan must
embed current lineage0651b476-d998-3cd7-3cc4-662f928824cf/serial1 and empty state;
previous lineageempty/serial0 is Terraform1.13.3's intentionally metadata-free
previous-state stub, even with a persisted backend. The private state-contract
review pins backend_plan.go140–151, statemgr/plan.go23–33 and remote/state.go.
Neither historical receipt nor HEAD proves present content or unmanaged absence.

Reviewed operation: bounded ARM and Storage owner token guards, two pre-HEADs,
one remote init exit0, one locked saved PLAN exit2, one local show-json exit0,
then the same blob HEAD after strict inspection. Existing four application TF
files/config/provider lock, Terraform1.13.3/AzAPI2.6.1 local mirror and full-body
oracle are unchanged. Only exact two app creates/zero updates/destroys, known
full bodies/identities/new digests/same selected versions, empty state and no
extra drift/outputs can pass. A fresh exact-path/fileset bootstrap precedes local
imports; isolated original candidate.bind and the source/release-bound accepted
SV3 result are checked. Previous bounded process capture now also guards tokens.

Remote init/PLAN is not read-only: backend state/workspace reads, leases/lock
metadata, possible initialization after a raced deletion, independent CLI/Entra/
backend/provider authentication and internal retries may occur. An unexpected
state can enter the private saved binary BEFORE inspection rejects it. No claim
of zero transient persistence or secure erasure. No raw process output/show JSON
retained; only new private work is removed on normal failure. Unconfirmed process
cleanup or failed local cleanup leaves custody for separately approved recovery;
no force-unlock/state deletion/automatic retry. Accepted plan filename alone is
insufficient: independently observed executor exit0, matching result/hash, no
failure and successful preservation/cleanup are required. HEADs read no body.
Three direct HEADs are not a total provider/backend HTTP/authentication limit.

Corebc0f4a17 binds495 files. Thirty tests pass Python3.12/3.14, including exact
lineage/serial/content rejection, missing/locked/wrong-type precheck refusal,
full-body mutations, bounded capture, output redaction and failure custody.
The test plan is a synthetic four-field retarget of AP1's earlier real mock-derived
public shapes; it is not new Terraform/live plan evidence. No Terraform invocation
ran during this preparation. Security/QA/DevOps accepted corebc0f4a17; QA
added61 independent negative probes. Node22.23.3 lint/typecheck/build/test passed
on planning a947 plus three docs (eight lint warnings/zero errors, other tasks
cached); receipt `/private/tmp/tonyai-l8-local-checks-x9whwwbx/results.json`.
No API integration/RLS/full infra suite/new CI dispatch ran. Checks precede only
final documentation receipt wording; final packaging QA is separate. All4,653 external bindings and17 protected files remain intact.

Owner approval bound the final seal/source and accepted backend/authentication/lease
effects, transient private-plan custody and unresolved findings for PLAN only.
That one-attempt authorization has now been consumed. Diagnostics destination=null, absent
vault networkAcls and runtime MI/SQL/SMTP/log acceptance remain OPEN. Prior RBAC
and SV3 are not closure. L7 runtime/SMTP readiness=true, apps=false remains separate
from historical false inputs. No secret GET, foundation/grant change, migration,
seed, email test, rotation, drain, APPLY or deployment is included. A successful
saved PLAN is evidence for a later separately approved operation only.


**AP2 execution outcome.** The owner approved final510-file packet SHA256
`81d3074d29ca77bfd3d19dd8d25af52aca859fbfdb6e02c917f2e2ab7cbbd703` and all
three conditions. One invocation2026-11-01T11:29:07Z–11:29:18Z returned observed
executor0 (`/private/tmp/tonyai-l8-ap2-runner-exit.json`). ARM/Storage guard commands
passed; container/blob pre-HEADs returned200 unlocked/available; blob BlockBlob181
bytes. Init0, PLAN2 and show0; inspected archive retained exact current lineage/
serial1 and previous empty stub0, empty state and sealed configuration/provider
lock. Full plan inspector accepted exactly two creates/zero updates/destroys and
complete r003/new image bodies/identities/versions. Final blob HEAD200 unlocked/
available/BlockBlob181bytes. HEAD size is not content equality or app absence.

Accepted plan `/private/tmp/tonyai-l8-app-plan2-jz4fmiht-execution/accepted.tfplan`,
mode0400,10335bytes,SHA256
`9f4476ad6dddaa7d46131d1fbcf1026d6d9f929d70e835d9d532ded9373e0c92`.
Original21 receipts/artifacts frozen by
`/private/tmp/tonyai-l8-ap2-original-receipts.json`, SHA256
`9448927def47bd6bfcbaa817438a764113f1f3f0cfb2d206f98d8dd17759cdbf`.
No failure receipt or new private work remains; process and cleanup receipts pass.
Result-record time11:29:18Z is distinct from the observer's return record in the
same second, not an independently timed plan-promotion event. Independent outcome
QA/DevOps accepted the bounded saved-plan evidence, replaying archive/source/lock/
state checks locally. Full-body acceptance is supported by the reviewed executor
and original result; no second Terraform/show ran. Post-outcome Node22.23.3 lint/
typecheck/build/test passed on planning a947 plus three docs (eight lint warnings/
zero errors; other tasks cached), `/private/tmp/tonyai-l8-local-checks-o6vh2zpn/results.json`.
No API integration/RLS/full infra suite/new CI dispatch; checks precede only final
documentation receipt wording. Final packaging QA is separate. Original packet, old AP1,
candidate/release/SV3/17 inputs preserved. Approval consumed; no APPLY, deployment,
seed, SMTP test, rotation or recovery followed. Open findings remain open.


**L8-AA2 prepared offline, approved once; APPLY0 followed by incomplete readback (2026-11-01).**
Packet `/private/tmp/tonyai-l8-app-apply2-4i0jzgzh` binds source/application
`a9476eb735cad53aa7091932dd02b38a4070cefb`, AP2 packet81d3074d/executioncd179ca3,
exact plan9f4476ad6dddaa7d46131d1fbcf1026d6d9f929d70e835d9d532ded9373e0c92,
r0031f2fb638/new candidatee0dcf596/SV3 acceptance. Old AA1/AP1 remain unchanged.
No additional metadata-only approval round is required by code: fresh exact-SHA
CI/E2E/integration observations and complete successful RG app inventory belong
inside this conditional operation before any Terraform action. Null diagnostics
or absent ACL fields cannot be assumed resolved by repetition or successful RBAC.

The proposed scope is three unauthenticated workflow GETs; bounded ARM/Storage
owner token guards; one exact complete inventory GET refusing either existing
app, pagination/malformed/ambiguous responses; one remote init and local show/
full-body/snapshot inspection of the selected binary; then one exact saved-plan
APPLY with locking/stale-state checks. No new PLAN, drain, imports/adoption or
force-unlock. API show, API revisions and web show then invoke the unchanged
source deploy_apps.verify via a fixed adapter. All seven GETs are literal/order/
credential-bound, bounded4MiB/60s socket timeout, no proxy/redirect/retry and no
raw payload persistence; safe attempt/status/parse receipts distinguish failures.
App location remains exact swedencentral; the observed environment-only alias
is not generalized without evidence. Readback failure remains incomplete after
apply0; no automatic rollback/retry/recovery. No post-APPLY blob HEAD is included,
so no independent lease-release readback is claimed.

Exact full packet fileset/path is checked before local imports. The sealed AP2
modules supply bounded token capture and clean source/original candidate binding;
accepted SV3 and observed AP2 executor0 remain bound. Recheck full preflight and
copied source/config/plan bytes before APPLY and after readback. Candidate42
migration fingerprints and lockfile equal the old L6-qualified candidate; this
is offline correspondence, not a fresh cloud migration-status proof. No migration
or historical false-readiness/grant replay. apps_ready=false remains owner-bootstrap
state; future deployer grants belong to separate WP-6.

Coredae180ec binds11 files;26 tests pass each Python3.12/3.14. QA found duplicate
contradictory workflow records could tie source max selection; wrapper now refuses
duplicate IDs or run_number/run_attempt tuples before unchanged release_checks.verify.
Tests cover refusal before Azure/TF/APPLY, exact call order/credentials, sensitive
output redaction, readback failure/custody, scope and replay. Independent
Security/QA/DevOps accepted coredae180ec; QA65 additional negative scenarios and
Security31 journal failures passed. Node22.23.3 lint/typecheck/build/test passed on
planning a947 plus three docs (eight lint warnings/zero errors; other tasks cached),
`/private/tmp/tonyai-l8-local-checks-utj00j34/results.json`. No API integration,
RLS probes, full infrastructure suite or new CI dispatch ran. These checks precede
only final documentation receipt wording; final packaging QA is separate. No Terraform
or live network was invoked during preparation;5,207 external bindings and17
protected originals remain intact.

Four fresh explicit owner acceptances must name final seal/source/plan and one
attempt: (1) backend/lease/authentication effects and transient unexpected-state
custody; (2) unknown vault networkAcls for this one initial hosted QA deployment;
(3) diagnostics destination=null remains open with console/system ingestion and
table routing assessed later before QA handover; (4) public HTTPS workload startup
before later acceptance, including platform image pulls/MI secret resolution,
Prisma runtime DB connect and readiness SQL SELECT1/timeout-setting plus private
bucket metadata GETs. Cleanup hold prevents removals, not public ingress. No
operator secret GET, seed, separately invoked SQL/SMTP/email test, rotation or
fixture provisioning is included. These are scoped dispositions, not finding
closure or a production waiver. Existing gates/inventory are point-in-time;
saved-plan staleness does not prove all external resources unchanged. No fresh
comprehensive drift/grant/vault/secret-validity/image-rescan occurs. Partial APPLY
may leave billable resources/state changes. Success requires observed executor0,
valid result/no failure and independent outcome review; runtime functional/log/
SMTP/credential validity, L8/L10 completion and QA account handover remain separate.
Owner subsequently approved finalseal44ecc6c5cdfabf447499d6b86b4a55793d333e9034b4c055a5cb1dcff92146ca
and all four conditions. One execution started2026-11-01T11:48:20Z; fresh exact-SHA
CI/E2E/integration and complete absent-target inventory passed; init/show0. APPLY
started11:48:27Z, returned0, then ARM_READBACK stopped; no deployment acceptance.
Execution `/private/tmp/tonyai-l8-app-apply2-4i0jzgzh-execution` must not be replayed.
This attempt consumed the approval; no retry/recovery/seed authority follows.


**AA2 execution outcome — incomplete deployment readback.** Observer launch at
2026-11-01T11:48:19Z, attempt receipt11:48:20Z, observed executor exit1 at12:05:36Z:
17m17s wall time at recorded-second precision. Fresh exact-source main gate IDs
CI40968399879/E2E41294897048/Integration41293973321 succeeded; complete inventory
showed neither target app. ARM/Storage token guards passed. Init0/show0; saved-plan
policy accepted exact2creates/0updates/0destroys/new r003 before APPLY. APPLY
started11:48:27Z and returned0 before API readback began12:05:35Z; its exact return
timestamp was not independently recorded. Fifth GET at12:05:36Z returnedHTTP200,
no pagination, valid JSON object. No GET6/revisions or GET7/web, no arm-readback
acceptance receipt and no success result. Failure phaseARM_READBACK; exact predicate
or local interruption cause was not retained. Do not infer a location, identity,
provisioning, runtime-setting or readiness cause from this bounded evidence.

Execution `/private/tmp/tonyai-l8-app-apply2-4i0jzgzh-execution` contains36 original
safe receipts frozen by `/private/tmp/tonyai-l8-aa2-original-receipts.json`, SHA256
`56f712188e051af05a9b4dfe71ec8346797d99f1a981e36e94e364d2a4f15421`.
Observer `/private/tmp/tonyai-l8-aa2-runner-exit.json` independently records exit1.
Failure reports apply_exit_zero_observed=true, process cleanup confirmed and new
private work removed; result absent. No further cloud query, retry, rollback,
recovery or forced unlock ran. A real resource/state change may have occurred;
apply0 is not complete ARM/functional acceptance. No post-APPLY blob lease/state
readback was included. Independent QA and DevOps accepted the bounded failure evidence only. Post-attempt
Node22 lint/typecheck/build/test all exited0, with8lint warnings and the other
checks served from cache (`/private/tmp/tonyai-l8-local-checks-zuqgdpww`).
API integration/RLS/full infra/new CI dispatch were not rerun for these documentation
changes. Final evidence packaging review is separate; deployment remains unaccepted. Old candidate/release/plans/source/SV3/17 inputs stay
intact. Approval consumed; diagnostics/vault/runtimeMI/SQL/SMTP/logging acceptance
remain open. Any current-state diagnostic needs a separate reviewed live scope;
it will not reconstruct the discarded historical response or authorize recovery.


**AD1 — current API pre-revision diagnostic (prepared offline, then separately approved and collected once).**
AA2's final bounded-failure evidence is53 files, seal
`7aaab6a48d94eaa07d950df21fb3597e2bf88883a28dd13f02e01dc57dc4dcc6`;
`/private/tmp/tonyai-l8-aa2-outcome-final-review.json` accepted packaging only.
Deployment readback remains incomplete. The next packet is
`/private/tmp/tonyai-l8-api-diagnostic-pnmw3apr`.

Proposed scope: one owner ARM token (existing CLI cache may refresh), then one GET
for `tonyaiqt-staging-api` in `tonyai-qatmp-apps`, subscription
`cb7efc2f-37a7-4672-b62c-93c207bcd33d`, API version2025-01-01. Exact sourcea947,
new candidate/r003, AA2 and its failure evidence are hash/mode bound. The token
command is bounded120seconds/64KiB; GET has60second socket timeout/4MiB body cap,
no proxy/redirect/retry. Socket timeout is not a whole-operation deadline.

Only fixed HTTP/status/timestamp, adapter booleans and source refusal categories
are retained. Raw metadata may contain env or unexpected confidential fields;
it is held in memory only. No secret-value/listSecrets/log/state/lease/SQL/SMTP
read, revisions/web request, Terraform or resource mutation is included.
The unchanged AA2 adapter is replayed over the payload, retaining canonical
`swedencentral` behavior. Location `Sweden Central` has a distinct fixed enum
and still does not pass. Independently, unchanged `deploy_apps.verify` receives
only this API object through an in-memory seam; it stops before revisions at
line51. Source prefix covers topology/mail/image/DB reference/storage settings/
runtime limits/scale/resources/grace. It reports the first refusal only, including
an unclassified error category. Probes/ingress/ready revision/exact secret set
are later checks and are not accepted here. Source scale equality and last-wins
non-mail env semantics remain unchanged; this diagnostic does not strengthen
or weaken the deployment guard.

Exit0 means completed diagnostic collection only; mismatch is not deployment
acceptance. A later observation cannot prove AA2's discarded historical cause.
Exact-schema authorization, final seal/source binding, expiry within one hour
and an exclusive execution directory restrict the operation to one attempt.
No result is accepted with a failure receipt; a separately observed runner0 and
outcome review are required. Only new scratch is cleaned; uncertain subprocess
cleanup retains scratch and invalidates acceptance. Bootstrap verifies code
before local imports, then checks all external/source/tool bindings and repeats
preservation before result publication. Old private work is untouched.

33 offline tests pass on Python3.12/3.14, including source-prefix mutations,
malformed shapes, no raw-value leakage, auth/replay, HTTP/JSON boundaries and
partial publication. Independent Security/QA/DevOps accepted core
`1d9eb614c381a9a3edf91d516e3ffa64e8debb1291fd48424d2d08f7efa9c00b`.
Node22 lint/typecheck/build/test all passed in the planning worktree at sourcea947
(`/private/tmp/tonyai-l8-local-checks-72qem4fp`); lint8warnings, other tasks cached.
Checks precede final receipt-only documentation wording. API integration/RLS/full
infra/new CI dispatch were not run for this offline diagnostic/documentation scope.
Final seal QA accepted31files, final manifest
`8f1d2661afc10e5399579db6c28437fd73e904812f93f6a7efca19a6db158f26`.
Preparation itself performed no live operation; the separately approved attempt
is recorded below. Diagnostics/vault/functional/log/SMTP findings remain OPEN.


**AD1 approved execution outcome (2026-11-01).** Owner approved the exact final
seal and ARM authentication-cache activity. Observer launch12:25:30UTC,
return12:25:33UTC, executor0, invocation_count1. One token command exited0 with
all fixed claim guards true. One API metadata GET returned200/no pagination;
JSON parsed and fixed classification published with no failure/pending/quarantine.
No raw body, token, env values or arbitrary exception text was retained.

Only `canonical_location_matches` is false; `location_classification` is
`KNOWN_DISPLAY_MATCH`, the fixed enum for exact `Sweden Central`. ID/name/type/
provisioning/identity checks match. Unchanged original adapter still rejects
the display form; its guard was not widened. Independently replayed source
prefix returned `REACHED_REVISION_BOUNDARY`, using the same API object in memory.
No live revision/web request, post-revision checks or full deployment acceptance
is implied. The historical AA2 response/cause remains unavailable; this new
observation cannot retroactively identify its precise predicate or exclude a
local recording/interruption failure.

Execution `/private/tmp/tonyai-l8-api-diagnostic-pnmw3apr-execution` contains9
original safe receipts, frozen by `/private/tmp/tonyai-l8-ad1-original-receipts.json`
SHA256 `8770d0d57b423bc94858b957b1fdc7b015ec6dd1f5acf41d964aa669c98041de`.
Independent exit observation is `/private/tmp/tonyai-l8-ad1-runner-exit.json`.
Exit0 follows new-scratch removal under the reviewed executor; old private work
was not accessed. Independent QA/DevOps accepted bounded diagnostic collection
only. Post-outcome Node22 lint/typecheck/build/test all passed in the planning
worktree at sourcea947 (`/private/tmp/tonyai-l8-local-checks-xi4_6gh8`), with8lint
warnings and other tasks cached. These checks precede final receipt-only wording.
API integration/RLS/full infra/new CI dispatch were not rerun for the documentation
scope. Final evidence packaging audit is separate. Approval consumed; no additional query, guard fix, plan/apply,
retry/recovery, SMTP test, seed, commit or push followed. Diagnostics destination
null, missing vault networkAcls and functional/log acceptance remain OPEN.


**AR1 — source ARM metadata readback (prepared offline; approved once, readback incomplete).**
AD1 final outcome has26 files, seal
`c5c98447d8ae13d27ebf905ec91dd87c2b68f2414b9ba93b0401b1f028c9295f`;
independent final QA accepted diagnostic collection only. New packet:
`/private/tmp/tonyai-l8-app-readback-02jsl7yz`.

One owner ARM token acquisition, with possible CLI cache refresh, precedes at most
three ordered GETs: exact API app, API revisions list, exact web app. Subscription
`cb7efc2f-37a7-4672-b62c-93c207bcd33d`, group `tonyai-qatmp-apps`, names
`tonyaiqt-staging-api`/`tonyaiqt-staging-web`, API version2025-01-01. No fourth or
out-of-order URL, pagination follow-up, proxy, redirect or retry. Stop on refusal.
Token capture120seconds/64KiB; each body4MiB and socket timeout60seconds, not a
whole-operation deadline. CLI internal authentication activity is outside the
three direct resource GET count.

The new private seam checks the two literal app URLs and expected ID/name/type,
then shallow-copies only exact top-level `Sweden Central` to `swedencentral`.
Canonical location remains unchanged; no generic trim/case-fold/other region
alias or revision mapping. The original response stays unchanged. The same fixed
mapping explicitly covers web, whose current region AD1 did not read. Original
AA2 Readback and deploy_apps.verify remain byte-identical and enforce every other
source predicate. Source quirks remain as-is, including non-mail env/probe/secret
last-wins and replica equality; this is not an unrelated validator rewrite.

Source readback checks API/web images and prescribed settings, API active revision,
probe paths, revision modes, HTTPS origin/latestReadyRevisionName and secret
reference metadata. It does not call health endpoints or prove probe ports,
every ingress/registry/environment field, SQL, SMTP, runtime identity or logs.
Success is source ARM metadata contract acceptance across three sequential
observations with the scoped representation mapping, not an atomic snapshot or
functional/complete-configuration proof. Historical AA2 cause remains unknown.

Only fixed stage/category enums, booleans/statuses/timestamps are saved. Known
source refusals have a fixed allowlist; unknown/local failures stay generic.
Raw ARM bodies/env/secret values/tokens and arbitrary exception output are not
retained. No Key Vault/listSecrets/log/SQL/SMTP/health/GitHub/backend-state/lease
read, Terraform/drain/deployment or mutation is included. Failed/partial records
cannot be accepted; require observed runner0, complete readback, no failure/
pending/quarantine and independent outcome review. Normal completion removes only
new scratch; uncertain subprocess cleanup retains it. Old private work untouched.

Exact-schema0600 authorization binds final seal/source/operation, one attempt,
expiry within one hour and explicit ARM cache activity. Exclusive execution
directory prevents replay; pre-import bootstrap, clean-source/tool/external
checks and prepublication preservation guard the inputs. Original17 files,
immutable candidates/releases, AA2/AD1 evidence and protected worktrees stay fixed.

34 offline tests pass on Python3.12/3.14, including app canonical/display matrix,
scope-only mapping/nonmutation, wrong-region/resource and post-prefix refusals,
revision shape/pagination, read order/fourth GET, source quirks, no-value leakage,
authorization/replay and publication failure. Independent Security/QA/DevOps
accepted core `20c0981d316483dce3b6fafe9164dd212fa7f7978c1f2cb41ef1db1e1e11c0aa`.
Node22 lint/typecheck/build/test passed in the planning worktree at sourcea947
(`/private/tmp/tonyai-l8-local-checks-h8_ig63c`), lint8warnings/other tasks cached.
Checks precede final receipt-only wording. API integration/RLS/full infrastructure/
new CI dispatch were not run for this offline private-packet/documentation scope.
Final seal audit is separate. All open diagnostics/vault/functional
findings remain OPEN; no live authority, seed, commit or push.


**AR1 approved execution outcome (2026-11-01; incomplete).** Owner approved final
seal `00f2f7c4c1dfe85e87259f090f13631951f0e6dbabc15128f671609a78e1a52d`, including
one token/cache activity, three ordered reads and the exact two-app location seam.
Observer launch12:39:51UTC, return12:39:56UTC, executor1, invocation_count1.
One token command exited0 and all five claim guards were true. API/revisions/web
GETs returned200/no pagination and parsed. API and web were each classified
KNOWN_DISPLAY_MATCH and received the authorized copy-only exact mapping.

The fixed refusal receipt records stageWEB_SOURCE and category
SOURCE_SHAPE_OR_LOCAL_ERROR. Reviewed control flow reached source web validation
after completing the API checks and returning from the web adapter; this is not
whole-contract acceptance or an independent functional test. Exact exception,
field and raw response are unavailable. In particular, no specific null/missing
env, secrets, ingress or other field cause is established; local failure remains
possible. No readback, pending or quarantine result exists.

Failure records process cleanup confirmed/private_work_retained=null. Cleanup
is supported by reviewed runner control flow and failure receipts; no independent
scratch-path readback was performed. The17 original safe receipts at
`/private/tmp/tonyai-l8-app-readback-02jsl7yz-execution` are frozen by
`/private/tmp/tonyai-l8-ar1-original-receipts.json`, SHA256
`01a6bfa4ad5596418758787d1ac2fea4d18f98b72d8ef7c2bc495f22e2135e21`.
Independent exit observation: `/private/tmp/tonyai-l8-ar1-runner-exit.json`.
Raw ARM/token/process output and arbitrary exception text were not retained.

Independent QA/DevOps accepted bounded failure evidence only. Post-outcome Node22
lint/typecheck/build/test passed in the planning worktree at sourcea947
(`/private/tmp/tonyai-l8-local-checks-o4lfbnuk`), lint8warnings/other tasks cached.
Checks precede final receipt-only documentation wording. API integration/RLS/full
infrastructure/new CI dispatch were not rerun for these documentation changes.
Final evidence packaging audit is separate.
Prepared31files, external5353 bindings, immutable inputs and original17 protected
files remain fixed. Approval consumed; no further query, guard fix, retry,
recovery, Terraform, deployment, seed, commit or push followed. Diagnostics/vault
and runtime/SQL/SMTP/log acceptance remain OPEN. A later web-shape diagnostic
would need new reviewed scope/approval and cannot prove this discarded historical
response's exact failure cause.


**WD1 — current web response shape diagnostic (offline preparation, 2026-11-01).**
New private packet `/private/tmp/tonyai-l8-web-diagnostic-plo9fupi` proposes one
ARM token acquisition and one exact web Container App metadata GET with API
version 2025-01-01. The subscription/resource group/app are identical to AR1's
third target. No API/revision/Key Vault/listSecrets/SQL/SMTP/log/health request,
Terraform, deployment, recovery, mutation or retry is included. Token cache
activity requires explicit acceptance in a new exact-seal authorization.

The classifier emits only fixed field presence/type categories (including
MISSING versus NULL), bounded collection categories and TRUE/FALSE/NOT_EVALUABLE
results for independent web predicates. It does not retain response bodies,
discovered names/values, env/secret values or arbitrary exception text. Original
AR1 normalize_app and AA2 Readback are reused unchanged in memory for the exact
web target; known display location maps only on a copy after exact identity
binding. No null field is replaced by an empty collection. Original
deploy_apps.verify remains unchanged and hash-bound; the diagnostic mirrors
only its web predicates and reuses its mail helper. It does not run the full
source verifier. Synthetic API/revisions exist only in offline equivalence tests.
Independent predicates do not identify the first source failure or the discarded
historical AR1 cause. Even all TRUE predicates do not accept deployment.

The packet inherits all 5,353 AR1 external hash/mode bindings and adds AR1's
31 prepared files, 34 final evidence files, manifests, original17 receipts and
detached final QA/observer records. Initial verification matched all prior seals,
immutable candidate/release and original receipts. Bootstrap, clean-source and
prepublication preservation checks remain; exclusive execution directory, exact
0600 authorization, one-attempt expiry and no retry preserve consumed authority.
Token command deadline is 120 seconds/64 KiB; HTTP uses a 60-second socket timeout
(not a total elapsed deadline) and 4 MiB cap, no proxy/redirect/pagination, and
rejects duplicate JSON keys/nonstandard numeric constants. Cleanup affects only
new scratch; uncertain process cleanup fails and retains that scratch.

36 offline tests pass on Python 3.12 and 3.14. Independent Security/QA/DevOps
accepted core `1a0c87bd18dd7bf86dc0374cb2abf4cfae01c062e4b6781399de4986f9bceb41`.
QA independently passed 328 source-parity/nonleak cases, 8 partial-write faults,
12 claim refusals and 3 local process checks; Security passed 330 synthetic probes.
Node22.23.3 lint/typecheck/build/test all exit0 at source `a9476eb` in the planning
worktree; logs/results `/private/tmp/tonyai-l8-wd1-local-checks-1j5dx4ix`. Lint has
8 warnings; typecheck/build/test are cached. Checks precede final receipt-only
documentation wording. API integration/RLS, full infra tests and CI dispatch
were not rerun for this private packet and documentation-only scope. Final
sealed packaging audit is detached at `/private/tmp/tonyai-wd1-final-qa.json`;
its acceptance is required before asking for the single new live approval. Diagnostics destination=null and absent vault
networkAcls remain OPEN. Runtime MI secret access, SQL, SMTP authentication and
delivery, workload logs and actual HTTP readiness remain unaccepted. The recorded
SMTP expiry is 2027-01-27, not live validity proof. L9 users/invitations and L10
smoke/tenant-role/locks-audit/evidence/TR-EN/monitoring/backup-recovery/handover
remain later operations. No authoritative factors means no numerical-emissions
QA acceptance. No seed, paused self-hosted operation, commit or push.


**WD1 approved execution outcome (2026-11-01; diagnostic collection only).**
Owner explicitly approved final packet seal
`854941ccd925ead3c8b21ccd0c0add6fe77d87cf9bb13dcd3d9d6b5df3486a9b`, including
ARM token-cache activity. Preflight and final-QA binding were rechecked offline.
One invocation was independently observed at 14:41:33–14:41:37 UTC, runner exit0.
The token command exited0, all five claim guards were true, and exactly one fixed
web metadata GET returned200 without pagination and parsed. No response body,
env/secret values, raw token/process output or arbitrary exception was retained.

The current response classified `configuration.secrets` as NULL and its
collection category as NOT_ARRAY. The mirrored empty-web-secret-set predicate is
NOT_EVALUABLE; the other seven independent web predicates are TRUE. All six
adapter predicates are TRUE; unchanged AR1 web adapter result MATCH, location
KNOWN_DISPLAY_MATCH with the unchanged exact-resource copy-only mapping. The
original complete deploy_apps.verify was not invoked. This does not establish
the discarded AR1 response or exact historical exception; no null-to-empty fix,
source-guard change, deployment acceptance or full configuration proof follows.

Nine original safe receipts in
`/private/tmp/tonyai-l8-web-diagnostic-plo9fupi-execution` are frozen by
`/private/tmp/tonyai-l8-wd1-original-receipts.json`, SHA256
`3df82b33d65427e7047280af73a1263e2934d169c0f6cf84401c282de4101954`.
Independent observer `/private/tmp/tonyai-l8-wd1-runner-exit.json` records one
invocation and exit0; exact authorization matches the attempt's canonical hash.
Classification completion and published diagnostic exist, with no failure,
pending or quarantined diagnostic. Successful runner control flow removes its
new scratch before publication; no independent scratch-path inspection is claimed.
Prepared packet, all5423external bindings, original AR1 receipts, protected17
historical inputs, candidates/releases and source trees remain unchanged.

Independent QA/DevOps accepted bounded current diagnostic collection only.
Post-outcome Node22.23.3 lint/typecheck/build/test passed in the planning worktree
at source `a9476eb`; logs/results `/private/tmp/tonyai-l8-wd1-outcome-checks-k8c932lj`.
Lint has8warnings/0errors; typecheck/build/test are cached. These checks precede
final receipt-only wording. API integration/RLS, full infra and new CI dispatch
were not rerun for documentation-only updates. Final evidence packaging audit is
detached at `/private/tmp/tonyai-wd1-outcome-final-review.json`.
Approval is consumed; no extra query, retry, repair, PLAN/APPLY, deployment,
recovery, SMTP test, email, rotation, seed, paused self-hosted operation, commit
or push followed. Diagnostics destination=null and absent vault networkAcls
remain OPEN. Actual HTTP readiness, runtime MI secret access, SQL, SMTP
authentication/delivery and workload logs remain unaccepted. Any later exact
web-null representation handling starts with separate offline design, negative
tests and independent review; any live operation needs a new exact approval.


**LC1 — combined L8 deployment/dependency acceptance (offline preparation, 2026-11-01).**
The owner requested faster L8 closure. AA2's successful APPLY is preserved; no
rebuild, redeployment or replay is planned. New private packet
`/private/tmp/tonyai-l8-closure-ppompehe` prepares a single exact operation rather
than another diagnostic-only approval round. It inherits WD1's entire evidence
chain and binds its approved outcome; old packets and protected inputs stay fixed.

One guarded ARM token precedes ten fixed sequential requests: API GET, API
revisions GET, web GET, exact web listSecrets POST (all API2025-01-01), then
public API liveness/readiness, web login, unauthenticated subsidiaries and allowed/
untrusted CORS OPTIONS. Public URLs derive from the immutable release; ARM bearer
never goes to them. No redirects, proxies, pagination or retry; fail at first
unaccepted check. No API listSecrets, Key Vault read, direct owner SQL, SMTP,
logs query, Terraform/state/lease/deploy/recovery, seed or onboarding operation.

The [GET contract](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/get?view=rest-resource-manager-containerapps-2025-01-01)
describes a secrets array and does not prove null equivalence. The separate
[listSecrets contract](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/list-secrets?view=rest-resource-manager-containerapps-2025-01-01)
is a POST read action whose collection entries may include secret values. LC1
requires exactly an explicit empty value array, independently of web GET shape.
Only exact-resource/identity-bound web NULL or empty-array inputs are allowed;
NULL becomes[] on a nested copy only after empty inventory confirmation and no
web env secretRef. Missing/other/nonempty forms fail. API null is never mapped.
Unexpected listed values exist in memory only, never output or persistence, and
prevent progress. Original deploy_apps.verify, AA2 Readback and AR1 location
mapping remain unchanged; the complete source verifier runs through that adapter.

Readiness can perform runtime SQL SELECT1/transaction timeout configuration and
three authenticated Supabase private-bucket metadata GETs, or return a five-second
cached result. Public requests may wake workloads and emit routine logs. These
effects, token-cache activity, possible unexpected listSecrets values in memory
and retaining existing open findings are four separate explicit acceptances in
the one final-seal-bound authorization. No credential value is requested from
the owner. One exclusive execution directory prevents replay. Normal publication
requires cleanup, preservation, all ten requests complete, independently observed
runner0 and separate outcome review; original results never change.

L8's go/no-go remains findings assessed, SV3 exact-secret evidence accepted
separately, exact deployed revisions and dependency readiness evidenced. A
successful LC1 may close that controlled-QA deployment/dependency milestone under
explicit outstanding-finding dispositions. It cannot prove current SQL identity/
full privileges, fresh MI vault access, SMTP validity/delivery, log ingestion,
complete configuration equality or historical AR1 cause. Diagnostics destination
null and missing vault networkAcls stay OPEN. L9 users/invites/email arrival and
L10 tenant/role/lifecycle/export/TR-EN/storage/logging/monitoring/backup/recovery/
QA handover remain required. This is no production waiver or numerical factor QA.

41 offline tests pass on Python3.12/3.14. Independent Security/QA/DevOps accepted
corrected core `f8234544acd5c4988c47709a48dfc0c89a3196c8ae874a3719f6643794514ac3`; only descriptive
location-scope wording changed after the initial reviews, with delta verification.
QA added68independent probes, Security6 and DevOps9. Node22.23.3 lint/typecheck/
build/test all exit0 in the planning worktree at sourcea947; logs/results
`/private/tmp/tonyai-l8-lc1-local-checks-xdy8mqpj`. Lint8warnings/0errors;
typecheck/build/test cached. Final receipt-only wording follows checks. API
integration/RLS/fullinfra/CI dispatch were not rerun for privatepacket/docs-only
scope. Final sealed packaging QA is detached at `/private/tmp/tonyai-lc1-final-qa.json`;
its acceptance precedes the exact live approval request. No new live authorization,
cloud call, source guard change, commit or push has occurred.


**LC1 approved execution outcome (2026-11-01; failed before public checks).**
Owner approved seal69e6011d0467d9260efc73f41a28643edfc814a4b7b6852aacbb14674ba8dde0
and all four effects/dispositions. One observer invocation at 15:34:11–15:34:20 UTC
returned1. Token0/allfiveclaims true; API/revisions/web metadata GETs each200
and parsed; both exact display-location copies were mapped. The fourth request,
exact web listSecrets POST, returned415. Its body was not read/parsed; no
empty-inventory proof, null conversion, complete source metadata or public
acceptance check exists. Refusal WEB_READ_ADAPTER_OR_INVENTORY has a generic
READ_SHAPE_OR_SOURCE_REFUSAL category. Failure phase ARM_AND_HTTP_ACCEPTANCE
records process_cleanup_confirmed=true and private_work_retained=null; cleanup
claim follows receipt/control flow, not independent scratch inspection.

Nineteen original safe receipts in
`/private/tmp/tonyai-l8-closure-ppompehe-execution` are frozen by
`/private/tmp/tonyai-l8-lc1-original-receipts.json`, SHA256
`3f4bf741045dd6eb18b19620396c78d375ebe88d116be2fcd88b86d24f62934f`.
Observer `/private/tmp/tonyai-l8-lc1-runner-exit.json` records one invocation/exit1.
Independent QA/DevOps accepted bounded failure evidence only, with prepared35,
external5491, candidate/source and old protected inputs unchanged. Final failure
packaging will be audited with the successor's final custody review.

A no-network probe `/private/tmp/tonyai-lc1-post-wire-diagnostic.json` traversed
real urllib HTTPS request preprocessing and intercepted the request before any
connection. It observed POST, Content-Length0, empty body, exact fixed target
and implicit Content-Type application/x-www-form-urlencoded. LC1's source omitted
that header, and the earlier mocked-opener tests bypassed urllib preprocessing.
This proves a local transport defect, not the discarded server error detail.
LC2 preparation sets explicit application/json for only this POST and adds
real-preprocessing regression tests. Scope, empty inventory requirement, source
guards and the four explicit owner acceptances stay unchanged.

No retry, extra query, repair of cloud state, deployment, seed, commit or push
followed. L8 remains unaccepted; diagnostics/vault and L9/L10 gates remain OPEN.
Fresh local checks and final receipt wording will be recorded with LC2 preparation;
previous LC1 checks remain historical evidence and did not cover this wire defect.


**LC2 — exact POST media-type correction (offline preparation, 2026-11-01).**
New `/private/tmp/tonyai-l8-closure2-ev4fytf5` changes only the sole web listSecrets
POST's explicit Content-Type to application/json. Body remains empty. Operation/
authorization paths are new; custody adds LC1's consumed failure history. All ten
request targets/order, token bounds, public bearer exclusion, source checks,
independent empty-secret inventory, null-copy conditions and four explicit owner
acceptances are unchanged. No retry is performed during preparation.

LC1 failure execution is sealed at
`852188a3e0f782590824361255ec4ae6ca51e701df97f83c5a62784871ed8857`,37files
excluding manifest; all original19receipts remain frozen. Its QA/DevOps reviews
accept failure evidence only. LC2 inherits5491external bindings and adds77
predecessor evidence bindings, total5568. Final LC2 custody QA must also audit
this exact sealed failure package; no later documentation rewrites its snapshots.

Two new regression tests traverse real urllib HTTPS request preprocessing with
synthetic handlers and denied sockets: all ten requests pass with explicit JSON
POST media type and no public bearer; deliberately removing that header restores
form encoding, produces synthetic415 and stops before parsing/public requests.
Together with41existing tests,43pass. No simulated result is Azure acceptance.
The real LC1 server error detail remains unavailable; the local media-type defect
is independently reproduced, not a reconstructed historical AR1 cause.

Independent Security/QA/DevOps accepted core
`bdc078e87995f6d14336077082820d20d1b552b4515f8af6d44419500af0e93a`;43tests pass on bothPythonversions.
Security65independent probes, QA3real-urllib probes, DevOps2wirecases and26auth
negatives passed. Node22.23.3 lint/typecheck/build/test all exit0 in the planning
worktree at sourcea947; logs/results `/private/tmp/tonyai-l8-lc2-local-checks-ct6_28jb`.
Lint8warnings/0errors; typecheck/build/test cached. Final receipt-only wording
follows checks. API integration/RLS/fullinfra/CI were not rerun for this private
packet/documentation scope. Final LC2 and LC1-failure custody audit is detached
at `/private/tmp/tonyai-lc2-final-qa.json` and precedes a new exact approval.
L8 remains unaccepted. No further cloud query, deployment, seed, source-guard
change, commit or push.


**LC2 APPROVED ONCE; STOPPED AT WEB LOGIN WITHOUT A RESPONSE (LP2-HQ; `a9476eb`; 2026-11-01).** Exact prepared seal `2efead75b85e62170e181a75c541efde9b5d038bf1a1aa27e7d2647d65c458e4`, all four owner acceptances, one observer invocation 15:52:47–15:53:09 UTC, exit 1. Token exit 0 and five claim guards passed. First six requests returned 200 and parsed: API/revisions/web, exact empty web secret inventory, liveness and readiness. Original source metadata and dependency checks reached accepted intermediate receipts. Request 7 (`/login`) has an attempt but no response receipt; requests 8–10 never ran. No final readback exists; overall L8 acceptance remains incomplete. Exact network error was not recorded; the 15-second interval does not prove timeout or cold start. Cleanup recorded true/null, no independent scratch inspection. All 31 original receipts are frozen by manifest `80fb823aec18b40e019759c1b70190453d2deff4425190a3ef82022394102710`. Approval is consumed. LC3 will preserve all ten checks with public socket timeout 60 seconds and bounded safe error categories; no retry or cloud repair is authorized.

Evidence: `/private/tmp/tonyai-l8-closure2-ev4fytf5-execution`, detached original manifest `/private/tmp/tonyai-l8-lc2-original-receipts.json`, observer `/private/tmp/tonyai-l8-lc2-runner-exit.json`. Independent failure reviews and final sealed custody audit precede successor approval. No extra query, deployment, seed, commit or push followed. Diagnostics destination=null and absent vault networkAcls remain OPEN; no SMTP/email, fresh MI vault read, current SQL-identity proof or QA handover is claimed.


**LC3 prepared offline (2026-11-01; no live authority).** Packet
`/private/tmp/tonyai-l8-closure3-jyxpjtrx`, core
`b7df73c4eb37a92da5034f0782a62f2c3cb54b5d654eddc14c601a7ee484ee5e`. Same one ARM token, ten exact
requests/order and four owner acceptances. Explicit application/json on the
empty-body web inventory POST is retained. Public socket timeout changes15→60
seconds; it is not a total-operation deadline. On failure, best-effort receipts
record literal stage/category only: type-only timeout/TLS/DNS/connection/URL/
JSON-or-encoding/IO/acceptance classification, no raw error text, body, headers,
URLs or secrets. Diagnostic publication failure still refuses. All ten checks
must complete with an observed executor0, preservation and independent outcome
review; LC2 intermediate successes do not bypass any check. No retry is added.

48 offline tests pass on Python3.12/3.14. The new tests distinguish response
receipt IO failure from transport timeout, cover nested URLError categories and
no-stringification, reject changed timeout bounds, and retain full LC2 real
urllib preprocessing and secret/guard regression coverage. LC2 original31 and
final47 receipts remain immutable under seal
`3dfa3714efe31ce5bcb76e2e0aa85419c27d81ede12857e7a79e14abcc4a69f1`;
QA/DevOps accepted bounded failure evidence only. LC3 binds5654external files.
Independent Security/QA/DevOps accepted the exact core. Node22.23.3 lint,
typecheck, build and test all exit0 in the planning worktree at `a9476eb`;
logs `/private/tmp/tonyai-l8-lc3-local-checks-ma3rqxkk`. Lint8warnings/0errors;
other tasks cached. Final receipt-only wording follows checks. API integration,
RLS probes, fullinfra and CI were not run for this privatepacket/docs-only delta.
The final sealed LC3 and LC2-failure custody audit is detached at
`/private/tmp/tonyai-lc3-final-qa.json` and must pass before fresh approval.
L8 remains incomplete; no fresh approval, token, HTTP request, deployment, seed,
SMTP/email, source-guard change, commit or push occurred during preparation.


**LC3 APPROVED ONCE; LOGIN HTTP200 REFUSED FOR LINK PRESENCE (LP2-HQ; `a9476eb`; 2026-11-01).** Exact prepared seal `c72e71100ea90820aa9895a9e8ed3f37dd4c330893df74e3f815e315650b8b28`, four owner acceptances, one observer invocation 16:13:08–16:13:39 UTC, exit1. Token0/five claim guards passed. Seven requests returned200; the first six parsed and source metadata, independent empty inventory, liveness and readiness passed intermediate checks. Login returned200 with a nonempty Link header; the blanket no-Link predicate refused at STATUS_CHECK/ACCEPTANCE_REFUSAL. Its actual Link value was not retained: preload, pagination or another relation is not established. HTML body/content-type acceptance was not reached; requests8–10 and finalreadback are absent. Original33 receipts frozen by manifest `c4552173b897ac4b3786625697b87de27b1821345ca60f594930719bf136ef68`; cleanup recorded true/null. Approval consumed, no retry. Prepare a narrow LC4 login-header correction with all ten checks/sourceguards preserved; L8 remains incomplete.

Evidence: `/private/tmp/tonyai-l8-closure3-jyxpjtrx-execution`, original manifest `/private/tmp/tonyai-l8-lc3-original-receipts.json`, observer `/private/tmp/tonyai-l8-lc3-runner-exit.json`. Independent outcome reviews and sealed custody audit follow. LC4 must preserve ARM and other public Link guards, exact targets, no traversal/redirect/retry, original metadata verifier and all four owner dispositions. No historical timeout cause is proved by this new200 response. No extra live query, redeployment, seed, email, commit or push followed.


**LC4 prepared offline (2026-11-01; no live authority).** Packet
`/private/tmp/tonyai-l8-closure4-4y2qbo96`, core
`c476f510902d8da89266f2ae939de1b068f4eff15013b882a6eb12ba4ed5d6fa`. The only changed acceptance
predicate ignores Link presence for the fixed login target. That check still
requires200/text-html, does not consume HTML and never traverses Link. Each of
the other nine requests still refuses Link presence. New response receipts use
link_header_present, without inferring its relation; old receipts are immutable.
Same ten targets/order, one ARM token, four acceptances,60second public socket
timeout and unchanged metadata/source verifier. No retry or mutation is added.

Read-only source investigation confirms HTML can legitimately carry Link: a947
apps/web/app/layout.tsx uses next/font; installed Next16.2.0 forwards React headers
and React safelyEmitEarlyPreloads constructs preload/preconnect Link values.
This supports the general correction, not a claim about the discarded LC3
header. All ten checks and independent outcome review remain required.

51 offline tests pass on Python3.12/3.14. The real urllib full-ten flow now
includes a hostile rel=next Link on login without following it. Dedicated cases
cover arbitrary/multiple Link, wrongstatus/contenttype, and refusal on every
other target. LC3 original33 and final49 failure evidence stays sealed
`d5089562dc911c7cc0e5b786a0e67f5a030a813bc33bd456ee4d09fe17314682`;
QA/DevOps accepted failure evidence only. LC4 binds5742external files.
Independent Security/QA/DevOps accepted the exact core. Node22.23.3 lint/typecheck/build/test exit0 in the planning worktree at `a9476eb`; logs `/private/tmp/tonyai-l8-lc4-local-checks-n7qogidp`, lint8warnings and other tasks cached. Final receipt-only wording follows checks. Final sealed LC4/LC3-failure audit is detached at `/private/tmp/tonyai-lc4-final-qa.json` before fresh approval.
API integration/RLS/fullinfra/CI were not run for this privatepacket/docs-only
delta; local checks do not establish live acceptance.
No new approval or live request, deployment, SMTP/email, seed, commit or push.
L8 remains incomplete; open findings and L9/L10 remain separate obligations.


**L8 COMPLETE — LC4 APPROVED ONCE AND ACCEPTED (LP2-HQ; `a9476eb`; 2026-11-01).** Exact prepared seal `8bc422578ba6e9576e6532c98fcaf0c25ded1a75c23d683932ab638ec0eadf30`, four owner acceptances, one observed invocation 16:25:39–16:26:09 UTC, exit0. All ten direct requests passed: seven200 responses, unauthenticated tenant route401 and allowed/untrusted-origin preflights204. Unchanged source verifier accepted exact deployed release metadata; independent empty web inventory, liveness, dependency readiness and login200/text-html passed. Login Link was ignored without body consumption/traversal. Readiness evidences runtime SQL and three private buckets, possibly using its five-second cache. Original47 receipts frozen by manifest `f8f98ca58814da15735ddcb05de7d8bb42bdefcab215cfe3b78d75b62af3a8cb`; readback-complete/result exist, no failure/pending/quarantine. Independent QA/DevOps outcome acceptance plus previously accepted SV3/L6 evidence closes the controlled synthetic-QA L8 deployment/dependency milestone. Diagnostics destination=null and missing vault networkAcls stay OPEN under the approved disposition; no fresh MI vault access, full SQL privilege check, SMTP delivery/validity, log acceptance, L9/L10, numerical-emissions QA or QA handover is claimed. Final sealed outcome audit is detached at `/private/tmp/tonyai-lc4-outcome-final-qa.json`. Node22.23.3 outcome lint/typecheck/build/test exit0 in the planning worktree at `a9476eb`, logs `/private/tmp/tonyai-l8-lc4-outcome-checks-0vu_teac`; lint8warnings, other tasks cached. Final receipt-only wording follows checks; API integration/RLS/fullinfra/CI not rerun for this documentation-only outcome. No deployment, retry, seed, commit or push.

**Accepted evidence and remaining scope.** LC4 execution is
`/private/tmp/tonyai-l8-closure4-4y2qbo96-execution`; originalmanifest
`/private/tmp/tonyai-l8-lc4-original-receipts.json`, observer
`/private/tmp/tonyai-l8-lc4-runner-exit.json`. Seven200/401/204/204 receipts and
all positive checks are complete; no unexpected response values were persisted.
The ten requests are sequential, not an atomic snapshot. The successful runner
performed final source/external custody checks and removed only its own scratch
before result promotion; cleanup is control-flow evidence, not independent
scratch forensics. Historical foundation apps_ready=false flags and all old
immutable inputs remain unchanged; they are not the current app checkpoint.

Independent outcome reviews are `/private/tmp/tonyai-lc4-outcome-qa.json` and
`/private/tmp/tonyai-lc4-outcome-devops.json`. Final sealed outcome packaging audit
is `/private/tmp/tonyai-lc4-outcome-final-qa.json`. Exact selected candidate/release
remain unchanged; no APPLY, redeploy, seed, email, Git commit or push ran.
L8 closure does not close wider G2 or authorize L9; prepare its synthetic holding,
first super_admin and individual role invitations offline, then obtain exact
owner approval. SMTP expiry2027-01-27 remains recorded metadata, not live
credential proof. L10 acceptance and authoritative factor release remain required.


**L9 STAGED OFFLINE; A0 CORE REVIEW ACCEPTED (LP2-HQ; `a9476eb`; 2026-11-01).** Private packet `/private/tmp/tonyai-l9-offline-hm6f5rhj` binds the owner-selected synthetic holding, five individual TR accounts, one subsidiary and a distinct disposable Auth-test address; recipients remain private. L8 seals, 69 execution files/original47, 5742 external bindings and 1316 source files match; three starting documents match LC4. Source inspection separates live dry-run DB reads, partial provisioning, SMTP submission and inbox acceptance. Proposed first operation A0 is read-only: eight exact Auth policy/settings/JWKS GETs plus one strict-TLS owner collation SQL session; any would-be PATCH is refused. No users or mail. Ban/refresh, first-admin provisioning, four invitations and later TR/EN lifecycle acceptance remain gated separately. Existing onboarding/mail unit suites60 pass; packet13 offline test methods pass. Security/QA/DevOps accepted the corrected A0 core (email column/default collation binding, locale/version evidence, isolated source-only launch, runtime/CA seals and explicit TLS/GSS setting). Node22.23.3 lint/typecheck/build/test exit0 in the planning worktree at a9476eb; lint8warnings, typecheck0/6cached, build2/4cached, test2/6cached. API integration/RLS/fullinfra/CI not rerun: no application/API/infra source changed. Final receipt-only wording follows these checks. Detached final seal audit must pass before approval. A1–A3 are source recipes, not accepted execution adapters; L9 as a whole remains incomplete. No cloud operation, seed, commit or push.

**2026-11-01 — L9 owner inputs and read-only prerequisite boundary.** The owner supplied a synthetic TR/TRY holding, five distinct individual TR accounts, a data-entry subsidiary and a sixth address solely for the hosted Auth probe; this supplies targets, not live approval. Preserve the QA holding for ongoing testing. Runbook04 temporary lifecycle rehearsal/retirement and EN email acceptance remain separate L10 work. A0 checks existing Auth policy twice with PATCH refused and reads ICU/Unicode collation under strict-TLS owner identity; it cannot create users, send email, reconcile drift or inherit any consumed L8 approval. A0 success does not authorize the later mutation stages. Do not use exit0, delivered=true, HTTP202 or the set-password screen alone as recipient/lifecycle acceptance.

The packet retains the exact r003/candidate-r002 target from LC4. L4 completed-journal and public policy evidence was recovered offline, but does not prove hosted ICU/Unicode or born-banned/refresh-AMR acceptance. A0 leaves Auth settings unchanged even on drift (STOP). It needs hidden owner Management token, publishable key and owner session URL; no Key Vault or Azure token operation. A1/A2/A3 are source-bound recipes awaiting prerequisite outcomes and their own final execution adapters/reviews/approvals. SMTP credential expiry metadata is not validity proof; invitation submission is not inbox delivery. L10 retains separate temporary acceptance identities, TR/EN recovery and retirement, monitoring/recovery and handover.


**L9-A0 STOPPED; A0R1 CORE REVIEW ACCEPTED (LP2-HQ; `a9476eb`; 2026-11-01).** The owner ran the approved A0 packet `6ca91d8d46af7311b82bd672a2397b57d1992f558b60b2de4236a47bc9c0a98e` and reported both STOP lines. Only attempt/failure receipts exist; no result. Exact failed stage, completed GET count and SQL invocation are unrecorded; process exit was not independently observed. The owner corrected an earlier assertion and reported pasting a wrong secret; this is a declaration, not recovered cause proof. Original two receipts are preserved by `/private/tmp/tonyai-l9-a0-original-receipts.json` (seal `9d6a53ddad9ae1b709e077315bcd97581f89aad5c35102debec5ac0de66371b0`). Original approval consumed. A separately requested single retry is prepared in `/private/tmp/tonyai-l9-a0r1-0bd_pq2g`: same8GETs/1read-onlySQL, new exclusive attempt, safe phase/status/counter receipts and correct propagation of inner SystemExit instead of misleading bootstrap failure. All source/TLS/runtime/acceptance guards preserved.13base+7diagnostic test methods pass offline; Security/QA/DevOps accepted the corrected core without blockers. Node22.23.3 lint/typecheck/build/test exit0 in the planning worktree at a9476eb (lint8warnings; typecheck6/6cached, build4/4cached, test6/6cached); private logs are in the A0R1 packet. No API integration/RLS/fullinfra/CI rerun: application/infra source unchanged. Final receipt wording follows checks; detached sealed QA audit must pass before the requested retry command is handed over. No new cloud operation, user/email mutation, seed, commit or push. L8 remains closed and L9 incomplete.

**2026-11-01 — A0 failure does not establish a bootstrap or credential cause.** The outer launcher caught the inner SystemExit and printed a misleading second STOP, reproduced offline with zero network calls. Existing failure evidence identifies no operation stage. The owner subsequently reported a wrong secret and requested another attempt. Preserve the failed packet/receipts and request history; create A0R1 with the same live scope and acceptance predicates, safe diagnostic enums only, and a fresh exclusive marker. Never store credential values, raw exceptions or provider responses; local entered/completed counters do not prove what a remote service received. This retry request does not authorize later L9 stages or automatic repeats.


**A0R1 ACCEPTED; A1 PREPARED OFFLINE (LP2-HQ; `a9476eb`; 2026-11-01).** Owner-reported PASS is backed by the unchanged A0R1 seal `139050fd0fa33c007f8bc06189441b834b9c907d940ebebbb4664b146c65bd57` and attempt/checkpoint/result receipts:8HTTP JSON responses,2accepted Auth rounds (4management/2settings/2JWKS,0PATCH),SQLexit0,PostgreSQL17 owner identity and default-email ICU en-US/153.121 collation with3true Unicode probes. Completed17:20:43UTC; overall process exit was not independently observed. Original3success receipts sealed at `/private/tmp/tonyai-l9-a0r1-original-success-receipts.json` (`05615114a0856bbe4f7d351fb442dd683f30c87903d7adb41db66aa81bc02fd8`); independent QA/DevOps outcome reviews accepted only Auth/collation prerequisites. Approval consumed. New private A1 packet `/private/tmp/tonyai-l9-a1-hptm_mwu` proposes one disposable Auth-only identity on the owner-provided probe address, born-banned/sign-in refusal/unban/two-refresh AMR and mandatory exact-returned-ID deletion+absence (maximum9requests). No tenant/profile/SQL/invite/mail call. SDK2.108.2 manual refresh retries are contained by a one-dispatch phase adapter; secret-safe receipts and120second cleanup grace.Six real-SDK mock test methods and four supervisor methods pass offline; Security/QA/DevOps accepted the corrected core, with QA independently exercising65additional probes. Timestamp-overflow and cleanup-grace findings are closed. Node22.23.3 lint/typecheck/build/test all exit0 in the planning worktree at `a9476eb`; lint8warnings, Turbo typecheck6/6,build4/4,test6/6cached, with the e2e TypeScript check also executed. Logs are in the private packet repository-checks directory. API integration/RLS/fullinfra/CI were not run for this private packet and documentation work; no application/infra source changes. Final receipt-only wording follows checks; final seal acceptance is tracked separately at `/private/tmp/tonyai-l9-a1-final-qa.json`; fresh explicit A1 approval is required. No A1 execution or authority; L9 onboarding/SMTP and L10 remain incomplete.

**2026-11-01 — A0R1 closes only Auth/collation; A1 must contain SDK retries and cleanup.** Accepted A0R1 evidence proves unchanged hosted Auth policy and effective default-email ICU/Unicode compatibility, not born-banned or AMR behavior. The exact installed SDK retries explicit refresh on network/5xx even with autoRefreshToken=false, reproduced with mocked fetch and zero network calls. A1 therefore uses a fresh sessionless public client for each refresh, a per-phase one-dispatch transport adapter, nonretryable synthetic failure plus an independent failed flag, exact body/key/URL controls and bounded secret-free receipts. Creation is never adopted on email collision/lost response; only the successfully returned matching identity may be cleaned up. A1 success requires the ban and AMR proofs plus acknowledged exact-ID deletion and404absence, with a child exit observation. New explicit owner approval must cover that create/update/delete scope and finally cleanup; A0R1 success grants none.


**A1 ACCEPTED; A2P1 PREPARED OFFLINE (LP2-HQ; `a9476eb`; 2026-11-01).** The owner approved one A1 attempt at sealed packet `0fe09efb899e2bfe91b867da6758dfae3905e52c9f395d4ee490ee125654e675`; recorded17:58:56–17:59:40UTC, childexit0, no interruption/forced termination. Nine expected responses [200,200,400,200,200,200,200,200,404] support future-ban/user_banned/no-session, two advancing refresh iat values with stable earliestAMR/session/guardMs, acknowledged exact-ID deletion and confirmed absence; cleanup_pending=false. Overall shell exit remains owner-reported. Original25receipts frozen by `/private/tmp/tonyai-l9-a1-original-success-receipts.json` (`6b94b36193b5ba64a733fecfbfede806fb38fd37c9cc361df5919cbcc48c3737`); detached QA/DevOps outcome reviews accept only this Auth probe and cleanup. No QA-team onboarding or email was requested; no subsequent live query. Approval consumed. New private `/private/tmp/tonyai-l9-a2p1-yjkrsj0f` proposes one psql REPEATABLE READ READ ONLY transaction, ten fixed owner/absence booleans and ROLLBACK: first-admin profile/Auth-email and exact holding-name collision checks, no HTTP/mutation/email. It is not the onboarding CLI dry run or a reservation; future apply must recheck and refuse existing-profile resend. Ten offline mocked test methods and43independent QA probes pass; Security/QA/DevOps accepted the corrected core. The RLS visibility refusal and fully qualified catalog relation/type guards close the review findings. Node22.23.3 lint/typecheck/build/test exit0 in the planning worktree at `a9476eb`; lint8warnings, Turbo typecheck6/6,build4/4,test6/6cached and the e2e TypeScript check executed. Logs are under the new private packet repository-checks directory. Final receipt-only wording follows those checks; no API integration/RLS/fullinfra/CI rerun because application/infra source is unchanged. Detached final packaging acceptance is recorded separately at `/private/tmp/tonyai-l9-a2p1-final-qa.json`; no A2P1 execution or authority. L9 onboarding/SMTP, L10 and QA handover remain open.

**2026-11-01 — First-admin preflight must not be mistaken for creation authority.** Read-only source exploration verified that OnboardingOperator.provision is retry-friendly: a pre-existing same-email/same-legal-name super_admin with a sent invitation can be resent; organisation legalName is not unique; an Auth-only email collision is detected after the public transaction. A2P1 therefore inspects exact selected targets and all-public-table owner qualification before the apply adapter is finalized. Its ten-boolean REPEATABLE READ READ ONLY snapshot includes auth.users exact normalized equality and does not expose identities. The independent QA visibility finding is closed by row_security=off in session startup and SET LOCAL: queries that would apply RLS must fail, including unexpected FORCE cases; this does not bypass or change any policy. A tenth predicate confirms the refusal setting, and catalog relations are schema-qualified against temporary-schema shadowing. It is neither pnpm onboarding dry-run proof nor a reservation. Future apply must repeat checks and reject an existing profile before the resend branch; serialize owner operations and retain partial failure state without automatic resend/reconcile/deletion. SMTP submission, inbox delivery and the deployed API mail path remain distinct evidence.


**A2P1 ACCEPTED; A2 FIRST-ADMIN PACKET PREPARED OFFLINE (LP2-HQ; `a9476eb`; 2026-11-01).** One approved A2P1 attempt recorded18:52:36–18:53:23UTC (including hidden input), one completed SQL process exit0 and all10owner/read-only/unfiltered/collision predicates true. No HTTP/write/email; this is not a CLI dry run or reservation. Overall shell exit remains owner-reported. Original4receipts are frozen by `/private/tmp/tonyai-l9-a2p1-original-success-receipts.json` (`8505c1e2c77cd8a7a2b79785d76e7467df0bc7fe7daa67610155c664b9f1ebc8`); independent QA/DevOps outcome reviews accept only the snapshot. Approval consumed. New `/private/tmp/tonyai-l9-a2-k7n7c0qt` prepares the unchanged source operator/classes in a private fresh TSC/Prisma build: real dry-run, repeated read-only preflight, create-only Prisma extension, one persistent QA organisation/first-admin/invitation with two business audits, at most3guarded Auth requests and1SMTP send, then13boolean exact-ID readback. No other role, grant, reset, delete or automatic retry.12Node tests (11actual-source/mockSDK +1generated-Prisma extension with fake engine),4supervisor methods and64independent QA negative probes pass; Security/QA/DevOps accept the core. Both SQL queries also executed successfully in the existing local Supabase PostgreSQL read-only transaction with fixture targets: correct preflight and absent-target readback, exit0/rollback/no writes. No hosted A2 query or SMTP occurred. The19compiled API artifacts reproduce exactly in independent in-memory builds;340source copies, native-only generator change,6110dependency files and87dependency aliases are bound. Node22.23.3 pnpm lint/typecheck/build/test all exit0 in the planning worktree at `a9476eb`; lint8warnings, Turbo typecheck6/6,build4/4,test6/6cached and e2e TypeScript check executed. Private repository-checks logs are bound; final receipt-only wording follows checks. API integration/RLS/fullinfra/CI were not rerun for private-operation/documentation work; application/infra source is unchanged. Native Prisma writes, positive hosted provisioning and SMTP remain unexecuted. Detached final seal acceptance is tracked at `/private/tmp/tonyai-l9-a2-final-qa.json`. A2 still needs explicit create/email approval; submission is not inbox delivery or deployed-API mail acceptance. L9/L10/QA handover remain open.

**2026-11-01 — First-admin execution reuses source business logic with bounded owner controls.** A2 composes unchanged CLI parseArgs/refuseUnsafe and OnboardingOperator/Auth/Sync/Delivery/Mail classes from a private fresh TypeScript build. It avoids CLI main raw exception logging without replacing the provisioning transaction or mail catalogue. An official Prisma query extension rejects every existing-profile branch, bounds source-specific writes and keeps private correlation IDs; an exact Auth adapter permits only create/unban/invite-link and one checked SMTP recipient. Read-only preflight repeats collision/owner predicates immediately before apply; exact-ID post-readback verifies persisted state and two audit events. No source schema changed: private Prisma generation narrows only binaryTargets to the native owner runtime. Partial DB/Auth/mail effects after commit remain possible and require separately approved reconciliation; no persistent-QA tenant auto-cleanup or automatic resend. SMTP submission in the owner process is not inbox delivery or proof of the deployed API mail path. Prelaunch dependency custody assumes a trusted local filesystem, not atomic protection against concurrent file tampering.


**A2 STOPPED BEFORE APPLY; A2D1 READ-ONLY DIAGNOSTIC PREPARED (LP2-HQ; `a9476eb`; 2026-11-01).** One approved A2 invocation began20:28:46UTC; childexit1 recorded20:29:45UTC, no interruption or forced termination. Four original receipts bind phaseDRY_RUN, zero Auth/SMTP attempts and no known IDs. Source flow confirms apply/create was not reached; the generic invitation warning does not establish any send in this attempt. Exact exception was discarded, so the historical cause is unknown. Original4failure receipts are frozen by `/private/tmp/tonyai-l9-a2-original-failure-receipts.json` (`b8ca76a3f865e6749f63d402e5d2f00b849192aa06b3c745cf9a3264cbb99878`); independent QA/DevOps accept only that outcome. Approval consumed; no retry, resend or cleanup. New `/private/tmp/tonyai-l9-a2d1-ayk9vvt1` prepares one native Prisma connection and read-only repeatable-read transaction using unchanged source provision(false), owner/profile/report checkpoints and class/code-only errors. Only hidden direct-url input; no Auth/SMTP credentials or calls. Ten Node and three supervisor methods pass. Native library construction passed offline; real native/source dry-run passed on temporary local PostgreSQL17 with three empty minimal fixture tables, then the container was removed. This does not prove hosted TLS, full schema equivalence or the old failure cause. Initial local P1001 attempts occurred with no running local stack. QA found a receipt-write path could skip disconnect; cleanup is now independently attempted and a regression test passes. Independent Security/QA/DevOps accepted the corrected core (QA40 and Security6 additional negative probes). Node22.23.3 pnpm lint/typecheck/build/test all exit0 in the planning worktree at a9476eb; lint8warnings, Turbo typecheck6/6,build4/4,test6/6cached, e2e TypeScript check executed. Private repository-checks logs bind these results. API integration/RLS/fullinfra/CI not rerun for private diagnostic/documentation-only work; application/infra source is unchanged. Final receipt wording follows checks. Detached final seal audit gates the next approval. No hosted A2D1 action has run; L8 stays closed, L9 onboarding/SMTP and L10/QA handover remain incomplete.


**A2D1 OBSERVATION COMPLETED; NATIVE CONNECTION FAILED WITH P1011 (LP2-HQ; `a9476eb`; 2026-11-01).** One approved invocation20:45:09–20:45:26UTC recorded childexit0 because diagnostic collection completed, not because connection checks passed. Result observation_complete=true,checks_passed=false, failure CONNECT/PrismaClientInitializationError/P1011; disconnect succeeded, no interruption, forced termination or receipt failure. No transaction/owner/profile query was reached, and no Auth/mail was invoked. P1011 identifies the TLS-opening failure family only; the underlying message was not retained, so certificate trust, parsing, hostname, protocol and I/O subcauses remain unproven. It does not prove wrong credentials or reconstruct the earlier A2 exception. Original6receipts are preserved by `/private/tmp/tonyai-l9-a2d1-original-observation-receipts.json` (`9307814dc3d5e73786bcd869111b3151228aa75092a7585cba42cea857f32283`). The prepared37member seal remains `9c1c6add7f44a5bb991e607251aad0b2b9b50a945683d56105fcd006b9f73b22`. Approval consumed; no automatic retry or TLS relaxation. Offline inspection confirms the pinned public CA parses with OpenSSL and its validity ends2031-04-26; this is not native trust or server-chain proof. Next work is focused offline TLS-path investigation, preserving all source/oldpackets/receipts; a new hosted connection requires a separately reviewed concrete operation and approval. L8 remains closed; A2 creation/email, L9/L10 and QA handover remain incomplete. Last Node22 lint/typecheck/build/test results are the successful pre-A2D1 checks; this receipt-only update does not claim a rerun.


**A2D2 PREPARED OFFLINE (LP2-HQ; `a9476eb`; 2026-11-01).** The exact Darwin SecItemImport public-CA test passed in clean environment/HOME absent: OSStatus0, one certificate, importKeychain=NULL, no network, trust evaluation or keychain persistence. A generic framework warning did not invalidate the returned success; no hosted TLS cause is proven. Private `/private/tmp/tonyai-l9-a2d2-i_r5ur9g` retains D1 strict TLS, native client, source read-only dry-run and all owner/profile/supervision guards. The only behavioral delta classifies P1011 message text in memory into a fixed allowlisted subtype; no matched text, captures, raw errors, URLs or secret values are retained. Missing/oversized/ambiguous text remains TLS_UNCLASSIFIED, never readiness acceptance. Eleven Node and three supervisor methods pass. Independent Security/QA/DevOps accepted the narrow delta without blockers; QA61 additional probes and Security14 additional cases plus1000unmatched sentinels passed. Node22.23.3 pnpm lint/typecheck/build/test all exit0 in the planning worktree at a9476eb: lint8warnings, Turbo typecheck6/6,build4/4,test6/6cached, e2e TypeScript executed. API integration/RLS/fullinfra/CI were not rerun because application/infra source is unchanged; final receipt-only wording follows checks. Frozen final audit gates fresh explicit approval for one D2 read-only attempt. No retry, create, Auth, email, certificate replacement, driver switch or trust-store change is authorized. Original A2/D1 source, packets and receipts remain preserved.


**A2D2 TLS OBSERVATION COMPLETE; A2L1 LINUX READ-ONLY PACKET PREPARED (LP2-HQ; `a9476eb`; 2026-11-02).** One approved D2 attempt20:56:00–20:56:12UTC on2026-11-01 recorded diagnostic childexit0, observation_complete=true but checks_passed=false: CONNECT/P1011/TRUST_OR_VALIDITY, successful disconnect and no source SQL/Auth/mail. The broad native-message category is not root-cause, expiry, wrong-password or originalA2 proof. Original6receipts frozen at `/private/tmp/tonyai-l9-a2d2-original-observation-receipts.json` (`dfc067c44bb0f81f0e4b6cde159e8381034d4d7e35ba874c5a5932b6ac72ca03`); independent QA/DevOps outcome accepted, approval consumed. Further standalone CA/trust probes were not used to invent a cause. New private `/private/tmp/tonyai-l9-a2l1-yh4vo05y` prepares the same strict owner/read-only source checks in the already-present accepted Linux/amd64 API image digest `e9ba267817667e8580afc39bfd1ace12f62cf012e044abe77ba30f4d8446495d`, without pull/build/deploy/API/healthcheck. Network-none inspection verifies Node22.23.4, Prisma6.19.3 and source/CA; two source artifacts differ only by sourceMappingURL comments. Original container CA URL stays unchanged. Secrets/private inputs use stdin only; image/bundle read-only, Docker logs disabled, fixed-schema private result envelope, no Auth/SMTP. One local temporary container has CID+operation/seal/name-verified stop/remove/absence cleanup. Eleven Node image mock methods and ten host transport methods pass. The actual native read-only source path passed in an internal local PostgreSQL fixture with empty business tables and normal observer cleanup; not hosted TLS/full-schema proof. Initial local setup and stop-ack failures are retained. The running-container test proved --time deprecation text polluted stdout; --timeout=5 fixes that without weakening exact-ID acknowledgment, and corrected running cleanup passed. Independent Security/QA/DevOps accepted the corrected core with no blockers (Security30 and QA76 extra negative cases). Node22.23.3 pnpm lint/typecheck/build/test all exit0 in the planning worktree at a9476eb: lint8warnings, Turbo typecheck6/6,build4/4,test6/6cached, e2e TypeScript executed. Private repository-checks logs bind those results; final receipt-only wording follows checks. API integration/RLS/fullinfra/CI were not rerun because application/infra source is unchanged. Frozen final audit gates fresh one-attempt L1 approval. A Linux PASS would establish that current owner read path, not the Darwin cause, provisioning/email authority or QA handover. L8 stays closed; L9/L10 remain incomplete.


**A2L1 ACCEPTED; A2L2 FIRST-ADMIN/INVITATION PACKET PREPARED (LP2-HQ; `a9476eb`; 2026-11-02).** One approved Linux read-only invocation 21:16:48–21:17:09 UTC on 2026-11-01 (00:16–00:17 Europe/Istanbul on 2026-11-02) passed strict connection, read-only/unfiltered settings, source ownership, exact profile absence and source dry-run report. Child exit 0, disconnect success, no interruption; exact local container scope/removal/absence confirmed. Original 17 receipts preserved at `/private/tmp/tonyai-l9-a2l1-original-success-receipts.json` (`f90de243c72eaa4555e3126e8ba1ab342a5d796ec5c9500aec2721e5b9623949`); independent QA/DevOps accept only the current Linux owner read path. It is not a reservation, Darwin-cause proof or create/email authority. Approval consumed. New private `/private/tmp/tonyai-l9-a2l2-puone6rz` proposes one synthetic holding/first-super_admin/invitation and two unchanged-source business audits, at most 3 exact Auth calls and 1 checked TR SMTP submission, preceded by fresh dry-run/ten-predicate preflight and followed by 13 predicate exact-ID readback. Same existing Linux image/strict TLS/source classes; no pull/build/deploy/API launch. Credentials/roster use stdin; the only writable container mount is a dedicated 0700 host receipt subdirectory, under bound nonroot UID 501/GID 20. Fixed safe events and stable UUID ledger use 0600 exclusive writes, file/directory fsync and atomic rename; host CID/cleanup files remain outside the mount. Ledger writes complete inside the source transaction before commit; false commit flag is unknown, not rollback proof. 12 source/SDK mock methods, 5 filesystem methods and 5 host supervisor methods pass; two host exact-CID SIGKILL fixtures exit 137 and retain owner-only ledgers/SMTP intent after container removal, with no external calls. Initial incomplete/failing test evidence is preserved; lstat and strict string checks close symlink/coercion gaps. All 19 image runtime artifacts (17 JS + TR/EN mail JSON) equal the original private source build apart from trailing JS source-map comments. Partial DB/Auth/email effects remain possible after commit; no automatic retry, resend, reconciliation or cloud cleanup. Local cleanup is exact-ID only with bounded termination grace. Independent Security/QA/DevOps reviews accept the core with no open blockers, pending frozen seal audit and fresh explicit create/email approval. Security independently ran 10 methods and 32 additional negative probes; QA ran 22 methods and 92 acceptance negatives; DevOps ran five transport methods and eight UUID negatives. Repository checks ran in the hosted-l7-plan worktree on a9476eb735cad53aa7091932dd02b38a4070cefb with Node 22.23.3: pnpm lint/typecheck/build/test all exit 0; lint retains eight existing warnings, Turbo typecheck/build/test tasks were cached (6/4/6), and the extra E2E TypeScript check passed. API integration/RLS probes, full infrastructure tests and manual self-hosted CI workflows were not rerun: this preparation changes only private operation artifacts and these three repository documents, with no application or infrastructure source changes. Final seal audit remains the last offline gate before requesting approval. L8 remains closed; later L9 users/grants, inbox/sign-in/lifecycle and L10/QA handover remain open.


**A2L2 ACCEPTED: FIRST ADMIN AND ONE INVITATION SUBMITTED (LP2-HQ; `a9476eb`; 2026-11-02).** One explicitly approved invocation ran 21:49:44–21:50:43 UTC on 2026-11-01 (00:49–00:50 Europe/Istanbul on 2026-11-02), child exit 0, without interruption or forced termination. Unchanged source dry-run and all ten fresh owner/collision predicates passed before apply. One synthetic holding, first super_admin and invitation were created with two business audit events; three bounded Auth calls returned HTTP 200 and one TR invitation SMTP submission was accepted. All thirteen exact-ID readback predicates, private ledger commit confirmation and disconnect passed. Receipt-backed exact local container scope/removal/absence checks passed. Original 20 files remain unchanged under `/private/tmp/tonyai-l9-a2l2-puone6rz-execution`; their manifest is `/private/tmp/tonyai-l9-a2l2-original-success-receipts.json` (`3b4a526f5910da9cb581f56e05fed0ba630e70ca90cfced85f34c2ece87d9774`). Independent QA/DevOps outcome reviews accept these bounded results. The prepared 74-member seal remains `f2ace16cbf4e9489d956a408b79deb67ba5e797527898b236d89de0399bf4e28`; final QA report hash is `470647cf6f5c34aa87f5c92f1fcd76c37f497f371696d1b880a64c4b1c638ff3`. Owner separately reports the invitation visible in the inbox; `/private/tmp/tonyai-l9-a2l2-owner-inbox-observation.json` records that human observation without retaining message/link. It is not independent header/content inspection or invitation/password/sign-in acceptance. Approval consumed; no replay, resend, additional user or cloud cleanup authorized. A3 owner-run invitation/password/fresh-login procedure is now prepared offline at `/private/tmp/tonyai-l9-a3-owner-acceptance.md`, SHA `71f20eabb2c2d25adfab77645af394398d12a52bf23e7d2678f96a1dc89ed60f`, and independently accepted by Security/QA with no blockers; binding seal `9af78abd85b5f283f12c0722dbbccc640b56e86f64e634a02d3634cf1f2d9048`. No code/test/live call was needed for this human procedure review. It covers one confirmation/password save, one sign-out/fresh sign-in and dashboard observation, with STOP on errors or absence of a real login form. Possible provider Auth security notices require owner approval. Existing LP4-01 follow-up (26), the ignored acceptance-API failure, means UI success cannot prove invitation/audit acceptance; exact-ID readback remains separately gated. Fresh explicit A3 approval is required. Other four QA roles, subsidiary grant, lifecycle/reset checks and L10/QA handover remain open; L8 stays closed. This receipt-only update does not rerun tests: the latest Node 22.23.3 lint/typecheck/build/test remain the successful pre-A2L2 checks on a9476eb in hosted-l7-plan (eight existing lint warnings; Turbo typecheck/build/test cached). No application/infra source changes, API integration/RLS/full-infrastructure or CI rerun claimed.


**A3 OWNER UI OBSERVATION RECORDED; TENANT/INVITATION READBACK OPEN (LP2-HQ; `a9476eb`; 2026-11-02).** After explicit one-attempt A3 approval, the owner reports successful password save and fresh password sign-in, Turkish UI and no visible error. The owner could not find the holding name and described an empty company view. Protected source inspection confirms the dashboard renders subsidiaries, not the holding legalName; its header shows user fullName/role, and no subsidiaries is the expected A2L2 state. Asking the owner to find the holding name on this dashboard was not a valid UI acceptance criterion. This observation is recorded at `/private/tmp/tonyai-l9-a3-owner-observation.json` (`c763c42aab839a5bbab30015654fa4746fdca1461995605088e9bbcff3a8ed8a`). It is owner-reported UI evidence, not independent session/tenant or invitation/audit readback. A2L2 exact-ID creation/provisioning receipts remain valid and unchanged. Existing LP4-01 follow-up (26) still prevents UI progression from proving invitation acceptance. A3 approval is consumed; no repeat confirmation/password/sign-in, reset/resend or further live query is authorized. Next is offline preparation of a narrow read-only current first-admin/organisation/invitation/audit verification, before any fresh explicit live-read approval. Remaining QA roles/subsidiary grants/lifecycle and L10/QA handover stay open; L8 stays closed. Only the existing three documents changed; no test rerun or live call by the agent is claimed. Latest successful Node 22 repository checks remain the pre-A2L2 run.


**A3 UI OBSERVED; A3R1 EXACT-ID READ-ONLY ACCEPTANCE PACKET PREPARED (LP2-HQ; `a9476eb`; 2026-11-02).** The owner reports password save/fresh sign-in success, Turkish UI, no error, and now explicitly confirms the expected first-admin name/super_admin header and empty subsidiary register. Protected source confirms no holding-name rendering on dashboard; zero subsidiaries is expected. Additional human observation retained at `/private/tmp/tonyai-l9-a3-owner-header-observation.json`; initial owner record remains unchanged. Current browser tenant identity and persisted invitation/audit acceptance are not independently established by those UI reports. A3 approval consumed. New private `/private/tmp/tonyai-l9-a3r1-dpjchees` prepares one strict-owner native connection and RepeatableRead READ ONLY snapshot in the existing Linux image, unchanged source assertOwner (no provision), fifteen fixed boolean exact-ID checks for holding/profile/accepted invitation/original audits/one accept audit/three total tenant audits/confirmed unbanned Auth identity, disconnect and exact local-container cleanup. It reads IDs privately from the committed hash-bound L2 ledger and reuses owner inputs; one hidden unchanged direct-url only, no Auth/SMTP credential, no HTTP/Auth API/mail/session/token/password-hash read or business mutation. An unexpected state is retained as failed predicates, without replay/resend/reconcile/delete authority. Ten observer methods pass on host and network-none Linux; five supervisor/cleanup and six parser methods pass. Three internal native local PostgreSQL minimal-schema cases distinguish accepted, unaccepted and wrong-profile-organisation states and use the unchanged source owner guard; local containers/network removed. An initial test-only regex/count failure is retained; corrected safety test passes. Native fixtures predate only the added core-dump-disable flag; host transport assertion covers that flag. These are local evidence, not hosted acceptance. Independent Security/QA/DevOps accept the core with no blockers: each independently ran all 21 host methods; QA also ran 176 additional negative probes. The bounded in-memory emitter is fixed (at most eleven events, capacity twenty); it is not an interchangeable durable sink, and memory/emit failure can require container termination rather than graceful native disconnect. Repository checks ran in hosted-l7-plan at a9476eb735cad53aa7091932dd02b38a4070cefb with Node 22.23.3: pnpm lint/typecheck/build/test all exit 0, eight existing lint warnings, Turbo typecheck/build/test cached (6/4/6), separate E2E TypeScript check passed. API integration/RLS/full-infrastructure/manual self-hosted CI were not rerun because no application or infrastructure source changed. Frozen seal audit is the remaining offline gate before fresh explicit one-attempt read-only/local-cleanup approval. Existing LP4-01 follow-up26 remains; L8 closed, later L9 roles/grants/lifecycle and L10/QA handover open.


**A3R1 ACCEPTED; A4 SUBSIDIARY/QA INVITATION PROCEDURE PREPARED (LP2-HQ; `a9476eb`; 2026-11-02).** One approved read-only invocation ran 22:15:09–22:15:29 UTC on 2026-11-01 (01:15 Europe/Istanbul on 2026-11-02). All fifteen predicates passed: strict read-only/unfiltered/database/owner, exact holding/profile binding and metadata, one profile/zero subsidiaries, accepted invitation, original create/invite audits plus one exact actor accept audit (three total), confirmed/unbanned Auth identity. Child exit 0, uninterrupted/unforced, successful disconnect and exact local cleanup recorded. Original fifteen files preserved under `/private/tmp/tonyai-l9-a3r1-dpjchees-execution`, manifest `/private/tmp/tonyai-l9-a3r1-original-success-receipts.json` (`505baacc388b61c45adb0bc54b61e0f7c5e7213b1151d129ea801dc9a74e31b6`); independent QA/DevOps outcome accepted. This is current persisted-state acceptance, not a browser-session or API tenant-isolation test. Approval consumed. Owner supplied the previously missing synthetic site name/TR as preparation input only. New private `/private/tmp/tonyai-l9-a4-ke_ujujl` proposes owner-run deployed UI/API creation of one pending subsidiary with one TR site, Scope1+2/company-wide tracking defaults, then four exact QA role invitations in TR with exactly one data_entry subsidiary grant at invite time. Optional descriptors/contact fields remain blank. Four application invitation submissions and seven new business audits expected on clean success (ten total); the source Auth email_exists fallback prevents a hard twelve-request claim. Lists/serial checks reduce duplicate risk but do not reserve state or enforce unique subsidiary names. Stop on any warning/error/ambiguous outcome; no replay/resend/reset/delete or opening recipient links. Possible provider security notifications are in proposed scope. Human procedure only, no code change or new mirrored tests; source/DTO/service/UI flow inspected offline. Independent Security/QA/DevOps accept the final source-based human procedure with no blockers; the private four-member roster and owner site input match original preparation values. API defaults for scopes/tracking are not editable create-form controls; language is verified in each invite dialog, not the user row. Source-reported sent status is not an independently captured SMTP envelope/inbox receipt; current provider quotas/capacity/deployed mail health remain unprobed. Node 22.23.3 pnpm lint/typecheck/build/test ran in hosted-l7-plan on a9476eb735cad53aa7091932dd02b38a4070cefb: all exit 0, eight existing lint warnings, Turbo typecheck/build/test cached (6/4/6) and separate E2E TypeScript passed. No application/infra change; API integration/RLS/full-infrastructure/manual self-hosted CI were not rerun. Final frozen inventory audit gates fresh exact one-attempt creation/email approval. L8 remains closed; later acceptance/lifecycle/isolation/L10/QA handover stay open.


**A4 OWNER UI/INBOX OBSERVED; A4R1 COHORT READ-ONLY SNAPSHOT PREPARED (LP2-HQ; `a9476eb`; 2026-11-02).** After explicit A4 approval the owner reports one subsidiary/site creation, four TR invitations, the single data_entry company assignment, five total users and no warning/error. All four emails are owner-reported received: second super_admin at Outlook in spam, data_entry/consultant/executive_viewer in inbox. Private observations are `/private/tmp/tonyai-l9-a4-owner-observation.json` and `/private/tmp/tonyai-l9-a4-owner-inbox-observation.json`; no raw message/link/header retained. This is human UI/mailbox evidence, not independent DB/provider-envelope proof. Spam cause unproven; delivery quality remains open under Open questions. Approval consumed; recipient links remain unopened. New private `/private/tmp/tonyai-l9-a4r1-yl8_z80d` extends accepted A3R1 strict Linux/read-only owner/source guard with one fixed parameterized 27-boolean snapshot: five exact profiles/roles, one approved pending TR subsidiary and site/defaults, four sent/unaccepted/unconfirmed invitations/Auth identities, one exact data_entry grant, source-shaped audits (ten total), plus original first-admin accepted/confirmed/holding predicates. New UUIDs resolve only inside SQL from frozen A4 private roster/site and known committed L2 IDs; outputs contain no IDs. No HTTP/Auth API/SMTP, business mutation, session/token/password-hash read or retry. Ten observer methods pass on host/network-none Linux, five supervisor and six parser methods pass. Four native internal local PostgreSQL minimal-schema/source-owner cases distinguish correct state, wrong grant, wrong role and premature invite acceptance; all local observer/DB/network resources removed. Local evidence is not cloud acceptance or role-isolation/lifecycle proof. Independent Security/QA/DevOps accept the final core with no blockers. The four JSON recordset field types were qualified with pg_catalog, and current ten host/Linux observer methods plus all four native fixtures passed again after that refinement. Negative native fixture states are cumulative, with specific role/invitation/Auth predicates asserted; they are not isolated single-fault native experiments. QA independently ran 21 supplied methods, 139 parser negatives and four additional observer/parameter probes. Node 22.23.3 pnpm lint/typecheck/build/test ran in hosted-l7-plan on a9476eb735cad53aa7091932dd02b38a4070cefb: all exit 0, eight existing lint warnings, cached Turbo typecheck/build/test (6/4/6), separate E2E TypeScript passed. API integration/RLS/full-infrastructure/manual self-hosted CI were not rerun because no application/infra source changed. Frozen audit gates fresh explicit one-attempt read-only/local-cleanup approval. L8 stays closed; later recipient acceptance, lifecycle/reset/isolation and L10/QA handover open.


**OWNER DEPLOYMENT SPLIT AND HOLD (LP2-HQ; 2026-11-02).** Claude Code owns the next QA candidate/deployment from `main` `7d3e2e9` including #259 and #261. Codex must not cut a candidate or touch application Terraform state or Azure Container Apps. Codex continues L9 read-only investigation and infrastructure findings. Recipient invitation acceptance, resend and L10 wait for Claude's deployment result; bind every later acceptance/smoke step to the supplied new release name, image digests and evidence before requesting its own live approval. Preserve old r003 manifests/inputs/source read-only; Claude may read but not modify them. The owner explicitly requested a PR for the existing README/hosted-roadmap/status changes at this stop point, plus #259/#260/#261 proposed status records. Owner still merges; no cloud action follows the documentation PR. The specified7d3e2e9 is the owner's candidate baseline, not proof a new candidate exists. This documentation PR may move main: Claude/owner must recheck source SHA and exact-SHA CI/E2E/Integration bindings at candidate preparation/execution; movement requires STOP and an explicit owner source-selection decision, never a silent Codex retarget.

**A4R1 COMPLETE OBSERVATION; STATE ACCEPTANCE NOT PASSED (LP2-HQ; old r003/`a9476eb`; 2026-11-02).** One approved read-only invocation ran 22:47:48–22:48:06 UTC on 2026-11-01 (01:47–01:48 Europe/Istanbul on 2026-11-02), native child exit 0, no interruption/force, disconnect and exact local-container cleanup complete. Twenty-one of 27 predicates passed. False: `audit_total_ten`, `subsidiary_metadata`, `location_metadata`, `four_sent_invitations`, `four_unconfirmed_auth_identities`, `four_invite_audits`. All five profiles/names/roles/TR, correct holding, one subsidiary/site and one exact data_entry grant passed. Original fifteen files are frozen by `/private/tmp/tonyai-l9-a4r1-original-observation-receipts.json` (`85f55048d9ebf59324d6634557d87ee0bd712e83a2af494f02ca1f4238dc89fd`); independent QA/DevOps accept observation completeness only. Owner then reports metadata/short-name/responsible-person edits, adding the data_entry grant after initially inviting without it, and at least one new recipient Continue click (roles unspecified). These explain why the clean unopened/blank-metadata/initial-grant baseline is no longer applicable; they do not independently resolve every failed aggregate. The initial empty-grant invitation audit must remain immutable and separate from later access creation. No creation/delivery failure or root cause is inferred from the aggregate flags. Approval consumed; no automatic repeat, repair, resend or audit alteration. Prepare only narrowly scoped read-only classification; recipient actions and L10 remain on the owner deployment hold.

**Main integration records (owner request, 2026-11-02):** #259 (`6c377d1`) removes shipped seed credentials/login hydration race; #260 (`b4cfe2c`) records the agent-only UAT pre-pass and catalogue corrections; #261 (`7d3e2e9`) offers dead-link reset and removes analytics. Old r003 remains unchanged. Human sign-off, exact-SHA replacement gates, new deployment and release-bound hosted acceptance remain open; review follow-ups are in the single status file.

**A4D1 PREPARED OFFLINE; CLASSIFICATION IS NOT L9 ACCEPTANCE (LP2-HQ; docs base `18ea5d8`, preserved operation source/image `a9476eb`; 2026-11-02).** New private `/private/tmp/tonyai-l9-a4d1-4131ecm4` preserves the original A4/A4R1 packets and fifteen A4R1 receipts (all hashes/modes verified). It retains accepted strict Linux/native Prisma/source owner/read-only transaction, nine fixed parameters, supervision and exact-ID temporary-container cleanup. Stable tenant/create-audit identity guards survive current company/site renames; guard failure suppresses classification. Per-field metadata equality/presence and owner-update-history flags, per-role invitation status/attempt/timestamp/error/Auth facts, original invite actor/role/TR/grant shape, current grant and separately later access audit, recipient accept audit and bounded tenant audit taxonomy are independent observations. No raw values, IDs, emails, timestamps, provider data, password/session/token fields or unknown strings leave the DB; counts saturate at100 (at least100). Diagnostic completion never sets `l9_accepted=true`, proves password choice or waives lifecycle/isolation gates. Eleven observer methods pass on host Node 22.23.3 and network-none accepted Linux image, seven parser/five supervisor methods pass; twenty-five isolated minimal-schema PostgreSQL17/source-owner fixtures pass, including missing/duplicate/foreign targets, renames, empty-initial/later-added grant, Auth/invite divergence, malformed array/scalar/null audits, unknown output categories and count saturation; all local DB/observer/network resources removed. Security/QA/DevOps accepted the core; corrected-source/final-seal/documentation acceptance is recorded separately before approval. Node 22.23.3 offline frozen install/lint/typecheck/build/test passed at 18ea5d8026bd69a3afe90fbc380bee89b7ea6342 in hosted-l9-diagnostic (lint8warnings; typecheck6/6 and test6/6 cached, build3/4 cached, separate E2E TypeScript passed). API integration/RLS/full-infra/manual self-hosted CI not run: application/infra source and gates are unchanged. No cloud operation, commit/push/PR or new live authority. Seek only fresh approval for this exact one-attempt read and scoped local-container cleanup after the final audit; no automatic retry, repair, resend or audit rewrite. #262 is merged at 18ea5d8; Claude/owner must revalidate the specified7d3e2e9 candidate source/exact gates and explicitly resolve movement. No Codex candidate/deploy/application-state/Container-Apps action. Bind later acceptance to owner-supplied new release/digests/evidence; recipient actions and L10 remain held. Diagnostics destination=null, missing vault networkAcls readback, Outlook spam cause, authoritative-factor and L9 lifecycle/isolation findings remain open.

**A4D1 CLASSIFICATION COMPLETE; L9 ACCEPTANCE OPEN (LP2-HQ; operation source/image `a9476eb`, documentation base `18ea5d8`; 2026-11-02).** One owner-approved A4D1 invocation at seal `ca93b3974d1dfbf9f2bad6405426fb3263512d7c4be2e4872d94de89d6b701ae` ran 2026-11-01 23:38:06–23:38:22 UTC (2026-11-02 02:38 Europe/Istanbul): child exit0, no interruption/force, successful disconnect and exact-ID local-container removal/absence. All 19 identity/target guards passed; classification_complete=true, l9_accepted=false. Four new roles each have accepted invitation, confirmed/unbanned matching Auth identity, one correctly attributed accept audit, one send attempt, no stored errors/resend audits and matching inviter/TR/original invite shape. All four initial grant arrays are empty; data_entry alone has one correct current company grant and one matching access-create audit strictly later than its initial invite. These are current-snapshot facts, not password-save/fresh-sign-in proof or a reconstruction of A4R1 at its earlier timestamp. Subsidiary/site names, geography, scopes and granularity match. Optional subsidiary metadata and site address/authorized person are populated; selected first-admin update audits show changes. Subsidiary status differs from pending (actual status was not emitted); sector is populated without a matching owner-update change flag, so provenance is unresolved. Tenant audit total23: organisation create1, subsidiary create1/update2, location create2/update1, invitation invite5/accept5, access create1, profile update4, other1; all remaining named categories0. One current site is observed. The second location-create record, other category and exact profile-update content are unclassified; do not infer deletion or password activity. Counts cover the snapshot, not full audit/lifecycle acceptance. Original15 receipts are frozen by `/private/tmp/tonyai-l9-a4d1-original-observation-receipts.json` (SHA256 `696724f07ffc0a9ed52e8ce55c438ea6a897b9427782250b326d39b369a7bfde`); sealed packet and prior A4R1 evidence remain unchanged. The11 receipt protocol events validate offline. Independent outcome QA/DevOps reviews are recorded separately. Overall owner-shell success is reported by the owner OBSERVED line; native child status and cleanup have recorded evidence. Approval consumed; no repeat, repair, resend or new cloud query authorized. Preparation checks remain the executed Node 22.23.3 results at 18ea5d8026bd69a3afe90fbc380bee89b7ea6342 in hosted-l9-diagnostic: lint/typecheck/build/test exit0, lint8 existing warnings, typecheck6/6 and test6/6 cached, build3/4 cached, separate E2E TypeScript passed;11 host/Linux observer,7parser,5supervisor and25 isolated native fixtures passed. This outcome follow-up adds only evidence/documentation and offline receipt validation; no claim those suites ran again. API integration/RLS/full-infra/manual self-hosted CI were not run; application/infra source and gates unchanged. No commit/push/PR. Recipient acceptance/resend and L10 remain on the owner deployment hold. Claude/owner must supply the replacement release/digests/exact-source evidence and explicitly revalidate the specified7d3e2e9 versus current18ea5d8 source; Codex does not silently retarget or deploy. Diagnostics destination, vault ACL readback, Outlook spam cause, authoritative factors and lifecycle/isolation remain open.

**R004 DEPLOYED; ACCEPTANCE PREPARATION REBOUND (LP2-HQ; 2026-11-02).** Owner/Claude deployed `r004` from fixed source `7d3e2e9c70846ed76d677fe72cff8ab831924192` (#259/#261), API `sha256:4126b6ce156625b987886884971183cdd83208c91d83dfe0fd1865fed1d27b68`, web `sha256:ded9a4f423a73388b8d4035b09f41c3ccd799187424327a50a5ef0a36db6a33f`. Deploy helper was `c8ca4af` (#263); preparation now uses `88b80b4` (#264) without changing runtime source. Local evidence is `~/tonyai-evidence-backup/r004/`; release manifest SHA256 `bc2ec4e7c4a9c7e0c47766990d6a1496d444960aeadda266e34cb9f28904e667`, candidate SHA256 `472296c27c6be86c17ba721671d823c358c0db8ac567ad6600f304b5135b55a0`. Codex independently verified local manifest/candidate binding, only four r003 differences (source/release/API/web), all 42 migration hashes and the lockfile hash, unchanged Terraform versus source/helper/preparation, and exact-source main success metadata for [CI41356114363](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41356114363), [E2E41356234839](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41356234839), [Integration41356114333](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41356114333). storage_cleanup_hold=true; old r003 inputs preserved. Owner/Claude evidence reports apply0added/2changed/0destroyed, initial post-apply Unexpected active API revisions failure followed by post-rollover verify-only PASS; API health/ready200, unauthenticated tenant401, own-origin CORS allowed/foreign refused, login200 and EN/TR empty fields/no seed/no uncaught error/no analytics, dead-link recovery copy/button, and no API error/fatal log lines (401/404 warnings only). These are attributed prior observations; Codex did not repeat cloud/ARM/browser checks. At that preparation point hosted sign-in, new-API email, Storage, cloud_smoke and L10 were unverified on r004; see the later A1 owner-observed login/UI/host200 subset and still-open identity comparison. The drain cost approximately 2 min 40 s downtime yet Azure Single mode restarted r003: old/new containers started23:38:07 UTC on2026-11-01, traffic moved23:38:18, old scaling ended about23:38:49; whether r003 handled requests is unknown. A4D1 snapshot23:38:06–22 overlaps that transition: preserve its DB facts, never label it r004 API/image acceptance. No migration occurred. Cosmetic transport/probe-order Terraform drift remains, with no image/revision change. Private `/private/tmp/tonyai-r004-acceptance-isz4nzbg` prepares manual R004-A1 only: owner confirms no later rollout, new private window, existing first-admin password, one login submit and normal protected dashboard reads including exact-origin GET /api/v1/me200 plus private expected identity/tenant/role/TR matches. No email/reset/resend/contact/business mutation; stop on refusal or unobserved protected read. Binding is to preserved deployment evidence/origins and owner continuity; no contemporary independent image-digest proof (the app has no identity endpoint). Accepted invitations cannot be resent by source; choose a later separately approved recipient fresh login, matching-session password completion or signed-out reset as needed. All further recipient notifications/live steps/handover require owner approval. Next deploy ownership is undecided; Codex does not operate application state or Container Apps. Node 22.23.3 pnpm lint/typecheck/build/test ran at 88b80b4 in hosted-l9-diagnostic, all exit0 (8 existing lint warnings; Turbo typecheck6/build4/test6 cached and separate E2E TypeScript executed). Twenty-two targeted mocked deployment/runtime/null-secret/rollover tests passed. No application/infra source changed by this work; API integration/RLS/full-infra/manual self-hosted CI not rerun. No commit/push/PR or new agent live operation. Evidence backup refreshed by rsync without deletion; the previously forbidden tonyai-ib1-work-o47ytgo9 directory is excluded and untouched.

**MERGED (#263, `fix/deploy-verify-null-secrets`; Claude Code; merge `c8ca4af89be3e99bd135d32bc6268aa361760518`; 2026-11-01).** deploy_apps.verify maps ARM null web secret inventory to empty while retaining exact inventory checks; API null and unexpected web secrets are still refused. The prior r003 verify crash and corrected read-only PASS are reported in the PR. Terraform and candidate application source are unchanged. Paused qa_readback.py:68 has the same null-list pattern and is left for route resumption.

**MERGED (#264, `fix/deploy-wait-for-rollover`; Claude Code; merge `88b80b4e3cf7af11f97113cd7c4035678f1c88ff`; 2026-11-02).** deploy_apps.py calls bounded drain_api.settle after apply, waiting for only the target active revision and no outgoing replicas before strict verification. Single mode restarted drained r003 beside r004 for about 40 s. Runbook 06 now acknowledges overlap. PR reports 1288 unit tests (2 skipped), 129 mutants and settled-r004 read-only positive/wrong-target checks; these are attributed results. **The new wait has not passed a real deployment; its first rollout exercise is the next release. --verify-only does not wait and can give a transient FAIL immediately after apply.** Downtime/exclusivity is an LP5-03 decision; every migration must tolerate approximately one minute of old code; paused qa_* drain/readback is separate and may need equivalent fixes on resumption.

**r004 remaining acceptance sequence:** R004-A1 existing first-admin login/protected read; then each approved recipient login/password-completion/recovery route (accepted-invite resend refused), role/access/tenant isolation, Storage and live/retained exports, separately reviewed dedicated synthetic cloud_smoke/lifecycle/retirement scope, monitoring/backup/recovery and L10 owner handover. Do not offboard the ongoing QA holding from generic runbook examples. Old links may be expired;202/reset audit alone is not SMTP delivery, and UI password-save alone is not other-session invalidation proof. Full runbooks04/06/11 checklist remains open, with numerical emissions blocked without authoritative factors. Existing diagnostics destination=null/vault ACL readback/spam and A4D1 audit-history findings remain open.

**R004-A1 OWNER LOGIN/UI OBSERVED; ACCESS EVIDENCE PARTIAL (LP2-HQ; 2026-11-02).** Owner reports R004-A1 at 2026-11-02 03:24 Europe/Istanbul (00:24 UTC, minute precision): successful first-admin login, expected dashboard name/role, authenticatedTR and exact r004 API /me200. URL establishes host/path only. Owner explicitly did not check/recollect private id/organisationId comparison: NOT_OBSERVED, no full A1 identity/access acceptance. Fresh-context/login-origin/continuity were not separately reported; do not infer them from approval. This is owner UI evidence, not independent runtime-digest/traffic proof. Approval consumed; no repeat login/read/email authorized. Original observation+clarification are frozen by /private/tmp/tonyai-r004-a1-original-observation-receipts.json (SHA256a128f88f104d80c90deb2d8598a8b01ddac40c4b37ab19fe3534490ea9f1586e); independent outcome QA/DevOps accept the observed subset only. Owner reports the existing data_entry password is chosen/known. New private /private/tmp/tonyai-r004-a2-1v3u1v6n prepares R004-A2: one owner-approved private-window login, /me role/email/name/TR and committed-holding comparison, one accessible company and matching normal /subsidiaries200 read, exact origins and private ID correspondence; booleans/counts only. No exported expected data_entry UUID exists: do not invent one. No contact/email/reset/resend/business mutation/foreign-ID probes or retry. Full A1 gap, other roles, isolation/lifecycle/Storage/cloud_smoke/L9/L10 remain open. Source remains7d3e2e9/digestsr004; preparation 88b80b4 does not retarget. This follow-up only checks receipts/source/custody/docs; prior Node 22fourchecks+22 mock tests were not rerun. No commit/push or agent live action.

**R004-A2 OWNER POSITIVE COMPANY READ OBSERVED; THREE ROLE CARDS PREPARED (LP2-HQ; 2026-11-02).** R004-A2 owner reports expected data_entry profile/TR,200responses,one expected company and one accessibleSubsidiaryId. Owner clarified without a new request that /me.organisationId and company.organisationId match the private committed holding, and company.id matches the single accessible ID (holding and company IDs are not compared to each other). Observation2026-11-02 03:38 Europe/Istanbul=00:38 UTC, approximate minute with no start/end interval. Accept only the owner-reported positive login/profile/own-company subset; no independent runtime image, fresh-context/submission-count or negative-isolation proof. Original report+clarification frozen by /private/tmp/tonyai-r004-a2-original-observation-receipts.json SHA256795afe770b1a444ff1262d2a632e92921ec7a71c9096b103a5426716f029280f. Approval consumed; no retry/email authorized. R004-A1 id/org comparison remains NOT_OBSERVED. Owner reports all three remaining passwords known. /private/tmp/tonyai-r004-role-reads-6nilloni prepares shared positive-read recipe with separately bound cards: R004-A3 second super_admin, R004-A4 consultant, R004-A5 executive_viewer. Every card is NOT_RUN and needs its own explicit approval; approving one never authorizes another. The three roles see all same-organisation companies via AuthGuard, not explicit data_entry grant rows. First request A3 only. Each scope is one isolated-context login plus /me and one expected company read, no write/foreign-ID test/email/contact/reset/resend. These reads do not prove admin approval authority, consultant/viewer mutation refusal or full L9/L10. Deployed7d3e2e9/digestsr004 remain fixed, prep88b80b4 is not a retarget. No new application/infra source or broad test rerun; this follow-up only verifies offline custody/source/owner records/docs, with independent review. Existing Node 22fourchecks+22 mock tests remain prior preparation evidence. No account authority/write denial, foreign-tenant refusal, password reset/email, Storage/export, cloud_smoke or handover is marked passed from these positive reads. Future L10 still needs owner-approved material scopes.

**R004-A3 SECOND-ADMIN OWNER POSITIVE READ OBSERVED (LP2-HQ; 2026-11-02).** Owner reports R004-A3 at 2026-11-02 03:52 Europe/Istanbul=00:52 UTC (minute precision): r004 continues/no later deployment, successful second-super_admin login, super_admin/TR, correct API host, /me200 and /subsidiaries200, matching holding IDs, one company/one accessible ID with matching IDs and expected company name. Owner supplied account name/email; raw personal values are not copied into repository/evidence, and no independent private-roster comparison is claimed. Fresh isolated context and actual submission count were not independently verified. Accept the owner-observed positive login/profile/company-read subset only; this is not runtime image proof, approval/write authority or tenant-isolation evidence. Original observation frozen by /private/tmp/tonyai-r004-a3-original-observation-receipts.json SHA256dde4e96e40fa58448ac074d8de133cad556599ea34dee492095b0ca145b7e5fb. A3 approval consumed; no retry/email/write authorized. A1 id/org comparison remains NOT_OBSERVED; full L9/L10 remain open. Shared recipe/card bindings remain unchanged; A4consultant is next for separate approval, A5 viewer remains unapproved. Existing prior preparation checks are not reported as rerun; this follow-up changes documentation/owner evidence only, no application/infra source, agent live operation or commit/push.

**R004-A4 CONSULTANT OWNER POSITIVE READ OBSERVED (LP2-HQ; 2026-11-02).** Owner reports R004-A4 at 2026-11-02 03:59 Europe/Istanbul=00:59 UTC (minute precision): r004 continues/no later deployment, consultant login successful, expected name/email match, consultant role, correct API host, /me200 and /subsidiaries200, matching holding IDs, one company/one accessible ID with matching IDs and expected company name. A same-observation clarification confirms authenticated TR; no new login/read was requested. Accept the owner-observed positive profile/company-read subset only; no independent image/context/submission-count proof, write/approval refusal or negative tenant-isolation acceptance. Two original report/clarification records frozen by /private/tmp/tonyai-r004-a4-original-observation-receipts.json SHA256239cd8d7964a2cbc5fb2835796abedf37da82ec789bb723e1d8e17dc26f63580. A4 approval consumed; no retry/email/mutation authorized. A1 id/org comparison remains NOT_OBSERVED and L9/L10 remain open. Next is separately approved A5executive_viewer under unchanged shared recipe. This documentation/evidence-only follow-up adds no application/infra source or agent live action; prior tests are not claimed rerun. No commit/push.

**L9 SYNTHETIC ONBOARDING COMPLETE — COMBINED ASSESSMENT (LP2-HQ; 2026-11-02).** L9 synthetic onboarding is COMPLETE by the existing hosted roadmap section 5 row L9: one holding, first administrator plus four invited role accounts, and invitation arrival. A2L2/A3R1 established the holding/first admin; owner reports all four later invitations received (Outlook spam remains a quality finding); A4D1 established five profiles, accepted/confirmed recipients, correct current data_entry access and immutable initial-empty/later-added grant history. All five r004 sign-in/profile observations are owner-reported; the four invited members also report positive company reads. No first-admin company-list response is claimed. A5 viewer at 2026-11-02 04:07 Europe/Istanbul=01:07 UTC reports continuity/no laterdeploy, success/nameemailmatch/executive_viewer/TR/hostcorrect,/me+subsidiaries200,holdingIDs andonecompany/accessID/name correspondence. Original sanitized A5record frozen by /private/tmp/tonyai-r004-a5-original-observation-receipts.json SHAb6afd46d79b9ea6b895884e9e6096365a89476555eb46cb1b9f64d728662bd72; approval consumed. The owner later confirms the first-admin private identity match, closing the current A1gap; exact time/same-versus-later response is unspecified. Separate confirmation manifest /private/tmp/tonyai-r004-a1-later-confirmation-receipts.json SHA6922275168b52237322a488879a997bfeffcb856591c78e08dfc8d645632ddcd preserves the original NOT_OBSERVED record without backdating. This is a later combined milestone assessment, not a rewrite of frozen diagnostic l9_accepted=false flags or independent current image/context/submission-count proof. Source continuity a9476eb→7d3e2e9 in API onboarding/auth/mail/users/Prisma/shared types supports retaining original onboarding evidence; it is not fresh r004 SMTP proof. Fresh r004 mail/reset and EN/lifecycle/revocation/failure/retirement acceptance remain OPEN under existing L10/LP4-01 scope. Roadmap row L10 already owns workflow/evidence/Storage/exports/locks/isolation/audit/RBAC/TR-EN/monitoring/handover; none is marked passed. Numerical factor loading remains deferred under O6/LP4-02 until an authoritative release exists, never passed or replaced with demo factors. Outlook spam cause, historical A4D1 metadata/audit provenance, diagnostics destination, vault ACL and rollout/paused-qa findings stay open. LP2-HQ overall remains IN_PROGRESS. Owner preference is now a consolidated remaining checklist and one bounded reviewable batch, not per-role/per-click approval loops. No additional live test, resend, repair or reset is needed to close L9. This preference grants no undefined mutation/email/notification/state/ContainerApps operation. The Water 100 m³/year2026/monthlyNovember/wholecompany draft is an unexecuted/unapproved L10 proposal only, NOT a L9 prerequisite; keep /private/tmp/tonyai-r004-water-draft-q1ocxast preserved/deferred. Its350 targeted mock tests passed at 88b80b4 underNode 22.23.3 (2 files), no new test/source implementation or hosted mutation. Prior fullrepo checks remain earlier evidence, not rerun; APIintegration/RLS/fullinfra/manualselfhostCI not run for documentation/evidence-only follow-up. No commit/push. Refresh allowed evidence backup at this stop, forbidden IB1 area excluded.
