# Design

## Context

See proposal.md for the motivation and the owner's scope decisions. The facts below shape how each drill runs. Step 1 read every one of them back on 2026-11-08.

- **Live release.** Web and API run revision `rb1-1`, which serves `ci17-1`'s images (API `sha256:c3a2d20c…`, web `sha256:3e2ee87b…`, source `d2a5f9b`). `main` at `8370935` carries docs only beyond that.
- **The `storage-verify` job** (`tonyaiqt-staging-storage-verify`, resource group `tonyai-qatmp-apps`) still runs API `sha256:efbbe12f…` (`ci4-1`). Its nightly runs succeed. The image, both secret versions and the operator are foundation inputs (`config.monitoring`), so only a foundation apply moves them, and auto-deploy never does.
- **L10's foundation input** is `~/tonyai-evidence-backup/l10-ci4-1/foundation-ci4-1.json`. Its `database_secret_version` and `backend_secret_version` equal the live release's values. Only `api_digest` differs. `infra/terraform/foundation/` and `terraform_run.py` are unchanged since `bdf7646`, the `release_sha` that L10's apply used.
- **L10's foundation plan** (`foundation-plan-1.txt`) was `0 to add, 2 to change, 0 to destroy`: `storage_verify["enabled"]` plus `join_grant[0]`, a recorded spelling difference that re-sends the same role GUID. The `join_grant` difference returned after that apply, so it is permanent and a foundation plan is never literally zero-diff. LP2-01's readback is therefore "no drift beyond the intended change and this recorded difference".
- **The alert rule** `tonyaiqt-staging-storage-verify` queries `ago(26h)` every 5 minutes with `autoMitigate` on. The 8.5 failure ran at 09:59 UTC on 2026-11-07, so the alert stayed fired until 12:15:25 UTC on 2026-11-08. `monitoring_readback.py` does not read the alert's state or count failures. Its result link only needs at least one `storage_verify` row in the window, so that failure does not affect it.
- **QA auto-deploy** carries the live API's Key Vault secret versions forward (`live_release_fields`). A rotated runtime version therefore reaches the apps only through an owner-selected release, not through a merge.

## Goals / Non-Goals

**Goals:**
- Each drill leaves a receipt bound to the release (source, revision suffix, both digests) and the time, stored privately under `~/tonyai-evidence-backup/g2/`. The repository gets hashes and outcomes only.
- No drill changes application code, and none weakens a grant, guard or RLS policy.

**Non-Goals:**
- A consistent DB+Storage restore, load budgets and production recovery (LP5-03).
- A custom mail domain and the production environment (LP2-04).
- Making auto-deploy move the `storage-verify` pin. That is filed as a follow-up.

## Decisions

**D1. 2a uses L10's foundation input with one field changed.**
- Write a new file, `~/tonyai-evidence-backup/g2/foundation-ci17-1.json`, copied from `foundation-ci4-1.json`. Only `config.monitoring.api_digest` becomes the live API digest. `release_sha` stays `bdf7646…` because the foundation code has not changed since then; moving it would retag every resource and hide the one real change.
- Expected plan: `storage_verify["enabled"]` updated in place (image only), and at most the known `join_grant[0]` re-send. Anything else stops the drill.
- Alternative: hand-edit the job with `az containerapp job update`. Rejected, because it creates drift that the next foundation plan would revert, and it gives no recreation readback.

**D2. 2a does not wait for the 8.5 alert to clear.**
- Sequence: apply, then one on-demand job execution on the new image, then `monitoring_readback.py --hours 26` with every link PASS.
- The readback is unaffected by L10's deliberate failure (see Context). The apply does not touch the alert rule. A success on the new image does not clear the alert early, because the query fires on any failure in the window.
- So the alert clearing (task 1.3) was checked on its own, whatever the order.

**D3. 2b follows 2a, and its job re-pin is a second, smaller foundation apply** that changes only `database_secret_version`.
- Keeping 2a separate fixes the known gap now and gives the rotation a clean baseline.
- Alternative: one combined apply after the rotation. That saves one apply but delays the fix and mixes two drills' evidence.

