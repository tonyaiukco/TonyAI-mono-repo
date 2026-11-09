# Proposal

## Why

Hosted QA still serves from the generated `*.swedencentral.azurecontainerapps.io` hostnames and sends invitation and password-reset mail from the Azure-managed ACS domain. That mail lands in Gmail's spam folder (an L10 finding under Open questions), and the managed domain's 5/min and 10/h limits cannot be raised. The owner has bought `tonyai.io` (Namecheap; Google Workspace already runs its mailboxes), so LP2-04's email and custom-domain items can now be delivered on hosted QA. Production is out of scope (owner ruling, 2026-11-09).

## What Changes

- **Public hostnames.** Hosted QA gets `qa.tonyai.io` (web) and `api.qa.tonyai.io` (API), each with a free ACA managed TLS certificate. One optional `public_hosts` input drives every origin derivation: Terraform, the build, the candidate contract, smoke, session resources, the browser-key check and Supabase Auth. Without the input, behaviour is unchanged. The generated hostnames keep working. During the transition the API accepts both web origins, and Supabase Auth allows both.
- **Staged binding.** Hostnames are added with binding `Disabled`. Then the managed certificates are created in the foundation lane. Then the hostnames are switched to `SniEnabled`. Each step is a separate owner-run apply, after DNS has been entered at Namecheap.
- **Mail from the verified domain.** ACS verifies the root `tonyai.io` as a CustomerManaged domain (owner ruling: QA sends as `no-reply@tonyai.io`, no separate subdomain). A sender username replaces the fixed `DoNotReply`. The root SPF record gains ACS's include, and Google's MX, SPF include and DKIM stay as they are. DMARC (`p=none`, reports to `dmarc@tonyai.io`) was added by the owner on 2026-11-09.
- **Availability tests.** A workspace-based Application Insights component, used only for two standard availability tests (`/api/v1/health/ready` and `/login`, 3 EU locations, every 15 minutes), with a metric alert on the existing action group. There is no SDK and no application telemetry. This is an owner-approved exception to the earlier "no Application Insights" decision (2026-11-09).
- **Hosted no-demo check.** A read-only check that hosted QA holds no seed accounts (`@tonyai.local`), no demo organisation and no `DEMO_SOURCE` factor rows. This is the #259 follow-up.
- **DNS contract output.** Foundation outputs the records the owner enters: ACS verification, SPF, DKIM ×2, CNAME ×2 and `asuid` TXT ×2.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `qa-release-operations`: public hostnames and their single derivation, the staged TLS binding, the custom mail sender, availability tests in the monitoring readback, and the hosted no-demo check.

## Impact

- **Infra code:** `infra/terraform/foundation/` (environment export, managed certificates, sender username, App Insights component, web tests and alert, outputs), `infra/terraform/application/` (`customDomains`, origins, `APP_URL`), `infra/scripts/` (`terraform_run.py`, `candidate.py`, `qa_autodeploy.py`, `deploy_apps.py`, `session_resources.py`, `check_browser_key.py`, `supabase_auth.py`/`auth_settings.py`, `smoke-contract.mjs`, `monitoring_readback.py`, `check_terraform_policy.py`, `mail_settings.py`), `.github/workflows/deploy-qa.yml` (optional host variables), the example configs, and their tests.
- **Docs:** runbook 11 (cutover procedure and DNS table), `docs/architecture/` where hosting or observability is described, and the planning file (Decisions 2026-11-09, the LP2-04 card and ledger, Open questions).
- **Owner operations, outside the PR:** DNS entries at Namecheap, ACS domain verification, four foundation applies and two application applies, the Supabase Auth update, the GitHub `qa` variables, one QA deploy dispatch, and the mail acceptance (one invitation and one reset received in the inbox).
- **Users:** QA users sign in again once on the new host, because cookies are host-only.
- **Not affected:** application code paths, the Prisma schema, RLS, migrations, factors and the calculation path. Production is not touched.
- **Cost:** the managed certificates are free. Standard availability tests are billed per execution: about 17,500 executions a month, a few USD at the third-party-reported rate. The exact figure is checked before the apply.
