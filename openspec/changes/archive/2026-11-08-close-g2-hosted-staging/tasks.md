# Tasks

## 1. Read-only verification (step 1)

- [x] 1.1 Read back the live job image, alert state and rule window, recent `storage-verify` executions, GitHub `qa` environment, ruleset and deploy workflows (2026-11-08; findings in proposal.md)
- [x] 1.2 Confirm remote-target guards (seed, RLS probes, int setup, e2e owner connection), journal-bound smoke cleanup and the lint worktree ignores
- [x] 1.3 After about 12:05 UTC on 2026-11-08, confirm the 8.5 alert has auto-resolved and the 02:00 UTC execution on 2026-11-08 succeeded

## 2. 2a: re-pin `storage-verify` and read back the foundation

- [x] 2.1 Write `~/tonyai-evidence-backup/g2/foundation-ci17-1.json` from L10's input, changing only `config.monitoring.api_digest` to the live API digest, and confirm by diff that nothing else changed
- [x] 2.2 Owner runs the foundation plan with L10's backend file and saves it as `g2/receipts/foundation-plan-2a.txt`; Claude checks it shows only `storage_verify` (image) and at most the known `join_grant` re-send
- [x] 2.3 On the owner's word: foundation apply, saved as `foundation-apply-2a.txt`
- [x] 2.4 Start one on-demand `storage-verify` execution and confirm it succeeds on the new image
- [x] 2.5 Run `monitoring_readback.py --hours 26`: every link PASS (receipt `monitoring-2a-*.txt`)

## 3. 2b: runtime credential rotation

- [x] 3.1 Map runbook 05's runtime rotation onto hosted QA (manifest from `inputs` plus the new version, hosted deploy command, `QA deploy` disabled/re-enabled) and present the exact steps to the owner
- [x] 3.2 Announce a write-free window to QA; owner stores the new `database-url` version, verifies it, runs `\password tonyai_runtime`, and the runtime identity/privilege evidence passes
- [x] 3.3 Deploy the release selecting the new version; readiness, probe A (login and exports) and the bucket checks pass
- [x] 3.4 Foundation apply that changes only `database_secret_version`; one job execution and the monitoring readback pass
- [x] 3.5 Prove a fresh Supavisor connection with the old password is refused, then disable the superseded version

## 4. 2c: error reporting

- [x] 4.1 Owner confirms a Sentry organisation and dedicated QA project exist (or creates them), with the named operator's alert routing
- [x] 4.2 Run `sentry-check.cli.js` from the exact live API image in a private owner shell, DSN entered at a hidden prompt; the event and release are visible in Sentry and the operator receives it

## 5. 2d: bounded dependency loss (local, exact image)

- [x] 5.1 Run the `ci17-1` API image against the local Supabase stack (one capped container): readiness 200 and liveness 200 as baseline
- [x] 5.2 Stop the database, then separately Storage: readiness 503 within 7.5 s plus polling, liveness 200, no stack trace from readiness in the logs, no restart loop; recovery on the next eligible probe
- [x] 5.3 Hung connection and cold start with the database down: record recovery or the required operator restart

## 6. Closure record (step 3)

- [x] 6.1 Owner confirms the RPO/RTO targets (accepted 2026-11-08: RPO ≤ 24 h, RTO ≤ 1 working day)
- [x] 6.2 Planning file: tick LP2-01…LP2-03 with evidence links, record G2's status and the three decisions plus RPO/RTO under Decisions, update the LP2-HQ ledger row, Current status and Next up, and correct the alert-clear time
- [x] 6.3 Runbook 11: add a G2 section and update the "Full G2/production recovery" row; correct runbooks 05/06 only where the hosted procedure differs
- [x] 6.4 Hosted roadmap: update the G2 line
- [x] 6.5 Open questions: keep the non-G2 items and add "auto-deploy does not move the `storage-verify` pin"
- [x] 6.6 Open one PR (docs only, deploy SKIP) with `openspec validate` clean; the user merges

## Workflow follow-up

- Archive the change with `/opsx:archive` after the PR merges.
