# 3. One versioned application deployment path

Restore the session/project variables (runbook 00). Keep infrastructure and image
source SHAs distinct. First create is owner-run; app-scoped OIDC deployment starts
only after both apps exist and runbook 01 grants their exact scopes.

## 3.1 Build and verify immutable images

Select a clean, reviewed source checkout. The script refuses dirty trees and a
SHA differing from HEAD. From that checkout, with restored foundation variables:

```bash
bash infra/scripts/build-images.sh '<image-source-full-sha>' .infra-local/staging/candidate-r001.json
```

Enter only the public anon/publishable browser key at the hidden prompt (obtain
it securely from Supabase). The script binds the key to the project via the Auth
settings endpoint, enforces disabled signup/providers, builds linux/amd64 images,
pushes them, records digests from **these build results**, pulls the exact web
digest, and scans its browser assets for privileged keys. It writes public
candidate provenance only after the scan passes, using exclusive file creation.
A failed scan leaves images unqualified; never promote their tags. Builds do not
change RG tags or application state. API may be promoted by digest; the web must
be rebuilt for each environment because NEXT_PUBLIC values are compiled in.

Copy the candidate's source SHA and both digests to the new release manifest;
verify its project and origins against the foundation contract. Release files
are immutable evidence: keep each version privately and create a new file and
`release_id` for later changes. Do not infer a selected image from a mutable ACR
tag or a newer candidate. For the initial release fill the backend version from runbook 02 and the
prepared runtime version from runbook 05. Never put the secret values into this file.
Every manifest must explicitly include `storage_cleanup_hold` (boolean) and
`storage_sweep_interval_seconds` (integer 1–86400, normally 300); legacy manifests
with either field missing are rejected. For first creation set the hold to `true`.
Before clearing it, inspect the reconciliation reports under runbook 04 and use
an owner-run deployment with `--ack-clear-storage-hold`. The deploy helper reads
the existing API's plain hold setting before planning/applying and refuses an
on/unknown-to-off transition without that flag. Protected workflow deployment
cannot clear an incident hold. Preserve the hold during rollback and rotation.

## 3.2 Deploy migrations separately

Run migrations from the clean checkout at the manifest’s image `source_sha`. The
helper checks HEAD and refuses a different chain. Node 22 and pnpm must be on PATH. Review the committed migration chain and compatibility with the
previous images before applying. No reset, seed, `migrate dev`, or down migration.

```bash
pnpm install --frozen-lockfile
pnpm db:generate
python3 infra/scripts/cloud_ops.py migrate --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --inputs .infra-local/staging/release-r001.json --direct-secret-version '<selected-direct-url-version>'
```

**LP3-03 preflight (independent review F4).** While the target has not applied
`20261004120000_lp3_03_factor_model`, run this read-only check in an `owner-psql`
session (runbook 05) before `cloud_ops.py migrate`. Skip it on initial setup: a new
project has no tables yet, and the query errors.

```sql
BEGIN READ ONLY;
SHOW server_version;
SELECT migration_name FROM _prisma_migrations
 WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
 ORDER BY migration_name DESC LIMIT 1;
SELECT "version", count(*) AS factor_rows,
       ("version" ~ '^[0-9]{4}\.[0-9]{1,2}$' OR "version" LIKE '0000-%') AS seed_shaped
  FROM emission_factors GROUP BY 1 ORDER BY 1;
ROLLBACK;
```

Expected on staging and production:

- `server_version` is 17.x;
- the last migration is the previous release's;
- the factor query returns **zero rows**, because the seed never runs there.

Any factor row stops the deploy; raise it with the owner, and never edit or
delete rows to pass. A `seed_shaped = f` row makes the migration refuse to apply
(`LP3-03: emission_factors holds versions …`). The deploy fails with P3018. The
migration rolls back whole, but Prisma records it as failed, so the next deploy
refuses with P3009. After the owner has classified the rows,
`prisma migrate resolve --rolled-back 20261004120000_lp3_03_factor_model` clears
that record. A `seed_shaped = t` row becomes a
placeholder release (`YYYY.N`) or a fixture release (`0000-…`), which the owner
reconciliation check reports as a finding (K3). Apply the migration in a window
with no writes and no long-running transaction, reads included (pause the
scheduled Storage verification job). It takes ACCESS EXCLUSIVE locks with a
5-second `lock_timeout`, and gives up rather than queue behind a long
transaction.

