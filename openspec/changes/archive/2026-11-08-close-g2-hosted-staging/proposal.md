# Proposal

## Why

Gate G2 ("repeatable labelled staging is available", LP2-01…LP2-03, target 2026-11-15) is the next gate on the pilot path, and L10 closed on 2026-11-07 having already proven most of it on hosted QA: the end-to-end journey (8.8, 41 PASS + 1 N/A on `ci17-1`), alert delivery to the named operator (8.5), same-image rollback (8.4) and the authenticated two-tenant smoke with exports (8.6, probe A on `rb1-1`). L10 explicitly left secret rotation, Sentry and recovery to G2/LP5-03, and the scheduled `storage-verify` job still runs `ci4-1`'s API image. The cards' boxes and the LP2-HQ ledger row also lag the evidence. G2 cannot be claimed until those gaps are closed or explicitly re-scoped.

## What Changes

- **Scope of G2 (owner decisions 2026-11-07).** (1) A consistent DB+Storage restore stays in LP5-03 (G5). G2 does not claim it, but the RPO/RTO targets are agreed now because LP2-04's PITR decision (O5) depends on them. (2) Sentry on QA means only the fixed-message `sentry-check` CLI run from a private owner shell. No standing `SENTRY_DSN` is set on QA. (3) The L1–L8 from-scratch hosted build counts as LP2-01's recreation evidence, together with one foundation `terraform plan` readback that shows only the intended changes.
- **Read-only verification (step 1, done 2026-11-08).** Hosted CI/CD runs through the GitHub `qa` environment (main-only branch policy), OIDC `azure/login` and the active `protect-main` ruleset. The `staging` environment and the JIT runner of `deploy-staging.yml` belong to the paused self-hosted route. Remote-target guards are in place for the seed, the RLS probes, the integration setup and the e2e owner connection. Smoke cleanup is journal-bound, and a failed cleanup blocks a pass. Root lint ignores nested worktrees. The 8.5 alert's query window is 26 h, so it cleared at 12:15:25 UTC on 2026-11-08, not 10:00 as recorded.
- **Owner drills (step 2), each announced first and run by the owner:**
  - **2a** One foundation plan and apply re-pins `storage-verify` to the live API digest (`sha256:c3a2d20c…`). It doubles as the recreation readback. The monitoring readback must then pass every link.
  - **2b** One runtime credential rotation (runbook 05 "Rotate the runtime credential", adapted to hosted QA), ending with the job re-pinned to the new secret version.
  - **2c** The `sentry-check` CLI on the live API image: the event and release are visible in Sentry, and the named operator receives it.
  - **2d** Bounded dependency loss: readiness returns 503 while liveness stays 200, with no restart loop, no stack trace and no Sentry event, and recovery follows on the next eligible probe.
- **Closure record (step 3).** The LP2-01…LP2-03 boxes are ticked with links to the evidence. The LP2-HQ ledger row and G2 status are updated, along with runbook 11's "Full G2/production recovery" row and the alert-clear time. The three decisions and the agreed RPO/RTO are recorded. Items that are not G2 stay under Open questions.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- None. This change records evidence and runs owner operations. No system behaviour changes, so `skip_specs` is set.

## Impact

- **Docs:** `docs/roadmap_docs/project_status_roadmap_phases.md` (Current status, Next up, ledger, LP2 cards, Decisions, Open questions), `infra/runbooks/11-qa-hosted.md` (a G2 section and the control table), `infra/runbooks/06-operations.md` / `05-rotation.md` only where the hosted procedure differs from what is written, and `docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md` (the G2 line).
- **Live operations (owner-run, outside the PR):** one or two foundation applies (2a, and the job re-pin in 2b), one runtime password change with a new API revision (2b, announced to QA as a short write-free window), one Sentry test event (2c) and the dependency-loss rehearsal (2d).
- **Not affected:** application code, the Prisma schema, RLS, migrations, the factor library and the calculation path. If a drill exposes a correctness or security defect, it gets its own focused PR.
- **Out of G2 (stay under Open questions):** Gmail spam on invitation/reset mail (LP2-04's custom domain), placeholder labels outside Reports/Emissions, the live PDF's Scope 3 standing, Scope 3 in Emissions totals, and auto-deploy not moving the `storage-verify` pin.
