# Design

## Context

The live target is `ci4-1`: source `bdf7646`, run 41738446426, artifact `qa-candidate-4-1`. Later merges move this binding, so it is re-read before every probe (see proposal.md, Why).

Facts the approach rests on:

- **Deploy path.** `infra/scripts/qa_autodeploy.py` provides `head | plan | wait-ci | migrate | rollout | check-github`. `rollout` drains the API, patches API then web through ARM, verifies, smokes, and restores the previous images on any failure (`rollout`, about lines 404–452). It cannot be started on its own: `deploy-qa.yml` only rolls out the commit at main's head, after building it.
- **Release binding.** `live_release()` rebuilds the binding from the live API app, but leaves out `mail` and `runtime_limits`. `deploy_apps.verify`, which `cloud_smoke` calls, refuses without them when SMTP is configured.
- **Existing probes.** `hosted_smoke.py` (A), `hosted_storage_probe.py` (C) and `hosted_backup_evidence.py` take `--candidate`, `--inputs`, `--helper-sha` and `--application-source`, and contain no r004 constants. A and D also need `--direct-secret-version`. `hosted_smoke.py` refuses to pull images, so the ci4-1 API image must already be in the local Docker cache.
- **Monitoring.** `monitoring.tf` pins the `storage-verify` job to the r004 API digest. The log chain is environment → Log Analytics (`azure-monitor`), plus a diagnostic setting for ConsoleLogs and SystemLogs, plus a scheduled query rule. Runbook 11 records live drift: "Existing diagnostics destination=null".
- **Migrations.** r004 (`7d3e2e9`) and `ci4-1` (`bdf7646`) ship the same migrations.
- **OpenSpec tracking.** `openspec/` is not in `NON_IMAGE_PREFIXES` and is not tracked in git yet.

**Update (2026-11-06).** The facts above describe Session 1. Since then: the freeze was lifted on 2026-11-05; QA runs `9c6f70a` (run 42110731838), whose migrations end at `20261107120000_lp4_02_billed_gcv_range`, so the migrations tree differs from `bdf7646` and the rollback guard makes `ci4-1` unreachable; QA's report lists BUG-01..10 in its own format plus a golden vector checklist. Decisions 8–11 record the owner's re-plan.

## Goals / Non-Goals

**Goals:**
- Reuse every existing probe unchanged. Add only the three missing operations: inputs export, on-demand rollback and monitoring readback.
- Keep each privileged action inside an identity and workflow that review already covers: the `qa` environment, OIDC and the `qa-deploy` concurrency group.
- Make QA's manual acceptance reproducible: one checklist, one evidence format.

**Non-Goals:**
- No change to application code, schema, RLS or the factor library.
- No automated hosted versions of the workflow, RBAC, lock or audit journeys. QA runs those manually from the checklist, and local Playwright already covers them on the seeded stack.
- No reconciliation of Terraform application state with ARM-patched images. That drift is known and recorded, not fixed here.
- No fault-injected rollout drill (option D). It is filed under Open questions in the planning file.

## Decisions

### 1. Rollback runs as a new manual workflow, not from the owner's laptop

**Choice.** Add `.github/workflows/rollback-qa.yml`: `workflow_dispatch` only, `main` only, `environment: qa`, the same OIDC login, and `concurrency: qa-deploy`. Its inputs are the candidate's run ID (digits only) and a mode (`candidate` or `same-image`). Before any Azure token exists, a `fetch-candidate` step checks through the GitHub API that the run is a completed, successful `deploy-qa.yml` run on `main` of this repository. It then downloads that run's `qa-candidate-<number>-<attempt>` with the runner's `gh` CLI (`actions: read`; no third-party download action) and requires the candidate to name the run's commit.

**Why.** The identity, its grants and the branch policy are already reviewed. A laptop run would need owner ARM credentials and a second, unreviewed rollout path.

**Freeze interaction.** Disabling "QA deploy" leaves this workflow available, which is what the drill needs. The shared concurrency group stops it from overlapping a deploy.

**Alternative rejected:** `deploy_apps.py` through Terraform. It is heavier, needs owner Terraform state access, and would fight the ARM-patched digests.

### 2. Rollback reuses `rollout()` unchanged

**Choice.** A new `rollback` operation:
1. Validates the downloaded candidate. Provenance is recomputed from the candidate commit's **git objects** (`git ls-tree`/`git show`): `candidate.bind` needs a clean checkout of that exact commit, while the workflow runs from `main`. The same applies to the inputs export (Decision 3).
2. Requires the candidate's source commit to be an ancestor of main's head. The workflow checks out with `fetch-depth: 0`.
3. Compares the `packages/db/prisma/migrations/` tree of the live source (from the live `source` tag) with the target source's tree, and refuses on any difference.
4. Refuses when the target equals live, unless the mode is `same-image`.
5. Calls the existing `rollout()` with revision suffix `rb<run_number>-<attempt>`.

