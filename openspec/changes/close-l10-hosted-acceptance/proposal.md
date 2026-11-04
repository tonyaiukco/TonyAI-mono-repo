# Proposal

## Why

Hosted QA has run release `ci4-1` (source `bdf7646`) since 2026-11-03, but the L10 acceptance gate is still open. Nobody has proven hosted sign-in, record creation, file upload, email, the log-to-alert chain or rollback on this release. The acceptance package that already exists was prepared for r004. It stalled because every step needed its own sealed packet and approval, and because the `direct-url` metadata preflight was never confirmed. The owner wants L10 closed in two working sessions with one QA round between them, so the pilot timeline (QA handover 2026-11-06, G2 2026-11-15) holds.

## What Changes

- **Scope of L10 (owner decision 2026-11-04).** L10 closes when `ci4-1` has functional and operational acceptance. Numerical emissions acceptance moves to the LP4-02 gate. Consistent DB+Storage restore, secret rotation, Sentry and production recovery move to G2/LP5-03. Neither is claimed here.
- **Evidence standard (owner decision 2026-11-04).** One owner approval covers the whole package, inside a declared freeze window, and replaces per-step sealed packets. Three rules still hold: stop on any unexpected result with no automatic retry; keep secrets, passwords, tokens and action or signed links out of every record; bind each result to the source SHA, release ID and both image digests.
- **Secret version (owner decision 2026-11-04).** The pinned `direct-url` version is the GitHub variable `QA_DIRECT_URL_SECRET_VERSION`. Deploy run 41738446426 already migrated with it. The separate "single enabled version" metadata preflight is retired for this package.
- **Deploy classification fix.** `openspec/` joins the paths that cannot change an image, so merging planning artifacts no longer redeploys QA.
- **Live release inputs export.** A read-only operation writes the complete live release binding: digests, source, secret versions, storage settings, `mail` and `runtime_limits`. The existing smoke, storage and backup probes consume this file unchanged.
- **On-demand rollback.** A new operation, started from a manual workflow, moves QA to a previously deployed candidate and then forward again. It refuses when the move crosses a migration and reuses the rollout's verification and smoke. The drill runs `ci5 → ci4-1 → ci5`, where ci5 is the first QA-fix release. Rolling back to r004 is excluded by owner decision. If no ci5 is produced, the drill redeploys the same candidate under a new revision suffix instead.
- **Monitoring readback.** A read-only operation reports the Container Apps diagnostics destination, whether the log tables exist and receive rows, and the alert rules with their action routing. This replaces guessing why three bounded log queries returned 0 rows.
- **Hosted acceptance checklist.** A QA-run checklist in `docs/uat/` covers the record lifecycle, roles, period locks, audit, evidence, reports, TR/EN copy, `no_factor`, invitation and reset mail, and two-tenant isolation. Each row has PASS/FAIL and an evidence field.
- **Process records.** These go into the central planning file: the four decisions above, and the owner's temporary single-writer handover. Claude Code writes until L10 closes; Codex reviews only. Runbook 11 gets a `ci4-1` acceptance section that replaces the r004 package as the live procedure. The r004 package stays as history.

## Capabilities

### New Capabilities
- `qa-release-operations`: how hosted QA releases are classified, read back, rolled back on demand and checked for observability. Covers path classification, the live release binding export, the on-demand rollback with its migration guard, and the monitoring readback.

### Modified Capabilities
- None. `openspec/specs/` holds no capability yet.

## Impact

- **Code:** `infra/scripts/qa_autodeploy.py` (classification, `inputs` and `rollback` operations); `infra/scripts/cloud_ops.py` or a sibling script (monitoring readback); tests under `infra/tests/`.
- **Workflows:** a new manual `.github/workflows/rollback-qa.yml` in the `qa` environment, sharing deploy-qa's concurrency group. `test_workflow_security.py` covers it.
- **Docs:** `infra/runbooks/11-qa-hosted.md`, a new `docs/uat/` checklist, `README.md`, `docs/roadmap_docs/project_status_roadmap_phases.md` and the hosted roadmap's L10 row.
- **Live operations (owner-approved, outside the PR):** the QA deploy freeze, then probes A (two-tenant smoke) and C (storage), backup metadata, the foundation re-apply that moves the monitoring job off the r004 digest, the rollback drill, and a controlled alert test. There are two API outages of about 2.5 minutes each, announced to QA.
- **Not affected:** application code, the Prisma schema, RLS, the factor library and the calculation path. None of these changes, so no database migration ships.