Before applying the LP1-03 migration, perform the hosted owner privilege checks in runbook 05. Expected:
`prisma migrate deploy` then `prisma migrate status` succeed using only the
explicitly selected owner session URL and the repository CA. For initial setup,
select `versions.direct_url_version` from the journal; after owner rotation use
its recorded replacement. The migration child receives that URL as both
`DATABASE_URL` and `DIRECT_URL` for Prisma's schema configuration; neither value
is passed to application containers. No runtime secret is read by this operation.
The owner URL is validated before Prisma starts; output is captured/suppressed
and errors never print URLs. Do not run on a shared shell host. A failure requires
owner inspection of migration history and forward recovery before retrying.
After migration, finish runtime login activation in runbook 05 before proceeding.
Then run runbook 05's [owner reconciliation check](05-rotation.md#owner-reconciliation-check)
from this checkout. This checkout is the deployed SHA, and the check is meaningful
only from it.

## 3.3 Verify exact secret versions and apply the application root

The owner has completed runbook 05's initial role handoff. Runtime URL verification
rejects owner usernames. Fixture provisioning separately reads the selected
`direct-url`; neither the app under test nor the browser gets it.

```bash
python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r001.json
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r001.json
```

The first command is **owner-only**. It reads exact versions into memory, verifies
enabled state, strict runtime TLS and backend-key project binding. The deployment
path itself requires no Key Vault data read: it takes IDs from the approved
manifest, plans/applies only Container Apps, then reads both apps independently.
Readback must match both digests, both exact secret references/identities, HTTPS
origins and ready revision IDs. Expected `PASS` for both apps. If Azure is still
converging, wait and run verification only:

```bash
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r001.json --verify-only
```

No readback failure is recorded as success. Do not restart arbitrary revisions
or use `az containerapp update/secret set/revision activate`: Terraform is the sole
application writer. Runbook 05 handles rotation/rollback with another manifest.
After the first creation, enable foundation `apps_ready` and apply the exact-app
OIDC grants per runbook 01. Preserve manifest, provider locks, infrastructure SHA,
image-source SHA, migration evidence and ready revision IDs for the release.

A successful Terraform apply is not a DB-backed smoke pass. Run runbook 04 and
LP2-02/03's actual image/login/export and readiness acceptance before release.

## 3.4 LP2-02 release sequence (D22/D23)

**No other E2E during a release.** Reserve the E2E window with the owner; avoid
the nightly schedule and do not dispatch another branch/PR run until release
qualification finishes. The shared concurrency group cancels an earlier run;
a cancelled release run must be rerun at the exact candidate SHA.

These are **owner-run instructions**, not recorded cloud evidence. Terraform is
still the only Azure application writer. LP2-01 cloud/fresh-recreation acceptance
remains open. LP2-02 is not DONE until the exact deployed candidate passes below.

### One-time owner setup

- Before **any first dispatch** (which can otherwise auto-create an unprotected
  environment) or federation, create and protect `staging`. Require a second
  human reviewer, prevent self-review, disable administrator bypass
  (`can_admins_bypass: false`), and allow exactly the `main` branch, no tags.
  A solo owner cannot approve their own run in this configuration. Do not use an
  admin bypass; recruit an independent reviewer before enabling deployment.
- Create the active `tonyai-main-release` repository ruleset from the committed
  public template. It requires reviewed PRs, current `build`, `docker-build`
  and `rls-probe` checks from GitHub Actions, and prohibits deletion/force-push.
  Its bypass list is empty, including administrators and automation. Every PR
  needs approval from an account other than the latest pusher; the verifier
  requires `require_last_push_approval: true`. A solo owner cannot satisfy either
  this ruleset or staging approval alone. Arrange independent human review before
  applying the ruleset or configuring federation; do not add a bypass. Do not make
  path-filtered Infrastructure/Integration or manual E2E required PR checks;
  integration and E2E are separate exact-SHA **release** gates.

  ```bash
  gh api --method POST repos/tonyaiukco/TonyAI-mono-repo/rulesets --input infra/config/main-ruleset.json
  ```

  Inspect existing rulesets first and update the matching ID instead of creating
  a duplicate. Owner-run `github_environment.py` and `configure_oidc.py` refuse
  missing/inactive/permissive rulesets, missing API fields and unreadable settings.