**Why.** The rollback-on-failure branch in `rollout()` already restores the images that were live before it began, so a failed rollback returns to the live release for free. No migration runs.

**Return forward.** The same operation, given the candidate that was live before the rollback (ci5). The ancestor rule is "ancestor of main's head", not "ancestor of live", so this direction works too.

**Alternative rejected:** a separate restore implementation. It would be a second rollback code path that has never been exercised.

### 3. Inputs export is an `inputs` operation in `qa_autodeploy.py`

**Choice.** The operation extends `live_release()` with:
- a `mail` block read from the live API's SMTP env and the `smtp-password` secret reference;
- a `runtime_limits` block read from the live API env;
- a consistency check that both apps carry the same source and revision suffix.

It writes 0600 JSON, then runs `deploy_apps.verify` read-only against what it wrote.

**Who runs it.** The owner, locally, after `az login`, with the candidate downloaded through `gh run download`.

**Why here.** This is the module that already owns the live binding, and an inputs file must agree with the deploy path's own view of the release.

**Alternative rejected:** hand-writing the inputs file. That is what made the r004 package brittle.

### 4. Monitoring readback is a new read-only script

**Choice.** `infra/scripts/monitoring_readback.py`, using `az rest` at the pinned API version, plus one bounded Log Analytics query per table. It reports PASS or FAIL per link with counts only (environment log destination, diagnostic setting, tables, rows in window, rule enabled, scope, action group). Log lines never appear in the output.

**Why a new script.** `cloud_ops.py` is the storage and DB tool; mixing monitoring into it widens a reviewed surface.

**Fix path.** A FAIL is fixed through the foundation Terraform apply. That is the same apply that moves the `storage-verify` job off the r004 digest, so one owner approval covers both.

### 5. Probes A and C and the backup check run unchanged

They run locally with:
- the inputs file from Decision 3;
- the `qa-candidate-4-1` file;
- `--direct-secret-version` set to `QA_DIRECT_URL_SECRET_VERSION` (owner decision, proposal.md);
- a clean helper commit, which is the merged PR's SHA.

The owner pulls the ci4-1 API image by digest before the run, because the probe itself refuses to pull. Receipts go to a 0700 directory under `~/tonyai-evidence-backup/l10-ci4-1/`.

### 6. Manual acceptance lives in `docs/uat/l10_hosted_acceptance.md`

**Choice.** One table per area:
- record lifecycle and independent approval;
- the four roles;
- period lock;
- audit, with one row per mutation;
- evidence upload and 60-second signed download;
- PDF/XLSX/CSV, including the Scope 3 "Not covered" disclosure;
- `no_factor` refusal for Electricity preview, and "Not calculated" display;
- TR/EN copy;
- invitation and reset mail: arrival, natural expiry, replay refusal;
- cross-tenant isolation, using known owned objects in the two new holdings.

Each row has: ID, steps, expected result, PASS/FAIL, evidence reference, release.

**Language.** The document is in English. Turkish UI strings are referenced by message key or English label, never pasted in.

**Evidence.** Kept in the owner's private store and referenced by ID. Credentials, action links and signed URLs never appear in it.

### 7. Planning artifacts and process records ship in the same PR

**Choice.** The PR commits:
- `openspec/config.yaml` and this change;
- the `openspec/` prefix fix;
- the planning-file Decisions entry (the four decisions and the single-writer handover);
- the runbook 11 `ci4-1` acceptance section;
- the README.

**Why it is safe.** The merge commit's own classifier sees `openspec/` as non-image, because the workflow checks out the merge SHA. The deploy is also frozen before the merge.

### 8. L10 closes on Claude Code's own evidence (owner decision 2026-11-06)

**Choice.** L10 closes when three arms hold: the drills PASS (8.4 same-image rollback, 8.5 controlled alert test, 8.6 probe A on the final release); Claude Code's run of the hosted acceptance checklist on the final release is complete, with evidence per row ID (8.8); and every QA finding has a disposition on the live release (8.1).

**Why.** QA reported per finding, not per checklist row, so mapping its report onto the template would leave rows unproven and block the pilot timeline. The triage keeps QA's findings as the independent input.

**Trade-off.** The self-run checklist is not an independent check. The closure record states who ran it.

### 9. The TR factor load runs inside L10, before the triage (owner decision 2026-11-06)

**Choice.** LP4-02 task 6.1 runs as L10 task 8.0: provision the hosted loader login, dry-run `packages/db/factor-releases/tr-2026-11/ipcc.json` and `etkb.json`, `--apply` on the owner's word, and read back. It is ticked in LP4-02's `tasks.md`, which is then archived.

