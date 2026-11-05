# Tasks

Branch `chore/l10-acceptance-package-2`. Groups 1–6 are the Session 1 PR. Groups 7–9 are owner-approved live operations and run outside the PR, under the one-approval evidence standard (proposal.md).

## 1. Deploy classification

- [x] 1.1 Add `openspec/` to `NON_IMAGE_PREFIXES` in `infra/scripts/qa_autodeploy.py`. Verify that `infra/tests/test_qa_autodeploy.py` gains cases where `openspec/`-only changes SKIP, `openspec/` + `apps/api/` DEPLOY counting one file, and `infra/certs/` still DEPLOYs; `python3 -m unittest infra/tests/test_qa_autodeploy.py` passes.

## 2. Live release inputs export

- [x] 2.1 Add the `inputs` operation (`--candidate`, `--out`). It extends the live binding with `mail` (SMTP env plus the `smtp-password` secret version) and `runtime_limits` (live API env), requires equal source tags and revision suffixes on both apps, writes the file with mode 0600, and runs `deploy_apps.verify` read-only against it. Verify unit tests cover: consistent state writes a binding the verifier accepts; mismatched apps refuse and write no file; a malformed secret reference refuses; no secret value or connection string appears in the output.
- [x] 2.2 Document the owner command sequence (`gh run download` of the candidate, then `az login`, then `inputs`) in runbook 11. Verify the documented flags match `--help`.

## 3. On-demand rollback

- [x] 3.1 Add the `rollback` operation (`--candidate`, `--mode candidate|same-image`). It validates the candidate, requires its source to be an ancestor of main's head, refuses when the migrations tree differs between the live source and the target source, refuses target == live unless the mode is `same-image`, then calls the existing `rollout()` with suffix `rb<run>-<attempt>`. Verify unit tests cover: rollback to an ancestor; return forward; a non-main candidate refused before drain; a migration difference refused before drain; target == live refused; same-image keeps digests and source tags; failure after drain restores the previous images (existing `rollout` test seam).
- [x] 3.2 Add `.github/workflows/rollback-qa.yml`. It runs on `workflow_dispatch` only, on `main` only, in `environment: qa`, with OIDC login, `concurrency: qa-deploy`, and `actions: read` to download `qa-candidate-<run>-<attempt>`. Its inputs are a digits-only run ID and the mode, both passed through env, never interpolated into shell. Actions are pinned by SHA as in `deploy-qa.yml`. Verify `infra/tests/test_workflow_security.py` asserts these properties and passes.
- [x] 3.3 Document the drill (`ci5 → ci4-1 → ci5`, the same-image fallback, the outage notice, stop rules) in runbook 11's automatic-deploy section. Verify the runbook links resolve.

## 4. Monitoring readback

- [x] 4.1 Add `infra/scripts/monitoring_readback.py`. It is read-only (`az rest` at the pinned API version plus bounded Log Analytics queries) and reports PASS/FAIL per link: environment log destination, diagnostic setting, ConsoleLogs and SystemLogs tables, rows in window, and each alert rule's enabled state, scope and action group. It reports counts only, never log content. Verify tests with recorded fixtures cover: a null destination fails and names the link; a missing diagnostic setting fails; a fully wired chain passes; no write verb is ever issued (the command recorder asserts GET/query only).
- [x] 4.2 Add it to runbook 11 next to runbook 06's monitoring section. Verify the documented command matches `--help`.

## 5. Hosted acceptance checklist

- [x] 5.1 Write `docs/uat/l10_hosted_acceptance.md` (English; UI strings by message key or English label). It contains one table per area as listed in design.md Decision 6, with ID, steps, expected result, PASS/FAIL, evidence reference and release columns. It states the ACS quota and the evidence rules. Verify every runbook 11 acceptance-checklist item maps to a row, and the doc contains no Turkish copy, credentials or links to private evidence.

## 6. Records, review and PR