- This public, **User-owned** repository uses **ephemeral JIT runners only**.
  Persistent self-hosted runners are forbidden, even if labelled for staging.
  Provision a fresh isolated EU host for each job, register it with GitHub's
  just-in-time configuration and label `tonyai-staging-eu`, allow one job, then
  destroy the host and disk on success, failure, cancellation or timeout. Never
  reuse a host, home directory, Docker state, PATH tools or Terraform cache from
  a prior job. The external owner-operated provisioner needs its own independent
  review; this PR does not create or attest a working provisioner.
- Configure all fork PR runs to require approval from **all outside
  collaborators**, including returning contributors. Set the repository variable
  `STAGING_RUNNER_MODE=ephemeral-jit` only after reviewing the provisioner.
  Both protected jobs require that repository variable before they can run.
  Deployment validation fails explicitly if it is missing or different, so a
  skipped deployment cannot leave a successful validation run.
  `verify_environment` reads and checks both settings before federation; a label
  or this variable alone does **not** prove ephemeral host isolation. Never
  approve untrusted fork code for a firewall-allowlisted release host.
- JIT hosts need stable EU NAT egress. Allow only its exact `/32` in the existing
  state-backend bootstrap configuration. No all-GitHub-IP firewall opening and
  no firewall administration by the deploy job. A persistent NAT gateway is not
  a persistent runner. No runner/cloud resource is provisioned by this PR.
  GitHub-hosted larger static-IP runners and workflow-restricted runner groups
  require an organization on Team/Enterprise; they are unavailable to this
  personal repository. An organization migration with a group restricted to
  `candidate.yml` and `deploy-staging.yml` at `refs/heads/main` is a future
  alternative requiring a reviewed change to the JIT-only preflight.
- Using the owner's GitHub administrator session (not the workflow token), run
  the read-only preflight below before federation and again before each release.
  The token must be able to read environment protections, rulesets including
  bypass actors, Actions variables and fork approval settings. An unavailable
  setting is a failure, never permission to continue.

  ```bash
  python3 infra/scripts/github_environment.py --repo tonyaiukco/TonyAI-mono-repo
  ```

  Preserve this result plus independent provisioner/teardown review as owner
  evidence. If policy drifts, stop releases and remove federation until restored.
- Finish runbooks 00–02 and the first owner-created application deployment. Only
  after the prerequisites above, apply `apps_ready` grants and bind the existing
  OIDC app to `environment:staging` as runbook 01 requires. Never grant workflows
  foundation, Key Vault data-plane, migration or firewall administration rights.
  API runtime credentials use the restricted runtime role; the owner credential is never passed to application workloads.
