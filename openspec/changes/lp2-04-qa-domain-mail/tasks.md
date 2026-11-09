# Tasks

## 1. Public hosts and one origin derivation (D1, D6)

- [x] 1.1 Add the parent domain `tonyai.io` to `infra/config/deployment-policy.json`, and add `public_origins(foundation)` with `public_hosts` validation to `terraform_run.py` (optional key in the foundation contract; hosts under the parent domain, distinct, `bound` boolean)
- [x] 1.2 Switch `candidate.py` (create/bind), `qa_autodeploy.py` (`foundation_from_env`, `bind_at`, `smoke`), `session_resources.py` and `check_browser_key.py` to `public_origins`
- [x] 1.3 `smoke-contract.mjs`: accept a bound pair of custom hosts under the parent domain, replacing the `-staging-web.` → `-staging-api.` rewrite with an explicit pair check
- [x] 1.4 `supabase_auth.py` / `auth_settings.py`: accept the custom web origin; the allow-list carries both origins' paths when bound
- [x] 1.5 `deploy-qa.yml`: optional `QA_WEB_HOST` / `QA_API_HOST` with fallback to today's origins
- [x] 1.6 Tests: unit tests for each script's absent, unbound, bound and outside-domain cases; update the existing fixtures

## 2. Staged custom-domain binding (D2)

- [x] 2.1 Application root: `public_hosts` in the `foundation` variable (validated), `customDomains` per stage, `WEB_ORIGIN` / `APP_URL` from the bound origins, and the deterministic `certificateId`
- [x] 2.2 Foundation root: export `customDomainVerificationId`; `public_hosts` with a `certificates` switch; one `managedCertificates` per host
- [x] 2.3 `deploy_apps.py` readback of the custom-domain stage; confirm `qa_autodeploy` verification keeps the binding
- [x] 2.4 Allowlist `Microsoft.App/managedEnvironments/managedCertificates` in `check_terraform_policy.py`; tftests for the three stages

## 3. Mail from the custom domain (D3, D5)

- [x] 3.1 Foundation: `email.sender_username` and `senderUsernames` resource; `email_contract.sender` follows it; allowlist the type
- [x] 3.2 `dns_contract` output: ACS records mapped to Namecheap host and value (SPF rendered as the merged root record), CNAME and `asuid` rows
- [x] 3.3 `mail_settings.py`: accept a sender on the linked custom domain; tests

## 4. Availability tests (D4)

- [x] 4.1 Confirm the 3 EU location IDs and the current per-execution price from Microsoft's documentation
- [x] 4.2 Foundation: App Insights component (workspace-based, local auth off), two standard web tests with the `hidden-link` tag, two metric alerts routed to `operator`; allowlist the types
- [x] 4.3 `monitoring_readback.py`: versions and checks for tests and alerts; tests including a disabled test

## 5. Hosted no-demo check (D7)

- [x] 5.1 `infra/scripts/hosted_no_demo_check.sql`, read-only, one row per check
- [x] 5.2 Drift test binding its identifiers to `seed.ts` and `factor-library.ts`

## 6. Docs and planning file

- [x] 6.1 Runbook 11: cutover procedure (Migration Plan steps 1–9), DNS table, "edit SPF, never add", rollback
- [x] 6.2 Example configs (`foundation.example.json`, `application.example.json`, `supabase.example.json`), `terraform/README.md` (the App Insights exception), and `docs/architecture/` where hosting or observability is described
- [x] 6.3 Planning file: Decisions 2026-11-09 (domain, hostnames, sender, App Insights exception, QA-only scope, prod deploy removed from LP2-04), LP2-04 card and ledger, Current status, Next up, Open questions (Gmail spam now addressed by this change)

## 7. Verification and review

- [ ] 7.1 `terraform validate` and tftests for both roots, `check_terraform_policy.py`, Python and Node script tests, `pnpm typecheck` and `pnpm test`
- [ ] 7.2 Review seats in parallel on separate tree copies: `security-rls` (Auth allow-list, CORS, CSP, mail sender, hostname validation), `qa-auditor` (tests, negative cases), `devops-cloud` (Terraform, staging, readbacks); fix findings
- [ ] 7.3 Open the PR; the owner merges

## 8. Owner cutover (after merge; each step announced, Claude checks before and after)

- [ ] 8.1 Foundation apply: custom domain `tonyai.io`, sender `no-reply`, App Insights and tests on the generated FQDNs; read `dns_contract`
- [ ] 8.2 Namecheap records entered; Claude confirms them on the authoritative servers
- [ ] 8.3 ACS verification initiated and passed; foundation apply with `custom_domain_verified = true`
- [ ] 8.4 Application apply with `bound = false` and `mail.from = no-reply@tonyai.io`
- [ ] 8.5 Foundation apply with `certificates = true`; certificates `Succeeded`
- [ ] 8.6 Application apply with `bound = true`; `supabase_auth.py` with the new origin
- [ ] 8.7 GitHub `qa` variables set; `QA deploy` dispatched; smoke on the custom hosts
- [ ] 8.8 Acceptance: invitation and reset in the inbox with SPF, DKIM and DMARC pass; availability tests green; monitoring readback PASS; no-demo check PASS; `storage-verify` re-pinned if needed
- [ ] 8.9 Record the evidence in runbook 11 and the planning file; archive the change
