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

## Functional QA intake — 2026-11-02

**Available for functional QA on the owner's expedited handover decision; L10
acceptance remains OPEN.** The owner approved the consolidated package, then
asked to deliver tonight with general verification and let QA return its bug
list. This releases the existing synthetic QA cohort to continue testing; it
never marks unexecuted acceptance controls as passed or authorizes arbitrary
QA tenant reset, factor loading or cloud operations.

Verified live web: https://tonyaiqt-staging-web.nicefield-3f0ba1ab.swedencentral.azurecontainerapps.io/login
API: https://tonyaiqt-staging-api.nicefield-3f0ba1ab.swedencentral.azurecontainerapps.io/api/v1
The live release remains **r004/source7d3e2e9**, with the exact digests below.
No r005/r006 deployment occurred. Keep the five existing individual QA accounts
and their current data; the owner distributes credentials privately.

The table records the initial intake before the separately authorized onboarding
operation below. Later provisioning does not close its unfinished acceptance tests.

| Observed control | Result / scope |
|---|---|
| Current ARM application binding | PASS: API/web images, source/revisions, HTTPS origins, runtime secret references and hold=true match r004 |
| Public web/API | PASS: login200, liveness200/ok, readiness200/ready, protected health endpoint401/unauthorized |
| Browser entry | PASS: empty login fields and Forgot password screen render; no reset submitted |
| Monitoring foundation | Applied exact saved plan:5creates only, no other changes; all5live readbacks match |
| Native API rules | Requests5xx and cumulative RestartCount rules enabled, exact API scope/operator routing verified |
| Operator Test | Owner confirms Test received; client request outcome was unconfirmed, so no duplicate was sent; exact delivery time not supplied |
| Scheduled verifier | Baseline job started once and observed Succeeded; hold=true/read-only verify. Structured Log Analytics matching returned0rows after3bounded queries: ingestion/alert chain remains unaccepted |
| Exact-source helper qualification | Clean cfb75e6 Linux Node22/Prisma/CA with network disabled PASS; not an application login smoke |
| A/D fixture and lifecycle journeys | NOT_RUN: owner-version metadata preflight unconfirmed; no retry, owner DB read or fixture creation followed |
| Workflow/Storage boundaries/reports/mail/rollback | Remain QA/owner acceptance work; no new records, application emails, lifecycle changes or maintenance deployments were executed |
| Backup metadata / wider recovery | NOT_RUN / OPEN; no Management token or recent backup result observed; no restore claim |

The owner subsequently requested two clean-start QA holdings and supplied two
new first-administrator targets privately. Both TR/TRY holdings now exist, each
with exactly one first super_admin and one initial TR invitation submitted.
Both read-only collision checks ran before writes; each target passed 13 strict
postchecks, 3 Auth identity matches, 1 SMTP acceptance and exact local-container
absence. Private evidence: `/private/tmp/tonyai-qa-two-holdings-1wlg2iy3/`.
No subsidiaries, sites, extra users, grants, activity data or factors were loaded.
The previous owner-connection precondition passed in this separate scoped
operation; the unexecuted old automated A–F proposal was not resumed.

The recipients now accept their invitations, choose their own passwords and
verify their own empty holding. Then they create companies/sites, invite their
role users and enter synthetic data from the UI. Invite a second super_admin
for independent approval: an author cannot approve their own record. An email
belongs to one holding; use distinct addresses for users in different tenants.
The existing five-person QA cohort remains untouched and separate. Do not run
account lifecycle experiments on those protected accounts or silently reset the
new intended QA owners. SMTP acceptance is observed; inbox arrival and fresh
sign-in await the recipients, not inferred from the sender's receipt.