- [x] 6.1 Runbook 11: add a "ci4-1 L10 acceptance" section (binding, freeze, probe commands, matrix with current state). Mark the r004 package as historical. Update the hosted roadmap's L10 row. Verify `git diff --check` and local link checks pass.
- [x] 6.2 Planning file: add a Decisions entry for 2026-11-04 covering the L10 scope, the evidence standard, the `direct-url` version, rollback option B with the same-image fallback and no r004, and the temporary single-writer handover (Claude Code writes until L10 closes; Codex reviews). Update Current status and Next up within the ten-entry cap. Add option D to Open questions. Verify the ten-entry and verbatim-archive rules hold.
- [x] 6.3 README: mention the `inputs`, `rollback` and monitoring readback operations and the rollback workflow. Verify the README commands match `--help`.
- [x] 6.4 Commit `openspec/config.yaml` and this change. Verify `openspec validate close-l10-hosted-acceptance` passes.
- [x] 6.5 Run Node 22 `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, and `python3 -m unittest discover -s infra/tests`. Verify all exit 0 and record any pre-existing warnings.
- [ ] 6.6 Run a fresh-eyes review with Codex (owner-requested reviewer) and `qa-auditor` in parallel on the diff, probing the rollback guards, workflow privilege and secret hygiene. Verify every blocker is fixed or answered in the PR. Open the PR with green CI; the owner merges after freezing "QA deploy".

## 7. Session 1 live acceptance (owner runs, Claude prepares and reads)

- [x] 7.1 Freeze "QA deploy" before the merge; after the merge, confirm the deploy run SKIPs or did not start. Verify `gh workflow list --all` shows it `disabled_manually` (`gh workflow view` cannot resolve a disabled workflow by name).
- [x] 7.2 Run `inputs` against live. Verify the binding equals `ci4-1` (source `bdf7646`, digests in the planning file) and stop on any difference.
- [x] 7.3 Pull the ci4-1 API image by digest. Run `hosted_smoke.py --verify-only`, then probe A (two tenants: login, own and foreign API/PostgREST confinement, exports, browser download, Auth absence). Verify PASS receipts are in `~/tonyai-evidence-backup/l10-ci4-1/` and the journal shows cleanup completed.
- [x] 7.4 Run probe C (`hosted_storage_probe.py`: three private buckets, size limits, MIME types, signed expiry, foreign denial, exact cleanup). Verify a PASS receipt and the cleanup of the exact probe paths.
- [x] 7.5 Run `hosted_backup_evidence.py` for recent backup metadata. Verify the receipt shows a backup inside the expected window. No restore is claimed.
- [x] 7.6 Run the monitoring readback. If any link fails, prepare the foundation plan that fixes routing and re-pins `storage-verify` to the ci4-1 digest; the owner applies it after the plan is inspected for changes beyond the known noise. Verify that a second readback passes every link.
- [x] 7.7 Hand the checklist to QA with the two holdings and the defect process (owner decision 2026-11-04: no window or sign-off date is recorded; QA reports its findings to the owner in its own format). Verify the handover is recorded in runbook 11.

## 8. Session 2: QA results, rollback drill, alert test

Order (owner decision 2026-11-06, design.md Decisions 8–11): 8.0 → 8.1 → 8.7 → 8.8 → 8.2/8.4 → 8.5 → 8.6 → 9.1. Numbers are kept stable because the planning file cites them.

- [x] 8.0 LP4-02 task 6.1, run inside L10 after the QA deploy of `9c6f70a` (run 42110731838) is green: provision the hosted loader login, dry-run `packages/db/factor-releases/tr-2026-11/ipcc.json` and `etkb.json` against hosted QA, and `--apply` on the owner's word. Verify `runtime-role.mjs check` passes, `GET /api/v1/factors` lists both releases as authoritative, and a QA record for 2025 TR electricity shows 0.434 kgCO2e/kWh; record the receipt without secrets, tick 6.1 in `lp4-02-tr-factor-package/tasks.md`, and run `/opsx:archive lp4-02-tr-factor-package`. **Done 2026-11-06:** the record is LP4-02's task 6.1. On this Mac the loader runs in a `node:22.23.3-bookworm` container (runbook 05).

- [ ] 8.1 Triage QA's report (`docs/uat/TonyAI BUG Report MD_v2.md`, BUG-01..10) per finding on the live release, after 8.0, and run its golden vector checklist on hosted. Verify every finding has a disposition (fixed with its PR, open, or new) and names the release that was live when it was made, and the golden checklist has a result per vector.
- [ ] 8.2 The freeze was lifted on 2026-11-05 (owner decision; merges deploy as they land, LP4-02 migrations included). Identify the live release after QA's fixes merge, and map every QA finding to the release that was live when it was made. Verify `inputs` shows that release, and check whether `git diff` of the migrations between `bdf7646` and its source is empty. If it is not empty, skip to 8.4. Expected since 2026-11-06: LP4-02's migrations differ, so 8.3 is recorded as not applicable and checked with that note.
- [ ] 8.3 After announcing the outage to QA, dispatch `rollback-qa` with `qa-candidate-4-1`, then with ci5's candidate. Verify both runs pass smoke and `inputs` shows ci4-1 and then ci5.
- [ ] 8.4 Fallback, when 8.2 found no release compatible with ci4-1 (expected once an LP4-02 migration has deployed): dispatch `rollback-qa` in `same-image` mode. Verify a new suffix, unchanged digests, and smoke PASS, and record that a cross-version rollback was not rehearsed.
- [ ] 8.5 Run the controlled alert test chosen from 7.6's readback. Verify the named operator acknowledges the notification and the readback shows the matching log rows.
- [ ] 8.6 Re-run probe A on the final live release. Verify PASS.
- [ ] 8.7 Fix in focused PRs, one per finding (owner, 2026-11-06: one PR, one commit per finding, on `fix/l10-qa-ui-fixes`; BUG-04's labels taken in): BUG-06 (comma refused while typing), BUG-07 (sub-location modal scroll), BUG-08 (year list to 2074) and the preview's "prototype covers 2026" hint (owner decision 2026-11-06), plus any other finding 8.1 left open that is a correctness, security or data-integrity defect. File the rest under Open questions; record BUG-05 (geolocation) as a post-pilot feature. Verify each PR has tests for the fix, green CI and its QA deploy, and 8.1's disposition names it.
- [ ] 8.8 Run `docs/uat/l10_hosted_acceptance.md` on the final release (after the last 8.7 deploy), adapting the UAT round 3 pre-pass harness; run mailbox rows with the owner. Verify every row has PASS or FAIL, an evidence ID in the private store and the release, every FAIL has a disposition, and no credential, action link or signed URL appears in any record.

## 9. L10 closure record

- [ ] 9.1 Fill runbook 11's ci4-1 matrix with each result (UTC and Europe/Istanbul time, release, digests, receipt ID). Mark L10 CLOSED in the hosted roadmap and the planning file, with numerical acceptance pointing to LP4-02 and full recovery to G2/LP5-03. The closure criterion (owner decision 2026-11-06): 8.4, 8.5 and 8.6 PASS, 8.8 complete, and every QA finding dispositioned in 8.1; the record names who ran each arm. Verify no unchecked in-scope item remains, then open the PR for Codex review.

## Workflow follow-up

- After the closure PR merges, end the temporary single-writer handover in the planning file (Codex resumes as writer).
- Archive this change with `/opsx:archive` once the owner accepts L10.
