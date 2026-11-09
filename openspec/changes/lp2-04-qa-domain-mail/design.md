# Design

## Context

Hosted QA has two Terraform roots. `infra/terraform/foundation/` is applied by the owner. `infra/terraform/application/` is applied by the owner with `deploy-apps.sh`; on main merges, `qa_autodeploy.py` merge-patches only the image and the revision. Both roots use AzAPI 2.6.1 only (azurerm resources are forbidden, `terraform/README.md`), and every ARM type must be on the allowlist in `check_terraform_policy.py`.

Every public origin is derived today as `https://<prefix>-staging-<kind>.<default_domain>`. The derivation is copied, not shared, across Terraform (`application/variables.tf` `local.web_origin`), `deploy-qa.yml` (`API_ORIGIN`/`WEB_ORIGIN`), `candidate.py` (create/bind), `qa_autodeploy.py` (`bind_at`, `smoke`), `session_resources.py`, `check_browser_key.py`, `smoke-contract.mjs` and `supabase_auth.py`. The last two accept only the generated pattern. The web image bakes `NEXT_PUBLIC_API_BASE_URL` and its CSP at build. The API reads `WEB_ORIGIN` (CORS, a comma list) and `APP_URL` (mail links) at runtime. Cookies are host-only.

ACS already models a CustomerManaged domain. It is linked to the Communication service only when `custom_domain_verified` is set, and its `verificationRecords` are exported. The sender is fixed as `DoNotReply@<domain>`. GoTrue sends no mail on hosted. Monitoring is one action group, a log alert for `storage-verify` and API metric alerts. There is no Application Insights.

## Goals / Non-Goals

**Goals:** QA on `qa.tonyai.io` / `api.qa.tonyai.io` with managed TLS. Mail from `no-reply@tonyai.io` that passes SPF, DKIM and DMARC. Basic availability tests that alert the operator. A hosted no-demo check. All of it parameterised per environment and inert until its input is set.

**Non-Goals:** anything in production (owner ruling, 2026-11-09). A new deploy pipeline. Application telemetry or an App Insights SDK. Moving DNS off Namecheap. Changing Google Workspace's MX, its SPF include or its DKIM. Enforcing a stricter DMARC policy than `p=none`.

## Decisions

### D1. One `public_hosts` input, one derivation

- **The input.** The application root's `foundation` contract gains an optional `public_hosts = { web, api, bound }`. Each host must be a lowercase DNS name under `tonyai.io`; that parent domain is the one constant, kept in `infra/config/deployment-policy.json`. The web and API hosts must differ.
- **One derivation per language.** Python gets `public_origins(foundation)` in `terraform_run.py`, beside `validate_release`, and every Python caller uses it. `smoke-contract.mjs` mirrors the same rule.
- **Before binding.** While `public_hosts` is absent or `bound = false`, the origins are the generated ones, exactly as today.
- **After binding (`bound = true`):**
  - The public origins are the custom hosts.
  - `APP_URL` is the custom web origin.
  - `WEB_ORIGIN` lists both web origins, custom first. The generated hostname still serves, so an old tab or bookmark keeps working.
  - Supabase Auth's `site_url` is the custom web origin, and `uri_allow_list` holds the three paths for both origins.

*Why not keep the derivation in each script?* Five copies already disagree in their failure messages, and a hostname switch must move all of them at once. *Why `bound` and not "hosts present"?* The web image must not point at `api.qa.tonyai.io` before that host serves TLS.

### D2. Staged TLS binding

ACA issues a managed certificate only for a hostname that is already on an app, and only once its CNAME and `asuid` TXT resolve. So the binding takes three applies:

1. **Application, `public_hosts.bound = false`:** `ingress.customDomains = [{ name, bindingType = "Disabled" }]`.
2. **Foundation, `public_hosts.certificates = true`:** `Microsoft.App/managedEnvironments/managedCertificates`, one per host, named `<stem>-<kind>-cert`, with `subjectName` set to the host and `domainControlValidation = "CNAME"`.
3. **Application, `bound = true`:** `bindingType = "SniEnabled"`, plus `certificateId` built from the environment ID and the deterministic name. The application root never reads foundation state.

**Where things live.** The certificates are environment children, so they belong in the foundation lane. The deployer identity keeps only Reader and join on the environment. The environment exports `customDomainConfiguration.customDomainVerificationId`, and a new `dns_contract` output lists every record the owner enters (D5).

**Readback.** `deploy_apps.py` and `qa_autodeploy.verify` (through `comparable`) check that `customDomains` matches the stage exactly. Autodeploy's merge patch never sends `ingress`, so it preserves the binding.

### D3. Mail sender

