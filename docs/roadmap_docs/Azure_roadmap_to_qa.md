# Azure delivery to QA — Claude Code continuation

Owner-requested handoff, 2026-10-24 (Europe/Istanbul). The owner stopped Codex work because approximately 2% usage remained and explicitly requested this file. Continue in Claude Code. This is a continuation checkpoint, not R3 acceptance or a publication request.

## Start here

1. Read `CLAUDE.md`, `AGENTS.md`, the canonical `docs/roadmap_docs/project_status_roadmap_phases.md` (Part A, B1–B4, B8/B9, LP2 cards and cited Part C findings), `Azure_roadmap_plan.md`, and runbooks 00, 08, 09 and especially 10.
2. Read the complete original owner request at `/Users/denizb/.codex/attachments/d830bfd5-0236-452c-891d-8077a5464bf3/Pasted text.txt`. It defines `R3_END_TO_END_CLOSURE`, authorization boundaries and actual completion criteria.
3. Read the current private evidence root `/private/tmp/tonyai-r3-closure-kuhmangj`, starting with `operation-result-matrix06.json`, `claude-handoff-source-snapshot01.json`, the reviews below and their linked evidence. Matrix06 supersedes matrix05; preserve both. Recompute hashes rather than trusting prose alone.
4. Inspect all relevant worktrees before editing. **The unpublished B implementation is in a managed worktree, not the main checkout.** Preserve it. Do not reset, regenerate old packets, replay consumed attempts or treat old fresh observations as current.

The canonical roadmap was not edited. This new file is the owner's explicit exception to the usual prohibition on new handoff/status files. The owner subsequently authorized commit, branch push and PR creation for this handoff document. The unpublished B implementation still requires its own reviewed publication scope and approval. Private operational evidence stays in its existing local directories.

## Actual gates and authorization

**R3 and CL-P2-3 remain OPEN. Bootstrap remains NOT_READY_FOR_BOOTSTRAP_APPROVAL.** No actual host bootstrap or accepted installation qualification occurred. SSH access has not yet been recovered. Collection is evidence, not accepted policy. PackageKit eligibility, P3 lifecycle/effect issues, native/exact-target qualification, nine-service transport, DB regression and actual Realtime GCM consumer remain open.

The owner authorized routine private evidence inspection, offline preparation, narrow implementation, synthetic tests and independent Security/QA review without repeated permission. Coordinate independent reviews. The owner requires a concrete reviewed scope and a separate exact approval for:

- Commit/push/PR creation or update; only the owner merges.
- Workflow dispatch/rerun, tool install, Docker/disposable runtime.
- New Azure/host-key observations, SSH/guest commands, Azure mutations.
- Collector/qualification executions, disks, bootstrap, deployment/install.

A refused, partial, interrupted or failed attempt consumes its approval. A retry needs a new exact approval. Never manufacture authorization references or freshness. Freshness is at most 900 seconds and must be rechecked at the operation's actual enforced boundaries. Do not assume the previous exclusive operator window remains open. Owner-only login/MFA/token/private-key steps remain with the owner. Never read token/private-key contents or ask for them in chat. Existing controller transport may use its explicitly bound token file only within approved execution. Keep private directories 0700 and files 0600. The local Supabase stack belongs to the Claude lane; no stack was started by Codex.

## Checkouts and published work

Main checkout: `/Users/denizb/Repos/TonyAI-mono-repo-codex`.
Last local HEAD: `cc74bd7a940c985e10d2333bd43152f895663aeb`; main tree `6d0e76d27c0e0b29da853f1830cb64dd4d0c9c08`. It was clean immediately before this handoff file. Refresh remote/main correspondence read-only before integrating; do not assume no owner merges occurred meanwhile.

