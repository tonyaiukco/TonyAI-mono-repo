# Azure delivery plan: trusted QA, recovery, then production

Dated **2026-10-17**, second revision after PR #184 re-review of `347e3b8`; source baseline **`7dd700445c00511476304d781eab8bbd7f7de457`** (#183). Dates use Europe/Istanbul. This is the owner's requested supplementary plan, not a ledger or authorization to execute. If it disagrees with the [canonical roadmap's Part A](project_status_roadmap_phases.md#part-a--working-set), Part A wins until the owner records a decision there. Detailed file ownership and accepted milestones do not change through this file; the owner's delivery instruction is recorded at the end of section 9.

## 1. Forecast, capacity and decisions

**Recommendation for the owner: plan on 2027-02-15 only if SC1's recovery implementer is staffed by 10-26 and every entry gate passes; it now has no meaningful float. SC2's serial forecast is 03-01.** These are proposals, not changes to the canonical 02-01 target/02-15 fallback. The previous SC2 02-15 claim compressed qualification and omitted storage/operator work. Even the review's 02-17 to 02-22 estimate precedes the newly scheduled backup foundation. Do not retain those dates without named additional capacity and a recalculated plan.

Assume one serial Codex cloud implementer, Claude Code about one review day per two cloud days, and O available 2-4 hours/day. **O executes at most one approved live packet/day including readback** unless a named T has issued access and an explicitly assigned packet. T is not currently staffed. A recovery implementer is not another live operator. Reserve a full four-hour window for each recovery drill and automate the two-hour marker prelude. D's M1 API implementation needs its own reservation, beyond review capacity; absent that reservation Q18 and all dependent dates move. No package's first implementation, independent review and first live use share a day; failures consume additional days.

| Phase / milestone | SC1: RI starts by 10-26, O remains sole live operator | SC2: one implementer and O | Entry / consequence |
| --- | --- | --- | --- |
| A: N2, R2, R3, full R4 / PD-3 | 10-19 to approximately 11-03 | Same | Network/backup design before R2; no broad drift waiver |
| B: integration tooling / first app release | Tooling through 11-20; release N on 11-24 | Same | Accepted storage-origin contract before private edge |
| C: proposed G2-functional | 12-07; reserve to 12-16 | 12-07; same reserve | Split live packets, two acceptance days, cloud-UAT rewrite |
| Backup foundation implement / review / apply | 11-04 to 11-05 / 11-09 / 11-13 | 12-08 to 12-09 / 12-10 / 12-11 | Separate writer/allowlist, before first capture |
| Recovery first drill / repeat / proof | 12-08 / 12-10 / 12-11 | 01-05 / 01-07 / 01-08 | Engineering and operator slots both required |
| Production design / guard implementation | Decisions 11-16 to 12-11; guard work 11-25, 11-26, 11-27, 11-30 | Same guard reservation; final entry decision 01-08 | Released scopes, named PW and independent review |
| Production P1-P15 | 12-14 to 12-18, then 01-04 to 01-15 | 01-11 to 01-29 | Fifteen working days; recovery and named humans first |
| Pen-test / written-report target | 01-18 to 01-22 / 01-27 | 02-01 to 02-05 / 02-10 | Five tester-days plus reserved retest; preliminary findings before V6 |
| V6-V12 / V13 / V14-G5 | 01-25 to 02-02 / 02-03 / 02-04 | 02-08 to 02-16 / 02-17 / 02-18 | Same serial stage durations; two-day UAT before gate |
| Closed deployment / invitations | 02-08 / **02-15** | 02-22 / **03-01** | No deployment on invitation day; Monday opening pattern |

Allow A +2, B +3, C +2 working days, about 20% per phase; they are not already available capacity in these earliest forecasts. Exclude 10-29 and weekends; 10-28 is half-day; no delivery booked 12-21 to 01-03. Dates without years are 2026 through December, 2027 from January. Without T by Q20, the expanded Phase C above is mandatory (+5 working days against prior SC1 G2); the old 12-07 P1 cannot coexist with it. Staffing T may recover 3-5 days only after assigning disjoint packets/access; no such acceleration is assumed here.

Reforecast: no RI by 10-26 selects SC2; PD-3 not closed by 11-06 shifts integration/G2; SMTP processor/DPA not signed by 11-04 moves acceptance. Confirm pen-test/retest by 10-30, hard stop 11-13 for reserving this plan's SC1 01-18 / SC2 02-01 assessment windows; later unconfirmed booking invalidates the corresponding G5 forecast. No SC1 recovery proof by 12-11 moves P1 to 01-04 and re-dates qualification/opening. SC2 needs an owner-approved recovery deadline of 01-08; missing it shifts P1 beyond 01-11. Each week of G2 slip consumes downstream float or moves G5 a week; SC1 currently has none. Do not apply that shift twice to delays already included above.

Critical path: N2/drift review -> R2 -> R3 -> full R4 -> foundation -> D storage-origin/TLS/Auth/release tooling -> split QA acceptance -> G2-functional -> backup foundation/capture/recovery proof -> production -> five-day assessment -> seven-day V6-V12 -> requalification/UAT -> G5 -> closed deploy -> onboarding -> invitations.

## 2. Verified baseline and explicit gate reconciliation

This revision checks repository sources and recorded runbook evidence; it makes no fresh Azure/host observation. [Runbook 10](../../infra/runbooks/10-qa-clean-replacement.md) records R1 containment and old VM deallocation on 10-15. Old QA is unavailable; retained disks, contracts and escrow must be preserved. R2-R4, full PD-3 closure and private-vantage acceptance are not established by that record.