- Set public environment variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID`, `STAGING_PREFIX`, `STAGING_ACA_DEFAULT_DOMAIN`,
  `STAGING_ACR_NAME`, `STAGING_RESOURCE_GROUP`, `STAGING_SUPABASE_PROJECT_REF`,
  `STAGING_SUPABASE_PUBLIC_KEY` (publishable/anon only), `STAGING_BACKEND_JSON`
  (the validated backend config, identifiers and IPs only). Supabase stays in
  Frankfurt and Azure in Germany West Central. No backend key, DB URL, password,
  refresh token or Terraform state belongs in a workflow input/variable/artifact.

### Candidate → migration → approval → deployment

1. Merge with owner approval, then select a clean **main SHA**. Dispatch both `gh workflow run e2e.yml --ref main` and
   `gh workflow run integration.yml --ref main`. Verify their `headSha` equals
   the selected SHA; `main` can move between commands. Manual flow-changing PR
   E2E runs remain required by D22. CI, full E2E and the real-PostgreSQL Integration
   suite must all succeed on this SHA. Integration proves lifecycle concurrency,
   rollback and audit atomicity (F10); unit tests do not replace it.
   A newer pending/failed run supersedes an earlier green run. Nightly evidence
   at another SHA cannot qualify this candidate.
2. Dispatch `candidate.yml` on main. Its protected staging job uses OIDC, builds
   both environment-bound images, labels their source SHA, pushes to ACR,
   retrieves these build-result digests, scans the exact web digest, and uploads
   `staging-candidate-<sha>` / `candidate.json`. It records the lockfile hash and
   every migration name/content hash. **This is build/scan evidence, not smoke.**
3. Download the candidate artifact from that successful run into a fresh directory:

   ```bash
   gh run download '<candidate-run-id>' --repo tonyaiukco/TonyAI-mono-repo --name 'staging-candidate-<full-sha>' --dir .infra-local/staging/candidate-download
   ```

   Use `.infra-local/staging/candidate-download/candidate.json` as the candidate
   below (or copy it to the referenced immutable evidence path). Prepare the normal
   application release manifest from section 3.1, using the exact two digests,
   source SHA, target project, a new `release_id`, and exact secret version IDs.
   From the candidate's clean checkout run:

   ```bash
   python3 infra/scripts/candidate.py verify --sha '<full-sha>' --candidate .infra-local/staging/candidate-download/candidate.json --inputs .infra-local/staging/release-r001.json
   ```

4. Review migration compatibility with the previous release. Run section 3.2
   migration deploy/status and section 3.3 exact-secret verification as the
   owner. Attach sanitised results and direct-secret version ID to the release
   review. Neither workflow runs migrations or reads Key Vault values. Stop on
   a failed/partial migration; no seed, reset, or automatic database rollback.
5. Dispatch `deploy-staging.yml` on the **same main SHA**, supplying the successful
   candidate **run ID** and reviewed public release JSON. If main has advanced,
   build a new candidate; this workflow does not accept arbitrary checkout refs.
   The unprotected `validate` job has no OIDC permission and publishes the
   normalized manifest and its SHA-256 in the run's step summary **before** the
   protected deployment job requests approval. The deployment job name includes
   that hash. Open this summary from the workflow run; compare every field,
   especially `vault_name`, `resource_group`, `release_id` and both secret version
   IDs, with the independently selected release. Before approval, compare the
   manifest hash, candidate artifact, CI/E2E/integration runs,
   migration/secret checks, schema rollback plan and backend runner IP. The job
   independently reads the candidate run's repository/branch/SHA/event/result,
   checks the immutable artifact archive hash, refuses unknown entries, and
   binds all provenance to the release and checkout, and re-derives the approved
   manifest hash **before Azure login**.
6. The protected job plans the application root into a private temporary file
   and applies that exact plan without replanning. Approval authorizes the visible
   manifest; it does **not** claim the reviewer inspected a Terraform plan. A
   plan cannot be produced here before OIDC/state access. Plan files are deleted and
   never uploaded. State stays in the Entra-authenticated application backend.
   Independent ARM readback checks ready revisions, digests, secret versions,
   managed identities and HTTPS origins. A failed readback stays failed; inspect
   convergence and use `--verify-only`, never imperative Azure app mutation.

The repository is public: workflow summaries, logs and candidate artifacts are
public metadata, including resource/identity names, subscription IDs and secret
**version IDs**. Never place secret values in them. The saved plan is not uploaded;
Terraform's textual plan is still visible in the job log.

If a job times out during apply, confirm the runner/process is terminated and no
other writer holds the application state before recovering. From a trusted owner
host initialize the same application backend with the same config; inspect the
reported lock ID and run `terraform -chdir=infra/terraform/application force-unlock
<lock-id>` interactively only after confirming it is stale. Never blindly break a
live Azure lease. Review state and ARM readback before a new plan/apply; a timeout
is an unknown outcome, not rollback or success. Do not download state into the PR.

### Qualify the actual deployed images

Use a trusted owner workstation with Node 22, pnpm, Python, the candidate's clean
checkout, generated Prisma client and Playwright Chromium:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @tonyai/shared-types build
pnpm exec playwright install chromium
python3 infra/scripts/cloud_smoke.py --candidate .infra-local/staging/candidate-download/candidate.json --inputs .infra-local/staging/release-r001.json --journal .infra-local/staging/smoke-r001.json --direct-secret-version '<selected-direct-url-version>'
```

