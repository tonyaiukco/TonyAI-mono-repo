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

## R004 consolidated L10 acceptance package (prepared 2026-11-02)

This is the single remaining acceptance package, **NOT RUN / NOT APPROVED**.
It incorporates the deferred Water W1 proposal; do not execute W1 separately.
L9 onboarding is closed. Positive role reads do not prove write refusal or
isolation. Existing login/dead-link observations need no gratuitous repeat.
Preparation branch: `chore/hosted-r004-l10-acceptance`, base
`1530dba767f30a9e62b9393e1c72ccf190171c30` (owner merged #265).
Two local helper failure-path fixes were required by independent review: preserve unexpected Auth response IDs and journal exact Storage paths before uploads, including lost-response cleanup. No application, Terraform, migration, gate or factor change is proposed. The owner approved publication and both manual infrastructure workflows; their results are tracked in the central planning file. A clean reviewed launcher must still be bound.

### Fixed target and custody

- Release `r004`; application source
  `7d3e2e9c70846ed76d677fe72cff8ab831924192`.
- API `sha256:4126b6ce156625b987886884971183cdd83208c91d83dfe0fd1865fed1d27b68`;
  web `sha256:ded9a4f423a73388b8d4035b09f41c3ccd799187424327a50a5ef0a36db6a33f`.
- Existing r004 manifest SHA-256
  `bc2ec4e7c4a9c7e0c47766990d6a1496d444960aeadda266e34cb9f28904e667`;
  candidate SHA-256
  `472296c27c6be86c17ba721671d823c358c0db8ac567ad6600f304b5135b55a0`.
  `candidate-r003.json` contains the r004 source/digests; its filename is historical.
- Exact-source successful CI/E2E/Integration runs 41356114363 / 41356234839 /
  41356114333 are prior evidence, not freshly executed tests. Deploy helper
  `c8ca4af` and preparation `88b80b4`/`1530dba` are not runtime source changes.
- Preserve `storage_cleanup_hold=true`. No state access, apply, deploy, migration,
  seed, reset, broad deletion or paused-route operation. The narrow ARM GET
  exception in A is requested, not presumed. There is no image-attesting
  application health or `/me` field. Manifest and owner continuity declarations
  are not independent current ARM verification.
- Private execution envelope: `/private/tmp/tonyai-r004-l10-acceptance/`.
  Store target IDs, exact object keys, recipient bindings and receipts there,
  owner-only. Never record passwords, tokens, action URLs or signed URLs in
  receipts. Freeze each attempt's evidence; never rewrite original L9 receipts.
  Do not access the excluded IB1 evidence directory.

### Acceptance matrix

These statuses describe hosted acceptance, not source/mock coverage. Only L9
and offline target binding currently pass. Each live result needs UTC and
Europe/Istanbul time, actor, release/source/digests, operation ID, exact private
correlation and observed outcomes. An absent observation remains NOT_RUN.

| Control | PASS/FAIL/NOT_RUN/BLOCKED | Evidence / pass predicate | Remaining dependency |
|---|---|---|---|
| L9 synthetic onboarding | PASS | Combined assessment and later first-admin confirmation; five owner profile/login observations, four invited company reads | Outlook spam quality finding remains; no first-admin company-list proof |
| Offline r004 binding | PASS | Manifest/candidate hashes above, selected source/digests and hold agree | Current ARM verification still requires A |
| A: two-tenant exact-release smoke | BLOCKED | Before/after ARM match; own API/PostgREST controls and foreign denial; live PDF/XLSX/CSV and browser PDF downloads; exact Auth deletion plus absence | Fresh owner approval, published clean reviewed helper, Linux fixture/CA launcher and exact hidden owner/backend versions |
| B: Water/evidence/roles/locks/audit | NOT_RUN | Exact November tuple, author submit, independent approval, discriminatory refusals and complete exact-ID audit reconciliation | Owner approval; slot empty/unlocked and no blocking period records |
| C: private Storage and report outputs | BLOCKED | Size/MIME configuration, bounded object probes and absence, valid evidence, retained PDF identity, scope disclosures in TR/EN | Concrete boundary/MIME/absence probe adapter; existing exact inventory boundary ID; owner consent for committed freeze effects |
| D: fresh TR/EN mail, recovery and revocation | BLOCKED | Real inbox receipts, expiry/replay refusal, fresh recovery/sign-in, disabled/old/refreshed-token refusal, dedicated tenant retirement | Dedicated temporary recipient roster and approval; one existing Auth-only probe address is allowed for mail targeting only |
| D-failure: hosted Auth-sync recovery | BLOCKED | A controlled actual failure, pending state, bounded reconciliation and final Auth/app agreement | No safe hosted fault injection is approved; mock coverage does not close this row |
| E: missing-factor and remaining localisation | NOT_RUN | Electricity `404 no_factor` with coverage; Water uncalculated; remaining TR/EN UI/error/email/export observations | Owner approval for live requests; D for email |
| Numerical emissions | BLOCKED | Authoritative source/version and golden calculation acceptance | LP4-02 / O6; never load demo values or claim zero |
| F-read: backup/monitoring inventory | BLOCKED | Current daily backup schedule plus successful backup metadata, three-bucket byte-backup inventory and existing alert/job configuration | Exact resource/method read allowlist or owner-provided offline exports; inventory alone is not a delivery/drill PASS |
| F-live: alert delivery, recovery, maintenance, rollback | BLOCKED | Named operator receives end-to-end alerts; runbooks 04–06 operational evidence and compatible rollback/recovery | Isolated rehearsal and explicit cloud/network/job/deploy/rotation permissions; current constraints prohibit these operations |
| QA handover | BLOCKED | Owner accepts exact results and reasoned dispositions, names remaining blockers | A–F results/dispositions; handover is separate from full G2 recreation/recovery and production approval |

### One approval envelope, separately bounded operations

Approve only the named operations and the privately bound targets. There is no
blanket live authority. Stop the affected subpackage on an unexpected result,
ambiguous commit, collision, timeout, pending cleanup or changed deployment;
no alternative month, unlock, edit, resend, retry or repair follows implicitly.
Expected negative tests below are planned results, not an instruction to stop
on the expected refusal. Mandatory **already approved exact-target cleanup**
remains in scope on failure; never widen deletion to obtain a green result.
Independent unrelated operations may proceed only within the same approval.

**A — proposed `cloud_smoke.py`, one invocation after launcher qualification.** Use the frozen candidate and
release, a new exclusive private journal, and the exact owner-session secret
version (`--direct-secret-version`); do not select latest. The helper reads the
exact owner URL/backend key from Key Vault, verifies strict project/pooler/TLS,
then checks ARM before writing. The execution helper must be a clean reviewed source commit, distinct from r004 application source. Do not use this dirty preparation checkout or bypass source guards. Bind its hash, Node22/Playwright runtime and a known-working Linux Prisma/strict-CA fixture launcher before approval; previous native P1011 evidence prevents assuming the native fixture will work. Existing candidate.bind also requires the executing checkout to be the exact application source SHA: publishing later helper fixes alone does not satisfy r004. A separately reviewed helper/application-source binding adapter is still needed; never monkeypatch clean_source, edit the candidate, silently retarget r004 or deploy just to pass this guard. It creates two random synthetic Auth accounts
(no email send), two organisations, two subsidiaries and two profiles with six
create audits in one Prisma transaction. Browser credentials never receive the
owner URL/backend key. The no-mail `tonyai.test` fixture addresses are built-in
Auth fixtures, not invented delivery recipients.

The browser logs in once per fixture, checks `/me`, own/foreign subsidiary API
reads, list confinement and own/foreign PostgREST result counts. It downloads
PDF/XLSX/CSV over the API and a PDF through each browser download event. These
GET exports generate audit rows too: six direct exports plus two browser PDFs
mean eight `generate/report` audits, in addition to six provisioning audits.
It repeats ARM verification and always attempts cleanup of its two journalled
Auth IDs after matching ID/email/fixture metadata, then verifies absence. App,
profile, subsidiary, organisation and append-only audit rows remain by design.
No new `--cleanup-only` invocation is approved by an unsuccessful first run. The local fix stores only the returned UUID and match booleans before rejecting an unexpected create response; it never deletes an untrusted returned ID. Intended-ID cleanup does not resolve that discrepancy, and cleanup-only must not claim it does. Disk/journal or response ambiguity stops acceptance and preserves the prior intent.

Requested ARM exception: only API/web `containerapp show` and API
`containerapp revision list --all`, two rounds inside smoke plus one final round
after the other approved tests (at most nine ARM requests). No `listSecrets`,
replica listing, revision start/deactivate, Terraform state or mutation. This
verifier checks active revisions; it does not prove all inactive outgoing
processes are absent. A final mismatch invalidates exact-release acceptance.

**B — one Water record in the preserved QA holding.** Use existing private
cohort bindings, first super_admin as author, second super_admin as independent
approver, and consultant/viewer solely for planned role tests. Do not disable,
reset, resend or offboard any of these five accounts. Preconditions: exact
whole-company slot `2026/monthly/November/Water`, `locationId:null`, unoccupied
and unlocked. Record value `100`, unit `cubic_metres`, activityType null; the
quantity is synthetic activity, not a factor. Retain the existing W1 packet
unchanged as historical deferred evidence.

One `POST /activity-records` must return 201/draft/Scope 3,
`calculation.reasonCode=no_emission_factor` and no numeric tCO2e. Upload one valid
small synthetic CSV evidence file while draft. With valid scoped IDs and valid
bodies, make exactly one non-author submit attempt (403
`record_author_forbidden`), and one create/submit/approve/evidence-upload/lock
attempt for each consultant and viewer (ten refusals; role guards must be the
cause). Consultant can review/reject, capture datasets and issue partial reports:
blanket consultant-mutation denial would contradict the shipped contract.

Author submits once (200/submitted), then attempts self-approval once (403
`self_approval_forbidden`); other super_admin approves once (200/approved).
A review transition is optional in the product but is not in this operation's
mutation budget. Before locking, enumerate the complete exact company/year/month period, not just Water or one page. Require B Water to be the only record the lock can change; any other record or incomplete inventory stops the lock substep. Super_admin locks this same period once only after this check; never resolve unrelated records. The source updates all approved records in that period to locked. Require the new Water status locked, lock audit recordsLocked=1, and one lock row/audit, preserving immutable calculation bytes.
Repeat the valid Water create body once after locking: expect 409
`period_locked`, checked before the duplicate insert. Editing an already
approved record can fail another gate first and is not lock evidence. Leave
this synthetic record/evidence/lock in place; no unlock/void/delete cleanup.

For each stage, query `/audit?entity=...&entityId=<exact-private-id>` and page
through the complete filtered result (`total` must reconcile). Expected base
business audits: `create/activity_record`, `create/evidence`,
`submit/activity_record`, `approve/activity_record`, `lock/period_lock`, one
per successful logical mutation and none for the planned refused writes.
Correlate actor/time/diff, snapshot identity and object/Storage-intent side
effects; counts alone do not establish provenance. Use separate IDs for
evidence and lock. Never PATCH/DELETE audit to test append-only semantics;
source/local tests cover that invariant. UI page-local search is insufficient.

**C — Storage and TR/EN live/retained exports.** Read all three exact bucket
settings first: private; evidence 10 MiB with PDF/JPEG/PNG/XLSX/CSV; import-sources
2 MiB with CSV/XLSX; report-artifacts 20 MiB with PDF only. The existing
`cloud_ops.py probe-storage` performs one CSV/CSV/PDF upload, anonymous public
read refusal, 60-second signed byte download and exact-path DELETE per bucket;
it does not prove deletion absence, maximum-size rejection or invalid MIME
rejection. The local fix adds a private exclusive `--journal` (auto-created in
an owner-only temporary directory if omitted), records all exact paths before
requests and places the upload inside cleanup's try/finally, including a lost
upload acknowledgement. Deletion acknowledgement remains distinct from
absence (`absence_verified=false`). Do not approve the old unjournalled helper;
the new helper still needs publication/clean source and manual CI gates.

The supplemental boundary/MIME/absence probe is a preparation-only specification, BLOCKED until a concrete tested adapter and payload bindings exist. It must not be included in live approval by describing behavior alone. Its journalled private namespace requires: per
bucket at most four distinct paths (small valid object, exactly-limit valid
MIME object, limit+1 object, wrong-MIME object). At most 12 upload attempts,
no upsert, with exact-path cleanup only for this probe; absence checks use an
exact authenticated object read, not a public read of a private bucket. Stop on
unexpected acceptance/rejection. No listing/prefix deletion and no application
owned evidence/import/report object deletion. Bucket MIME checks are separate
from API file content checks: never claim arbitrary PDF bytes validated the
API's genuine PDF/content rules. Check mismatch and malformed PDF with the
API's existing refusal suites offline; live API negative probes, if approved,
are one mismatched-content and one malformed-PDF evidence request against B's
draft before submission, no metadata/audit/owned bytes on refusal. Size-limit
probes are sequential and rate/quota bounded, never parallel load tests.

Download the B evidence via `/evidence/:id/url`, verify `expiresIn:60` and byte
hash; test own access, foreign-tenant API refusal, anonymous and authenticated
non-signed direct Storage refusal, and signed expiry after 60 seconds. Never
store the URL in receipts. Keep adopted B evidence and issued PDFs intact.

After B, generate each live PDF/Excel/CSV once per language (six exports) as
an authorized reader; record browser download events as well as API MIME/body.
Water must not enter Scope 1/2 totals or the live CSV ledger; PDF/XLSX disclose
Scope 3 as Not covered (with the catalogue's TR equivalent). Uncalculated Water
is not a measured zero. CSV machine headers remain English as specified.

For the exact QA organisation/year, first read an existing exact `boundaryId` for the QA organisation/year and capture preflight. No such boundary is established by L9 evidence. If absent or unsuitable, stop retained-output acceptance; creating/editing a boundary is not authorized. Capture one dataset only if the owner explicitly accepts its freeze effect: `POST /report-datasets` can freeze an open inventory boundary
and adds `capture/report_dataset` plus conditional `freeze/inventory_boundary`. Freeze commits in its own transaction before dataset assembly/storage: a failed capture may still leave the boundary frozen, with no automatic unfreeze/repair. Read `/report-datasets/:id/issuance-preview` first, require server-derived `partial` and review the actual gaps; Water-only/excluded data and absent factors do not guarantee partial status. If preview is final or unclear, stop before issue. Issue at most one **partial** PDF per language (two `POST /report-issuances`,
`issue/report_issuance` audits), not a falsely final numeric report. Retained
records and objects are permanent acceptance artefacts; no cleanup. Download
each issuance PDF twice and compare bytes/SHA with its stored metadata; XLSX
and CSV once each must reconcile to that retained dataset. XLSX/CSV are produced
on request, not stored-byte identity guarantees. Audit live export generation as well as retained mutations; the six C live exports add six generate audits. Live `generate/report` rows have entityId:null: filter entity/action plus private actor/time interval, reconcile all pages and diff company/year/template/exportType. Do not apply an exact entityId predicate to these null-ID generation rows. All entity mutations still require exact entityId.
Foreign read probes use only the exact two A tenant IDs and the new B/C IDs,
only for subsidiary isolation in A. Do not extend A credential lifetimes or
recreate its deleted users. For B/C foreign record/evidence/dataset/issuance
reads, use D's authenticated disposable EN viewer before its disable/retirement:
first verify that viewer's own `/me` and own tenant dataset/issuance list succeed,
then request the exact B/C IDs and require scoped refusal without content.
Order: A; B draft; C API evidence negatives/download; B submit/approve/lock; C reports; D onboarding; C foreign negatives; D disable/retirement; final ARM. If D is blocked, these additional cross-tenant checks stay BLOCKED.
A alone proves subsidiary isolation, not evidence/report isolation.

**D — separate temporary lifecycle tenant, not the QA cohort.** The owner has
permitted the existing Auth-only probe address to be a mail target and supplied
the monitoring recipient privately; neither statement approves a send. A full
recipe needs a temporary bootstrap administrator plus distinct TR and EN API
invitees (three privately selected, owner-controlled addresses). The probe
address can fill one slot; two additional addresses remain unbound. Never
invent aliases or reuse the working cohort. Bind the legal name/operator,
roles (bootstrap super_admin, TR consultant, EN executive_viewer), exact
targets and collision dry run before D can be executable.

Proposed bounded recipe: one CLI dry run and one provision apply (bootstrap
invitation); administrator accepts/sets password/signs in; two r004
`POST /users/invitations` (TR/EN); retain one TR invitation unused for more than
its observed one-hour expiry, prove refusal, resend **once** via
`/users/:id/invitation/resend`, then accept and prove used-link replay refusal.
For each TR/EN invitee, request one r004 `/auth/password-reset`; let the TR reset
expire, prove refusal, request exactly one fresh TR reset, then recover TR with the fresh link; request the EN reset only after the TR expiry wait and consume it promptly. Prove replay refusal and fresh sign-in for each, without allowing the EN link to expire accidentally. Budget: at most eight email send attempts (bootstrap + TR/EN invitations + one planned resend + three initial/expiry-recovery resets + one EN reset after re-enable). Natural invitation and reset expiry requires one-hour waits; no Auth policy/time manipulation is approved. Space attempts to the actual ACS/r004 limits; 429/SMTP ambiguity stops,
not retries. Real delivery records kind/language/sender/origin/times and inbox
or spam classification; generic 202 and reset audit are not delivery proof.

On the disposable EN invitee only: capture a pre-disable session/token privately,
refresh once before disable to preserve a second stale-token specimen, disable
once and verify sign-in/API refusal; enable once, verify both pre-disable token
specimens stay refused after enable. After enable, attempt the old refresh token exactly once; if Auth issues a new access token, require API 401/session_revoked using earliest AMR; otherwise record Auth refusal without claiming a minted-token test. Both disable and enable rotate the password to an unusable value: request the budgeted fresh EN reset after enable, recover with a new password and prove fresh sign-in. The old password cannot be expected to work. Test a refresh
attempt after disable as its own expected Auth result; do not infer refresh
revocation solely from API refusal. Check no password-change email from ban
sync. Read exact profile/invitation audits and Auth-sync state. No forced Auth
failure is authorized; D-failure stays BLOCKED until an isolated approved method
exists. One offboard dry run + one apply retires only this newly returned
organisation, even after another D failure: require `applied=true`,
`offboardedAt` and `authPending=[]`. It retains organisation/Auth/audit rows,
disables members and revokes invites (D17). Nonempty pending is a stop requiring
a separately bounded recovery, not implicit reconcile/retry authority.

**E — no-factor and localisation.** One valid Electricity preview per language
(two read-like POSTs, no persisted calculation) must yield 404 `no_factor` and
correct coverage. A placeholder or numeric fallback is a finding. Observe
remaining TR/EN data-entry/errors, role refusals, reports and D emails as part
of the above journeys; keep previously observed login/dead-link screens as
prior evidence. Do not repeat account onboarding to fill catalogue cells.
Authoritative factor loading and numerical emissions remain LP4-02/O6 blocked.

**F — metadata inventory, unapproved; operational drills excluded.** The private
`f-arm-metadata-allowlist.json` binds exactly five one-attempt ARM GETs to the
frozen r004 subscription/resource group: the exact storage-verification job,
operator action group and storage alert, plus the group's metric-alert and
scheduled-query-rule metadata inventories. API versions follow the foundation
contracts; no nextLink traversal (truncation is BLOCKED), raw output stays
private. Security/RLS checked these bindings offline. This is a concrete
F_ARM_METADATA proposal, not execution authority or alert delivery evidence.
No log query, secrets call or execution-history traversal is included.
Prefer owner-provided private offline Supabase daily-backup exports; no
unbounded dashboard/Management API access is requested. Backup metadata must
show schedule and an actual successful backup, not merely the Pro tier. The owner-selected
operator's address stays private. No action-group Test, job start, alert-trigger
mail, missing-byte injection, resource configuration, rotation or network rule
change is included in this read scope. Check a successful daily DB backup;
DB backups omit Storage bytes, so evidence/import-source/report-artifact byte
recovery remains separate. Actual alert receipt/acknowledgement requires its own
concrete notification target and test operation within a future approved batch.

Runbooks 04–06 also require bounded DB/Storage loss and hung-flight recovery,
Sentry receipt, secret rotation, consistent DB+three-bucket byte recovery,
maintenance and old/new migration-compatible rollback/redeploy. Their needed
cloud mutation/deployment permissions conflict with this session's constraints;
leave them BLOCKED and prepare an isolated rehearsal after the owner supplies
its target, operator, RPO/RTO and permissions. No deploy merely to exercise #264.
QA handover may occur only after explicit owner acceptance of the remaining
dispositions; it never substitutes for full G2 recreation/recovery or production.

### Findings carried forward

Keep the approximately 2m40s deployment outage, roughly 40s observed overlap
and one-minute old-binary migration-compatibility allowance under LP5-03.
The #264 wait has no real-deployment proof; verify-only can transiently fail
right after apply. The paused qa_* drain/readback/null-secret-list issue remains
paused. Diagnostics destination=null, missing vault networkAcls, Outlook spam,
A4D1 audit/metadata provenance and undecided next-deploy ownership remain open.
No automatic repair or silent disposition is implied by this package.

### Local verification and review (not hosted acceptance)

At base `1530dba` plus the uncommitted preparation diff, in the reused
hosted-l9-diagnostic worktree, Node 22.23.3 `pnpm lint`, `pnpm typecheck`,
`pnpm build` and `pnpm test` exit 0. Lint has eight existing warnings; Turbo
replayed six typecheck/test and four build tasks, while E2E TypeScript executed.
Fresh offline helper checks: 61 Python tests and five Node smoke tests pass.
The default lost-upload-response cleanup and unresolved Auth cleanup-only
regressions fail behaviorally on archived `1530dba`; matching new tests pass.
Security/RLS, QA and DevOps independently accepted the local helper fixes and
corrected scope, with no remaining P0–P2 finding. They did not qualify live
execution, the Linux launcher, supplemental probes or cloud recovery. Journal
power-loss durability was not tested. Exact receipts/source hashes and review
summaries are private under the execution envelope above.

No API data-path change: API integration/RLS were not run. Because infra/scripts
and infra/tests changed, `selfhost-checks.yml` and `qa-infra.yml` must be dispatched
on the eventual pushed PR branch before merge, even though that route remains
paused. The owner has approved commit/push and both dispatches on this preparation
branch. Record the tested SHA and run links in the central planning file;
never substitute runs on old main. New helper
publication does not authorize cloud execution, application deploy or migration.