Both holdings can support actual cross-tenant acceptance once QA has signed in
and created known owned objects in each; random-ID404s remain insufficient.
Workflow/evidence/roles/locks, TR/EN reports and isolation remain tests to execute,
not automatically passed by provisioning. Stop occupied/locked slots without
fallback or unlock. Authoritative numerical emissions stay excluded. Record bugs
using Reporting a defect; never include credentials or action/signed links.
[PR #266](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/266) was owner-merged
at `b59fac1`; main was synchronized and its merged branch deleted. This follow-up
records the completed onboarding. Publishing these documents performs no deployment,
account change or additional email submission.

## Acceptance checklist

Record source SHA, release ID, both image digests, timestamps and operator against
each result. An unchecked item is an open gate, not an assumed pass.

- [ ] L4a proves project region/version/pooler/CA and owner privileges before migration;
  post-migration owner reconciliation and runtime-role checks pass.
- [x] `/api/v1/health` liveness and `/api/v1/health/ready` readiness pass; readiness
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
failed onboarding result. Application deploys run automatically on merge (next
section); the staging/production CI path (WP-6) stays deferred.
Local tests do not establish cloud access, email delivery or recovery acceptance.

## Automatic deploy on merge

**Owner decision 2026-11-03:** QA is internal and fixes must reach it quickly, so
every merge to `main` whose **CI** workflow passes deploys to hosted QA with no
approval step, **migrations included**. E2E (nightly) and Integration
(path-filtered) are not gates for QA. `.github/workflows/deploy-qa.yml` starts on
the push itself and runs `infra/scripts/qa_autodeploy.py` on a GitHub-hosted runner
in the `qa` environment. It builds the images **while CI runs**, then waits for
CI; nothing touches the database or the apps until CI has passed for that exact
commit. Every Azure call is `az rest` at API version `2025-01-01`, with no CLI
extension. Measured on 2026-11-03, CI on `main` takes 3–7 minutes.

1. **head (before Azure login):** if a newer commit has reached `main`, the run
   stops without a token, because the newer commit deploys instead. If `main`'s head
   then fails CI, QA keeps the last deployed commit until the next green merge.
2. **plan:** skip when every file changed since the deployed source (the apps'
   `source` tag; `git diff --no-renames`) is under `docs/`, `infra/` (except
   `infra/certs/`, which the API image copies), `e2e/`, `openspec/`, `.github/`,
   `.claude/`, `.codex/` or a top-level `*.md`. A manual dispatch from `main` always deploys.
3. **build (in parallel with CI):** `build-images.sh` builds, pushes and scans
   both images at that SHA. `BUILD_CACHE=registry` reuses layers from
   `<registry>/tonyai/buildcache:{api,web}`; owner builds leave it unset. Image
   digests still come from the build itself. A manual dispatch builds without the
   cache. A red CI leaves pushed but never deployed images. To discard a suspect
   cache, run
   `az acr repository delete -n <registry> --repository tonyai/buildcache --yes`.
4. **CI gate:** `wait-ci` polls CI's latest push run for this exact SHA on `main`
   in this repository. Red stops the deploy; green re-checks that the commit is
   still `main`'s head and logs in to Azure again for fresh tokens.
5. **migrate:** the same pinned schema-engine transport as `hosted_migrate.py`
   (checksum-bound engine, read-only container, strict TLS). It reads **only**
   `direct-url`, at the exact version in `QA_DIRECT_URL_SECRET_VERSION`, then runs
   runbook 03's read-only `owner-check`. Any privilege problem, PUBLIC exposure or
   factor-library notice stops the deploy before rollout. The log reports
   platform-default findings for owner review. With no migration pending, zero are
   applied.
6. **rollout:** drain the API (one process for process-local quotas, so expect a
   1–2 minute API gap). JSON-merge-PATCH only the template (image digest and
   revision suffix `ci<run>-<attempt>`) and the `release`/`source` tags, then the web
   app. Each app must be ready on the new revision and identical to before apart
   from its image. Then the smoke check: liveness 200, readiness 200,
   `/api/v1/health/synthetic` 401, web `/login` 200. The forward rollout has a
   35-minute budget so the step keeps time to roll back.
7. **rollback:** any rollout, verification, smoke, budget or cancel failure
   redeploys the previous images (web first, suffix `…-rb`) and smoke-checks
   again. The run fails either way. `ROLLBACK INCOMPLETE` in the log names the app
   that still needs attention; recover with **Run workflow** on `QA deploy` from
   `main`. "Rollback applied but smoke is still failing" points at a shared
   dependency such as Supabase. Every `az` call has a 3-minute timeout. Do not
   cancel a running rollout step: GitHub kills the process within seconds, so a
   cancel or a step timeout can leave the API drained, and only a re-run repairs
   that.
   Migrations are not rolled back, so keep them additive (expand first, contract
   in a later release).
   Container Apps listings (revisions, replicas, apps) are read page by page:
   Azure pages revisions at 20, and each app keeps up to 100 inactive ones. Each
   `nextLink` must be the listing's own next page on `management.azure.com`, at
   the pinned api-version with a skip token. A foreign link, a repeated page or
   more than 20 pages is refused as an incomplete listing. Until 2026-11-10 any
   `nextLink` was refused: once the API app passed 20 revisions, run 42889302849
   failed with `Incomplete Container Apps listing` and `ROLLBACK INCOMPLETE for
   api`. That run left the new API image serving and the web on the previous
   release; a re-run was bound to fail the same way until the fix.

Migrations that runbook 03 gives an owner `owner-psql` preflight (for example
LP3-03) now apply without one. For such a migration, run its preflight before
you merge.

**Owner Terraform releases.** Terraform still owns every setting, but the live
image, revision suffix and tags now drift from its state, and azapi shows them as
an in-place update. Before you prepare or apply an owner application release,
disable the workflow, and enable it again afterwards:

```bash
gh workflow disable "QA deploy" -R tonyaiukco/TonyAI-mono-repo
gh workflow enable "QA deploy" -R tonyaiukco/TonyAI-mono-repo
```

**Disabling does not stop a run that has already started, so wait for it.** A
deploy or rollback that is running or queued keeps going after the workflow is
disabled, and an owner's Terraform apply is outside GitHub's `qa-deploy`
concurrency group. The rollout patches the template it read when it began: if the
owner's release lands in between, the patch writes the older template back over
it — the rollout then sees the difference and restores, and the settings the owner
added are gone (reproduced for a registration release: the secret stayed, the two
settings did not). After disabling, and **before exporting a manifest or planning**,
walk the whole run history of both workflows and print every run that is not finished:

```bash
for wf in deploy-qa.yml rollback-qa.yml; do
  gh api --paginate "repos/tonyaiukco/TonyAI-mono-repo/actions/workflows/$wf/runs?per_page=100" \
    --jq '.workflow_runs[] | select(.status != "completed") | "\(.id) \(.status) \(.head_sha[0:7]) \(.created_at)"'
done
```

It must print **nothing**. Three things make this the check, each learned the hard way:

- **By file name, not display name.** While a workflow is disabled its display name
  does not resolve (the note under "Freeze" below); `gh run list --workflow "QA deploy"`
  then fails instead of answering.
- **The whole history, not the latest runs.** `--paginate` reads every page, and each
  run's own `status` is tested. A list of the latest 20 filtered afterwards misses a
  long deploy that newer, finished runs have pushed off the page.
- **Not GitHub's `status=` filter.** On 2026-11-12 `…/runs?status=in_progress` answered
  a total of 1 for `deploy-qa.yml` an hour after its last run had completed, and 0 on
  six repeats. A count that can be stale in one direction is not trusted in the other.

The history is short (44 deploy runs on 2026-11-12); GitHub serves at most 1,000 runs
to one listing, which leaves room for years at this rate. If a run is printed, let it
finish — never cancel a rollout part-way, which can leave the API drained — and run
the check again. Only then export the manifest: one exported while a
deploy was still running describes a release that is about to change.

That release takes its digests and `source_sha` from the live `source` tag or the
latest `qa-candidate-<run>-<attempt>` artifact (public digests and migration
hashes only), uses a fresh `release_id`, and should find no migration pending.

**One-time owner setup — in this order.** The GitHub side needs a repository
admin; the Azure side needs the subscription owner. No client secret or GitHub
secret is created.

1. **GitHub first: protect `main`, then create `qa`.** CI is now the only gate
   between a push to `main` and QA, which includes migrations run as the database
   owner. On 2026-11-03, `main` had no branch protection and no ruleset.
   - Add an active ruleset on the default branch, with no bypass actors, that:
     - requires a pull request;
     - requires the CI jobs `build`, `docker-build`, `rls-probe` and
       `migration-diff`;
     - blocks deletion and force pushes.
   - Then create the environment `qa` with a deployment-branch policy of exactly
     `main` and no required reviewers. Do both before the federated credential
     exists: GitHub creates a missing environment with no branch policy the first
     time a workflow names it, and a branch workflow could then obtain the token.
   - Verify both, signed in to `gh` as a repository admin. Only admins can see a
     ruleset's bypass actors, so the check refuses anyone else.

   ```bash
   python3 infra/scripts/qa_autodeploy.py check-github
   ```

   The check asks GitHub which active rules actually apply to `main`
   (`GET /repos/{repo}/rules/branches/main`). It never interprets a ruleset's
   include or exclude patterns itself. Each required rule counts only when it
   comes from a ruleset with no bypass actors. A ruleset that targets the default
   branch but excludes `main` therefore fails the check.

   Limits to know:
   - A pull request with zero required approvals passes; PRs are required, not
     reviews.
   - A required check is matched by job name from any GitHub Actions workflow,
     so a PR could add its own job named `build`. This is a GitHub-wide limit of
     status-check rules.
   - The check runs once, here. Run it again after any change to rulesets or to
     the `qa` environment.

2. **Azure identity.** Create the identity once `check-github` passes:

   ```bash
   SUB='cb7efc2f-37a7-4672-b62c-93c207bcd33d'; REPO='tonyaiukco/TonyAI-mono-repo'
   ACR='<foundation registry_name>'; VAULT='<foundation vault_name>'
   APP_ID=$(az ad app create --display-name tonyai-qa-github-deploy --query appId -o tsv)
   SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
   az ad app federated-credential create --id "$APP_ID" --parameters "{\"name\":\"github-qa\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"subject\":\"repo:${REPO}:environment:qa\",\"audiences\":[\"api://AzureADTokenExchange\"]}"
   # Outside Terraform; record both. Only the migration secret, at secret scope:
   az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
     --role 'Key Vault Secrets User' \
     --scope "$(az keyvault show --subscription "$SUB" -n "$VAULT" --query id -o tsv)/secrets/direct-url"
   # az acr login looks the registry up through ARM; AcrPush has no registries/read:
   az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
     --role Reader --scope "$(az acr show --subscription "$SUB" -n "$ACR" --query id -o tsv)"
   ```

3. **Foundation grants.** Set the foundation input `deployer_object_id` to `$SP_ID`
   (it must be empty today; changing it moves every deployer grant) with
   `apps_ready: true`, then PLAN/APPLY as usual. Expect grant creates only:
   - AcrPush
   - Managed Identity Operator on both app identities
   - environment Reader and the custom join role
   - Container Apps Contributor on the two apps

   Container Apps may re-check the identity and environment links on a PATCH, so
   keep all of them.

4. **GitHub variables.** Add these environment variables to `qa`. They are public
   identifiers, never secret values:
   - `AZURE_CLIENT_ID` (`$APP_ID`)
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
   - `QA_RESOURCE_GROUP`
   - `QA_PREFIX` (`tonyaiqt`)
   - `QA_ACA_DEFAULT_DOMAIN`
   - `QA_ACR_NAME`
   - `QA_VAULT_NAME`
   - `QA_SUPABASE_PROJECT_REF`
   - `QA_SUPABASE_PUBLIC_KEY` (the browser key, never `service_role`)
   - `QA_DIRECT_URL_SECRET_VERSION`

   Rotating `direct-url` means updating that last variable. The repository is
   public, so run logs and the candidate artifact are public as well; they carry
   identifiers only.

5. **First run.** Click **Run workflow** on `QA deploy` from `main` and watch every
   step. Three behaviours are proven only live: the PATCH body, `az acr login` and
   web readiness. If the vault or the Supabase project restricts network access,
   the run fails at **migrate**; decide on the rule explicitly. The plan step reads
   `main` anonymously, so making the repository private needs a token there first.

## On-demand rollback

`.github/workflows/rollback-qa.yml` (**QA rollback**, owner decision 2026-11-04)
moves QA to the candidate an earlier **successful** QA deploy from `main`
published, or redeploys the live release under a new suffix. It changes images
only, through the same `rollout` as a deploy: drain, API then web, verify,
smoke, and automatic restore of the previous images on any failure. It never
migrates or builds. Disabling `QA deploy` leaves it available; the shared
`qa-deploy` concurrency group stops it from overlapping a deploy.

**Who:** the owner dispatches it. The accepted boundary (owner decision 2026-11-04) is the
same as `QA deploy`: any repository writer *can* dispatch it, but only main's own
successful deploy candidates can be served.

Dispatch it from `main` with the deploy **run ID** (the number in the run's URL,
not the run number) and a mode:

```bash
gh workflow run "QA rollback" -R tonyaiukco/TonyAI-mono-repo -f candidate_run_id=<deploy run ID> -f mode=candidate
```

- `fetch-candidate` (before any Azure token) accepts only a completed, successful
  `deploy-qa.yml` run on `main` of this repository and requires the downloaded
  `qa-candidate-<number>-<attempt>` to name that run's commit. A run that skipped
  published no candidate and is refused.
- `rollback` refuses before draining when the candidate's source is not on `main`,
  its provenance (migrations, lockfile, origins, registry) differs from its commit's
  git objects, it is already live (`candidate` mode) or it is not the live release
  (`same-image` mode), or **the migrations of the live source and the candidate
  differ in either direction**. Migrations are never rolled back.
- The new revision suffix is `rb<run number>-<attempt>`; the `source` tag names the
  candidate's commit. A failed rollback leaves the previous release serving.
- **Concurrency:** GitHub keeps at most one *pending* run per concurrency group.
  When a rollback is dispatched while a deploy runs, it replaces any pending push
  deploy, and a later push replaces a pending rollback. After a rollback, check the
  `QA deploy` history: if a pending deploy was cancelled, dispatch `QA deploy` from
  `main` once the drill is over. Since 2026-11-05 `QA deploy` runs on every merge
  again (owner decision), so check that no deploy is running or pending before you
  dispatch a drill.
- The migration guard compares migration chains in **code** (live source against
  candidate), not the database. If an earlier deploy migrated and then rolled its
  images back, the database is already ahead of both. The guard does not make that
  situation worse, and it does not detect it either. Check the deploy history before
  a drill.

**Drill (L10):** after a QA-fix release `ciN` deploys with no new migration,
announce two API gaps of about 2.5 minutes, then dispatch with `ci4-1`'s deploy run
(41738446426) and afterwards with `ciN`'s. Confirm each with `inputs` below. When
no compatible later release exists, dispatch `mode=same-image` with the live
release's run instead and record that a cross-version rollback was not rehearsed.
Since the freeze was lifted on 2026-11-05, LP4-02's migrations deploy as they merge.
Once one has deployed, no release is compatible with `ci4-1`, and the drill is
`same-image` (owner decision 2026-11-05).
Stop on the first failure; there is no automatic retry. Never target r004: it
predates automatic deploys and has no candidate artifact.

## Live release inputs and monitoring readback

The hosted probes take an inputs file describing the live release. Never write it
by hand; read it from ARM. Run as the owner after `az login`, from a clean checkout
of `main`, with the QA variables of the `qa` environment exported. The variable names
are the same as `deploy-qa.yml`'s job environment: `AZURE_SUBSCRIPTION_ID`,
`AZURE_TENANT_ID`, `RESOURCE_GROUP`, `PREFIX`, `ACR_NAME`, `VAULT_NAME`,
`ACA_DEFAULT_DOMAIN`, `SUPABASE_PROJECT_REF`. Then:

```bash
mkdir -m 700 -p ~/tonyai-evidence-backup/l10-ci4-1
gh run download <deploy run ID> -R tonyaiukco/TonyAI-mono-repo -n qa-candidate-<number>-<attempt> -D ~/tonyai-evidence-backup/l10-ci4-1/candidate
python3 infra/scripts/qa_autodeploy.py inputs --candidate ~/tonyai-evidence-backup/l10-ci4-1/candidate/candidate.json --out ~/tonyai-evidence-backup/l10-ci4-1/inputs-$(date -u +%Y%m%dT%H%M%SZ).json
python3 infra/scripts/monitoring_readback.py --hours 26
```

`inputs` refuses unless both apps serve one source and one revision suffix and the
images equal the candidate. It adds the live `mail` block (SMTP settings and the
`smtp-password` version), the live `registration` block when registration is
enabled (the `registration-code` version and the placeholder allowance) and
`runtime_limits`, recomputes the candidate from the
source commit's git objects, and runs the read-only release verifier before it
writes. The file is new (never overwritten) and mode 0600. It holds Key Vault
version identifiers, never values. Rerun it before every probe: a merge while QA
deploys are enabled moves the release.

`monitoring_readback.py` reads the environment's log destination, the
`container-logs` diagnostic setting, the console and system log row counts, the
`storage_verify` results, whether the `storage-verify` job runs the live API image,
the operator action group, and the three alert rules. It prints PASS/FAIL per link
with counts only and exits 1 on any FAIL. It changes nothing. A FAIL is fixed only
by an inspected foundation plan and owner apply (runbook 06). That same apply
re-pins the job to the live API image.

ARM reads `logAnalyticsDestinationType` back as `null` although the foundation
requests `Dedicated` (runbook 01), and Terraform sees no difference, so an apply
cannot change it. The diagnostic-setting link therefore prints the value and accepts
`null` only on measured routing inside the window: rows in both dedicated tables and
zero rows in `AzureDiagnostics`. Any other value fails. Every count must be exactly one
integer with no partial error, so a workspace without `AzureDiagnostics` fails closed.
This shows where the window's rows landed in the workspace. It is neither a `Dedicated`
readback nor proof of routing newer than ingestion latency.

## Public hosts and mail domain (LP2-04)

**Goal.** Hosted QA moves to `qa.tonyai.io` (web) and `api.qa.tonyai.io` (API), each with a free ACA managed certificate. Invitation and reset mail moves to `no-reply@tonyai.io` on the verified root domain. Two availability tests alert the operator. The design is OpenSpec `lp2-04-qa-domain-mail`.

**Production is out of scope.** Nothing here touches it (Decisions 2026-11-09, second).

**What stays the same.**
- DNS stays at Namecheap, and the owner enters every record.
- Google Workspace keeps the root MX, its SPF include and `google._domainkey`.
- The generated `*.azurecontainerapps.io` hosts keep serving throughout. Until step 7, nothing user-visible changes.

### Inputs (owner-local, never committed)

Each step names the field it flips. Everything else in the files stays as it was.

| File | Field | Final value |
|---|---|---|
| `foundation.json` | `config.email.custom_domain` | `"tonyai.io"` |
| `foundation.json` | `config.email.custom_domain_verified` | `false` → `true` at step 4 |
| `foundation.json` | `config.email.sender_username` | `"no-reply"` |
| `foundation.json` | `config.availability_tests` | `true` from step 2. It is opt-in, so no unrelated foundation apply creates the tests. |
| `foundation.json` | `config.public_hosts` | `{ "web": "qa.tonyai.io", "api": "api.qa.tonyai.io", "certificates": false, "monitored": false }`; `certificates: true` at step 6, `monitored: true` at step 9 |
| Application release manifest | `foundation.public_hosts` | `{ "web": …, "api": …, "bound": false }` at step 5, `true` at step 7 |
| Application release manifest | `release.mail.from` | `"no-reply@tonyai.io"` at step 5 |
| Application release manifest | `release.release_id` | a new value for each apply |
| `supabase.json` | `public_web_host` | `"qa.tonyai.io"` at step 7. The journal stays bound to the original five keys. |

### DNS records (Namecheap → Advanced DNS)

| Host | Type | Value | Source |
|---|---|---|---|
| `@` | TXT | ACS `Domain` record (`ms-domain-verification=…`), **added beside** `google-site-verification` | `dns_contract.email` |
| `@` | TXT (SPF) | **Edit the existing record** to `v=spf1 include:_spf.google.com include:spf.protection.outlook.com -all`. Never add a second `v=spf1` record. It ends in `-all` (Decisions 2026-11-10). | ACS `SPF` record |
| `selector1-azurecomm-prod-net._domainkey` | CNAME | ACS `DKIM` value | `dns_contract.email` |
| `selector2-azurecomm-prod-net._domainkey` | CNAME | ACS `DKIM2` value | `dns_contract.email` |
| `qa` | CNAME | `<stem>-web.<default domain>` | `dns_contract.hosts.web.cname` |
| `api.qa` | CNAME | `<stem>-api.<default domain>` | `dns_contract.hosts.api.cname` |
| `asuid.qa`, `asuid.api.qa` | TXT | the environment's verification ID | see below |

Read the selector host names and values from the output, not from this table.

The CNAMEs must point straight at the app hosts. An intermediate CNAME blocks certificate issuance.

`dmarc@tonyai.io` and `no-reply@tonyai.io` already exist as Google Groups. DMARC is `p=none` (added 2026-11-09).

Read the verification ID read-only. It is the same for every app in the environment:

```bash
az containerapp env show -g tonyai-qatmp-apps -n tonyaiqt-staging-env --query properties.customDomainConfiguration.customDomainVerificationId -o tsv
```

After each DNS change, Claude Code reads the records from Namecheap's own servers (`dig @dns1.registrar-servers.com`) before the next step.

### Cutover (each step announced; plan read before every apply)

**Before you start.**
- The `az communication` commands need the extension: `az extension add --name communication`.
- If `tonyai.io` ever gains CAA records, they must allow DigiCert, ACA's certificate issuer.
- After every foundation apply, run the plan once more. It must show no changes. A difference that is only ID casing goes to Claude Code; it is never re-applied blindly.

**The steps.**

1. **Merge the PR.** Nothing changes: no input is set yet, and `monitoring_readback.py` checks the availability links only with `--availability`.
2. **Foundation apply** with the custom domain, `sender_username`, `availability_tests: true` and `public_hosts` (`certificates: false`).
   - From now on, run `monitoring_readback.py --availability`. Between step 7 and step 9, and in the middle of a rollback after `monitored: false`, it reports the API availability test as FAIL. In that window the readback expects the public host while the test still targets the generated one. Re-run it after step 9.
   - The plan must add exactly this: the CustomerManaged domain, the App Insights component, one web test (the API's `/api/v1/health/ready`) and its metric alert. Nothing else.
   - `terraform_run.py foundation output` prints `application_contract`, then `dns_contract`.
   ```bash
   python3 infra/scripts/terraform_run.py foundation plan --backend .infra-local/staging/backend.json --inputs .infra-local/staging/foundation.json
   python3 infra/scripts/terraform_run.py foundation apply --backend .infra-local/staging/backend.json --inputs .infra-local/staging/foundation.json
   python3 infra/scripts/terraform_run.py foundation output --backend .infra-local/staging/backend.json --inputs .infra-local/staging/foundation.json
   ```
   Within 30 minutes the portal's Availability blade must show results for the test, still on the generated API host. If no result appears, the component's `DisableLocalAuth` is the first suspect: stop and report it.
3. **Enter the DNS records** from the table. Claude Code confirms them on the authoritative servers.
4. **Verify the domain in ACS**, one call per record type, then confirm all four are `Verified`:
   ```bash
   for t in Domain SPF DKIM DKIM2; do az communication email domain initiate-verification -g tonyai-qatmp-apps --email-service-name tonyaiqt-staging-email --domain-name tonyai.io --verification-type $t; done
   az communication email domain show -g tonyai-qatmp-apps --email-service-name tonyaiqt-staging-email --domain-name tonyai.io --query properties.verificationStates
   ```
   - ACS's SPF verification failed with Google's `~all`. The owner moved the root to `-all` (Decisions 2026-11-10), and then all four records read `Verified`. A service other than Google Workspace or ACS that sends as `tonyai.io` now fails SPF, so its include goes into the one root record first.
   - Then a foundation apply with `custom_domain_verified: true`. That apply links the domain and creates the `no-reply` sender.
5. **Application apply** (`deploy-apps.sh`, new `release_id`, same images) with `public_hosts.bound: false` and `mail.from: no-reply@tonyai.io`.
   - Disable `QA deploy` around it, as for any owner release.
   - Until step 7, an owner shell running `qa_autodeploy.py inputs` or a probe exports `WEB_HOST`, `API_HOST` and `HOSTS_BOUND=false`. Without them, the readback refuses the live `Disabled` domains.
   - Each app gains its host with binding `Disabled`, and the readback checks that stage.
   - Send one reset to a synthetic account. It must arrive from `no-reply@tonyai.io`, in the inbox.
6. **Foundation apply** with `public_hosts.certificates: true`. Then wait until both certificates read `Succeeded`. The output never refreshes state, so read them live:
   ```bash
   az containerapp env certificate list -g tonyai-qatmp-apps -n tonyaiqt-staging-env --managed-certificates-only --query "[].{name:name, subject:properties.subjectName, state:properties.provisioningState}" -o table
   ```
   The availability tests stay on the generated hosts. A `Disabled` host serves ACA's default certificate, which would fail the TLS check.
7. **Application apply** with `bound: true`. From here the owner shell drops `HOSTS_BOUND` (it defaults to `true`).
   - Both hosts switch to `SniEnabled`, `APP_URL` becomes `https://qa.tonyai.io`, and `WEB_ORIGIN` lists both web origins. The readback checks that exact list.
   - Then set `public_web_host` (it must equal the foundation's web host, whose certificate exists) and run runbook 02's `supabase_setup.py --reconcile-auth-only`.
   - Tell QA users they will sign in again once on the new host.
8. **GitHub `qa` environment:** set `QA_WEB_HOST=qa.tonyai.io` and `QA_API_HOST=api.qa.tonyai.io`, then dispatch `QA deploy`.
   - The web image is rebuilt with `api.qa.tonyai.io`, and smoke runs on the public hosts.
   - From now on, export `WEB_HOST` / `API_HOST` beside the other QA variables for `qa_autodeploy.py inputs` and `monitoring_readback.py`.
9. **Foundation apply** with `public_hosts.monitored: true`. It moves the availability test to `api.qa.tonyai.io`. Make it the same apply that re-pins `storage-verify` to step 8's API image (`monitoring.api_digest`).
10. **Acceptance:**
    - One invitation and one reset arrive in the inbox, not spam. The owner's written report is the evidence, and the headers show `spf=pass`, `dkim=pass` and `dmarc=pass` for `tonyai.io`.
    - `monitoring_readback.py` shows every link PASS, including the availability test on `api.qa.tonyai.io` and its alert.
    - The hosted no-demo check passes.

**Alerting.** An availability alert fires only when all three locations fail within 15 minutes. A deploy's short API drain therefore does not page the operator.

**Cost.** One test, 3 locations × 4 runs an hour: about 8,800 executions a month, a few USD. There is no web test (owner decision 2026-11-09, option B): it would keep the scale-to-zero web app warm for roughly 25–40 USD a month. Every QA deploy's smoke already checks `/login`.

### Hosted no-demo check

`infra/scripts/hosted_no_demo_check.sql` is a single read-only `SELECT`, so the SQL editor shows its rows. Run it in the Supabase SQL editor, or through the owner `psql` in runbook 05's Linux container on macOS. Every row must read `0` / `PASS`. A `FAIL` names what to remove, which is an owner-reviewed cleanup and never part of this runbook.

### Rollback

Undo in reverse order, one foundation or application apply per row:

| To undo | Do this |
|---|---|
| The tests on the public hosts | Foundation apply with `monitored: false` |
| The web build | Clear the two GitHub variables, then dispatch `QA deploy` |
| Public origins | Application apply with `bound: false`, or without `public_hosts` |
| The certificates | Foundation apply with `certificates: false`. Only after unbinding: a bound certificate cannot be removed. |
| The sender | Set `mail.from` back to the managed `DoNotReply@…` address |

- **Rolling back across the cutover.** `QA rollback` binds a candidate's origins to the live inputs, so it refuses a pre-cutover candidate (generated origins) once the GitHub variables are set, and the reverse. To return to a pre-cutover image, undo the public origins first (rows above), then roll back.
- **Renaming a host** follows the same order. Unbind it, remove its certificate, then add the new name.
- **DNS records** are harmless while unbound. If the QA environment is ever deleted, delete the `qa` and `api.qa` CNAMEs and their `asuid` records too, so the names cannot be claimed elsewhere.
- **Mail posture.** DMARC stays `p=none` until `dmarc=pass` has been observed. Moving to `quarantine` is an open question for the owner.

### Cutover record (2026-11-09 to 2026-11-10)

Hosted QA serves `qa.tonyai.io` and `api.qa.tonyai.io` with managed TLS and sends from `no-reply@tonyai.io`. Live release `ci27-1`: source `8fc3a9a`, API `sha256:a58bea76…`, web `sha256:b1be5df8…`. Receipts are private, under `~/tonyai-evidence-backup/lp2-04/`. Hashes are the first 16 hex characters of SHA-256.

| Step | Outcome | Receipt |
|---|---|---|
| 2 foundation | `4 added, 1 changed, 0 destroyed`: the CustomerManaged domain, the App Insights component, the API test and its alert, plus the recorded `join_grant` difference | `foundation-plan-step2.txt` `cedffb5001dea5fc`, `foundation-apply-step2.txt` `3bf0ebe18505c632` |
| 3 DNS | Every record read on `dns1.registrar-servers.com`. The root SPF ends in `-all` (Decisions 2026-11-10). | — |
| 4 verification and link | Domain, SPF, DKIM and DKIM2 `Verified`. `1 added, 2 changed, 0 destroyed`: the domain linked and the `no-reply` sender created. The re-plan shows only `join_grant`. | `foundation-plan-step4.txt` `0956dc1ec6fd007c`, `foundation-apply-step4.txt` `43317946d364a8a4`, `foundation-replan-step4.txt` `3fd6cc45434992e2` |
| 5 sender, hosts `Disabled` | Release `mail1-1` on `ci24-1`'s images, `0 added, 2 changed, 0 destroyed`. Verification and the unbound readback PASS. The reset arrived in the inbox from `no-reply@tonyai.io`, with SPF, DKIM and DMARC `pass` (owner's report). | `application-plan-step5.txt` `84c2977117f8c39e`, `application-apply-step5.txt` `0ecadd823697ffca`, `inputs-mail1-1-20261109T215052Z.json` `6659da207997819c` |
| 6 certificates | `2 added, 1 changed, 0 destroyed`. Both managed certificates `Succeeded` (CNAME validation). The re-plan shows only `join_grant`. | `foundation-plan-step6.txt` `6256e2d3d6bd9143`, `foundation-apply-step6.txt` `ed41d2d2b1e05812`, `foundation-replan-step6.txt` `b995d1c44b3daf81` |
| 7 binding and Auth | Release `host1-1`, `0 added, 2 changed, 0 destroyed`: both hosts `SniEnabled`, `APP_URL` `https://qa.tonyai.io`, both web origins in `WEB_ORIGIN`. `qa.tonyai.io` serves `CN=qa.tonyai.io` from DigiCert. Auth reconciled with `public_web_host` PASS. Sign-in and a reset on the new host worked (owner's report). | `application-plan-step7.txt` `77e237c77d77ada2`, `application-apply-step7.txt` `c8057de47e421b49`, `supabase-reconcile-step7.txt` `15c263f059102782` |
| 8 web build | `QA deploy` run 42710511127 → `ci27-1`: migrations 0, owner check PASS (10 platform-default findings), smoke PASS on the public hosts. The web's CSP `connect-src` names only `https://api.qa.tonyai.io` and the Supabase project. | the run's log |
| 9 monitoring | `0 added, 3 changed, 0 destroyed`: the test moved to `https://api.qa.tonyai.io/api/v1/health/ready` and `storage-verify` re-pinned to `ci27-1`'s API image. Execution `2okgbj9` `Succeeded`. Every monitoring link PASS. | `foundation-plan-step9.txt` `5204bd5068c0a469`, `foundation-apply-step9.txt` `369f9708e2740728`, `foundation-replan-step9.txt` `4968e4b52e14ec39`, `monitoring-step9-20261109T223524Z.txt` `0b07b5f7ae6c4191` |
| 10 acceptance | The API test's first results on `api.qa.tonyai.io` passed in all three locations (North Europe and West Europe 22:39, France Central 22:47 UTC; every result since 18:00 on the generated host passed too). An invitation arrived in the inbox from `no-reply@tonyai.io`, linking to `qa.tonyai.io`, with SPF, DKIM and DMARC `pass` (owner's report). The hosted no-demo check reads `0` / `PASS` on every row (owner's report). | — |

**Found on the way.**
- ACS's SPF verification failed with `~all`. The owner moved the root to `-all`.
- `.infra-local/staging/supabase.json` in the `hosted-qa-preflight` worktree is an unfilled template. The real configuration is L4's `supabase.candidate.json`, which equals the journal's target.
- A reset mail sent before step 7 keeps its generated-host link. Gmail threads it with later mails, so check a mail's own date before reading its link.

**Not claimed.** `dmarc=pass` has been observed, but DMARC stays `p=none` until the owner rules on `quarantine`.

## Reset, maintenance and announcements

Application deploys follow [Automatic deploy on merge](#automatic-deploy-on-merge) and need no per-deploy approval;
QA sees a short API gap on each one. For every other change, the owner approves each reset or deployment and names the affected environment,
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

## ci4-1 L10 acceptance (from 2026-11-04)

**This section governs L10.** The r004 package below is historical: keep its
evidence, but do not resume it. Planning (archived 2026-11-07): `openspec/changes/archive/2026-11-07-close-l10-hosted-acceptance/`; its spec: `openspec/specs/qa-release-operations/`.

**Scope (owner decision 2026-11-04).** L10 closes on functional and operational
acceptance of the live release. **Numerical** emissions acceptance belongs to the
LP4-02 gate. Consistent DB+Storage restore, secret rotation, Sentry and production
recovery belong to G2/LP5-03. Neither is claimed here.

**Evidence standard (owner decision 2026-11-04).** One owner approval covers the
whole package inside a declared freeze window; per-step sealed packets are retired.
Three rules still hold:

- Stop on any unexpected result, with no automatic retry.
- Keep secrets, passwords, tokens, invitation/reset links and signed URLs out of
  every record.
- Bind each result to UTC and Europe/Istanbul time, the source SHA, the release ID
  and both digests.

Receipts go to `~/tonyai-evidence-backup/l10-ci4-1/` (0700). The owner-DB version is
the `qa` variable `QA_DIRECT_URL_SECRET_VERSION`, which deploy run 41738446426
migrated with. The separate "single enabled version" metadata preflight is retired.

**Target.** Source `bdf7646230cc194ab984cac01a48164a819552c3`, suffix `ci4-1`,
API `sha256:efbbe12f092ab11c472e6e07751853491df412e7c731ebda11de78b0ec515c01`,
web `sha256:73b68708a1ef1e8628ae7ffe7eaf0c1600c0399e4e7e946752f9a68c15bbbbff`,
deploy run 41738446426 / artifact `qa-candidate-4-1`. Re-read it with `inputs`
before every operation; stop if it moved.

**Freeze.** Disable `QA deploy` before merging anything during acceptance, and
re-enable it only for an intended fix release:

```bash
gh workflow disable "QA deploy" -R tonyaiukco/TonyAI-mono-repo
gh workflow enable "QA deploy" -R tonyaiukco/TonyAI-mono-repo
```

While it is disabled, `gh workflow view "QA deploy"` and `gh run list --workflow "QA deploy"`
cannot resolve the name. Read the state with `gh workflow list --all` and the runs
with `--workflow deploy-qa.yml --all`.

**Session 1: automated probes (owner runs; helper SHA = the merged acceptance-tooling commit).**

1. Write the inputs file and run the monitoring readback
   ([previous section](#live-release-inputs-and-monitoring-readback)).
2. Pull the ci4-1 API image by digest once, because the probes never pull. Use a
   clean checkout of `bdf7646` as the application source.
3. Run the probes:
   - **A, two-tenant smoke:** `hosted_smoke.py --helper-sha <sha> --application-source <checkout> --candidate <candidate.json> --inputs <inputs.json> --journal <receipts>/smoke.json --direct-secret-version "$QA_DIRECT_URL_SECRET_VERSION"`.
     Run `--verify-only` first. Wake the web immediately before the run with one
     `curl` of its `/login`: the web app scales to zero, a cold load took 26 s
     (measured once, 2026-11-04), and Playwright's default navigation limit is 30 s.
     Run the probes from the main checkout, which holds the Playwright dependency; it
     must stay clean and at the helper SHA, so record results in another worktree.
     Each journal or receipt name works once, except that `--cleanup-only` reuses its
     journal. A repeat stops before writing to QA, though it may already have read the
     vault and ARM, and needs a new name and the owner's word.
   - **C, Storage:** `hosted_storage_probe.py` with the same helper, source,
     candidate and inputs, and `--journal <receipts>/storage.json`. Its hidden prompts
     take the browser key and one owner-approved synthetic QA account's UUID and
     fresh access token, held in memory only. The probe changes no account.
   - **Backup metadata:** `hosted_backup_evidence.py` with the same flags and
     `--receipt`. It needs a hidden `backups_read` Management token and records
     metadata only; no restore is claimed.
4. On a readback FAIL, inspect a foundation plan that fixes routing and re-pins
   `storage-verify` to the live API image. Apply it only on the owner's word, then
   read back again.
5. Hand [the QA checklist](../../docs/uat/l10_hosted_acceptance.md) to QA with the
   two new holdings and the defect process.

**Session 2.** Map QA's report to the checklist's row IDs. Since the freeze was lifted
(2026-11-05), also map each finding to the release that was live when it was made
(deploy run and revision suffix). Then triage it: correctness,
security and data-integrity defects are fixed; the rest go under Open questions. Then:

1. Run the [rollback drill](#on-demand-rollback).
2. Run one controlled alert test, chosen from the readback, with operator
   acknowledgement.
3. Rerun A on the final release.
4. Record the results below.

| Control | State (closed 2026-11-07, final release `ci17-1`) | Closing evidence |
|---|---|---|
| Live binding / ARM | PASS | `inputs` 10:02 UTC / 13:02 Europe/Istanbul: `rb1-1` (= `ci17-1`'s images), source `d2a5f9b`, API `sha256:c3a2d20c…`, web `sha256:3e2ee87b…` |
| A two-tenant smoke | PASS on `rb1-1`, 10:03:03–10:04:37 UTC / 13:03:03–13:04:37 Europe/Istanbul (owner-run) | `l10-ci17-1/receipts/smoke-20261107T100236Z.json.passed.json` (`84efd39de6363a3f…`) |
| C Storage probe | PASS (Session 1, `ci4-1`) | storage receipt + exact-path cleanup |
| Backup metadata | PASS (Session 1, `ci4-1`) | backup receipt (no restore claim) |
| Log → alert chain | PASS: one failing `storage-verify` execution (exit 2, 09:59:40 UTC) → alert Fired 10:04:24 UTC / 13:04:24 Europe/Istanbul → operator acknowledged | execution `…-4xymmp9`; alert history; owner's acknowledgement in chat |
| Hosted checklist (lifecycle, roles, lock, audit, evidence, reports, TR/EN, no_factor, mail, isolation) | PASS: 41 rows, RP-03 N/A, run by Claude Code on `ci17-1` (task 8.8); QA's own findings dispositioned (8.1) | `l10-checklist/results-r2.jsonl` |
| Rollback drill | PASS, same-image (cross-version not rehearsed: LP4-02 migrations) | `QA rollback` run 42361513330, suffix `rb1-1`, digests unchanged, smoke PASS |
| Numerical emissions | Out of scope → LP4-02 (DONE; owner's five hosted checks on `ci16-1`) | — |
| Full recovery | Out of scope → G2/LP5-03 | — |

**L10 CLOSED (2026-11-07).** Closure criterion (owner decision 2026-11-06): 8.4, 8.5 and 8.6 PASS, 8.8 complete, every QA finding dispositioned. Known after closure: the `storage-verify` job still runs `ci4-1`'s API image (a foundation apply re-pins it; Open questions); its alert stays fired until the test's failing row leaves the 26-hour window.

**Session 1 evidence (2026-11-04, helper `139235c`, release `ci4-1`, source `bdf7646`,
both digests above; times UTC / Europe/Istanbul; receipts in
`~/tonyai-evidence-backup/l10-ci4-1/receipts/`, with `session1.log` beside them):**

- **Freeze:** `QA deploy` reads `disabled_manually`; no deploy run exists for `139235c`.
- **Binding:** `inputs` matched the target before every operation.
- **A, first attempt, 16:43:46–16:45:10 / 19:43:46–19:45:10: STOP, not accepted.** The fixtures
  were created, then the browser step failed. The probe withholds its error by
  design. Likely cause, inferred and not proven: the web scaled from zero. Its replica
  was created at 16:44:38, Next.js was ready at 16:44:55, the API logged only the
  expected anonymous 401, and Auth logged no `/token` request, so the browser never
  submitted the sign-in form. An exact-ID `--cleanup-only` then exited 0.
- **A, second attempt, 16:57:45–16:58:46 / 19:57:45–19:58:46: PASS** after waking the web
  (`smoke-2.json.passed.json`, SHA-256 `850708d21e4598f7…`): ARM before and after, browser
  sign-in and download, PDF/XLSX/CSV, two-tenant API and PostgREST isolation, exact Auth
  cleanup. **Retained by design from both attempts:** four `LP2 smoke` organisations with
  their subsidiaries, profiles and audit rows.
- **C, 17:00:32–17:07:02 / 20:00:32–20:07:02: PASS** (`storage.json` `759aa17ba0c53107…`,
  `objects.json` `829fa5a76685d8a4…`), using an owner-selected QA account other than
  `executive_viewer`: three private buckets, size and MIME refusals, signed expiry,
  anonymous and selected-account denial of non-signed reads of the probe's own objects,
  and deletion plus absence for all 12 exact paths. Isolation between holdings stays with
  the QA checklist. A repeat at 17:08:21–17:09:20 reused the
  receipt name and stopped at the repeat guard, with no new container directory and no
  change to the receipt, so it wrote nothing to Storage.
- **Backup, 17:11:43–17:13:23 / 20:11:43–20:13:23: PASS** (`backup.json`
  `9b65471d9c84ac3a…`): seven completed backups, the latest inserted 2026-11-03 23:20:32
  UTC, region `eu-north-1`. Metadata only; no restore claim.
- **Monitoring:** the first readback (17:14:41 / 20:14:41) failed two links: the job image
  and the destination type. The foundation apply at 17:18:58 / 20:18:58 (`0 added, 2 changed,
  0 destroyed`; `foundation-apply-1.txt` `b03723855d81e086…`) moved `storage-verify` to the
  ci4-1 API digest and re-sent the recorded `join_grant` spelling difference, with the same
  role GUID. The second readback (17:20:09 / 20:20:09) failed only the diagnostic-setting
  link. Its output did not print why; an ad hoc ARM GET and KQL count at about 17:21 UTC read
  a `null` destination type and 0 `AzureDiagnostics` rows. The corrected check, run from
  this branch before merge (17:36 / 20:36, `monitoring-branch-20261104T173627Z.txt`
  `9fc32f88934c3443…`), prints both values and passes all 11 links. The rerun from merged
  `main` `8f327c8` (20:28 / 23:28, `monitoring-20261104T202835Z.txt` `bacfdc5f59dda7c0…`), with
  `inputs` matching ci4-1 just before it, also passes all 11 and closes task 7.6. The one
  `storage_verify` result in that window came from the job's r004 image; the first ci4-1
  result is due after 02:00 UTC / 05:00 Europe/Istanbul and is not yet observed.
- **QA handover:** the owner sent the checklist and the defect process to QA on 2026-11-04.
  The holdings are Arda Test Holding and Emre Test Holding. QA reports its findings to the
  owner in its own format, and no window or sign-off date is recorded (owner decision).

## G2 closure (2026-11-08)

G2 is met on hosted QA. Live release `rot1-1`: `ci17-1`'s images (API `sha256:c3a2d20c…`, web
`sha256:3e2ee87b…`), source `d2a5f9b`, runtime secret version `b4ca2b9d…`. Planning (archived):
`openspec/changes/archive/2026-11-08-close-g2-hosted-staging/`. Receipts are private, under
`~/tonyai-evidence-backup/g2/receipts/`; hashes below are the first 16 hex characters of SHA-256.

| Drill | Outcome | Receipt |
|---|---|---|
| 2a foundation re-pin and recreation readback | `0 added, 2 changed, 0 destroyed`: `storage_verify` image and the recorded `join_grant` difference | `foundation-plan-2a.txt` `63b30c96f2471459`, `foundation-apply-2a.txt` `2ff98f84e8ac1946` |
| 2a job on the new image | Execution `m2lvjtx` `Succeeded`; every monitoring link PASS | `monitoring-2a-20261108T152845Z.txt` `5eed11adb394159d` |
| 2b new runtime identity and privileges | `tonyai_runtime` on both; privileges as intended | `rotation-identity-20261108T214207Z.txt` `4b6b20bc58e88fa5` |
| 2b deploy | `0 added, 2 changed, 0 destroyed`; readback PASS; readiness 200 | `application-plan-rot1-2.txt` `4fe6a6881326359b`, `rotation-deploy-20261108T214559Z.txt` `f4130a53295cf058` |
| 2b job on the new version | Execution `a0m5bsm` `Succeeded`; every monitoring link PASS | `foundation-plan-rot1.txt` `e01462dfd18a6a9e`, `rotation-foundation-apply-20261108T215247Z.txt` `6d21962f3bd348b4`, `monitoring-rot1-20261108T215854Z.txt` `5f51cf6de381239d` |
| 2b probe A on `rot1-1` | PASS: two-tenant login and exports, cleanup included | `smoke-20261108T215659Z.json` `20dde30a7f4d0677` |
| 2b old password | `FATAL: password authentication failed` through Supavisor; new version connects; old version disabled | `rotation-old-refused-20261108T215944Z.txt` `cbbc22b07c80e509` |
| 2c Sentry | CLI exit 0 from the live image. Owner's report: event, release and environment visible in the EU region, alert email received | `sentry-check-20261108T220910Z.txt` `3850a717aba017d5` |
| 2d dependency loss, local | Results in [runbook 06](06-operations.md#readiness-and-authenticated-synthetic-checks) | `dep-loss-20261108T222114Z/report.txt` `23e78459a8837680`, `sink.txt` `cd9947becb500746` |

**Not claimed.** A consistent DB+Storage restore (LP5-03), ACA ingress during an outage, and
how ACA restarts a failed boot. The first scheduled job run on the new version is due at 02:00 UTC
on 2026-11-09. Backups were not restored; RPO and RTO are targets until LP5-03 measures them.

### Rotating the runtime credential on hosted QA

Runbook 05's order, with these hosted specifics. Run from a clean checkout at the live source.

1. `gh workflow disable "QA deploy" -R tonyaiukco/TonyAI-mono-repo`, then wait until no `QA deploy`
   or `QA rollback` run is running or queued ("Owner Terraform releases", above).
2. Write a manifest with `qa_autodeploy.py inputs` and give it a new `release_id`. Build the new
   URL from the selected version's URL, changing only the password.
3. `release_secrets.py store`, select the returned version in the manifest, then
   `release_secrets.py verify`. Nothing live has changed yet.
4. `terraform_run.py application plan`: only the secret version, revision suffix and `release` tag
   may differ, plus the cosmetic `transport` casing and startup-probe order that auto-deploy's PATCHes
   leave behind. Do this before the password changes.
5. Change the password (runbook 05 step 5). Run the identity and privilege evidence in the exact
   API image, because Prisma on macOS refuses the Supabase pooler certificate and the URL's
   `sslcert` already names the image's path. Mount `infra/scripts/runtime-identity.mjs`,
   `packages/db/scripts/runtime-role.mjs` and `packages/db/prisma/migrations` read-only at the same
   paths under `/app`, and pass `DATABASE_URL` with `-e` by name only.
6. `bash infra/scripts/deploy-apps.sh --backend <file> --inputs <manifest>`. The API drains first.
7. Copy the last foundation input, changing only `config.monitoring.database_secret_version`.
   Plan and apply it before the job's next 02:00 UTC run, or that run fails and fires the alert.
   Start one execution, then run `monitoring_readback.py --hours 26`.
8. Run probe A.
9. Try the old password once through Supavisor, reading it from its vault version so that a typo
   cannot pass as a refusal. Confirm that nothing references the old version, disable it, then
   `gh workflow enable "QA deploy" -R tonyaiukco/TonyAI-mono-repo`.

### Enabling self-service registration on hosted QA

Runbook 03 §3.6, with these hosted specifics. Registration on QA runs over the
**placeholder** KVKK notice, so its manifest says `allow_placeholder_consent: true`;
QA is `staging`, the only environment where that is accepted.

1. `gh workflow disable "QA deploy" -R tonyaiukco/TonyAI-mono-repo`, then wait until no
   `QA deploy` or `QA rollback` run is running or queued ("Owner Terraform releases",
   above: the check prints nothing). A deploy still running would write its older
   template back over this release and remove the registration settings.
2. Only then write a manifest with `qa_autodeploy.py inputs` (above). `release_secrets.py store
   --inputs <that manifest> --name registration-code`; type the code at the hidden
   prompt. Note the version identifier's last segment.
3. Foundation: copy the last applied foundation input — never the stale file in
   `hosted-qa-preflight` — and set only `config.registration_secret_ready=true`. Plan,
   read (one role assignment added, plus the known cosmetic `join_grant`
   difference), apply.
4. In the manifest set a new `release_id` and add the `registration` block.
   `release_secrets.py verify`, then `terraform_run.py application plan`: the API gains
   the `registration-code` reference and two settings; besides the revision suffix
   and `release` tag, only the cosmetic `transport` casing and startup-probe order
   that auto-deploy's PATCHes leave behind may differ.
5. `bash infra/scripts/deploy-apps.sh --backend <file> --inputs <manifest>`, then
   `--verify-only` once the outgoing revision has gone.
6. `curl -s https://api.qa.tonyai.io/api/v1/auth/registration` answers 200 with
   `"consentIsPlaceholder":true`. `gh workflow enable "QA deploy" -R tonyaiukco/TonyAI-mono-repo`.
7. Register one company at `https://qa.tonyai.io/register` with an address the owner
   reads; a wrong code is refused on the page, the right one leads to the email, the
   link, a password and a first sign-in as `super_admin` of an empty organisation.
   Record the release id and the secret's version identifier — never the code.

**Backing out.** The manifest that was live before cannot be applied again as it
is: its API revision still exists, inactive, and the deploy refuses an intended
revision that exists but is inactive. Copy that manifest — the one exported in
step 2, without the `registration` block — give it a **fresh `release_id`**, then
`release_secrets.py verify`, plan, `deploy-apps.sh` and `--verify-only`, with
`QA deploy` disabled and the check above printing nothing. Registration is then off
again; the secret and its grant may stay.

The Storage verification job is untouched: this release changes no image and no
database or backend secret version.

### Incident: the wrong password stored at step 5

**What happened.** On 2026-11-08 our instructions put the password on the clipboard and also gave
`\password tonyai_runtime` as a command to copy. Copying it replaced the clipboard, so the command's
text was pasted at both hidden prompts and stored. The first identity check failed, as it should.

**Effect.** The BYPASSRLS runtime role held that guessable text for about 10 minutes, ending about
21:41 UTC. The API lost new connections and was unavailable from about 21:38 until the deploy,
with QA idle. The owner read Supabase's logs for the window and reported nothing wrong.

**Recovery, with no paste.** As the owner, compare the verifier in `pg_authid.rolpassword` with the
selected password offline. Send `ALTER ROLE tonyai_runtime PASSWORD '<client-side SCRAM verifier>'`
over stdin, which is the same statement `\password` sends. Compare again and require a match, then
run one identity check. Reselect no old manifest.

## R004 consolidated L10 acceptance package (prepared 2026-11-02; historical)

Superseded on 2026-11-04 by [ci4-1 L10 acceptance](#ci4-1-l10-acceptance-from-2026-11-04).
Kept as history; do not resume or rerun it.

The owner approved this bounded batch. **Execution is partial; full L10 remains
OPEN.** Current observations and expedited functional QA disposition are above. L9 remains
COMPLETE; Water W1 is superseded as an execution proposal and its old evidence
stays intact. The owner first selected current-host maintenance as a design, then approved
the bounded batch. Maintenance was not executed after its fixture prerequisites
stopped; the healthy r004 release remains live. Stop the affected subpackage on an unexpected result, changed
release, collision, timeout, ambiguous commit or unresolved cleanup. No retry,
alternate month, resend, unlock or repair is implicit. Expected negative tests
are planned observations. Exact mandatory cleanup/retirement below remains in
scope after a failure; it never grants foreign or broad deletion authority.

### Fixed target and custody

- Initial release `r004`, application source `7d3e2e9c70846ed76d677fe72cff8ab831924192`.
- API `sha256:4126b6ce156625b987886884971183cdd83208c91d83dfe0fd1865fed1d27b68`;
  web `sha256:ded9a4f423a73388b8d4035b09f41c3ccd799187424327a50a5ef0a36db6a33f`.
- Original manifest SHA256 `bc2ec4e7c4a9c7e0c47766990d6a1496d444960aeadda266e34cb9f28904e667`;
  candidate SHA256 `472296c27c6be86c17ba721671d823c358c0db8ac567ad6600f304b5135b55a0`.
  Historical `candidate-r003.json` contains r004, not rollback bytes.
- Private envelope `/private/tmp/tonyai-r004-l10-acceptance/` is owner-only.
  The two real TR/EN inboxes are bound in `lifecycle-owner-targets.json` (0600),
  independently checked against the protected five-person QA cohort. No new
  address, alias or password is invented. The monitoring target is privately
  bound to the owner-selected operator; it is not a disposable lifecycle user.
- Application source remains a separate clean pinned checkout. `hosted_smoke.py`
  requires a clean reviewed **helper commit**, independently prepares the exact
  application/candidate fingerprint and inspects the cached Linux image before
  credentials. No monkeypatch, dirty-source bypass, native Prisma or image pull
  is permitted by this probe preparation. Node22/Prisma6.19.3/strict bundled CA
  must pass `--verify-only` with network disabled at the published helper SHA.
- One preflight metadata-only GET lists versions of **direct-url only** in the
  manifest-bound vault (no secret values, no nextLink). Require exactly one
  enabled version, record its immutable ID privately, and pass that explicit
  version to every owner read. Multiple/absent versions stop owner-DB work; never
  select latest or fall back. Backend/runtime versions remain release-pinned.
- Preserve `storage_cleanup_hold=true` throughout. Secrets enter hidden prompts
  or exact-version Key Vault reads and child stdin; never chat, argv, receipts,
  git, Terraform input/state or raw logs. Private receipts contain exact IDs,
  hashes and bounded observations, never passwords/tokens/action/signed URLs.
  Preserve all L9 originals and never access the excluded IB1 directory.

### Acceptance matrix

The matrix below distinguishes actual observations from unfinished acceptance.
Every observation must bind
UTC and Europe/Istanbul time, operation, exact actor/target, release/source/digests
and the underlying response. Prior successful exact-source CI/E2E/Integration
41356114363/41356234839/41356114333 are attributed evidence, not new runs.

| Control | Current state | Required hosted result |
|---|---|---|
| L9 / offline r004 manifest binding | PASS (prior) | Preserve original evidence; current ARM still required |
| A exact-release two-tenant smoke | BLOCKED (owner-version metadata) | ARM match, own reads, foreign API/PostgREST confinement, exports/browser downloads, exact Auth absence |
| B workflow/RBAC/lock/audit | NOT_RUN | Synthetic Water lifecycle, independent approval, valid-body denials, period inventory and immutable snapshot |
| C Storage/evidence/TR-EN reports | NOT_RUN | Boundary/MIME/absence, signed expiry, foreign denial, partial retained output identity |
| D mail/recovery/revocation/retirement | BLOCKED (no fixture creation) | Two real inboxes, seven-attempt ceiling, natural reset expiry/replay, old-session denial, scoped retirement |
| D failure recovery | NOT_RUN | Explicit compiled-service fault seam, real DB pending, real Auth reconcile, API refusal |
| E no-factor/localisation | NOT_RUN | No numeric fallback; remaining TR/EN UI/email/export observations |
| F monitoring/backup/maintenance | PARTIAL:5resources/readbacks, Test acknowledgement, verifier Succeeded; logs0rows; backup/maintenance not run | Recent backup metadata, active routed rules, actual operator acknowledgement, job chain, rollback and return |
| Numerical emissions | BLOCKED O6/LP4-02 | Authoritative factors/golden results; no synthetic substitute |
| Full G2/production recovery | G2 MET 2026-11-08 ([G2 closure](#g2-closure-2026-11-08)); restore and production gates OPEN | Consistent DB+Storage restore (LP5-03) and wider production gates (LP2-04) |

### One approval envelope, separately bounded operations

**A — one exact-r004 smoke invocation.** `hosted_smoke.py` uses the existing
smoke core with separate helper/application provenance and the Linux fixture
transaction. It creates two no-mail synthetic Auth users, two organisations,
two subsidiaries and two profiles (six application rows/six create audits).
One browser login per fixture proves `/me`, own/foreign subsidiary reads/list
confinement, PostgREST row confinement, API PDF/XLSX/CSV and browser PDF downloads.
The six direct exports and two browser PDFs add eight generate/report audits.
Before/after ARM verifies API/web and API revision inventory. Auth cleanup is
mandatory: exact journalled ID/email/metadata match, delete and readback absence.
Application/audit rows remain. An unexpected returned UUID is preserved but never
deleted; intended-user absence cannot resolve that discrepancy. No cleanup-only
rerun is automatically authorized. Allow at most three verification rounds
(before/after A and before maintenance); no listSecrets or unrelated ARM access.

**D0 — one no-mail lifecycle bootstrap, before B/C.**
`hosted_lifecycle_bootstrap.py` creates one random Auth identity with confirmed
synthetic `tonyai.test` address and a durable ban, then one new synthetic holding
and its super_admin profile with two audits in one transaction. It unbans only
its exact metadata-matched identity after commit/readback. Lost acknowledgement
never authorizes deletion: failure quarantine targets only the intended identity,
uses the established `876000h` ban and a new unknown password, then validates
ID/email/metadata and future ban. Unexpected response IDs remain unresolved.
This is an explicit owner/bootstrap write, not the cloud seed or an invitation.
One bootstrap password is owner-created in the password manager and entered
privately. Only the new tenant is a lifecycle mutation target.

Invite two real inboxes through the r004 API: TR super_admin (independent
approver) and EN consultant. Accept/set passwords/fresh sign-in and test used-link
replay. Create exactly two synthetic UK subsidiaries, no sites: primary for
November workflow/reporting; secondary for positive data_entry and maintenance
journeys. No working QA account is reset, disabled, edited or offboarded. One
existing protected consultant may sign in **read-only**, verify its own `/me` and
company list, then request the known synthetic record/evidence/dataset/issuance
IDs for foreign API404 and direct PostgREST zero-row checks. Its credentials do
not enter the fixture/operator container.

**B — four predeclared synthetic Water slots, never fallback slots.** Primary
`2026/monthly/November/Water`, secondary September (data_entry), October (r005)
and November (r006), all `locationId:null`, value100, unit`cubic_metres`,
activityType null. Before **each** create verify that exact slot is empty and
unlocked. Collision/lock stops its subpackage; no alternative date or unlock.
Every create must be201/draft/Scope3/no_emission_factor/no numeric tCO2e. Four
small valid synthetic CSV evidence files are retained, one per accepted record.

For primary, bootstrap author creates/uploads; TR admin's non-author submit
must403/record_author_forbidden. EN consultant and later EN viewer each attempt
one valid scoped create/submit/approve/evidence-upload/period-lock (ten expected
role refusals). Consultant review/reject/dataset/partial-issuance rights are not
blanket mutation denials. After author submit200, author self-approve must
403/self_approval_forbidden and TR admin approve200. Enumerate **all** primary
November records/pagination before locking; require this approved Water to be
the only affected record. One lock must lock exactly one record, preserve its
snapshot and produce recordsLocked1. Repeat the valid create once after lock:
409/period_locked, before duplicate insertion. Leave record/evidence/lock intact.

Change EN consultant→data_entry; grant only primary, verify fresh `/me`, own
read and secondary refusal; add secondary grant, then EN creates/evidences/
submits secondary September and TR admin approves. Change EN→executive_viewer
and verify the source clears both grants with corresponding audited deletes.
All denied writes use valid scoped IDs/bodies so schema/foreign404 cannot mask
RBAC. No additional role, factor or record lifecycle repair is allowed.

Reconcile complete exact-entity audit pagination/total after each stage: actor,
action, timestamps/diff, snapshot and storage side effects. One audit per logical
mutation, none for refusals; role and subsidiary_access audits share the EN profile ID: distinguish
entity/action and reconcile diff.subsidiaryId for each grant. Evidence and
period_lock use their own IDs. Do not assert a global audit count that ignores exports or conditional freeze.
Never mutate audit to test append-only behavior.

**C — private Storage and synthetic report boundary.** One
`hosted_storage_probe.py` invocation checks all three private bucket settings
(10/2/20MiB; documented PDF/image/XLSX/CSV allowlists). Twelve sequential unique
paths total: small valid MIME, exactly-limit, limit+1 and wrong MIME per bucket;
no upsert. Intent is persisted before any upload. Successful bytes/hash,
anonymous and real-user non-signed denial, same-origin signed bytes, actual
60-second expiry while service bytes still exist, and exact authenticated
NoSuchKey absence are separate checks. Cleanup removes only the twelve exact
probe paths, including lost upload ACK, and requires absence; generic404 is not
proof. The probe buffers/deadlines whole bodies; no prefix/listing deletion.
It validates Storage MIME rules, not PDF content validity.

Against the primary draft, one mismatched-content and one malformed-PDF API
upload must leave no metadata/audit/owned bytes. Valid evidence URL must have
expiresIn60 and matching bytes; after65s require signed denial with adopted
bytes still present. Preserve adopted evidence and issued PDFs.

Generate live PDF/XLSX/CSV once per language (six exports) and observe browser
downloads. Scope3 Water is excluded from Scope1/2 totals and the emissions CSV;
PDF/XLSX show the actual TR/EN Not covered disclosure. Uncalculated is never
measured zero; CSV machine headers stay English. Live generate/report audit rows
have entityId:null: filter actor/action/entity/time plus company/year/template/
format, reconcile all pages. Do not use an entityId filter that hides them.

Create exactly one new2026 inventory boundary, configure **primary only** for
November, no sites/sources; the five Scope1/2 category applicability entries are
explicitly undetermined with a synthetic-QA reason. Do not confirm the boundary.
Capture one primary-only dataset after reviewing its DTO selection; capture may
commit a freeze before subsequent assembly fails. No retry/unfreeze. Require
issuance-preview partial with boundary_unconfirmed/applicability_undetermined;
if final/unclear, stop before issue. Issue at most one partial PDF per language
(two issuances). Download each PDF twice and compare bytes/hash with stored
fingerprint/size; download each retained XLSX/CSV once and reconcile to its dataset.
These exports are generated from retained data, not stored-byte guarantees.
Foreign evidence/dataset/issuance refusals use the protected read-only consultant
before retirement. Owning rows/objects remain permanent synthetic artefacts.

**D — seven real email attempts maximum; one natural expiry wait.**
Two invitation sends above; two initial password-reset emails (TR+EN) left unused
until after their observed one-hour expiry; then one actual expiry attempt each.
Do not mint fresh links before this check: supersession is not expiry. Two new
reset emails recover both users; prove replay refusal/new-password fresh login.
One final EN reset follows disable→enable and the durable300s cooldown. No resend,
SMTP/429 retry or policy/time modification. Seven is a ceiling, not permission
to repeat failed sends. Natural unused **invitation** expiry is not newly proved
by this design; prior dead-link observations remain attributed evidence.
Delivery requires actual inbox/spam kind/language/sender/origin/time observations;
202/audit alone is not arrival. Links/passwords enter private prompts, never chat.

EN-only disable/enable: privately capture original access/refresh and one
pre-disable refreshed access specimen; disable once, test password sign-in,
API and refresh refusal; enable once, both old access specimens remain refused.
Attempt the old refresh once after enable; if Auth mints a token, API must refuse
session_revoked using earliest AMR; otherwise record Auth refusal, not a minted
token claim. Both operations rotate the password, hence the seventh recovery
email is required for fresh EN login. No unplanned password-change mail.

After all EN journeys and maintenance, `hosted_lifecycle_operator.py` injects
one `AuthAdminError('auth_unavailable')` at the compiled r004 `setBanned` service
boundary **before provider HTTP**, EN only. Shipped AccessAdmin/Lifecycle/AuthSync
services on the real owner connection must commit disable+audit and leave
pending; real Auth still recognizes the captured token while ACA API refuses
it. This is a compiled-service fault seam with real hosted DB, not a naturally
failed ACA request/provider outage or runtime-role grant proof. Run shipped CLI
reconcile dry then apply once for this exact pending EN ID; verify real Auth ban,
cleared pending and no mail. Finish with shipped offboard dry/apply for only this
new holding. Require offboardedAt, disabled exact member roster, authPending[]
and token refusals. Retain Auth/application/evidence/report/audit rows (D17).
The wrapper permits the exact journalled1–3member subset for early-failure
retirement; unexpected members/IDs stop it. No repeated apply/reconcile or hard
delete is implicit. Ambiguous membership needs review, not broader cleanup.

**E — no-factor and localisation.** Two valid Electricity previews, one per
language, must404/no_factor with appropriate coverage, no persisted calculation.
Record remaining TR/EN role/error/data-entry/report/email observations in these
journeys. No seed, factor load, demo factor, numeric fallback or numerical QA.

**F — current-host monitoring and maintenance, a requested explicit exception.**
First execute the private eight-GET ARM allowlist: exact job/action group/storage
alert and resource-group metric/query-rule inventories; no nextLink traversal.
The other three exact ACA environment/diagnostic/workspace metadata GETs
bind job logs to the existing workspace; no listKeys/listSecrets. Run
`hosted_backup_evidence.py` once with a hidden backups_read Management token:
one pinned-project GET `/database/backups`, whole-request60s, no download/restore.
Require an actual COMPLETED timestamp no older than36h; record latest seven
COMPLETED backup inserted_at timestamps, region and WAL/PITR flags. This is recent-backup metadata,
not independent daily-schedule, restore or Storage-byte proof. The Pro custom
schedule endpoint is Enterprise-only and must not be called.

Foundation state access is restricted to init/one saved plan/one saved apply for
**monitoring only**, using existing backend and owner session. Populate the
private monitoring input from exact r004 API/secret versions and the bound
operator. Review `terraform show -json` privately before apply. Allow create/update
only of storage_verify[enabled], operator[enabled], storage_verify_alert[enabled]
and api_metric_alert[http_5xx|restarts]. Any other address, delete, replacement,
import, grant, network/vault/diagnostic drift or unknown plan stops before apply;
no `-target`, state edit or automatic repair. Apply that exact saved plan only.
The two new native metric rules use Requests/Total/statusCodeCategory5xx and
RestartCount/Maximum>0, exact API scope and existing action group. RestartCount
is cumulative: no guaranteed five-minute clearing or new notice per restart.
This replaces the proposed log-dependent API alarm implementation; it does not
claim diagnostics ingestion is fixed.

One action-group Test targets only the bound operator; require actual receipt
and acknowledgement. Before fault injection, require baseline job exit0 ingested
and the exact storage alert state Resolved; otherwise the chain stays BLOCKED,
never attribute a prior/initial notification to the new fault. Allow at most six
read-only alert-state inspections limited to this exact rule and test interval,
without nextLink traversal or unrelated alert content. At most five starts of the exact storage-verification job,
no retries: baseline; one at a time removal of exact retained synthetic evidence,
new import-source probe and retained issued-PDF bytes; clean after restoration.
Before each removal save/hash bytes privately; restore **that exact path and
bytes**, preserve metadata, and require download/hash via owning evidence/issuance
APIs after restoration. Import-source is explicitly an unowned synthetic probe,
so it proves bucket restore only and cannot trigger an owning-row mismatch.
Journal its exact thirteenth probe path before create; after restore/hash
comparison, delete only that unowned path and require authenticated NoSuchKey
absence before the final clean job. Adopted evidence/PDF never receive this cleanup.
Use the evidence or issued-PDF mismatch to prove one real job exit1→log→alert→
operator chain; bucket probe deletion must not be mislabeled as that trigger.
If exit1 persists, restore bytes immediately before any further operation.
If live ingestion/config is unsuitable, stop the alert chain; do not synthesize
logs, change tables/queries or disable rules to get a green result. Bounded log
queries: exact job, execution IDs, operation interval≤2h, at most10 queries,
project only time/execution/event/exitCode. Retain received acknowledgement.
A failed result keeps the rule fired for26h; later clean verification does not
prove independent exit2 or elapsed26h outage delivery. Initial missing-result
firing is not a post-success26h outage drill. No API crash/5xx injection is approved;
read back both real metric rules/scopes/routing and provider metric definitions.

Reserve one≤90min maintenance window on the existing QA API/web hosts; QA can
be unavailable twice. Confirm r005 and r006 do not already exist; if either
exists, STOP, never choose another ID. Preserve exact original manifests.
Deploy r005 once carrying prior r003 bytes/source
`a9476eb735cad53aa7091932dd02b38a4070cefb`, API
`sha256:e9ba267817667e8580afc39bfd1ace12f62cf012e044abe77ba30f4d8446495d`, web
`sha256:15f41c1b2cb86fbf357d8507e259a257cd04b1202a8215508cf3e9fd53b7a0f3`.
API runtime/schema/migrations/shared contracts are identical across these sources;
the38-line API difference is test-only. **Web differs**: known r003 login/link/
analytics behaviors temporarily return. Restrict the test browser to approved
origins; no ordinary QA use during maintenance. No migration/build/push.

Use the reviewed deploy helper (including #264 drain/settle) with exact saved
application plans and existing backend only. One rollback and one return apply;
allow only API/web revision image/source/release changes, no credential/config/
identity/network/grant changes. The two deploy invocations may list API revisions/replicas and deactivate only
the outgoing API revisions captured immediately before that invocation; no
revision deletion, unrelated app mutation or arbitrary activation. Record drain,
settled active revisions/outgoing
replica absence, readiness/liveness, synthetic login/read/write journey and RTO
(actual measured, target≤10min each). Secondary October writer journey on r005;
secondary November on r006, same evidence/independent-approval contract as B.
Return once to **r006 with exact r004 source/digests**; only release ID differs
from r004 input. After return, final ARM+browser acceptance must identify r006,
not falsely claim r004 is still the live ID. Never clear hold. Failed rollback
still permits the one preapproved r006 return; no further redeploy/rollback loop.

Execution order: clean helper qualification→A→D0/invites→B/C/E, reset expiry wait
in parallel→C foreign checks→monitoring/backup→r005/r006 maintenance→remaining
D recovery/token/fault/reconcile→authenticated final r006 browser checks using
the still-enabled TR admin→mandatory retirement→public browser/ARM r006 checks. Do not
retire before writer/token tests need the identities. An unexpected r006 return
failure stops handover and requires new recovery approval; preserve evidence.

### Handover and wider gates

Full L10 sign-off requires the above mandatory observations and explicit owner
acceptance of the disclosed boundary. The expedited functional QA intake above
is a separate, partial owner disposition, not that sign-off. Boundaries remain:
no authoritative numerical acceptance; full DB+three-bucket consistent disaster
restore/recreation, isolated DB/Storage outages/hung flights, provider credential
rotation and Sentry delivery remain wider G2/LP5 work. Three-bucket restoration
above is not a full DB restore. No data-loss/RPO claim follows from backup metadata.
Sentry configuration is absent; never fabricate a receipt or enable a DSN without
runbook06's privacy/review gate. Fresh unused-invitation expiry and delayed26h
monitoring remain separately disclosed, not passed. If the owner requires these
for QA too, retain QA handover BLOCKED and plan the wider rehearsal explicitly.

Use this runbook and the single central planning file for the final QA entry,
release binding, accepted limits, operator, defect reporting and evidence links;
never create another status/roadmap/handoff file. Preserve approximately2m40s
prior rollout outage/40s overlap and migration compatibility allowances. Existing
diagnostics destination=null, vault networkAcls absence, Outlook spam, A4D1
metadata/audit provenance and paused qa_* findings remain open without repair.
The paused self-hosted route/resources/workflows are not resumed or deleted.

### Local verification and review (not hosted acceptance)

The following records historical preparation before PR #266, later owner-merged
at `b59fac1`. Earlier publication fa18ba3 and manual selfhost-checks41496050486 /
qa-infra41496056240 passed but did not validate the then-unpublished larger diff.
That preparation added Linux adapters, exact fixture transaction reuse,
Storage expiry/absence, no-mail bootstrap/quarantine, scoped service/CLI lifecycle,
bounded backup metadata and two native API metric alerts. No application
runtime, factor, schema or migration changes.

At HEAD `629e3a9703a9441625464d3b628805da90c3b645` plus this working diff,
in `/Users/denizb/.codex/worktrees/hosted-l9-diagnostic/TonyAI-mono-repo-codex`,
Node22.23.3 `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` pass.
Lint initially found four new Storage-helper errors; the empty catches now
explain their safe handling and mandatory cleanup is extracted without changing
its finally semantics. Rerun lint passes with eight existing warnings. Turbo
replayed6/6 typecheck/test and4/4 build tasks; E2E TypeScript executed. The actual
CI Node glob (`infra/tests/*.test.mjs`) independently passes548tests/23files after
the cleanup refactor. Hosted Python pattern40tests and cloud-smoke9tests pass;
Terraform policy, recursive fmt and diff check pass. Isolated backend-free
foundation mock tests passed9/9 on the same Terraform changes; this is not an
Azure plan. Cached exact-r004 Linux network-none runtime/receipt-IO probes passed,
including UID1000 and host readback; they used a working public bundle and do
not replace clean committed-helper qualification after publication.

Fresh independent Security/RLS, QA and DevOps reviews accepted source/proposal
boundaries with no remaining P0–P2. Review-discovered long-ban/password-rotation,
identity readback, whole-body deadline, early-retirement subset and durable
step/outcome-custody fixes have permanent regressions. QA also exercised actual
compiled r004 service constructors with an in-memory transactional DB: one
injected disable audit/pending state and zero provider requests. This is not a
hosted injection result. Detailed review/check receipts (including the Security
harness's three fake-project/synthetic-token worker attempts with unobserved
HTTP outcome) remain in the private envelope; no real credential/tenant was
used in those attempts and they are not called zero-network proofs.

API integration/RLS were not run locally; no runtime API path or schema changed.
The full offline Python infrastructure baseline was subsequently run and passed
for the test-only follow-up; the two updated identity mutants were killed.
The full129mutant run remains CI work, not claimed from that targeted result. The focused
source/helper checks above do not substitute for CI/manual checks at publication.
Both `selfhost-checks.yml` and `qa-infra.yml` must be dispatched on the newly
published branch before merge, even though the live self-hosted route is paused.
Owner approval was received and cfb75e6 published in PR266; clean committed
runtime qualification passed. Required manual workflows at that source passed:
[selfhost41513559838](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41513559838)
and [qa-infra41513565589](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41513565589).
PR CI exposed two test-harness defects: a late rejection observer in the new
Storage deadline test and stale ID/email mutation anchors from the earlier
positive-predicate refactor. Both are corrected without production changes or
weakened gates. Independent Security/QA reviews accept these fixes; the full
local Python infrastructure baseline passes and both updated mutants are killed
by assertion failures, with no test errors. Final tested source `071e85340a492118faab189e9f38766148ee5574` passed all four:
[CI41517516123](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41517516123),
[Infrastructure41517516061](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41517516061),
[selfhost41517591495](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41517591495),
[qa-infra41517596319](https://github.com/tonyaiukco/TonyAI-mono-repo/actions/runs/41517596319).
Node22.23.3 lint/typecheck/build/test also pass directly at071e853 in the same
worktree (cached application tasks; eight existing lint warnings). Clean final
helper offline qualification passes. This closing results update changes docs
only, preserving tested source/test/Terraform/workflow blobs; it does not claim a
new code test run or close the remaining hosted L10 controls. The owner merged
PR #266 at `b59fac1`; the current onboarding follow-up changes documentation only.
No local/mock PASS closes L10.