| Work | Location / branch | Exact source and state |
| --- | --- | --- |
| A snap leaf diagnostic | `/Users/denizb/.codex/worktrees/r3-snap-leaf-diagnostic/TonyAI-mono-repo-codex`, `feat/r3-snap-leaf-diagnostic` | `caf0639960834831a22366dce5e452cea8a2b403`; published PR #216, no Codex merge |
| B identity diagnostic | Published `fix/r3-recovery-identity-diagnostic` | `ff3e37ada40ea86cbfaf0f1b3bfe2a17a010f852`; published PR #218, no Codex merge |
| **B new recovery amendment** | `/Users/denizb/.codex/worktrees/r3-recovery-identity-diagnostic/TonyAI-mono-repo-codex`, **`fix/r3-identity-bound-recovery`** | HEAD remains `ff3e37a…`; **nine dirty/new files, uncommitted and unpublished** |
| Clean B execution source | `/private/tmp/tonyai-r3-identity-source-06bqki_h/checkout` | `ff3e37a…`; unchanged published execution source |
| Historical recovery source | `/private/tmp/tonyai-r3-main-source-ffywatfi/checkout` | `cc74bd7…`; preserve |

PRs: https://github.com/tonyaiukco/TonyAI-mono-repo/pull/216 and https://github.com/tonyaiukco/TonyAI-mono-repo/pull/218. Both attached to the Codex chat. B publication attempt01 was rejected by GitHub; the owner approved one normal push/PR retry, which succeeded. Preserve those failed/retry records. This was not an automatic tool approval rejection.

`ci-publication-correspondence01.md` and its JSON verify the actual CI checkout trees against published source. Both PRs had five successful checks. A: 603 Python tests, B: 597, zero Linux skips; each 21 Node infra tests and full 297 mutations killed, zero survivors/invalid. CI used merge checkouts, not the source commit itself: A checkout `39136c37f949bfc9e12faeeb77adfb92c4e4a492`, B `05e620a44f365e10b0c42140730fa748a6f25e0a`. Do not transfer these results to the new dirty amendment.

## B — actual access-recovery history

The approved extension enable succeeded: one PATCH with `If-Match: "1"`, `allowExtensionOperations=false → true`, VM ETag `1 → 2`. This does not establish recovered access.

Historical `recovery-main01`, packet `371f6a2b01444ba18a23d3844afdf81c`, delivery SHA256 `6107578691170cf48479e2936e7d8c33012611751cdd1686c69605f093e4c500`:

- One approved managed key-append PUT ran. Controller returned PARTIAL because of its ARM region spelling check while the first response was pending.
- A separately approved single status GET proved the guest actually refused at `identity-before`, `ValueError`, exit 2, provider/execution `Failed`.
- No append and no guest evidence-directory path were reported. Do not fetch nonexistent guest evidence or retry that packet. Microsoft handler platform effects still occurred.

A new separately published diagnostic was then prepared and executed:

- Packet `identity-diagnostic01`, ID `c3a70090753d41bc81cdc01d524935d5`.
- Delivery SHA256 `d16a69c7c251d76735a18f3091c957aded71a152ac6cfeb51743c4b2b42e7f76`.
- Owner approved observation03: twelve ARM GETs plus Ed25519 host-pin comparison, all accepted and sealed. Its fresh VM observation was `2026-10-24T19:22:35.251676Z`, expiring `19:37:35.251676Z`. **Expired; never reuse.**
- First diagnostic CLI invocation omitted mandatory `--execute`. It stopped at argparse before client construction: zero GET/PUT. The owner approved a distinct corrected retry; preserve both records.
- Corrected retry completed with **7 GET + 1 PUT**, one new diagnostic command. Guest execution `Succeeded`, exit 0; report accepted independently by Security and QA.
- **Last observed provider provisioning state was still `Creating`.** Do not describe it as provider-terminal success. New recovery requires a separately approved fresh read proving terminal `Succeeded`.
- Only the IMDS location spelling differed; seven other selected identity fields matched. Corrected expected IMDS spelling is recorded in the private report. This diagnostic explains the current strict comparison, not a retroactive raw-IMDS proof for the earlier failure.
- Diagnostic ciphertext SHA256 `9d8d193eb215416a3824acacbe63684f58f9c2ab3de8fbb63dc484330a95288e`.