**Why before the triage.** BUG-01/02 (no factor) cannot be judged without the releases loaded. **Why after the deploy.** The IPCC release carries `billed_gcv_*` rows that only the CHECK from migration `20261107120000_lp4_02_billed_gcv_range` admits.

### 10. Claude Code runs the hosted acceptance checklist itself

**Choice.** Claude Code runs `docs/uat/l10_hosted_acceptance.md` on the final release, adapting the UAT round 3 pre-pass harness. Evidence stays in the owner's private store and is referenced by ID, under the rules of Decision 6. Rows that need something Claude Code cannot reach alone, such as a real mailbox for invitation and reset mail, are run with the owner, and their evidence field says so. No row is marked PASS without evidence.

**Why.** It turns the checklist from a template waiting for QA into evidence on the release that L10 accepts.

### 11. Fix scope inside L10 (owner decision 2026-11-06)

**Choice.** Focused PRs fix BUG-06, BUG-07, BUG-08 and the preview's "prototype covers 2026" hint, as exceptions to the pre-pilot rule that a non-defect finding is filed, not fixed, because they block the testers directly. Any other open correctness, security or data-integrity defect is fixed as well. Everything else goes to Open questions in the planning file. BUG-05 (geolocation) is a new feature, recorded for after the pilot.

## Risks / Trade-offs

- **QA produces no fix, so ci5 never exists.** → Run the same-image drill (spec: same-image redeploy). Record that a cross-version rollback was not rehearsed.
- **ci5 contains a migration.** → The rollback refuses by design, and the same-image drill runs instead. Never relax the guard for the drill.
- **The freeze is forgotten and a merge moves QA mid-acceptance.** → Re-run the inputs export before each probe and stop on any binding change. The freeze and unfreeze commands are in runbook 11.
- **The foundation plan shows changes beyond the known join-role spelling noise.** → Stop and report. Apply only an inspected plan.
- **The new privileged workflow becomes an attack surface.** → `main` only, the `qa` environment, digits-only run ID, no free-form input reaches a shell, and `test_workflow_security.py` assertions cover it.
- **ACS-managed domain quota is 5/min and 10/h.** → QA paces invitations and resets; the checklist states the ceiling.
- **Reset-link expiry needs real waiting time.** → QA checks expiry and replay at the end of its round, not inline.
- **Two API outages of about 2.5 minutes each during the drill.** → Run outside the QA test window and announce it beforehand.
- **Fix PRs deploy while the checklist runs.** → Run 8.8 only after the last L10 fix PR has deployed, and re-run the inputs export before each run and probe. A binding change mid-run restarts the affected rows.
- **The self-run checklist is not independent.** → QA's findings are triaged on their own (8.1), and the closure record names who ran each arm.

## Migration Plan

1. **Session 1.**
   1. Implement the PR.
   2. Codex review, plus `qa-auditor`.
   3. Owner freezes "QA deploy", then merges.
   4. Owner runs the inputs export, probes A and C, and the backup check.
   5. Owner runs the monitoring readback. If it fails, apply the foundation fix (this also re-pins the monitoring job).
   6. Hand the checklist to QA.
2. **QA round.** Checklist execution and bug list.
3. **Session 2 (superseded on 2026-11-06 by step 5 below).**
   1. Fixes merge with the deploy briefly unfrozen, which produces ci5. Then freeze again.
   2. Rollback drill: `ci5 → ci4-1 → ci5`.
   3. Controlled alert test.
   4. A smoke on ci5.
   5. Record results and close L10.
4. **L10 closure, re-planned (owner decision 2026-11-06).** Claude Code runs it in this order:
   0. Record the decision and revise this change.
   1. After the QA deploy of `9c6f70a` is green, load the TR releases (8.0).
   2. Triage QA's report on the live release, plus its golden vector checklist on hosted (8.1).
   3. Fix what stays open in focused PRs (8.7).
   4. Run the hosted acceptance checklist on the final release (8.8).
   5. Run the drills, each announced to the owner first: same-image rollback (8.2, 8.4), controlled alert test (8.5), probe A (8.6).
   6. Write the closure record (9.1).
5. **Backing out this change.** Revert the PR. It is infra, docs and planning only, so no QA redeploy follows. Delete `rollback-qa.yml` with it.

## Open Questions

- **Controlled alert test method.** Two candidates: one deliberately failing `storage-verify` execution, or relying on the drill's outage against the native 5xx and restart rules. Chosen after the monitoring readback shows which rules evaluate. The task is the same either way.
- **QA window and drill times.** Set by the owner with the QA team.