The public browser key is entered at a hidden prompt. Exact Key Vault backend
and DB versions go directly to process memory. The browser process receives
only synthetic account passwords and the public key; never DB/backend secrets.
Do not enable shell tracing, Playwright tracing, screenshots, debug logging or
HTTP body logging. The command suppresses child error payloads because browser
errors may echo credentials. It performs ARM readback before and after smoke.

Two new, UUID-bound, synthetic organisations/subsidiaries/super-admin users are
created specifically for this run. Application rows are created through Prisma
in one transaction, with one audit row per write. No factors or inventory values
are fabricated. Both tenants must pass browser login and PDF download,
authenticated PDF/XLSX/CSV bytes, own-tenant positive reads and foreign-tenant
negative reads via **both API and PostgREST**. The PDF starts Chromium inside the
actual API image. The web exercise tests its compiled project/API URLs and CORS.
This is smoke coverage, not the complete table-by-table RLS or lifecycle suite.

The ID-only journal is written **before** Auth creation. Each run closes browser
sessions, deletes only its exact Auth IDs after matching email and synthetic
metadata, then proves those IDs absent. Application rows and append-only audit
rows remain as labelled evidence; there is no broad cleanup or audit deletion.
Only after smoke, final ARM readback and cleanup pass is
`smoke-r001.json.passed.json` written, binding evidence to the candidate/release.
Retain it together with the workflow run IDs, release manifest and migration
results. No successful deploy workflow alone qualifies a release.

If interrupted (including a lost Auth-create response), keep the journal and run:

```bash
python3 infra/scripts/cloud_smoke.py --candidate .infra-local/staging/candidate-download/candidate.json --inputs .infra-local/staging/release-r001.json --journal .infra-local/staging/smoke-r001.json --cleanup-only
```

Cleanup attempts both exact accounts even if one fails; any mismatch/failure
keeps the command red. A cleanup-only run never emits passed-smoke evidence.
After cleanup, use a **new journal** for a fresh qualification attempt. No local
`db:seed`, `rls:probe`, E2E setup/teardown or demo credentials target cloud. The
RLS demo harness now refuses all non-loopback targets before its first request.

### Rollback and remaining proof

Use runbook 05's reviewed compatible-schema rollback manifest and the sole
Terraform writer. The automated path deliberately requires a current main
candidate; historical/secret-only rollbacks remain owner-run. Repeat exact-image
smoke after rollback. Preserve previous image digests and exact secret versions;
an image rollback cannot undo data migrations. Dependency readiness, DB-loss
probes and rollback rehearsal remain LP2-03; actual cloud execution and fresh
recreation remain owner evidence. Auth inventory/create/delete API responses,
OIDC, static runner access, provider apply and live browser behavior must still
be proven in staging.

Offline checks (first create the PyYAML environment):

```bash
python3 -m venv /private/tmp/tonyai-infra-venv
source /private/tmp/tonyai-infra-venv/bin/activate
python3 -m pip install --only-binary=:all: --require-hashes -r infra/tests/requirements.txt
python3 -m unittest discover -s infra/tests -v
```

Then
`node --test infra/tests/*.test.mjs`, the existing mutation/policy/Terraform suites,
plus root lint/typecheck/build/test. CI's `docker-build` now **loads and starts**
the actual linux/amd64 images against its isolated local Supabase stack and runs
startup/login/download/export smoke. Those localhost-bound web images are never
promoted to staging; staging's own digests require the owner-run smoke above.

Runner prerequisites: [GitHub runner security](https://docs.github.com/en/actions/reference/security/secure-use),
[larger runner availability](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/use-larger-runners),
and [fork approval API](https://docs.github.com/en/rest/actions/permissions#get-fork-pr-contributor-approval-permissions-for-a-repository).