Read `identity-diagnostic-outcome-qa01.md`, `identity-diagnostic-outcome-security01.md` and `identity-diagnostic-outcome-security-addendum01.md` in the private root. Raw captures and approval/consumption records remain under `identity-diagnostic01`.

### B amendment implementation ready for final verification/publication preparation

Nine changed/new files in `fix/r3-identity-bound-recovery`:

- `infra/scripts/r3_access_repair_amendment.py` (new).
- `infra/scripts/r3_access_repair_history.py` (new).
- `infra/scripts/r3_access_repair_packet.py`, `r3_access_repair_contract.py`, `r3_access_repair_control.py`.
- `infra/tests/test_r3_access_amendment.py` (new), `infra/tests/r3_mutations.py`.
- `README.md`, `infra/runbooks/10-qa-clean-replacement.md`.

The implementation creates a new, exact diagnostic-bound append attempt. Guest IMDS remains byte-exact; only the proven expected location is corrected. ARM VM checks retain their original spelling. It permits exactly two proven predecessor command IDs, verifies full fresh bodies, exact scripts/options/output, old Failed/exit2 and diagnostic provider/execution Succeeded/exit0, then checks absence and sends one new PUT. It permits at most six precondition GETs, one PUT, five polls: 12 requests. No predecessor update/delete. Freshness is checked at approval and immediately before mutation, not every GET. Existing request deadlines, 180-second start budget, durable consumption and private sealing remain.

The historical verifier parses but never executes retained code. It validates full shell/Python wrappers, embedded proposals, decoded module closure, request and export hashes. Security caught an internally consistent forged source-map attack; immutable source-map anchors now close it:

| Historical source | Source-map SHA256 | Independent Git verification |
| --- | --- | --- |
| `cc74bd7a940c985e10d2333bd43152f895663aeb` | `24e9dc15cfeb082ad7ae1b52c9e6c7a959668eade0c2d1a85eac26604bcb60d4` | 24/24 blobs |
| `ff3e37ada40ea86cbfaf0f1b3bfe2a17a010f852` | `1158ade2d0ae9ebba7a009b3f1ccddded7042b346e9122a6162f3840b81622d6` | 25/25 blobs |

`decision_sha256` is a review reference, not execution authority. A future exact owner approval binds the new delivery/fresh hashes. The new request body uses the corrected region casing; docs explicitly disclose that. The later separate export accepts exactly the two predecessors plus the new repair command and preserves strict guest custody validation. Export does not itself perform ARM readback; fresh predecessor observations are a separate scope.

Actual verification on this dirty worktree, HEAD `ff3e37a…`:

- New amendment suite: **15 passed**.
- Full infrastructure discovery: **612 passed, one platform skip**, 42.719 seconds; `amendment-tests01/infra-result.json` and logs. Warnings were recorded, not hidden.
- Existing Node **22.23.3**, pnpm **11.9.0**: build, lint, typecheck, test all exit 0; `amendment-node22-checks01/result.json` and logs. Several tasks used Turbo cache; do not imply all tasks reran uncached.
- Actual retained old and diagnostic packets pass the new verifier with unpatched production anchors.
- Security review03: no remaining source blocker, six independent consistent-provenance forgeries rejected. `recovery-amendment-security-review03.md`, SHA256 `6ea1000bdbf05f1ac26d6d7d15884dfad0459d1a48daa22330d22054b1dfe4c0`.
- QA interim: 78 access tests and four additional adversarial tests passed, including actual export approval/envelope validation with fake transport/sealing. `identity-amendment-qa01.md`, SHA256 `45461268965f3eb711715c119fb8794207cc9cb7b9ed931e746eafb9e5c4f030`.
- Full mutation run started with **309 mutations** (297 existing + 12 new). Its final state is recorded in the final checkpoint below. Never assume success from the suite starting.