| Surface | Current evidence / missing package |
| --- | --- |
| Executor / installation | [replacement_run.py](../../infra/scripts/replacement_run.py) accepts R1/R2 only. N2 requires private exclusive diagnostic files and wrapper-death tests; [runbook 10](../../infra/runbooks/10-qa-clean-replacement.md#pre-r2-apply-gate-wrapper-lifetime-and-diagnostic-streams-n2) defines the implementation boundary and packet gate. R3 bounded-egress/offline installation and hash-bound package transfer need implementation. |
| Trust acceptance | [Acceptance matrix](../../infra/selfhost/replacement-acceptance.json) exceeds current probes: anon controls, session/refresh retirement, encryption round trips, disabled listeners, `external`, `provenance`, `public_activation` and a qualified private vantage remain. Test every recovery-vault version from before and after dashboard rotation. |
| App / delivery | No `selfhost-foundation` or `selfhost-application` root exists. [build-images.sh](../../infra/scripts/build-images.sh), candidate/deploy helpers and cloud smoke assume hosted Supabase. Port explicitly; never remove legacy subscription/region checks. |
| Auth / fixtures | [selfhost_init.mjs](../../infra/scripts/selfhost_init.mjs) leaves SMTP/extra redirects empty; hosted settings helpers are not selfhost writers. Add guarded Auth/SMTP change and re-escrow. Existing cloud smoke lacks the required four-role fixture matrix. |
| Recovery | `wal-g.conf` presence is not implemented backup capture. The recovery vault is Key Vault escrow, not a backup vault. Object bytes are on the VM disk; r02 denies outbound traffic and disables extensions, excluding extension-based VM Backup/AMA without a new design. Escrow restore is same-VM-bound. |
| Startup | [compose.r02.yml](../../infra/selfhost/compose.r02.yml) sets `restart: "no"`: every reboot needs a guarded operator start. Disk retention and a normal reboot prove neither full-host recovery nor the 15-minute file RPO. |

**G1 decision:** LP1-03 needs a deployed `runtime-role.mjs check`. The previous Q10/11-02 was already after the canonical 11-01 target; in the revised sequence the check is Q25/11-23. Forecast G1 no earlier than **11-24**, one working day after that check and review, subject to all other integrity evidence. Do not silently retain 11-01.

**G2 decision:** propose a G2-functional checkpoint plus a separately measured recovery proof mandatory before P1. Canonical C7 staging does not specify a measured restore, but LP2-01 explicitly requires reproducibility/fresh recreation, and runbook 07's QA-delivery checklist includes recovery. The split therefore requires owner-recorded reconciliation of both roadmap and runbook; it is not an existing waiver. For initial reproducibility propose first creation from code plus zero-diff re-plan; P6 contributes app-foundation reproducibility evidence; REC4/P12 recover the full host and application in the same closed environment under the explicit pre-opening recovery design in section 5, not an undefined second-origin target. Owner acceptance is required if this replaces LP2-01's stronger fresh-recreation criterion. A second-origin isolated environment would need its own subnet/NSG/DNS/certificate/image/redirect design and added days; it is not hidden inside REC4/P12. The owner must also reconcile canonical isolated-restore wording with the pre-opening maintenance method before accepting that proof.

**LP2-02 decision:** its ledger requires the independent approver, ruleset, protected staging environment, JIT runner and OIDC. Until a second person exists, owner-run deployment is a proposed recorded deviation for G2-functional, or G2 stays open. It does not satisfy the unchanged LP2-02 definition. No unattended OIDC or self-approval workaround.

## 3. Architecture, ownership and entry requirements

Keep Next.js and NestJS on Container Apps, self-hosted Supabase in Sweden Central, private PostgreSQL and isolated QA/production resources. Selfhost remains the sole VNet/subnet/NSG writer; app foundation owns ACR, app Key Vault, managed identities, logs and application private DNS; one application writer owns release, rotation and rollback. Bind the reserved app subnet in the environment's first PUT. No state reconfiguration/import or region fallback by implication.

The browser uses Supabase only for Auth; business data goes through the API. The current QA gateway nevertheless routes PostgREST, Storage and Auth-admin paths publicly ([Caddyfile](../../infra/selfhost/Caddyfile)), so a leaked service-role key is usable from the internet. Do not describe this existing edge as Auth-only or assume every protected table grants the service role access.

| Boundary | Required design / acceptance |
| --- | --- |
| Production public edge | Auth user endpoints (token, verify, user, logout, settings, JWKS) and signed-URL download path only. Auth-admin, Storage write/bucket and `rest/v1` use an apps-subnet-only private listener; any remaining public path is an owner-accepted, probed exception. Studio/pg-meta disabled; Realtime disabled without a consumer. Implement/test the routing writer before activation; prove required onboarding/upload/download consumers still work. |
| Network activation | Add a reviewed selfhost executor phase and saved-plan policy: bounded R3 install egress, R4 inbound 443/ACME, apps subnet -> 5432, SMTP and backup private-path access. No other writer changes the r02 NSG. Plan each staged rule set, DNS, endpoint and denial probe before its separately approved packet. |
| DB TLS | Implement API startup refusal for non-loopback DATABASE_URL lacking `sslmode=require&sslaccept=strict&sslcert=<CA>` ([runtime_urls.py](../../infra/scripts/runtime_urls.py)); server `ssl=on`, TLS >=1.2, private listener, apps-subnet `hostssl` with scram-sha-256 and `hostnossl reject`, preserving required internal Supabase access. Separate CA per environment, expiry alerts and overlapping CA bundle rotation in rebuilt images; prove SAN checks through the owner tunnel and actual API engine. |
| Capacity / rollout | One serving API replica and initial five-connection Prisma pool; budget internal services, jobs and maintenance separately. The single-mode drain has not run live: Q26 verifies first-creation handling; Q33 must prove outgoing deactivation, zero outgoing replicas, replacement and failure handling. Plan maintenance; never promise zero downtime or scale-out under process-local quotas. |
| Isolation before P1 | Separate production subscription by default; check Q1 credit binding. Same-subscription exception needs recorded risk acceptance, approved production-only ACR/build context from qualified SHA and separate `production` GitHub environment/federation subject. Before P1 read back inherited subscription/backend access; after creation at P3/P6, prove no QA principal access to production resources/backend before P10 activation. |
| Custody before P4 | Two Entra emergency-access accounts; second named custodian with eligible recovery-vault access, activation alerts and firewall not tied to one home IP; owner vault separate from app vault for migration-owner/loader/DB-CA material. Verify created vault RBAC before credential use; at role creation P7 verify no `tonyai_runtime` membership in owner/loader roles before workload access. Backup operator must execute V11 without owner assistance. |
| Owner-run route | Clean checkout verified against recorded SHA/digests, phishing-resistant MFA, production PIM eligible-only roles, [runbook 00](../../infra/runbooks/00-session.md) session rules, Activity Log export beyond 90 days and second-person packet review. Missing controls block production; record the temporary single-human limitation under canonical C8. |
| Auth abuse | Prove per-client limiting on `/auth/v1/token` and verify; forged X-Forwarded-For must not reset limits despite current GOTRUE_RATE_LIMIT_HEADER configuration. Signup disabled, exact CORS/redirects, JWKS/issuer/audience checks; no insecure-local-auth flag. |
| Operations before P1 | Decide guarded starts/on-call/RTO after reboot, OS patching versus pinned package hashes, SSH /32 versus Bastion/JIT, WAF/DDoS edge protection, Log Analytics retention (currently 30 days) and Sentry processor/no-DSN policy. A single Supabase VM is a failure domain requiring explicit pilot availability acceptance. |

Leads below: **C** = Codex cloud implementer; **R** = Claude Code independent code/evidence review seats; **O** = owner/live operator; **T** = named external human tester; **D** = Claude API/DB lane; **RI** = second recovery implementer, only if staffed; **PW** = owner-named production infrastructure writer; **L** = qualified legal reviewer; **V** = external pen-test vendor. R/D handle no credential or live acceptance; O or T executes live checks. When PW is Claude Code, R is not its independent cross-lane reviewer: C supplies B9 review in S6/S7/P2, using reserved C capacity; when PW=C, R supplies independent review. Unnamed roles remain dependencies.

The owner decides LP2-04's infrastructure writer by **S1/11-16**. October's decision assigns LP2-04 to Claude Code, with infra/workflow work waiting for Codex to release reservations; an alternative Codex assignment requires explicit reassignment. Without a named writer, released file scope and actual capacity, S6 and P2-P14 cannot start. Claude's LP4-02 window is not spare production capacity. **This plan does not transfer ownership.** Name OIDC approver, backup operator and independent launch approver before P1; code-review agents cannot fill human roles. Keep the local stack, `scripts/rls-probes.mjs`, migrations and shared files in their assigned lanes/slots.

## 4. QA package calendar: implement, review, execute

Q1-Q24 retain the earlier dates; Q25-Q35 explicitly split O's live work. S6 uses C/PW dates 11-25, 11-26, 11-27 and 11-30, with C's 12-01 reserved for cloud-UAT rewriting and 12-02 for cross-lane review if PW=Claude. QA fixes displace production work. Live packets contain approved readback, not a second mutation hidden in acceptance; independently owned engineering may run alongside O, but no unstaffed T is counted.

| Day / date | Stage and output | Lead |
| --- | --- | --- |
| Q1 Mon 10-19 | Reconcile R1/contracts/state; inspect credit/quota; define recovery private storage/network design, R2 resource boundary, custody and loss model. Start SMTP/domain and vendor booking. | C, O |
| Q2 Tue 10-20 | Implement N2 hardening/tests; inspect exact resource_drift after old-VM deallocation and implement only the justified policy revision, preserving safe refusal of other drift; finish recovery/network inputs. | C |
| Q3 Wed 10-21 | Review N2 and any justified drift-policy delta; freeze network/backup design **before R2 packet approval**, then prepare a new exact saved plan; unexpected drift stops safely. | R, O |
| Q4 Thu 10-22 | Execute approved R2 and read back isolation/state; C implements network-activation phase/policy for staged R3/R4/TLS/SMTP/backup rules. These are different packages. | O; C |
| Q5 Fri 10-23 | Implement pinned R3 offline-bundle or bounded-egress install/transfer tooling; test provenance, disk/escrow guards and retries. | C |
| Q6 Mon 10-26 | Review network-activation/R3 packages; C implements remaining R4 matrix and qualified private-vantage tooling. Confirm RI staffing or select SC2 forecast. | R; C |
| Q7 Tue 10-27 | Execute approved install-egress/R3 bootstrap with new secrets and two-stage escrow; C continues R4 tools using sanitized results. | O; C |
| Q8 Wed 10-28 (half-day) | Review R4 matrix/private-vantage design and packet coverage; no first live activation. | R |
| Q9 Fri 10-30 | Fix R4 review findings; enumerate every pre/post-rotation vault version and external/provenance/activation controls. Confirm pen-test + retest booking. | C, O |
| Q10 Mon 11-02 | Independent R4 re-review, qualify private vantage and approve exact activation/probe packet. | R, O |
| Q11 Tue 11-03 | Execute full R4/network activation; new-positive/old-negative/new-positive controls, sessions/encryption/listeners/containment; review evidence. INCONCLUSIVE blocks PD-3 closure. | O/T; R |
| Q12 Wed 11-04 | Implement additive selfhost-foundation root/state contract and creation-time subnet tests; SMTP processor/DPA deadline. | C; O/L |
| Q13 Thu 11-05 | Continue foundation/RBAC/DNS tests; prepare private-edge, TLS and guarded Auth/SMTP change design. | C |
| Q14 Fri 11-06 | Independently review foundation and TLS/Auth design. Reforecast if PD-3 remains open. | R |
| Q15 Mon 11-09 | Apply approved app foundation/readback; C implements TLS/edge/Auth writer; D implements private-service/public-download origin separation in its own reserved API/env slot. | O; C, D |
| Q16 Tue 11-10 | Continue TLS/Auth/edge tests; D tests signed public URLs, preserved path/query and explicit public Auth issuer including /auth/v1. | C, D |
| Q17 Wed 11-11 | Review TLS/Auth/edge and D storage-origin contract; C gives D's B9 review; verify capacity/reservations and re-escrow/CA custody. | R, D; C |
| Q18 Thu 11-12 | Execute approved TLS/edge/Auth packet only after D origin change and both reviews are accepted; verify network/TLS/route denials and D's reviewed origin-contract evidence; actual-image browser/consumer proof waits for Q26. Otherwise defer activation. | O/T |
| Q19 Fri 11-13 | Implement selfhost-application root and candidate path: port build-images/deploy_apps/drain_api without weakening hosted gates. Pen-test booking hard stop. | C; O |
| Q20 Mon 11-16 | Continue release contract, exact-source/image tests and target-bound web builds; decide PW and reserve S6 now. | C; O |
| Q21 Tue 11-17 | Review application/release/drain package; C implements selfhost alerts: scheduled Container Apps readiness/synthetic job, Log Analytics failure/missing-heartbeat queries and Action Group delivery; agentless host checks, no VM extension. | R, D; C |
| Q22 Wed 11-18 | Implement cloud-safe two-organisation/four-role smoke fixtures, exact-ID cleanup and residue policy; request D's `rls-probes.mjs` adaptation in its own slot. | C; D |
| Q23 Thu 11-19 | Continue fixture/negative/cleanup tests; candidate N and N+1 preparation, build-bound keys/CA and strict TLS startup check integration with D. | C, D |
| Q24 Fri 11-20 | Review fixtures, migration/grant/TLS startup, alert port and exact release packets; run exact-SHA main CI/E2E/Integration gates. No hosted monitoring origin may survive the port. | R, D; O |
| Q25 Mon 11-23 | Execute one schema/grants/buckets packet, deployed runtime-role/raw-index checks and readback; no app release yet. | O; D/R evidence |
| Q26 Tue 11-24 | Execute release N packet with first-creation readback, actual-image/TLS/signed-download smoke, fixture cleanup and Action Group test notification. | O |
| Q27 Wed 11-25 | Execute SMTP/owned-domain configuration and re-escrow packet; end Namecheap deferral; record sender DNS. | O; PW engineering separately |
| Q28 Thu 11-26 | Invitation/reset redemption/expiry/reuse and XFF/rate-limit acceptance packet; no new configuration change. | O |
| Q29 Fri 11-27 | Two-tenant/four-role tester acceptance day 1; actual-image business flows. | O or named T |
| Q30 Mon 11-30 | Acceptance day 2: signed evidence/report flow; factorless Water = Not calculated, factor categories = no_factor while LP4-02 PR C is blocked. | O or named T |
| Q31 Tue 12-01 | Rewrite UAT instructions for exact cloud fixtures/build, roles and safe cleanup; remove local demo-reset assumptions. | C, product owner |
| Q32 Wed 12-02 | Independently review QA/UAT/alert evidence, zero-diff re-plan and N+1 rollback/rotation packets. Final S7 review uses C if PW=Claude, R if PW=C. | R; C where required |
| Q33 Thu 12-03 | Execute N -> N+1 -> N packet with deactivation, zero-outgoing-replica/failure evidence, smoke and cleanup; no credential rotation today. | O |
| Q34 Fri 12-04 | Execute credential/anon-key rotation packet using prebuilt qualified web image; re-escrow, rejection/positive controls, browser smoke and cleanup. | O |
| Q35 Mon 12-07 | Review complete evidence and decide proposed G2-functional; absent owner gate/deviation decisions it remains unaccepted. | O, R, named approver |

Q25 still forecasts G1 review on 11-24. Before Q18, D must change [StorageService](../../apps/api/src/storage/storage.service.ts) and its env contract: its current service client and signedUrl both use SUPABASE_URL, so a private service origin would leak unreachable URLs to browsers. Separate the public signed-download origin while preserving signed path/query; bind SUPABASE_JWT_ISSUER to the public Auth issuer including /auth/v1 and preserve private JWKS/Auth-admin reachability. Reserve D by Q13; no API code is changed by this plan. A missing slot or failed review shifts Q18 and successors.

**Proposed G2-functional evidence:** accepted PD-3; exact candidate/config identity; deployed runtime-role and raw-index checks; private evidence/import buckets and signed downloads; no public service key or insecure-local-auth; no fixture/placeholder factor release and `ALLOW_PLACEHOLDER_FACTORS` off; two organisations/four roles and exact-ID fixture cleanup/residue report; actual-image login -> Water entry -> evidence -> independent approval -> report, plus `no_factor`; N+1 rollback; real operator alerts and tested error reporting or recorded no DSN; UAT instructions rewritten for deployed cloud fixtures (no demo `db:reset`); stated RPO **15 minutes** / RTO **4 hours**, explicitly unproven until REC passes. Local E2E is not QA browser acceptance. No real customer inventory before G5.

## 5. Recovery track: independent workload and measurable acceptance

Fix backup networking/resource needs in Q1-Q3, without expanding R2's fixed allowlist. [Runbook 10's design-freeze inputs](../../infra/runbooks/10-qa-clean-replacement.md#q1-q3-design-freeze-and-r2-preparation) define the writer split, private path, retention/RBAC/custody decisions and fresh-packet procedure; unresolved inputs prevent Q3 acceptance. Add a planned **selfhost-backup foundation writer** with separate state/contract for isolated QA and production storage accounts in Sweden, immutable retention, soft deletion, storage private endpoints/DNS and RBAC separate from app/deployer identities. Its owner is RI in SC1 or C in SC2, in explicitly reserved files; selfhost alone changes subnet/NSG rules. Account/retention/endpoint/RBAC creation is its own approved packet, not just NSG activation. Production reuses reviewed parameterized code, with separate storage/keys/state and new review/apply at P2/P5.

**Concrete pre-opening recovery target:** recover the same closed environment during announced QA or pre-customer production maintenance. Deallocate and retain the failed VM and original disks untouched; create a **new host generation with fresh OS/data disks**, never delete/reuse the old disks or claim same-VM reconstruction. The new recovery writer/packet binds resource/state identities, generation/escrow rebinding, new principal RBAC, an unused address in the existing host subnet, NSG/private-DNS cutover and transfer of the retained static public-IP association after the old edge is offline. Restore encrypted Caddy certificate/account state from caddy-data/caddy-config as well as DB, objects and configuration, preserving public origins and image digests without parallel ACME issuance. Current r02-only and same-VM escrow tools do not implement this; no lock removal, implicit import or weakening is authorized. App revisions/configuration are reapplied from the release contract. No customer data is admitted during a drill. Different-origin isolated drills are post-opening design work requiring their own subnet/NSG/DNS/certificate/image and calendar, not evidence already earned here.

| Backup foundation stage | SC1 dates / lead | SC2 dates / lead | Required output |
| --- | --- | --- | --- |
| BF1 implement, 2 days | Wed 11-04 / Thu 11-05, RI | Tue 12-08 / Wed 12-09, C | Storage writer, private-path contract, protection/RBAC tests; separate from R2 |
| BF2 independent review | Mon 11-09, R | Thu 12-10, R | Exact plan-policy and resource permissions accepted |
| BF3 approved apply/readback | Fri 11-13, O | Fri 12-11, O | Protected reachable target before first capture; no other O live packet that day |

| Package / effort | Implement -> review -> first live use | Lead / dated slots |
| --- | --- | --- |
| REC1 design, 2 days | Full-host loss, WAL/base + frequent object capture, TLS state, generation rebinding, pre-approved recovery packet with capacity/spend/access. Initial network constraints already fixed Q3. | RI Mon 10-26 / Tue 10-27 in SC1; SC2 credits Q1-Q3 design, not duplicate new days |
| REC2 capture + age alerts, 3 days | Implement capture/manifest/age/failed-job signal (2), independent review (1), later first capture. Private immutable storage; no assumed Azure Blob/Supabase endpoint equivalence. | SC1 RI Mon 11-09 / Wed 11-11, R Thu 11-12, O first capture Mon 11-16 (age-signal delivery verified Q26); SC2 C Fri 12-11 / Mon 12-14, R Tue 12-15, O first capture Wed 12-16 |
| REC3 restore tooling, 4 days | New-generation writer and complete DB/object/TLS/config recovery, guard/start/DNS/IP rebind tests (3); review (1). No reliance on preserved source disks. | SC1 RI Tue 11-17 to Thu 11-19, R Thu 11-26; SC2 C Wed 12-16 to Fri 12-18, R Mon 01-04 |
| REC4 drill + repeat, 2-3 days | First drill; review/fix; later repeat. Any material fix takes another review and moves the repeat. Proof review is separate. | SC1 O Tue 12-08, review Wed 12-09, O repeat Thu 12-10, proof Fri 12-11; SC2 O Tue 01-05, review Wed 01-06, O repeat Thu 01-07, proof Fri 01-08 |

REC remains **11-12 engineering days plus the explicit 4-day BF foundation** and access/review waits. No recovery drill shares Q33/Q34's rollback/rotation window. REC4/P12/V11 use the same closed-environment method and require the bounded recovery packet pre-approved so per-action ceremonies do not consume RTO; repeat V11 with the backup operator, without owner assistance.

1. From two hours before T0, automated sequenced markers/minute write an API record and evidence object; SHA-256 and timestamps are journalled outside the system. Record NTP offsets; baseline counts, audit/seal expectations, object manifest and report totals belong to an immutable comparison cohort. Journal expected counts at each marker checkpoint, excluding intentionally lost trailing markers from recovered totals.
2. At T0, induce the declared loss just before the next object capture. Fence/deallocate the source; restore from backups/escrow only to the new host generation, with reclamation hold and same images/origins. No old disk or running source is a recovery input; only retained network identity and backed-up TLS material are reused as designed.
3. RPO = max(T0 minus last contiguous recovered DB marker, T0 minus last contiguous hash-matching recovered object marker), accounting for clock uncertainty. A gap, row without bytes or bytes without row fails reconciliation.
4. RTO = T0 until readiness, real login with restored accepted keys, hash-equal evidence download and baseline reference-report totals all pass. Reconcile counts, audit continuity, factor-release seals, runtime-role checks and historically retired-credential rejection. Pass only at RPO <=15 minutes and RTO <=4 hours; preserve evidence and repeat once. Any prerequisite/measurement failure reforecasts the gate.

## 6. Production design and entry decisions

This is a decision/design lane, not extra cloud capacity. S6 reserves PW on 11-25, 11-26, 11-27 and 11-30 while O executes QA; C's 12-01 belongs to the UAT rewrite. If PW=Claude, C reviews the completed early S6 subset on 11-27, the final package at S7/12-02 and the production plans at P2; these are C review slots, not simultaneous C implementation. If PW=C, R reviews. Missing writer capacity, reservation release or review moves P1.

| Slot / date | Output required | Lead |
| --- | --- | --- |
| S1 Mon 11-16 | Name LP2-04 infrastructure writer, release/reserve exact paths, check product workload and capacity. | O |
| S2 Tue 11-17 | Select separate subscription; verify credit restriction, RBAC and production ACR/build/environment isolation design. | O; PW/R review |
| S3 Wed 11-18 | Confirm RPO/RTO/loss model, single-host SLA and primary/backup custodian arrangements. | O, named backup operator |
| S4 Thu 11-19 | Domain/DNS and private/public edge decision; agree pilot data size, concurrency and performance/error budgets before testing. | O, T, domain reviewer |
| S5 Fri 11-20 | Qualified legal review of controller/processor roles, KVKK Article 9 mechanism/notification, email/Azure/error-reporting processors, log location/retention, breach notice, erasure versus append-only audit. Record decision before P1; no legal conclusion inferred here. | O, L |
| S6 Wed 11-25 / Thu 11-26 / Fri 11-27 / Mon 11-30 | 3-5-day production-contract/guard package: replace QA-only variable/r02/init bindings with explicit reviewed production contracts; test protected defaults, edge and custody rules. Four days reserved; fifth day moves later work. Review completed early subset on 11-27, final review S7; first live use P3/P4. | PW; C B9 if PW=Claude, otherwise R |
| S7 Wed 12-02 | Final independent production code/parameter/interface review; no apply. C is reserved here if Claude wrote the package. | C B9 if PW=Claude, otherwise R; PW |
| S8 Mon 12-07 | Confirm operating costs, alert thresholds, patch/start/network/monitoring decisions and human second-person roles. | O, named operators |
| S9 Wed 12-09 | Review production plan and accepted-domain-on-QA evidence; recovery proof must precede P1. | O, R |
| S10 Fri 12-11 | SC1 entry decision after REC proof; SC2 repeats this entry check on 01-08, never claims an early pass. | O, named independent approver |

Legal review uses current [KVKK law and Article 9](https://www.kvkk.gov.tr/Icerik/6649/Personal-Data-Protection-Law) and the selected processor contracts; this document does not select a transfer mechanism. SMTP remains undecided, not implicitly ACS or Resend. Before P1: owned-domain integration accepted on QA, production names/DNS control approved, legacy-key decision recorded, recovery passed, live authority granted, named second-person roles and G2/deviation decisions recorded. Missing prerequisites keep production closed/unprovisioned as applicable.

Book the pen-test and retest now: confirm by 10-30, hard stop 11-13 for this plan's SC1 01-18 and SC2 02-01 assessment starts; booking failure invalidates those windows and their downstream G5 dates. Require signed scope, rules of engagement, NDA and synthetic test accounts; at least five tester-days on closed production, no customer data. Both scenarios require vendor rebooking from 01-11. Obtain preliminary findings before V6 and the written report by V12 at the latest (SC1 target 01-27; SC2 02-10), and retest the V13 candidate. Legal/processor decisions are reconfirmed at V10.

## 7. Production foundation: fifteen working days, customers closed

Dates show SC1 / SC2. P2 validates the already implemented/reviewed S6 package; it is not first implementation. P1 requires named second-person roles and approved custody design; created-vault readback and completed credential custody must precede P4 use. Each live packet needs separate review/approval; reserved windows do not grant access. P6 creates the production app foundation on its own subnet. P12 and V11 use section 5's closed-environment full-host recovery with a new generation, fenced old host, fresh disks, backed-up Caddy TLS state and the same approved DNS/public-IP routing; no undefined second-origin environment is assumed.

| Day / SC1 date / SC2 date | Work / evidence | Lead |
| --- | --- | --- |
| P1 Mon 12-14 / Mon 01-11 | Recheck entry gates, human roles, approved estimate and reserved writer; accept precise plan. | O, independent approver |
| P2 Tue 12-15 / Tue 01-12 | Independent review of production plans including backup-foundation resources and recovery cutover; changes need renewed review. C reserves this day for B9 if PW=Claude. | PW; C B9 if PW=Claude, otherwise R |
| P3 Wed 12-16 / Wed 01-13 | Execute reviewed host/network/disks packet; read back RBAC and deny QA access. Backup-storage creation is its separate P5 packet. | O |
| P4 Thu 12-17 / Thu 01-14 | Approved trusted Supabase bootstrap with new production credentials, dual custody and guarded start. | O, second custodian |
| P5 Fri 12-18 / Fri 01-15 | Execute approved production backup-foundation packet (account, protection, endpoint/DNS/RBAC), read back private path. Start capture/age alerts in P9 only after this target passes. | O/T |
| P6 Mon 01-04 / Mon 01-18 | Create app foundation/ACR/vault/identities/private DNS/TLS/logs from code; verify separate subnet and recreation contract. | O; PW/R evidence |
| P7 Tue 01-05 / Tue 01-19 | Apply exact-source migrations, status/catalog/runtime-grant checks and private buckets through owner channel. | O; D/R evidence |
| P8 Wed 01-06 / Wed 01-20 | Activate owned Auth DNS/TLS, private/admin edge, guarded redirects/CORS and issuer; web/API domain bindings wait for apps. | O/T |
| P9 Thu 01-07 / Thu 01-21 | Execute one pre-reviewed production configuration packet: capture/age alerts plus email/sender configuration and re-escrow; bounded internal controls, full browser acceptance P11. If packet estimate exceeds O's window, split and shift successors. | O/T |
| P10 Fri 01-08 / Fri 01-22 | Build production-bound images from qualified SHA in production context; deploy closed apps; then bind web/API domains/certificates and smoke actual images. | O; PW/R |
| P11 Mon 01-11 / Mon 01-25 | Verify certificates, actual-web invitation/reset link redemption/expiry/reuse (P9 proves delivery only), four-role/two-tenant negatives, no-demo checks, exact cleanup and alerts. | O/T |
| P12 Tue 01-12 / Tue 01-26 | Execute section 5 in-place full-host recovery in closed production; restore DB/bytes/TLS/config on fresh disks/new generation and validate actual app images, origins and reconciliation. | Backup operator, T; R evidence |
| P13 Wed 01-13 / Wed 01-27 | Execute one N+1 rollback/guarded-restart packet; credential rotation has separate QA proof at Q34 and needs a new production packet/day if required. Capacity measurement is V9. | O/T, backup operator |
| P14 Thu 01-14 / Thu 01-28 | Loader dry run, review result, then explicitly approved --apply --allow-remote of reviewed authoritative releases into closed production; verify seals/provenance/no demo rows. | O (loader custodian), D/domain reviewer |
| P15 Fri 01-15 / Fri 01-29 | Independent readiness evidence/handover; keep customer opening gated on G4/G5. | R, T, O |

Container Apps custom domains/certificates bind to existing apps, hence P10/P11, not P8. [Microsoft domain guidance](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates). LP4-01's supported onboarding is already delivered; live invitation/reset delivery via LP2-04 remains. Product factors, reports, TR/EN acceptance, limits and legal/domain decisions still require their own gate evidence. No local demo seed or broad cleanup in either cloud environment.

## 8. Qualification and opening: exact candidate before customers

SC1 and SC2 each retain all fourteen V stages, including seven serial V6-V12 days; there is no hidden parallelization to promise 02-15 for SC2. V1-V5 are the five vendor days on closed production. O's acceptance sessions use disjoint synthetic tenants/windows; vendor restrictions move dates. V6 uses preliminary findings, V8 requires the written report; a late report/fix moves requalification. Customer UAT runs at least two days on **closed production with synthetic tenants after V10 legal clearance**, V12 and V13; V14 only checks the final-candidate delta and decides G5. Material V13 changes restart affected acceptance, not a same-day substitute for two days.

| Day / SC1 date / SC2 date | Required evidence | Lead |
| --- | --- | --- |
| V1 Mon 01-18 / Mon 02-01 | Confirm G1-G4 and freeze assessment candidate; exact-main CI/E2E/Integration, actual-image smoke; vendor starts signed scope. | O/T, V; R |
| V2 Tue 01-19 / Tue 02-02 | Four-role/two-tenant, TR/EN/year/import and onboarding checks on candidate; vendor assessment day 2. | T/O, V |
| V3 Wed 01-20 / Wed 02-03 | Validate exact production-loaded factor manifests/seals and independent reference cases; vendor day 3. | Domain reviewer, O, V |
| V4 Thu 01-21 / Thu 02-04 | Domain review of those exact sealed releases, inventory/report reconciliation; vendor day 4. | Domain reviewer, T, V |
| V5 Fri 01-22 / Fri 02-05 | Vendor day 5; triage reproducible findings and plan fix/retest scope. | V, O; R |
| V6 Mon 01-25 / Mon 02-08 | Implement reserved code fixes; preserve evidence and release compatibility. | Assigned C/D/PW |
| V7 Tue 01-26 / Tue 02-09 | Independent fix review; C gives B9 for Claude infrastructure/secret packages, R reviews C packages; no same-day first implementation/live release. | R; C B9 where required |
| V8 Wed 01-27 / Wed 02-10 | Receive written report; execute approved fix candidate and targeted retests. | V, O/T |
| V9 Thu 01-28 / Thu 02-11 | Production-shaped load/PDF/import/memory/pool and abuse tests against pre-agreed budgets. | T/O; R |
| V10 Fri 01-29 / Fri 02-12 | Security/privacy/legal checkpoint, processor/erasure decisions reconfirmed; any blocker reforecasts G5. | V, L, O |
| V11 Mon 02-01 / Mon 02-15 | Final-candidate closed-environment full-host recovery; backup operator acts without owner assistance, O runs no other packet. | Backup operator, T; R |
| V12 Tue 02-02 / Tue 02-16 | Customer UAT day 1 on closed production synthetic tenants; final report deadline, retest preparation and operator evidence review. | V, T/O, R |
| V13 Wed 02-03 / Wed 02-17 | Customer UAT day 2; requalify final main SHA: CI, explicit Integration, full local E2E, actual-image/cloud checks and vendor retest. No material candidate change without renewed acceptance. | O/T, V; R |
| V14 Thu 02-04 / Thu 02-18 | Check V12-V13 UAT/sign-off against final candidate delta; complete evidence packet, then owner G5 decision. No first UAT session today. | Pilot representative, domain reviewer, O, independent launch approver |

`release_checks.py` requires successful exact-SHA runs on **main**. `e2e.yml` uses a local stack, not the QA URL; run separate live acceptance. Explicitly dispatch Integration because path filters skip documentation-only commits. Freeze main from V13 until closed deployment; later source/image/config/secret/factor changes invalidate affected proof. Repeat V11 if a later change affects recovery, and independently review material fixes. No unresolved release-blocking findings or unapproved evidence substitutions.

| Opening action | SC1 date | SC2 date | Lead |
| --- | --- | --- | --- |
| Deploy G5 manifest closed; synthetic smoke and exact fixture cleanup | Mon 02-08 | Mon 02-22 | O |
| Supported holding onboarding with explicitly approved restricted first admin; otherwise dry-run and defer invitation to opening | Tue 02-09 / Wed 02-10 | Tue 02-23 / Wed 02-24 | O, pilot representative |
| Operational rehearsal / pre-opening backup, alert and rollback checks | Thu 02-11 | Thu 02-25 | O, backup operator |
| Freeze and confirm coverage; no late UAT gate | Fri 02-12 | Fri 02-26 | O, independent approver |
| Invite agreed pilot users; **no deployment on opening day** | Mon 02-15 | Mon 03-01 | O, pilot representative |
| First five working days / first real close | Daily operations review / G6 after real reporting cycle | Same sequence | O, domain/customer owner |

Supported onboarding sends the first-admin invitation immediately; there is no suppress-email option. Customer UAT is V12-V13 before G5. Earlier 02-01/01-25 opening dates are not executable under this serial calendar; an owner-selected acceleration requires named staffing, re-dated gates and preserved deploy -> onboarding -> rehearsal -> freeze -> invite ordering, not compression after opening.

## 9. Release controls, costs and evidence

- Bind source SHA, lockfile hash, migration order, API/web digests, target origins/JWKS/issuer, CA hash, runtime limits, cleanup hold and exact secret versions. Web `NEXT_PUBLIC_*` inputs are build-bound: a different environment, public anon-key rotation or bundled CA change requires the affected image rebuild and requalification; never copy QA secrets to production.
- Apply migrations via separate owner credential. The spurious `DROP INDEX activity_records_reporting_entity_period_category_key` must be removed during migration generation/review. At deployment require exact-source `migration-diff`, `prisma migrate status` and a catalog check of the raw NULLS NOT DISTINCT index and runtime grants. App rollback does not reverse a DB migration; prove N+1/N compatibility or use an approved maintenance/forward-fix plan.
- Failed containment, trust, isolation, migration, readiness or restore reconciliation stops the gate. Preserve state/private diagnostics; no automatic retry/import/force-unlock/destruction after partial apply, no reopening old credentials or contained endpoints. RPO/RTO remain measured requirements, never inferred from Key Vault escrow or disk locks.
- Production estimate explicitly includes always-on API (initial budget assumption **1 vCPU/2 GiB**, validate by load), web compute, Log Analytics ingestion/retention, production ACR, backup Blob + WAL/object growth, private endpoint/DNS, second recovery VM/disks, retained QA/old disks/IPs, Key Vault, network egress/email, and Bastion/Defender/WAF if selected. Credit eligibility/expiry/balance and SKU capacity remain unverified; the former TRY cap is not reinstated.
- Runbook 10's dated USD 100.96/month is only a replacement-plus-retained-resource component subtotal, not a QA/production budget. Refresh actual rates and include recovery overlap/taxes; agree operating thresholds and budget/forecast alerts. Alerts do not stop spend. Review consumption after seven days and each gate.
- Every gate records source/plan/executor hashes, resource/state identity, digests, exact secret version IDs (no values), migration/factor manifests, scenario outputs, times/clock offsets, human operator/reviewer and limitations. Live operations, legal/vendor sign-offs and restore measurements are not claimed by this documentation patch.

Implementation handoff requires Node 22 `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, appropriate infrastructure checks and honest cache/omission reporting. Use canonical B9 in the handoff; proposed roadmap decisions go there for Claude Code after owner merge. This document does not edit the ledger, README, runbooks, application or cloud. Next work remains Q1-Q3 design/N2 review before an exact R2 packet; the planning-date, staffing, G2 split, owner-run deviation and production-writer decisions remain with the owner.

**Delivery responsibility (owner instruction, 2026-10-17):** The owner has selected this document as the basis for Azure delivery and assigned Codex responsibility for taking every work step forward in sequence. For each step, Codex prepares the bounded work package, implements within the granted scope, coordinates dependencies and independent review, prepares any required operator packet, verifies the results and hands off the evidence before advancing through the next dependency gate. Start with Q1-Q3. Parallel work is limited to the separately staffed tracks already identified in this plan.

This delivery responsibility spans the whole plan; the specialist leads and existing file reservations above still govern who performs each contribution. Codex brings required scope/ownership decisions to the owner before dependent work. Independent review, named human roles, packet-specific live authorization and owner-only merge remain in force. Each work package records its exact source, results, remaining dependencies and next step in the PR's B9 handoff; Claude Code records canonical roadmap updates after owner merge. This file remains the delivery plan, not a second task ledger.