**D4. 2b's release step goes through an owner-selected manifest, not auto-deploy.**
- The manifest is built from a fresh `qa_autodeploy.py inputs` readback plus the new runtime version.
- `QA deploy` is disabled for the window and re-enabled afterwards (the 2026-11-03 policy).
- The deploy command stays `deploy-apps.sh` (the application Terraform path). A read-only plan on 2026-11-08 with the live release unchanged (`receipts/application-plan-preflight.txt`) showed only cosmetic differences left by auto-deploy's PATCHes: `transport` casing, the startup probe's position and computed output. No image, secret or setting differed, so the path is usable.
- The steps live in a private helper, `~/tonyai-evidence-backup/g2/rotation.py`, which the owner runs one step at a time. It follows runbook 05's order and calls the repository's own commands. Three things differ from the runbook, because of the hosted setup:
  - The new URL is built from the old version's URL with only the password replaced, and every value is read back from Key Vault by exact version, so no password is saved to disk. The owner pastes it from the clipboard at the hidden prompts, and the clipboard is cleared afterwards.
  - The runtime identity and privilege evidence runs inside the exact live API image, with the checkout's scripts and migrations mounted read-only. Prisma on macOS refuses the Supabase pooler certificate, and the URL's `sslcert` already names the image's path.
  - The old password is tried once, from the old Key Vault version, instead of a hidden `psql -W` prompt. A mistyped password would also be refused and would prove nothing.
- "Bucket checks" in task 3.3 means readiness, which covers all three private buckets, plus the `storage-verify` job after the re-pin. `hosted_storage_probe.py` needs a user's access token and tests Storage rules this rotation does not touch, so it is not rerun.
- Incident in the first attempt (2026-11-08, about 21:31 to 21:41 UTC): the owner copied the `\password` command from the instructions while the password was on the clipboard, so the command text was stored as the password. This was a flaw in the instructions. `\password` accepted it because both entries matched, and the identity check caught it. `rotation.py repair` recovered forward with no paste: it sends a client-side SCRAM verifier for the selected version and compares the stored verifier offline before any login. The closure record states this window, and runbook 05 gets the check.
- The nightly job at 02:00 UTC still selects the old version until task 3.4, so that apply must land before 02:00 UTC or the run fails and fires the alert.

**D5. 2c runs the exact live API image in a private owner shell.**
- The image is pulled from ACR by digest, and `node dist/observability/sentry-check.cli.js` runs with a DSN for a dedicated QA Sentry project, entered at a hidden prompt.
- No DSN goes onto the Container App (owner decision 2).
- Prerequisite: a Sentry organisation and project exist, and the operator's alert routing is set up (task 4.1).

**D6. 2d runs on the exact `ci17-1` API image against the local Supabase stack, not on shared QA.**
- Recommended because runbook 06 asks for an isolated rehearsal, and QA's testers share the hosted stack.
- On Supabase Cloud, denying the database means changing network restrictions. Container Apps consumption egress is not static, so that would cut off every user.
- What is under test (readiness deadlines, cache, 503 without a stack trace, no restart loop) is the image's code.
- Limitation, recorded: ACA ingress removing unready replicas is not exercised.
- A local HTTP sink stood in for Sentry so that an event from a readiness 503 would be counted. The results and the sink's contents are in `receipts/dep-loss-20261108T222114Z/`.
- Respect the 16 GB protocol: one capped API container, nothing else running.

**D7. Proposed RPO/RTO targets, for the owner to confirm:**
- RPO ≤ 24 h, which Supabase Pro's daily backups (7-day retention) already meet.
- RTO ≤ 1 working day for QA and the pilot.
- PITR (O5) is needed only if the owner sets an RPO below 24 h.
- LP5-03 measures against these targets.

## Risks / Trade-offs

- [The 2a plan shows changes beyond the job image] → Stop. Do not apply; compare with `foundation-plan-1.txt` and find the drift first.
- [An image-affecting merge lands between the apply and the readback] → The pin is stale again. Announce the window and keep image-affecting PRs unmerged until the readback.
- [2b: new connections fail after `\password`] → Use a write-free window announced to QA and recover forward. Never reselect the old manifest.
- [2b: the old password still works through the Supavisor cache] → Do not claim the rotation and do not disable old versions; resolve with Supabase first (runbook 05 step 10).
- [2c: no Sentry project exists yet] → 2c waits. G2 can close with 2c recorded as pending only if the owner accepts that explicitly.
- [2d is local] → It proves the image's behaviour, not hosted ingress. Record this as a limitation, not a pass on hosted.

## Migration Plan

No deploy of new code. Rollback per drill:
- **2a:** apply the previous input (`foundation-ci4-1.json`).
- **2b:** recover forward, per runbook 05.
- **2c and 2d:** nothing to roll back.

## Open Questions

- None. The backend file L10's apply used is the one recorded in the `hosted-deploy-path` note.