Next B steps: finish/check mutation results; repair any survivor; final frozen-source Security/QA correspondence; prepare exact commit/branch-push/PR scope and ask owner once ready. **No publication permission exists for this new amendment branch.** It depends on published PR218 source. After publication and packet review, obtain a new separately approved observation (same target plus both predecessor expanded statuses; expected scope 13 ARM GETs plus host pin, to be reviewed), require diagnostic provider-terminal success, create a new unique amended repair packet, then ask exact append approval. Actual successful append still requires separately approved private evidence fetch and access acceptance. Do not jump directly to collection/bootstrap.

### Authentication custody

Owner installed Azure CLI 2.91.0 and completed tenant/subscription login. Authentication scripts and confirmations are in the private root. Latest owner-only preparation was `owner-auth03.sh`; `owner-auth03-confirmation.json` records only safe file metadata. Token file lives in `/private/tmp/tonyai-r3-arm-auth-pyn7zw7x`, outside the evidence root. **Do not open it.** It may now be expired; use the reviewed owner-only procedure with a new filename/attempt if a new token is needed. Do not reuse/overwrite old empty or expired token files.

Public-key, known-hosts and age tool bindings are in existing delivery/custody records. The owner retains private-key custody. No agent decrypted A evidence or accessed a private key. Do not discover alternate credentials or silently change the authentication route.

## A — snap diagnostic accepted, collection still incomplete

Published source `caf0639…`, run **40125054738 attempt1**, one owner-approved dispatch. Workflow succeeded. This was an ephemeral network-isolated Noble guest diagnostic with disclosed runner package installation effects, not Azure execution or bootstrap.

Private root: `/private/tmp/tonyai-r3-closure-kuhmangj/snap-run40125054738-readback01`.

- Exactly one artifact; allowed files were encrypted evidence, binding and public summary.
- Ciphertext SHA256 `324c8233ac952b5846e6aa47957e5a39ce6d6f65b6c108c13d0954e4b0431636`.
- Owner ran reviewed `owner-decrypt01.sh` and replied “çözüldü”. Private plaintext SHA256 `4cbaccaac5b7fa6d80cfb5313969d0d30e77854a61915f7a5b0705a91c49c2fc`.
- Final validator `validate-private-snap01.py` SHA256 `169ece2bb36e9a819fb901d57afb44c4b1ac90d18c8fb091c9d5a2d9e663efa9`; 78 outer members, three guest members, all 1066 source blobs verified. QA found and fixed concatenated-TAR trailer acceptance before actual validation. Final independent synthetic checks passed.
- The fixed snap path was a stable root-owned symbolic link with the expected relative alias, not a regular executable. The report records exact bytes/hash and metadata. This supports the current no-follow ELOOP explanation, but does not prove the historical leaf, target bytes, execution behavior or installation eligibility.
- Independent actual-outcome reviews: `snap-diagnostic-outcome-qa01.md` and `snap-diagnostic-outcome-security01.md`. Read the validator/decryption reviews as needed.

Next collector design is in `snap-collector-adaptation-options01.md`. Recommended narrow path: a versioned evidence-only record for the exact known alias, plus an independently opened **fixed** `/usr/lib/snapd/snapd` digest; no recursive symlink following, no opening the alias as an executable, and no generic no-follow relaxation. Proposed target-only 64MiB streaming cap; current target size is unobserved. Preserve absent/regular cases explicitly, source/IMDS bindings, parent/leaf stability, late repeated sampling, bounded errors and cleanup. Keep old evidence schema and diagnostic semantics valid. Fixed package metadata corroboration is optional design scope, not publisher provenance. No implementation or new A branch has been created for this collector adaptation.

Collection completeness must remain separate from installer acceptance: snap review records currently do not enter installer facts hashes. PackageKit remains independently blocking. Changing collection helper modules also changes recovery source maps; integrate deliberately and never silently rebind a frozen/consumed B packet.

## Package effects / PackageKit / P3