- **Domain.** `email.custom_domain = "tonyai.io"` (the root, per the owner's ruling). A new `email.sender_username` (default `DoNotReply`) creates `Microsoft.Communication/emailServices/domains/senderUsernames` with display name `TonyAI`. `email_contract.sender` follows it.
- **Verification.** ACS needs Domain, SPF and DKIM ×2 verified before it sends. Verification is started outside Terraform (`az communication email domain initiate-verification`, one per record type), then `custom_domain_verified = true` links the domain.
- **Release side.** The application release's `mail.from` becomes `no-reply@tonyai.io`. `mail_settings.py` accepts a sender on a linked custom domain. `smtp-password` is unchanged.
- **Root SPF.** The root has exactly one SPF record, and it becomes `v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all`. The runbook says "edit, never add".

### D4. Availability tests

- **Component.** `Microsoft.Insights/components` (`kind = web`, `WorkspaceResourceId` set to the existing workspace, `IngestionMode = LogAnalytics`, `DisableLocalAuth = true`). No SDK writes to it.
- **Tests.** Two `Microsoft.Insights/webtests` of kind `standard`: GET `/api/v1/health` and GET `/login`, expecting 200, with an SSL check and a warning 7 days before certificate expiry. They run every 900 s from 3 EU locations (exact location IDs are confirmed from Microsoft's list during implementation), with retries on. Each test carries the required `hidden-link:<component>` tag.
- **What they target.** The custom hosts once `public_hosts.certificates` is set in the foundation config; until then, the generated FQDNs.
- **Alerting.** One `metricAlerts` rule per test, using `WebtestLocationAvailabilityCriteria` with `failedLocationCount = 2`, routed to the existing `operator` action group.
- **Readback.** `monitoring_readback.py` gains the three types in `VERSIONS` and checks that each test is enabled, targets the expected URL, and has its alert enabled and routed.
- **Cost.** Microsoft's pricing page did not render its rate. A third-party listing reports $0.0005 per execution per location. 2 × 3 × 4/h × 730 h ≈ 17,520 executions a month, about 9 USD. The plan is shown to the owner before the apply. The tests also wake the scale-to-zero web app every 15 minutes, which adds a small compute cost.

### D5. DNS contract

The `dns_contract` output contains only nonsecret records:

- the four ACS `verificationRecords` (Domain TXT, SPF, DKIM, DKIM2), mapped to Namecheap host and value,
- `qa` CNAME → `<stem>-web.<default_domain>`,
- `api.qa` CNAME → `<stem>-api.<default_domain>`,
- `asuid.qa` and `asuid.api.qa` TXT → the verification ID.

The SPF row is rendered as the merged value with the instruction to edit the existing record. Runbook 11 gets the same table.

### D6. Build and workflow

`deploy-qa.yml` gains optional `vars.QA_WEB_HOST` / `vars.QA_API_HOST`. `API_ORIGIN`/`WEB_ORIGIN` use them when set and fall back to today's expressions otherwise. `foundation_from_env` reads `WEB_HOST`/`API_HOST` into `public_hosts` with `bound = true`. The owner sets the variables only after step 3 of D2. The candidate contract, `bind_at` and smoke then agree by construction. `build-images.sh` is unchanged: it already takes `API_ORIGIN`.

### D7. Hosted no-demo check

`infra/scripts/hosted_no_demo_check.sql` is one read-only `SELECT` that returns a row per check (`seed_auth_users`, `seed_profiles`, `demo_organisation`, `demo_factor_rows`) with a count and `PASS`/`FAIL`. The owner runs it in the Supabase SQL editor or through the owner `psql` (runbook 05's container path on macOS). The identifiers come from `seed.ts` and `factor-library.ts`, and a unit test fails if they drift. No hosted sign-in attempt is made: the seed password belongs only to the `@tonyai.local` accounts, so zero such accounts is the stronger proof.

## Risks / Trade-offs

- **SPF edit mistake.** Two SPF records would break Google mail too. *Mitigation:* the runbook says edit, not add, and Claude checks the published record from Namecheap's nameservers before verification.
- **Shared domain reputation.** QA mail shares `tonyai.io` with business mail. This is accepted by the owner. Volume is low, and DMARC reports watch it.
- **Certificate issuance stalls** if the CNAME is wrong or proxied. *Mitigation:* Claude checks DNS before each apply. A stalled certificate leaves the `Disabled` binding harmless.
- **Re-login.** Host-only cookies sign QA users out once. They are told in advance.
- **Cost drift** from the tests. Bounded by frequency and location count; the plan is read before the apply.

## Migration Plan (owner-run, each step announced)

1. Merge (inert: no input set).
2. Foundation apply with `email.custom_domain = tonyai.io`, `sender_username = no-reply`, App Insights and tests on the generated FQDNs → read `dns_contract`.
3. Namecheap: enter the records. Claude checks them on the authoritative servers.
4. Initiate ACS verification. Once verified, foundation apply with `custom_domain_verified = true`.
5. Application apply (new `release_id`, same images) with `public_hosts.bound = false` and `mail.from = no-reply@tonyai.io`.
6. Foundation apply with `public_hosts.certificates = true` (tests switch to the custom hosts). Wait for the certificates to read `Succeeded`.
7. Application apply with `bound = true`. Run `supabase_auth.py` with the new origin.
8. Set the GitHub `qa` variables, then dispatch `QA deploy` (the web rebuild). Smoke runs on the custom hosts.
9. Acceptance: one invitation and one reset arrive in the inbox with SPF, DKIM and DMARC `pass`. The availability tests are green and the monitoring readback passes. The no-demo check passes. Re-pin `storage-verify` if the deploy produced a release candidate.

**Rollback:** an application apply with `bound = false`, or without `public_hosts`, restores today's origins. Clearing the GitHub variables plus a deploy restores the web build. The mail sender reverts through `mail.from`.

## Open Questions

- The exact availability-test location IDs for 3 EU locations, confirmed from Microsoft's list during implementation.
- Whether ACA requires the `asuid` TXT before the `Disabled` add (documented as yes). Claude checks DNS before step 5 either way.
