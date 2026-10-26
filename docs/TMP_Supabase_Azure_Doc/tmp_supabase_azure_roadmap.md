# TEMPORARY — QA on Supabase Cloud (Stockholm) + Azure Sweden Central

> **Temporary document.** A time-boxed bridge so the QA team can start while the
> self-hosted Sweden QA (R3 → R4 → application) continues in the Codex lane. It
> lives until **(1)** the first QA handover on the bridge is done and **(2)** the
> self-hosted Supabase on Azure has replaced the bridge; then the bridge is torn
> down and this folder is deleted (section 11). It is not a second status file:
> `docs/roadmap_docs/project_status_roadmap_phases.md` stays the one planning
> record (Decisions 2026-10-26, the bridge; ledger row LP2-QT).

| | |
|---|---|
| Created | 2026-10-26 (from a read-only drift check of `main` @ `fa620e6`; re-based on `42f5c07`, #248, on 2026-10-27) |
| Implementer | **Claude Code** (this lane). Codex continues R3, R4 and the self-hosted application path and never edits the bridge files |
| Target handover to QA | **2026-10-30** (Day 1 = 10-27, Day 2 = 10-28 half day, Day 3 = 10-30; 10-29 is off the owner's calendar) |
| Supabase | Supabase Cloud, **North EU — Stockholm (`eu-north-1`)**, Pro plan, PostgreSQL 17 |
| Azure | **Sweden Central (`swedencentral`)**, the **same subscription** as the self-hosted QA |
| Data | **Synthetic only.** No customer data, ever |

## 1. Why, and what does not change

The self-hosted route still needs about 28–42 working days against a 2026-11-15
QA target. The repo already holds a reviewed, never-applied **hosted-Supabase
path** (LP2-01…LP2-03, #139/#141/#143/#145; runbooks 00–05;
`infra/terraform/foundation` + `infra/terraform/application` — the legacy roots,
not their `qa/` subfolders; `bootstrap_backend.py`, `supabase_setup.py`,
`cloud_ops.py`, `build-images.sh`, `candidate.py`, `deploy-apps.sh`,
`release_secrets.py`, `cloud_smoke.py`). It already supports an **owner-run
first deployment from the owner's machine** (runbook 03); CI, GitHub OIDC, the
protected `staging` environment and the JIT runner are only for later deploys and
are skipped (`deployer_object_id` empty, `apps_ready=false`). The bridge
re-targets this path to Stockholm and Sweden Central and applies it.

**Unchanged — non-negotiable:**

- R3, R4 and their gates continue in parallel (Codex lane). Nothing here touches
  `r3_*`, `qa_*`, `selfhost_*`, `replacement_*`, runbooks 07/08/10, the r02
  host, the self-host VNet/subnets (including the delegated `10.80.2.0/23`), its
  NSGs, private DNS, its backend storage account or its Terraform state.
- `infra/config/deployment-policy.json` is **not edited** — its sha256 is bound
  into Codex's QA receipts — and `deployment_policy.py:9` stays verbatim (a
  mutation test pins it).
- Tenant isolation, RLS (enabled, never `FORCE`d), the `tonyai_runtime` login for
  the API, the append-only `audit_log`, RBAC, JWT verification (ES256 over JWKS)
  are exactly as in local and CI. `ALLOW_INSECURE_LOCAL_AUTH` is never set.
- The seed never runs against the cloud (`seed-guards.ts` refuses it, by design).
- No secret enters git or chat: secrets are typed at hidden prompts and live in
  the owner's password manager and the bridge's Key Vault.

## 2. Target architecture

```
QA testers ──HTTPS──▶ ACA app: <prefix>-staging-web (Next.js, NEXT_PUBLIC_* baked at build)
                         │
                         ▼
                      ACA app: <prefix>-staging-api (NestJS)
                         ├─ Supavisor pooler (IPv4) ─▶ Postgres 17 (Supabase, eu-north-1)
                         ├─ Supabase Auth (ES256 JWKS)
                         ├─ Supabase Storage: evidence · import-sources · report-artifacts (private)
                         └─ SMTP: Azure Communication Services Email relay (smtp.azurecomm.net:587, STARTTLS)

Azure, Sweden Central, same subscription — bridge resources only:
  tonyai-qatmp-tfstate  → its OWN backend storage account (Terraform state)
  tonyai-qatmp-apps     → ACR · Log Analytics · ACA environment (Consumption, NO VNet)
                          · Key Vault · managed identities · the two apps
                          · Email Communication Service + Communication Services (data location Europe)
                            + SMTP Username — Terraform (AzAPI), foundation root

Outside Azure Terraform (section 4): the Entra application that owns the SMTP
identity and its client secret; the Supabase Cloud project (reviewed scripts).
```

- **Separate Terraform backend.** The legacy roots write `foundation/staging.tfstate`
  and `application/staging.tfstate`. The self-host's backend account must not get
  them (`qa_network.py` forbids extra blobs there) and `bootstrap_backend.py`
  would otherwise adopt any `purpose=terraform-state` account and rewrite its
  firewall. So the bridge bootstraps its own backend group and account, and a
  guard pins `bootstrap_backend.py` to exactly that pair.
- **No VNet.** The legacy foundation's ACA environment has no `vnetConfiguration`;
  `selfhost_app_network.py` refuses only environments on the QA subnet or in
  `tonyai-staging-apps`, so a non-VNet environment in another group passes.
- **Names are fixed by the path:** the environment is `staging` and the apps are
  `<prefix>-staging-api` / `<prefix>-staging-web`. The prefix must **not** be
  `tonyai` (that is the self-hosted application's); proposed `tonyaiqt`.
- **Database connections go through the Supavisor pooler** (ACA egress is IPv4;
  Supabase's direct host is IPv6-only). `pooler.py` builds the URLs; the running
  API gets only the runtime `DATABASE_URL`, never the owner `DIRECT_URL`.
- **Default ACA hostnames** with managed TLS; no custom domain.

## 3. Isolation inside the shared subscription

| Fence | Rule |
|---|---|
| Resource groups | `tonyai-qatmp-tfstate` (backend) and `tonyai-qatmp-apps` (everything else). Never `tonyai-staging-apps` or `tonyai-staging-data*` |
| Name prefix | `tonyaiqt` — never `tonyai`; ACR and Key Vault names globally unique |
| Terraform state | The bridge's own backend account; the self-host account is never written or adopted |
| Network | No VNet, subnet, NSG, route table, private endpoint or private DNS zone |
| Role assignments | Scoped to the bridge groups and their resources; never at subscription scope |
| Subscription gate | **Narrowed by a new file**, `infra/config/hosted-qa-exception.json` (`subscription`, `resource_group`, `prefix`, `backend_resource_group`, `backend_storage_account`). `require_hosted_target(subscription, resource_group, prefix)` keeps line 9 verbatim and admits the listed subscription only on an exact match with the exception, never for the `tonyai-staging-*` groups or the `tonyai` prefix; the two legacy `variables.tf` validations mirror it; negative tests prove the self-host targets are still refused |
| Cost | A subscription budget alert covering the bridge |

## 4. Terraform scope (owner decision D5 = A, 2026-10-27)

**Every Azure resource of the bridge is Terraform-managed through AzAPI**, inside
the existing legacy foundation and application roots and under
`check_terraform_policy.py`'s rule that only reviewed `azapi_resource` types enter
state and **no secret enters state**. The Supabase Cloud side stays on the
reviewed scripts: the official `supabase/supabase` provider (1.11.0) covers only
the project and its settings, stores the database password in state (not
write-only), cannot create buckets, signing keys or database roles, and would be
thrown away with the bridge — the permanent QA and production use self-hosted
Supabase, which that provider does not manage.

| Managed by Terraform (AzAPI) | Outside Terraform, and why |
|---|---|
| Resource groups, ACR, Log Analytics, ACA environment, Key Vault, managed identities, role assignments (foundation root) | **Bridge Terraform backend** — `bootstrap_backend.py` creates the state account before any state exists |
| Container Apps `api` and `web`, their secrets references, probes, ingress (application root) | **Entra application + client secret** for the SMTP identity — a Microsoft Graph object, not an ARM resource; AzAPI cannot create it and a Terraform-made secret would sit in state. The owner creates it once (`az ad app create`, `az ad sp create`) and writes the secret straight into Key Vault as `smtp-password`; Terraform takes only the non-secret application (client) ID, service-principal object ID and tenant ID as inputs |
| **ACS Email:** `Microsoft.Communication/emailServices` (data location Europe), `emailServices/domains` (`AzureManaged`; a `CustomerManaged` domain when D2 adds one), `communicationServices` (data location Europe, `linkedDomains`), `communicationServices/smtpUsernames` (username, Entra application ID, tenant ID), the role assignment of the Entra service principal on the Communication Services resource — API `2026-03-18` | **Custom-domain DNS records** (verification TXT, SPF, DKIM, DMARC) — the domain's DNS lives at Namecheap, not Azure DNS; the owner publishes what the domain resource reports, then verification is triggered |
| | **Supabase Cloud** — project, Auth policy, buckets, ES256 key: `supabase_setup.py` / `cloud_ops.py` over the Management API (reviewed, journalled); database roles and passwords: runbook 05 |
| | **Data and releases** — Prisma migrations (`cloud_ops.py migrate`), onboarding, factor loading, image builds (`build-images.sh`): application operations, never infrastructure state |

The ACS resources hold no secret: an SMTP Username stores only the username and
the Entra IDs, and the sender address is read back from the domain's
`mailFromSenderDomain`. New AzAPI types are added to the policy allow-list with
tests, in PR-T1.

## 5. Findings that shape the plan (drift check, 2026-10-26)

| # | Finding | Consequence |
|---|---|---|
| F1 | ~13 hosted scripts and Terraform files pin Frankfurt (`eu-central-1`) / Germany West Central, plus ~20 test files and two `security.tftest.hcl` | PR-T1, mechanical but wide (~40 files) |
| F2 | The subscription gate refuses the shared subscription; the policy JSON is hash-bound into Codex receipts | PR-T1, the exception file above — never the policy JSON |
| F3 | Hosted setup creates only `evidence` and `import-sources`; the app also needs `report-artifacts` (20 MiB, PDF only) | PR-T2 |
| F4 | `runtime-role.mjs provision` refuses remote databases; the hosted handoff is runbook 05 (`CREATE ROLE … BYPASSRLS` privilege probe, then `\password tonyai_runtime`, `ALTER ROLE … LOGIN`, `runtime-role.mjs check`) | Works as designed; **the probe on Supabase Cloud is the go/no-go** (Day 1) |
| F5 | The seed refuses the cloud; the first super_admin comes from `pnpm onboarding provision --apply --allow-remote`, everyone else by **emailed invitation** | **SMTP is required** before QA accounts exist — Azure Communication Services Email, Terraform-managed (section 4) |
| F6 | Factors arrive only through the factor-release loader as `tonyai_factor_loader`; **no release file is in the repo** | QA starts with an empty library unless a release is loaded (section 7, D3) |
| F7 | `smoke-fixtures.mjs` writes `DE` geography; #248 (merged 10-26) narrowly changed it and `smoke-contract.mjs` for its separate `qa-sweden` target, keeping the hosted `staging` target distinct | PR-T2 re-checks the hosted `staging` target against the current schema; both files are now shared with Codex's Sweden adapter — one-slot shared files, changed only with the owner's slot |
| F8 | The legacy RG, environment and apps carry `prevent_destroy` | Teardown is a manual owner deletion (section 11) |
| F9 | Not provable from the repo: `eu-north-1` offered by the Management API for this org; the bundled `prod-ca-2021.crt` covering that region's pooler | Checked on Day 1 before anything else is built on it |

## 6. Work packages (PRs)

All PRs: a feature branch, green CI, the owner merges. PR-T1 touches the
deployment gate and the infrastructure path, so it gets the mandatory fresh-eyes
pass (`security-rls` + `qa-auditor` + `devops-cloud`) before it opens.

| PR | Branch | Scope | Size |
|---|---|---|---|
| **PR-T0** | `chore/qatmp-decision` | This document; the decision, lane split, ledger row and Next up in the status file; pointers in `CLAUDE.md`, `README.md`, `infra/README.md` | done in this change |
| **PR-T1** | `feat/qatmp-hosted-retarget` | F1 + F2 + ACS: regions to `eu-north-1` / `swedencentral` across the hosted scripts, Terraform, examples and tests; the ACS Email AzAPI resources of section 4 in the foundation root (inputs: Entra client ID, service-principal object ID, tenant ID, optional custom domain; outputs: SMTP username, sender address) with their policy allow-list entries and `security.tftest.hcl` cases (data location Europe, no secret in state or outputs, role scoped to the Communication Services resource only); the hosted-QA exception file, `require_hosted_target`, the mirrored `variables.tf` validations, the `bootstrap_backend.py` pin; negative tests (self-host subscription without the exception, `tonyai-staging-*` groups, `tonyai` prefix, the self-host backend account — all refused; the line-9 mutant still killed) | 1–1.5 days |
| **PR-T2** | `feat/qatmp-handover` | F3 + F7: the `report-artifacts` bucket in `cloud_ops.py` with tests; smoke fixtures re-checked; runbook banners pointing at the bridge; the QA handover runbook `infra/runbooks/11-qa-temporary-hosted.md` (URLs, account issuance, known limitations, reset, teardown) | 0.5 day |
| **PR-T3** *(D3 = a)* | `feat/qatmp-placeholder-factors` | A QA-only factor release file in the import contract's shape, built from the placeholder library and **labelled placeholder / not authoritative** in its source and version; `data-factors` + `qa-auditor` seats; loaded with the loader's dry run first | 0.5 day |
| PR-T4 *(only if needed)* | `fix/qatmp-*` | Fixes found during the live steps | — |

Total: **4 PRs** (T0–T3; T4 only if live steps need fixes), plus about **10 owner-run live operations** (section 9).

## 7. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | ~~Names~~ **Decided 2026-10-27:** groups `tonyai-qatmp-tfstate` / `tonyai-qatmp-apps`, prefix `tonyaiqt` | — |
| D2 | ~~SMTP provider~~ **Decided 2026-10-27: Azure Communication Services Email** (section 4; step 6a). Still open: the sending domain — an Azure-managed `*.azurecomm.net` domain (instant, but 5 emails/min and 10/hour per subscription, not raisable) or a verified custom domain (DNS records; 30/min and 100/hour, raisable) | Azure-managed domain to start on Day 2; add the custom domain as soon as its DNS verifies and switch `MAIL_FROM` to it |
| D3 | ~~Factors for QA~~ **Decided 2026-10-27: (a)** — a QA-only placeholder release (PR-T3), labelled placeholder / not authoritative in its source and version and on screen; replaced by the authoritative UK/TR release (LP4-02) when it exists | — |
| D5 | ~~Terraform scope~~ **Decided 2026-10-27: A** — all Azure resources, ACS Email included, in Terraform (AzAPI); Supabase Cloud stays on the reviewed scripts (section 4) | — |
| D4 | ~~Image build~~ **Decided 2026-10-27:** the existing, reviewed `build-images.sh` (local Docker buildx; amd64 emulation on Apple Silicon is slow and heavy on 16 GB, so stop the local Supabase stack first); `az acr build` only if the build proves too slow | — |

## 8. Step by step

**Owner** = consoles, credentials, applies (from the owner's machine). **Agent** =
Claude Code: code, PRs, dry runs, reading outputs with the owner.

### Day 0 — owner prerequisites (section 10)

### Day 1 (10-27) — code, Supabase project, go/no-go

1. **Agent — PR-T0** (this record). Owner merges.
2. **Agent — PR-T1** (retarget + exception), seats, then open; owner merges.
3. **Owner — Supabase project** in **North EU (Stockholm)**, Pro. Confirm F9
   (region offered; pooler TLS chain accepted by the bundled CA).
4. **Owner + Agent — the runbook 05 privilege probe** on the new project
   (`rolcreaterole`, `rolbypassrls`, storage USAGE/SELECT,
   `CREATE ROLE lp1_probe BYPASSRLS` inside a rolled-back transaction).
   **Go/no-go:** if Supabase Cloud refuses it, the bridge stops here and we decide
   with Supabase support — RLS and the tenant guard are never weakened to pass.
5. **Agent — PR-T2** (bucket, smoke, runbook 11), and PR-T3 (the labelled placeholder factor release).

### Day 2 (10-28, half day) — Azure, database, release

6a. **Owner — the SMTP Entra application** (once, outside Terraform — section 4;
    can start on Day 1):
    1. `az ad app create --display-name tonyai-qatmp-smtp`, then
       `az ad sp create --id <appId>`; record the application (client) ID, the
       service-principal object ID and the tenant ID for the foundation inputs.
    2. Create a client secret (expiry ≤ 90 days, noted for rotation) and write it
       **straight into the bridge Key Vault** as `smtp-password` once the vault
       exists (step 12) — password manager in between, never chat, never Terraform.
    3. Everything else — the Email Communication Service, the Azure-managed (and
       optional custom) domain, the Communication Services resource with its linked
       domain, the SMTP Username and the role assignment — is created by the
       foundation apply (step 7).
    4. For a custom domain: publish the verification, SPF and DKIM records the
       domain resource reports at Namecheap, then trigger verification and switch
       the release's sender to that domain.
    5. The release's `mail` block (step 10): host `smtp.azurecomm.net`, port `587`,
       `secure: false` (STARTTLS — the API enforces `requireTLS`), user = the SMTP
       Username output, from = the sender-address output.

6. **Owner — backend bootstrap**: `bootstrap_backend.py` with `location:
   swedencentral`, the bridge backend group and account, the owner's /32.
7. **Owner — foundation plan/apply** (legacy foundation root,
   `runtime_secrets_ready=false`), now including the ACS Email resources; read the
   plan first — only bridge resources. Save the contract output (with the SMTP
   Username and sender address).
8. **Owner — `supabase_setup.py`**: reconciles the project, Key Vault entries,
   `direct-url`, the three buckets, the Auth policy (public sign-up off) and the
   ES256 signing key. Management API token at the hidden prompt.
9. **Owner — runtime secret**: generate the runtime password
   (`openssl rand -hex 32`), `release_secrets.py store --project-ref …`.
10. **Owner — images**: `build-images.sh` (publishable key at the hidden prompt),
    `candidate.py`, then `release-r001.json` with `storage_cleanup_hold: true`.
11. **Owner — migrations**: `cloud_ops.py migrate` from a clean checkout at the
    release's `source_sha`; then `\password tonyai_runtime`, `ALTER ROLE … LOGIN`,
    `runtime-role.mjs check` against the runtime URL.
12. **Owner — SMTP secret** (the Entra application's client secret from step 6a, written directly, not through Terraform) into Key Vault as `smtp-password`; foundation re-apply
    with `runtime_secrets_ready=true` and `smtp_secret_ready=true`.
13. **Owner — deploy**: `release_secrets.py verify`, then `deploy-apps.sh`
    (interactive `yes`).

### Day 3 (10-30) — data, verification, handover

14. **Owner — factors** (PR-T3's release): loader dry run, then `--apply`, as
    `tonyai_factor_loader` (runbook 02's loader login).
15. **Owner — QA organisation**: `pnpm onboarding provision --apply --allow-remote`
    for one synthetic holding and its first `super_admin`; that admin invites the
    second `super_admin` (nobody approves their own record), `data_entry`,
    `consultant` and `executive_viewer` from the UI. Real tester emails; synthetic
    company data only.
16. **Owner + Agent — smoke**: `cloud_ops.py probe-storage`, `cloud_smoke.py`, then
    by hand: login per role; record create → submit → approve by the other
    `super_admin`; evidence upload and signed download; PDF and Excel export; a
    period-lock refusal; a cross-tenant read refused; an `audit_log` row per
    mutation; viewer and consultant cannot mutate; TR and EN render.
17. **Owner — monitoring**: a Log Analytics alert on api 5xx and restarts; Supabase
    daily backups (Pro) confirmed.
18. **Owner — handover to QA** with runbook 11: URLs, how accounts arrive, known
    limitations, bug reporting, the reset policy.

**Known limitations to tell QA:** factors are placeholders and are
labelled so — results are not authoritative; default Azure hostnames; the
environment may be reset with notice; it will be replaced by the Sweden
self-hosted QA and QA data will not be migrated.

## 9. Live operations (each owner-run and owner-approved)

| # | Operation | Day |
|---|---|---|
| L1 | Supabase project + F9 checks + runbook 05 probe | 1 |
| L1b | SMTP Entra application + client secret (step 6a; the ACS resources come with L3) | 1–2 |
| L2 | Backend bootstrap | 2 |
| L3 | Foundation apply (secrets not ready; ACS Email included) | 2 |
| L4 | `supabase_setup.py` | 2 |
| L5 | Runtime secret store + images + candidate | 2 |
| L6 | Migrations + runtime login + `check` | 2 |
| L7 | SMTP secret + foundation re-apply | 2 |
| L8 | Deploy | 2 |
| L9 | Factors (PR-T3's release) + QA organisation + invitations | 3 |
| L10 | Smoke + monitoring + handover | 3 |

## 10. Owner prerequisites (before Day 1)

1. ~~Decisions~~ all decided on 2026-10-27 (section 7).
2. **Supabase:** MFA on the account; the organisation's **ID and slug**; the **Pro
   plan** with billing approved (~$25/month); a **Management API personal access
   token** in the password manager. Do not create the project yet — Day 1 does it
   in **North EU (Stockholm)** together with the checks.
3. **Azure (same subscription):**
   - Tenant ID, subscription ID and the owner's **object ID**; the account holds
     **Owner**, or **Contributor + User Access Administrator**, on the subscription.
   - Register the providers `Microsoft.App`, `Microsoft.OperationalInsights`,
     `Microsoft.ContainerRegistry`, `Microsoft.KeyVault`,
     `Microsoft.ManagedIdentity`, `Microsoft.Storage`, `Microsoft.Communication`.
   - Permission to create a Microsoft Entra **app registration** in the tenant
     (for the SMTP identity).
   - Sweden Central Container Apps capacity in the subscription.
   - A budget alert.
   - The owner's public IPv4 (for the backend firewall /32).
4. **Email (D2):** decide the sending domain — Azure-managed to start, and, if a
   custom domain is wanted, DNS access to publish its verification, SPF and DKIM
   records. No third-party account is needed: everything is Azure Communication
   Services in the same subscription, created by Terraform (section 4).
5. **Local tools** (runbook 00): `az` logged in and `az account set` to the
   subscription; Terraform **1.13.3**; Node **22**; pnpm **11.9.0**; Python
   **3.10+**; Docker with buildx; `psql`.
6. **QA team inputs:** testers' names and emails and the role each needs.

## 11. Retirement

When the Sweden self-hosted QA (Codex lane) has passed R3, R4 and its application
acceptance and QA has moved:

1. Announce the cut-over date; no data migration.
2. Delete the bridge by hand (F8): the apps, the ACA environment, the ACS Email
   resources, Key Vault (and purge), ACR, Log Analytics, then the groups
   `tonyai-qatmp-apps` and `tonyai-qatmp-tfstate`; delete the SMTP Entra
   application.
3. Pause, then delete the Supabase project; revoke the Management API token; rotate
   anything else that was shared.
4. Remove the hosted-QA exception file and its code path, or keep the hosted path
   only if the owner decides it stays as a fallback.
5. Record the retirement in the status file; delete `docs/TMP_Supabase_Azure_Doc/`
   and the pointers to it (`CLAUDE.md`, `README.md`, `infra/README.md`).