Read `installer-effect-review.md`, `packagekit-supplemental-collection-plan01.md`, and `native-hook-reachability-disposition01.md` (SHA256 `87268a4adcf3b4eb89a851e01194f3b1c95896103c40e812980376fff9fe65b4`). The current installer requires PackageKit activation predicate false, while retained A reports true. Stopping only the five existing units does not remove this conflict. Do not suppress hooks, stop a sixth service, exempt writers or treat a notification as harmless without proof.

The review covers retained five Docker package control scripts, triggers, systemd/deb-systemd helpers, AppArmor, man-db, needrestart, D-Bus and APT effects. Existing retained archive analysis is not fresh signature/extraction proof; original five Debian archive files were not found in searched roots. No native/exact-target installation qualification has run.

Latest offline findings: retained apt-config output identifies `binary=apt-config`, not effective apt-get configuration. Snap's hook is under `binary::apt::AptCli::Hooks::Install`; exact APT source proof for apt-get exclusion is missing. Actual PackageKit hook tests `/var/run/dbus/system_bus_socket`, while collector predicate samples `/run/dbus/system_bus_socket`; alias correspondence is unproved. The conservative installer predicate still refuses. `packagekitd` is also a guarded foreign manager, independent of whether its writes seem benign. Retain all lifecycle/interruption/unmask/reboot, sampling, process writer/content, detached-child, lock/order and cleanup questions. A genuine contract conflict needs a concrete independently reviewed owner decision, not a silent bypass.

## DB replacement regression — independent offline progress

The owner confirmed the original exact `supautils` reproduction was never retained and its only owner-held file is gone. The owner explicitly accepted preparation of a replacement criterion while historical event remains **NOT_REPRODUCED**. Do not claim historical reproduction.

Read `db-replacement-regression-proposal01.md`, `db-prisma-harness-implementation-plan01.md`, `db-live-adapter-security-plan01.md`, and new **`db-real-entrypoint-plan01.md`**.

Private `db-candidate01` contains:

- `driver.mjs`: injected pure orchestration, **32 tests passed**; no live client construction or CLI.
- `prisma-adapter.mjs`: wraps an already supplied Prisma client, fixed SQL allowlist, one interactive transaction/client, strict timeouts, no retry, sticky violations, no late callback execution; **21 tests passed** plus independent adversarial checks. SHA256 `f48ef01e8f8d06dda6b330d7c2e757fd535458279d8e67858b89b73e4e1e43b9`.
- Final adapter QA02 and Security02 reports accepted the offline wrapper. Earlier reports/findings are preserved.

Criterion: six GRANT/REVOKE CURRENT_USER/SESSION_USER/PUBLIC variants, three repetitions, plus two named controls; exact expected SQLSTATE, same persistent connection/backend/PID/sentinel, postmaster continuity, independent A/B/C connections, positive controls, unchanged role memberships and complete bounded crash logs. Real driver queries need bounded membership/sentinel results and an injected loaded-library attestation seam before runtime.

Policy pins: PostgreSQL17.11, supautils3.4.4. Binary SHA256 `d9cf21be28ce84a1c8d17500164d5d35d59cf67d991677adf396f1500ca23261`; policy/config/source identities are recorded in the plans. New offline investigation found retained `security/source344-supautils.c` and reconstructed `src/roles.c` from retained comparison metadata with matching Git blob/hash. This establishes the RoleSpec path even when reserved_roles is empty; it does not establish the currently loaded binary.

Missing live entrypoint work: exact existing generated Prisma6.19.3/Linux engine/dependency closure, clean direct connection environment before client construction, fixed isolated two-role/one-database setup, startup include chain/GUC/auth configuration, A/B/C `/proc` loaded-library/inode/hash evidence, complete bounded log interval, external deadline, cleanup and encryption. No DB/container/credentials/setup has been run. Reuse existing pure OCI/runtime/custody guards, **not `r3_qualification.run` unchanged**, because that starts nine services. No local stack reuse without the proper lane slot.

