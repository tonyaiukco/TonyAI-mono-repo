# 11. Hosted QA operations and acceptance

This runbook is for the owner and assigned QA team. It prepares QA on Supabase
Cloud Pro, Stockholm (`eu-north-1`), and Azure Container Apps, Sweden Central
(`swedencentral`). It does not record a deployment or authorize a cloud action.
Use the [hosted plan](../../docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md)
L1–L10 and runbooks 00–06. The paused self-hosted route is not a fallback to run.

## Access and URLs

The owner distributes the **verified** web origin from restored foundation
`WEB_ORIGIN` / the selected candidate's `web_origin` (bound to the release) and
its `/login` URL. The API origin is that candidate's `api_origin` (`/api/v1`);
Supabase's project ref/origin
comes from the completed script-creation journal and actual L4a readback.
Compare all three with ARM, the selected image digests and smoke evidence.
Do not guess a hostname, use a local demo URL or share vault access with testers.

After L4a privilege acceptance, migrations, runtime checks and SMTP acceptance,
the owner uses [runbook 04 §4.6](04-verify.md#46-lp4-01-hosted-auth-and-first-organisation-owner-run)
to provision one synthetic holding and its first super_admin. That admin invites
the second super_admin, data_entry, consultant and executive_viewer, assigning
explicit subsidiary access to data_entry. Use individual accounts and private
invitations; never share passwords or reuse `@tonyai.local` demo accounts.

| Role | QA responsibility |
|---|---|
| First super_admin | Manage synthetic subsidiaries/users, author records; cannot approve own records |
| Second super_admin | Independently approve the first author's submissions and test locks |
| data_entry | Author/submit in assigned subsidiaries; foreign/unassigned access must fail |
| consultant | Review/read access; no record-authoring or approval privileges |
| executive_viewer | Read/export only; every attempted mutation must be refused |

Use a second synthetic holding for isolation acceptance. The automated smoke
creates two random-ID super_admin tenants itself; it does **not** issue QA team
accounts or prove the four-role matrix. Its Auth accounts are removed after each
run; application rows and append-only audit remain labelled smoke evidence.

## Acceptance checklist

Record source SHA, release ID, both image digests, timestamps and operator against
each result. An unchecked item is an open gate, not an assumed pass.

- [ ] L4a proves project region/version/pooler/CA and owner privileges before migration;
  post-migration owner reconciliation and runtime-role checks pass.
- [ ] `/api/v1/health` liveness and `/api/v1/health/ready` readiness pass; readiness
  includes all three private buckets. Liveness alone is insufficient.
- [ ] Exact-release `cloud_smoke.py` passes both tenants' login, own/foreign API
  and PostgREST reads, PDF/XLSX/CSV and browser download, final ARM readback and
  exact-ID Auth absence. Keep its ID journal for interrupted cleanup.
- [ ] Invites/password resets arrive via ACS; sign-in, expiry/replay refusals,
  role grants, disable/re-enable and account isolation match runbook 04.
- [ ] Create a factorless **Water** record, attach valid evidence, submit as its
  author, approve as the other super_admin. Reject own approval and non-author
  submission. Show `no_emission_factor` / “Not calculated”, never numeric zero.
- [ ] With no authoritative factor release, Electricity preview refuses with
  `404`, `code: no_factor` and coverage. A placeholder refusal or invented figure
  is a finding. Other categories are not automatically recordable without factors.
- [ ] Lock a period and prove write refusal. Reconcile one audit row per mutation
  and no update/delete of audit history. Test all four roles and foreign IDs.
- [ ] Evidence upload and 60-second signed download work; browser direct Storage
  access fails. `cloud_ops.py probe-storage` passes for evidence (10 MiB),
  import-sources (2 MiB) and report-artifacts (20 MiB, PDF only), all private;
  verify cleanup of the exact synthetic probe paths.
- [ ] Live PDF/XLSX/CSV respect the Scope 1/2 boundary: Water (Scope 3) is absent
  from ledger/totals/CSV, and PDF/XLSX disclose Scope 3 as “Not covered”. Covered
  factorless rows, where present, show “Not calculated”; do not fabricate one.
  Separately
  exercise retained dataset/report issuance and repeat download of the same PDF
  bytes from report-artifacts; live exports do not prove retained storage.
- [ ] TR and EN labels, errors, invitation/reset copy and exports are correct.
- [ ] Named operator receives/acknowledges monitoring tests; backups and storage
  byte recovery, maintenance and compatible rollback are evidenced in runbooks 04–06.

## Known limitations

Only synthetic data is allowed. Until LP4-02 delivers authoritative UK/TR factors,
QA tests workflow, permissions and reporting of missing calculations; it cannot
accept numerical emissions, factor standing or a factor appendix. Never enable
placeholder factors or load the demo seed to fill this gap. Default ACA hostnames
are intentional. Azure-managed mail has low service quotas; pace controlled
invitations and confirm current limits before a batch. SMTP failure remains a
failed onboarding result. CI OIDC adaptation is WP-6; initial rollout is owner-run.
Local tests do not establish cloud access, email delivery or recovery acceptance.

## Reset, maintenance and announcements

The owner approves each reset or deployment and names the affected environment,
scope, window, retained evidence and recovery path. Notify QA through the agreed
channel before the window and again when the exact release is accepted; pause
submissions meanwhile. Preserve bug evidence and the selected release/journals.
No broad cleanup script, seed, local RLS/E2E harness or audit deletion targets
cloud. A reset requires a separately reviewed recreation/retention procedure,
not a database reset command. Smoke cleanup deletes only matched random Auth IDs;
its retained application/audit rows are intentional. Failed cleanup blocks a pass.
Do not promise data retention across an announced synthetic-environment reset.

## Reporting a defect

Include environment/web origin, release ID/source SHA, time with timezone, role,
locale, reproducible steps, expected/actual result, HTTP status/error code and
request/correlation ID when available. Include synthetic record/subsidiary IDs
and export format where relevant. Redact screenshots and logs: no passwords,
tokens, invitation/reset links, signed URLs, secret versions' values, real personal
data or raw provider errors. Report suspected cross-tenant exposure privately to
the owner immediately, stop that test and preserve minimal sanitized evidence.

The owner signs QA availability only after L10 evidence and open-gate disposition;
this does not close the wider G2 recovery/recreation gates or approve production.