## Realtime and nine-service transport

`realtime-provenance-review.md`, `realtime-gcm-consumer-plan01.md`, and `realtime-gcm-harness-architecture01.md` contain retained source evidence and the implementation plan.

- Realtime source `ef866244e88428bbd286f3e4ac88eb5e54a41bd4`, v2.134.10; retained image/source assertion is unsigned and builder/dependency correspondence remains incomplete.
- API writes JWT secret and five DB fields; health200 is not a GCM consumer proof.
- Proposed injected harness uses existing realtime-js/Phoenix/ws/jose/Prisma, two isolated services and two synthetic tenants; exercise six stored fields, actual API/socket/broadcast/DB changes, cold restart persistence, ten tag-tamper cases and separate JWT/DB wrong-key cases. Bound SDK reconnect/rejoin behavior; fresh sockets per refusal. No harness implementation or runtime run yet.
- Registry-denied, empty-store exact nine-service transport has not run. Twelve pins/nine active services and existing archives remain evidence/preparation only. Never pull/build implicitly or claim transport qualification from archive validation.

## Continuation order and final acceptance

1. Resolve the final B amendment mutation/freeze status, prepare reviewed publication scope, obtain exact owner approval, publish and verify source/CI correspondence.
2. Prepare new observation and amended recovery packet using published source. Require fresh terminal predecessor evidence, new exact owner window/approval, one append, then separate evidence fetch and independent access acceptance.
3. Complete snap-aware A/B collector preparation, source/contract review and separately approved runs. Preserve old PARTIAL outcomes.
4. Resolve substantive package/source effects and PackageKit/P3 contract conflicts before asking for installation qualification. Obtain owner decisions only for concrete reviewed changes that exceed existing authorization.
5. Advance DB/Realtime/transport preparation independently; execute only under exact approved isolated scopes.
6. Only after all pre-bootstrap gates and independent reviews pass, prepare and obtain exact actual-host bootstrap approval; preserve disk, identity, modes/ownership and two-stage environment/intrinsic escrow requirements.
7. Independent actual runtime/host/custody acceptance is necessary to close R3. Then produce the final operation matrix, consumed/retry ledger, private evidence index/hashes, gate dispositions, B9 and canonical Claude-lane ledger update. No final closure index/B9 has been produced yet.

The owner intentionally transferred this task. Do not leave it parked merely because PR216/218 exist, and do not interpret this checkpoint as an instruction to repeat completed suites or live attempts.

## Final checkpoint

See the appended handoff verification below for the mutation process disposition and exact current source snapshot. The documentation branch contains only this requested handoff file. No new live action was started during handoff.


### Handoff verification — 2026-10-24

- Snapshot: `/private/tmp/tonyai-r3-closure-kuhmangj/claude-handoff-source-snapshot01.json`, SHA256 `4ef89d50ad3a837fd6797867ff433633a20eb98b2ddeb915acc4e7d38e05d9c6`. It binds all nine dirty/new B files to their exact hashes and records the unpublished branch/base. Compare these bytes before relying on the reviews.
- Mutation result JSON was **absent at the latest publication check**; completion is unverified. Codex execution session ID `61814` is local to this chat. Claude Code should inspect the OS process whose command is `python3 -B infra/tests/r3_mutations.py --output /private/tmp/tonyai-r3-closure-kuhmangj/amendment-mutations01.json` and then read that result plus `amendment-mutations01.stdout.log` / `.stderr.log`. The run uses a disposable source copy, not live Azure/guest/runtime. Do not start a duplicate while it is active. If it exits without a complete source-bound result, record it as incomplete and rerun the offline suite as needed; never infer all mutations passed. Final Security/QA publication acceptance remains pending this result and exact freeze correspondence.
- All independent review/investigation agents finished their requested work. No pending live operation or owner approval request exists. The later owner publication authorization covers this document only.
- No new A collector implementation was started. No DB/Realtime/live qualification ran during handoff.
