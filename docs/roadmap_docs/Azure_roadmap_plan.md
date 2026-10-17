# Azure delivery plan: trusted QA, recovery, then production

Dated **2026-10-17**, revised after PR #184 review of `965d9b8`; source baseline **`7dd700445c00511476304d781eab8bbd7f7de457`** (#183). Dates use Europe/Istanbul. This is the owner's requested supplementary plan, not a ledger or authorization to execute. If it disagrees with the [canonical roadmap's Part A](project_status_roadmap_phases.md#part-a--working-set), Part A wins until the owner records a decision there. No assignments or accepted milestones change through this file.

## 1. Forecast, capacity and decisions

**Recommendation for the owner: plan on 2027-02-15; target 02-08 only if scenario S1 is staffed. 02-01 is credible only if PD-3 closes by 10-30 and G2 passes by 11-20, with all later gates also satisfied.** The planning date remains an owner decision. The canonical target remains 02-01 until changed. Phase A-C dates are forecasts, not commitments; 11-15 is reachable only if PD-3 closes by 10-30, and that condition alone is insufficient.

Assume one serial Codex cloud implementer, Claude Code supplying about one review day per two cloud days while carrying its own cards, and the owner supplying 2-4 hours/day for approvals/live work. There is currently no second human. External pen-test, legal and D24 domain reviewers and DNS access are dependencies, not available staff. A second recovery implementer is additional capacity, not implicitly Claude Code. No package's first implementation, independent review and first live execution share a day; failed review moves execution. Tables reserve separate stages, not proof that implementation will fit its estimate.

| Phase / milestone | S1: second recovery implementer starts by 10-26 | S2: one implementer | Entry / consequence |
| --- | --- | --- | --- |
| A: N2, R2, R3, full R4 / PD-3 | 10-19 to approximately 11-03 | Same initial sequence | Recovery network/storage design fixed before R2 packet approval |
| B: Sweden application integration | 11-04 to approximately 11-23 | Same initial sequence | Accepted replacement; no legacy gate bypass |
| C: proposed G2-functional | 11-30; reserve to 12-08 | 12-01 | Owner must accept gate split and any owner-run deviation |
| Recovery proof | Approximately 12-04 | Approximately 12-16 | 11-12 engineering days, separate track below |
| Production design | 11-16 to 12-04, with explicitly reserved implementation slots | Same decisions; guard work uses Q26/Q27/Q29/Q30 only if reserved | No second simultaneous Codex implementation |
| Production foundation | 12-07 to 12-18, then 01-04 to 01-08 | 12-17 to 12-18, then 01-04 to approximately 01-19; P15 handover 01-20 | Fifteen actual working days; recovery and human roles required before P1 |
| Pen-test / report | 01-11 to 01-15; report approximately 01-20 | Rebook to 01-21 to 01-27; report by 02-01 | At least five tester-days on ready closed production, plus retest slot |
| Fixes, capacity, recovery, requalification | 01-18 to 01-22; final requalification 01-25 to 01-27 | 01-28 to 02-04 | Vendor/report/fix dependencies can move these dates |
| G5 / closed deployment / pilot | 01-28 / 02-01 / **02-08** | Approximately 02-05 / 02-08 / **02-15**, zero float | Owner decides; never infer approval from date |

Reserve about 20% per phase: A +2, B +3, C +2 working days. These reserves are not free production-design capacity. No work is assumed on 10-29; 10-28 is a half-day. No guaranteed delivery capacity is booked during 12-21 to 01-03. Dates without a year below are 2026 through December and 2027 from January. S2's extra P15 day corrects the fourteen-day 12-17 to 01-19 window; it does not compress qualification.

Reforecast immediately: no second implementer by 10-26 selects S2; PD-3 not closed by 11-06 means G2 no earlier than 12-08 and pilot 02-15 or later; SMTP processor/DPA not signed by 11-04 moves G2; pen-test and retest not confirmed by 10-30 (hard stop 11-13) makes canonical G5 01-22 infeasible; no S1 recovery pass by 12-11 moves P1 to 01-04 and pilot to at least 02-15. S2 needs an explicit owner decision to extend its recovery deadline to 12-16 for a 12-17 entry; without that decision, or without proof by 12-16, P1 moves to 01-04 and the zero-float 02-15 pilot must be reforecast. Each week of G2 slip past 11-20 consumes a week of downstream float or moves G5 a week; the scenario forecasts already include their expected slip. S1's reserve to 12-08 cannot coexist with P1 on 12-07. Recompute downstream dates, do not spend the same reserve twice.

Critical path: N2 -> R2 with network/backup design -> R3 tooling and execution -> full R4 with private vantage/network activation -> foundation -> private TLS/Auth/release/candidate tooling -> SMTP -> G2-functional -> recovery proof -> production -> pen-test -> G5 -> closed deploy -> onboarding -> opening.

## 2. Verified baseline and explicit gate reconciliation

This revision checks repository sources and recorded runbook evidence; it makes no fresh Azure/host observation. [Runbook 10](../../infra/runbooks/10-qa-clean-replacement.md) records R1 containment and old VM deallocation on 10-15. Old QA is unavailable; retained disks, contracts and escrow must be preserved. R2-R4, full PD-3 closure and private-vantage acceptance are not established by that record.

| Surface | Current evidence / missing package |
| --- | --- |
| Executor / installation | [replacement_run.py](../../infra/scripts/replacement_run.py) still uses PIPE and accepts R1/R2 only. N2 needs private exclusive diagnostic files and wrapper-death tests. R3 bounded-egress/offline installation and hash-bound package transfer need implementation. |
| Trust acceptance | [Acceptance matrix](../../infra/selfhost/replacement-acceptance.json) exceeds current probes: anon controls, session/refresh retirement, encryption round trips, disabled listeners, `external`, `provenance`, `public_activation` and a qualified private vantage remain. Test every recovery-vault version from before and after dashboard rotation. |
| App / delivery | No `selfhost-foundation` or `selfhost-application` root exists. [build-images.sh](../../infra/scripts/build-images.sh), candidate/deploy helpers and cloud smoke assume hosted Supabase. Port explicitly; never remove legacy subscription/region checks. |
| Auth / fixtures | [selfhost_init.mjs](../../infra/scripts/selfhost_init.mjs) leaves SMTP/extra redirects empty; hosted settings helpers are not selfhost writers. Add guarded Auth/SMTP change and re-escrow. Existing cloud smoke lacks the required four-role fixture matrix. |
| Recovery | `wal-g.conf` presence is not implemented backup capture. The recovery vault is Key Vault escrow, not a backup vault. Object bytes are on the VM disk; r02 denies outbound traffic and disables extensions, excluding extension-based VM Backup/AMA without a new design. Escrow restore is same-VM-bound. |
| Startup | [compose.r02.yml](../../infra/selfhost/compose.r02.yml) sets `restart: "no"`: every reboot needs a guarded operator start. Disk retention and a normal reboot prove neither full-host recovery nor the 15-minute file RPO. |

**G1 decision:** LP1-03 needs a deployed `runtime-role.mjs check`. The previous Q10/11-02 was already after the canonical 11-01 target; in the revised sequence the check is Q25/11-23. Forecast G1 no earlier than **11-24**, one working day after that check and review, subject to all other integrity evidence. Do not silently retain 11-01.

**G2 decision:** propose a G2-functional checkpoint plus a separately measured recovery proof mandatory before P1. Canonical C7 staging does not specify a measured restore, but LP2-01 explicitly requires reproducibility/fresh recreation, and runbook 07's QA-delivery checklist includes recovery. The split therefore requires owner-recorded reconciliation of both roadmap and runbook; it is not an existing waiver. For initial reproducibility propose first creation from code plus zero-diff re-plan; P6 contributes app-foundation reproducibility evidence, while P12 must recreate and recover the complete production-shaped system for LP2-04/G5. Owner acceptance is required if this replaces LP2-01's stronger fresh-recreation criterion. A second QA environment would need another delegated /23, NSG rules, private DNS link, web rebuild and Auth redirects, with added days/cost.

**LP2-02 decision:** its ledger requires the independent approver, ruleset, protected staging environment, JIT runner and OIDC. Until a second person exists, owner-run deployment is a proposed recorded deviation for G2-functional, or G2 stays open. It does not satisfy the unchanged LP2-02 definition. No unattended OIDC or self-approval workaround.

## 3. Architecture, ownership and entry requirements

Keep Next.js and NestJS on Container Apps, self-hosted Supabase in Sweden Central, private PostgreSQL and isolated QA/production resources. Selfhost remains the sole VNet/subnet/NSG writer; app foundation owns ACR, app Key Vault, managed identities, logs and private DNS; one application writer owns release, rotation and rollback. Bind the reserved app subnet in the environment's first PUT. No state reconfiguration/import or region fallback by implication.

The browser uses Supabase only for Auth; business data goes through the API. The current QA gateway nevertheless routes PostgREST, Storage and Auth-admin paths publicly ([Caddyfile](../../infra/selfhost/Caddyfile)), so a leaked service-role key is usable from the internet. Do not describe this existing edge as Auth-only or assume every protected table grants the service role access.

| Boundary | Required design / acceptance |
| --- | --- |
| Production public edge | Auth user endpoints (token, verify, user, logout, settings, JWKS) and signed-URL download path only. Auth-admin, Storage write/bucket and `rest/v1` use an apps-subnet-only private listener; any remaining public path is an owner-accepted, probed exception. Studio/pg-meta disabled; Realtime disabled without a consumer. Implement/test the routing writer before activation; prove required onboarding/upload/download consumers still work. |
| Network activation | Add a reviewed selfhost executor phase and saved-plan policy: bounded R3 install egress, R4 inbound 443/ACME, apps subnet -> 5432, SMTP and backup private-path access. No other writer changes the r02 NSG. Plan each staged rule set, DNS, endpoint and denial probe before its separately approved packet. |
| DB TLS | Implement API startup refusal for non-loopback DATABASE_URL lacking `sslmode=require&sslaccept=strict&sslcert=<CA>` ([runtime_urls.py](../../infra/scripts/runtime_urls.py)); server `ssl=on`, TLS >=1.2, private listener, apps-subnet `hostssl` with scram-sha-256 and `hostnossl reject`, preserving required internal Supabase access. Separate CA per environment, expiry alerts and overlapping CA bundle rotation in rebuilt images; prove SAN checks through the owner tunnel and actual API engine. |
| Capacity / rollout | One serving API replica and initial five-connection Prisma pool; budget internal services, jobs and maintenance separately. The single-mode drain has not run live: Q25 verifies first-creation handling; Q29 must prove outgoing deactivation, zero outgoing replicas, replacement and failure handling. Plan maintenance; never promise zero downtime or scale-out under process-local quotas. |
| Isolation before P1 | Separate production subscription by default; check Q1 credit binding. Same-subscription exception needs recorded risk acceptance, approved production-only ACR/build context from qualified SHA and separate `production` GitHub environment/federation subject. Before P1 read back inherited subscription/backend access; after creation at P3/P6, prove no QA principal access to production resources/backend before P10 activation. |
| Custody before P4 | Two Entra emergency-access accounts; second named custodian with eligible recovery-vault access, activation alerts and firewall not tied to one home IP; owner vault separate from app vault for migration-owner/loader/DB-CA material. Verify created vault RBAC before credential use; at role creation P7 verify no `tonyai_runtime` membership in owner/loader roles before workload access. Backup operator must execute V11 without owner assistance. |
| Owner-run route | Clean checkout verified against recorded SHA/digests, phishing-resistant MFA, production PIM eligible-only roles, [runbook 00](../../infra/runbooks/00-session.md) session rules, Activity Log export beyond 90 days and second-person packet review. Missing controls block production; record the temporary single-human limitation under canonical C8. |
| Auth abuse | Prove per-client limiting on `/auth/v1/token` and verify; forged X-Forwarded-For must not reset limits despite current GOTRUE_RATE_LIMIT_HEADER configuration. Signup disabled, exact CORS/redirects, JWKS/issuer/audience checks; no insecure-local-auth flag. |
| Operations before P1 | Decide guarded starts/on-call/RTO after reboot, OS patching versus pinned package hashes, SSH /32 versus Bastion/JIT, WAF/DDoS edge protection, Log Analytics retention (currently 30 days) and Sentry processor/no-DSN policy. A single Supabase VM is a failure domain requiring explicit pilot availability acceptance. |

Leads below: **C** = Codex cloud implementer; **R** = Claude Code independent code/evidence review seats; **O** = owner/live operator; **T** = named external human tester; **D** = Claude API/DB lane; **RI** = second recovery implementer, only if staffed; **PW** = owner-named production infrastructure writer; **L** = qualified legal reviewer; **V** = external pen-test vendor. R/D handle no credential or live acceptance; O or T executes live checks. Unnamed roles remain dependencies.

The owner decides LP2-04's infrastructure writer by **S1/11-16**. October's decision assigns LP2-04 to Claude Code, with infra/workflow work waiting for Codex to release reservations; an alternative Codex assignment requires explicit reassignment. Without a named writer, released file scope and actual capacity, S6 and P2-P14 cannot start. Claude's LP4-02 window is not spare production capacity. **This plan does not transfer ownership.** Name OIDC approver, backup operator and independent launch approver before P1; code-review agents cannot fill human roles. Keep the local stack, `scripts/rls-probes.mjs`, migrations and shared files in their assigned lanes/slots.

## 4. QA package calendar: implement, review, execute

Q1-Q25 are the shared earliest sequence; Q26-Q30 reserve C for S6 production-contract work while O/T executes already-reviewed QA procedures and R reviews evidence. This overlap is valid only after an explicit reservation/ownership decision; if QA needs C for fixes, move S6 and downstream dates. No new cloud implementation is assigned to R on review days. Live execution always waits for the preceding independent review and exact packet approval.

| Day / date | Stage and output | Lead |
| --- | --- | --- |
| Q1 Mon 10-19 | Reconcile R1/contracts/state; inspect credit/quota; define recovery private storage/network design, R2 resource boundary, custody and loss model. Start SMTP/domain and vendor booking. | C, O |
| Q2 Tue 10-20 | Implement N2 diagnostic-stream/lifetime hardening and tests; complete recovery/network design inputs. | C |
| Q3 Wed 10-21 | Independently review N2 and freeze network/backup design **before R2 packet approval**; prepare exact saved R2 plan. | R, O |
| Q4 Thu 10-22 | Execute approved R2 and read back isolation/state; C implements network-activation phase/policy for staged R3/R4/TLS/SMTP/backup rules. These are different packages. | O; C |
| Q5 Fri 10-23 | Implement pinned R3 offline-bundle or bounded-egress install/transfer tooling; test provenance, disk/escrow guards and retries. | C |
| Q6 Mon 10-26 | Review network-activation/R3 packages; C implements remaining R4 matrix and qualified private-vantage tooling. Confirm RI staffing or select S2 forecast. | R; C |
| Q7 Tue 10-27 | Execute approved install-egress/R3 bootstrap with new secrets and two-stage escrow; C continues R4 tools using sanitized results. | O; C |
| Q8 Wed 10-28 (half-day) | Review R4 matrix/private-vantage design and packet coverage; no first live activation. | R |
| Q9 Fri 10-30 | Fix R4 review findings; enumerate every pre/post-rotation vault version and external/provenance/activation controls. Confirm pen-test + retest booking. | C, O |
| Q10 Mon 11-02 | Independent R4 re-review, qualify private vantage and approve exact activation/probe packet. | R, O |
| Q11 Tue 11-03 | Execute full R4/network activation; new-positive/old-negative/new-positive controls, sessions/encryption/listeners/containment; review evidence. INCONCLUSIVE blocks PD-3 closure. | O/T; R |
| Q12 Wed 11-04 | Implement additive selfhost-foundation root/state contract and creation-time subnet tests; SMTP processor/DPA deadline. | C; O/L |
| Q13 Thu 11-05 | Continue foundation/RBAC/DNS tests; prepare private-edge, TLS and guarded Auth/SMTP change design. | C |
| Q14 Fri 11-06 | Independently review foundation and TLS/Auth design. Reforecast if PD-3 remains open. | R |
| Q15 Mon 11-09 | Apply approved foundation and read back region/subnet/identity; implement TLS/hostssl, private-edge and Auth/SMTP/re-escrow writer package. | O; C |
| Q16 Tue 11-10 | Continue TLS/Auth writer, SAN/tunnel, brute-force and edge-consumer tests. | C |
| Q17 Wed 11-11 | Review TLS/Auth/edge package and staged NSG plans, including re-escrow/rollback and CA custody. | R |
| Q18 Thu 11-12 | Execute approved private TLS/listener/edge changes and guarded Auth configuration; verify denials and internal consumers. | O/T |
| Q19 Fri 11-13 | Implement selfhost-application root and candidate path: port build-images/deploy_apps/drain_api without weakening hosted gates. Pen-test booking hard stop. | C; O |
| Q20 Mon 11-16 | Continue release contract, exact-source/image tests and target-bound web builds; decide PW and reserve S6 now. | C; O |
| Q21 Tue 11-17 | Review application/release/drain changes; inspect migration and runtime-role execution packet with D. | R, D |
| Q22 Wed 11-18 | Implement cloud-safe two-organisation/four-role smoke fixtures, exact-ID cleanup and residue policy; request D's `rls-probes.mjs` adaptation in its own slot. | C; D |
| Q23 Thu 11-19 | Continue fixture/negative/cleanup tests; candidate N and N+1 preparation, build-bound keys/CA and strict TLS startup check integration with D. | C, D |
| Q24 Fri 11-20 | Review fixtures, migration/grant/TLS startup dependency and exact release packets; run exact-SHA main CI/E2E/Integration gates. | R, D; O |
| Q25 Mon 11-23 | Execute migrations, deployed runtime-role/bucket checks and release N; actual-image smoke, strict TLS negatives, first-creation single-replica readback, scoped fixtures/cleanup. | O/T; D/R review evidence |
| Q26 Tue 11-24 | Execute reviewed SMTP/owned-domain changes and re-escrow; end Namecheap deferral; sender DNS, invite/reset and anti-brute-force acceptance. C uses reserved S6 slot. | O/T; PW |
| Q27 Wed 11-25 | Four-role/two-tenant QA and signed evidence/report flow; Water is factorless and returns Not calculated; factor categories return no_factor while LP4-02 PR C is blocked. | O/T; PW |
| Q28 Thu 11-26 | Review QA evidence/UAT instructions, fault/alert checks, zero-diff re-plan and release N+1 rollback packet; independent S6 review. | R |
| Q29 Fri 11-27 | Execute N -> N+1 -> N with deactivation/zero-outgoing-replica/failure evidence, compatible rollback/rotation, smoke and cleanup; anon-key rotation rebuilds web. Missing predecessor means stop traffic, not invented rollback proof. | O/T; PW |
| Q30 Mon 11-30 | Evidence/sign-off for proposed G2-functional (S1); S6 final fixes and reviewer checks consume reserved capacity, not new live changes. | O/T, R; PW |
| Q31 Tue 12-01 | S2 acceptance/retest allowance; dispatch recovery capture work only after reviewed design and approved network/storage packet. | O/T, R; C |

Q25 forecasts G1 review on 11-24. Q15 is infrastructure creation, **not the old Q15 recovery drill**; recovery drills now have explicit REC slots below. If any package needs another implementation/review round, shift its first execution; the combined lead entries never authorize first implementation and first live use of that package on one day.

**Proposed G2-functional evidence:** accepted PD-3; exact candidate/config identity; deployed runtime-role and raw-index checks; private evidence/import buckets and signed downloads; no public service key or insecure-local-auth; no fixture/placeholder factor release and `ALLOW_PLACEHOLDER_FACTORS` off; two organisations/four roles and exact-ID fixture cleanup/residue report; actual-image login -> Water entry -> evidence -> independent approval -> report, plus `no_factor`; N+1 rollback; real operator alerts and tested error reporting or recorded no DSN; UAT instructions rewritten for deployed cloud fixtures (no demo `db:reset`); stated RPO **15 minutes** / RTO **4 hours**, explicitly unproven until REC passes. Local E2E is not QA browser acceptance. No real customer inventory before G5.

## 5. Recovery track: independent workload and measurable acceptance

Fix network/storage requirements in Q1-Q3 before R2 approval. Use isolated immutable, soft-delete-protected Sweden backup storage over a private path, with RBAC separate from app/deployer identities. Azure Blob is not assumed to be a drop-in Supabase Storage endpoint. Specify continuous WAL + base backups and separately frequent object-byte capture; a 15-minute object RPO needs measured capture frequency/lag. Cross-host escrow rebinding must verify new target identity without disabling old custody protections. Pre-approve a bounded recovery packet, scoped privileges, target capacity and spend so per-action approvals cannot consume the four-hour RTO; emergency access remains audited.

| Package / engineering days | Implement -> independent review -> approved execution | Lead / scheduling |
| --- | --- | --- |
| REC1 Design, 2 days | Loss model, DB/object consistency, network/private storage, immutable retention, cross-host escrow and recovery packet; review before capture. Initial network constraints already fixed Q3. | RI in S1 starting 10-26; C's Q1-Q3 design counts toward S2's total, never duplicated |
| REC2 Capture + age alerts, 3 days | Implement and test capture/manifest/freshness/failed-job alerts (2); review (1); first live capture on a later REC3 day after approval. | RI or serial C; O executes |
| REC3 Restore tooling, 4 days | Implement isolated complete-system recreation, full-host/DB/object/config restoration and guarded start (3); independent review (1); no live loss drill on review day. | RI or C; R; O capture validation |
| REC4 Drill + repeat, 2-3 days | Execute approved drill (1), inspect/fix/review if needed (1), repeat independently on a later day (1). A failed drill can exceed this allowance. | O/T, backup operator, R; implementer handles defects |

Total **11-12 engineering days**, plus waiting for review, access and approved execution. S1 runs in parallel with Phase B only if RI is staffed by 10-26, with proof forecast by 12-04. S2 credits the two design days already booked Q1-Q3; reserve C's 12-02 to 12-15 for the remaining ten engineering days and 12-16 for proof review. Do not book production implementation there. Capture begins only after reviewed private storage/network activation. REC4, P12 and V11 all use this protocol:

1. From two hours before T0, write one sequenced marker/minute: an API record and an evidence object with SHA-256 journalled outside the system. Record NTP offsets. Capture baseline counts, audit/seal expectations, hashed object manifest and reference-report totals in an immutable comparison cohort, excluding later marker mutations from its totals; journal per-marker expected counts to compare the recovered contiguous checkpoint, not demand recovery of intentionally lost trailing markers.
2. At T0, induce the declared loss just before the next object backup. Restore an isolated target from backups and escrow only, using the same image digests and reclamation hold. Exercise full-host loss, not reuse of source disks; capacity/keys/config must come from the approved recovery packet.
3. RPO = max(T0 minus last contiguous recovered DB marker time, T0 minus last contiguous hash-matching recovered object marker time). A gap or a row without bytes/bytes without a row fails; quantify clock uncertainty rather than hiding it.
4. RTO = T0 until readiness, real login with restored accepted keys, hash-equal evidence download and baseline-cohort reference-report totals all pass. Reconcile counts, audit continuity, factor-release seals and runtime-role checks; historically retired credentials remain rejected, while accepted backup keys remain usable as designed.
5. Pass only at RPO <=15 minutes, RTO <=4 hours and clean reconciliation. Preserve sanitized measured evidence and repeat once. V11 is run by the backup operator without owner assistance; a pre-production proof does not replace final-candidate recovery qualification.

## 6. Production design and entry decisions

This is a decision/design lane, not ten extra implementation days hidden beside QA. The only production-code allocation before G2 is S6: four C days Q26/Q27/Q29/Q30 if PW=C after explicit reassignment/reservation; otherwise the owner supplies named PW capacity or moves P1. Material fixes consume reserve and shift dates.

| Slot / date | Output required | Lead |
| --- | --- | --- |
| S1 Mon 11-16 | Name LP2-04 infrastructure writer, release/reserve exact paths, check product workload and capacity. | O |
| S2 Tue 11-17 | Select separate subscription; verify credit restriction, RBAC and production ACR/build/environment isolation design. | O; PW/R review |
| S3 Wed 11-18 | Confirm RPO/RTO/loss model, single-host SLA and primary/backup custodian arrangements. | O, named backup operator |
| S4 Thu 11-19 | Domain/DNS and private/public edge decision; agree pilot data size, concurrency and performance/error budgets before testing. | O, T, domain reviewer |
| S5 Fri 11-20 | Qualified legal review of controller/processor roles, KVKK Article 9 mechanism/notification, email/Azure/error-reporting processors, log location/retention, breach notice, erasure versus append-only audit. Record decision before P1; no legal conclusion inferred here. | O, L |
| S6 Tue 11-24 / Wed 11-25 / Fri 11-27 / Mon 11-30 | 3-5-day production-contract/guard package: replace QA-only variable/r02/init bindings with explicit reviewed production contracts; test protected defaults, edge and custody rules. Four days reserved; fifth day moves later work. Independent first review Q28, final review S7; first live use P3/P4. | PW, R |
| S7 Tue 12-01 | Close independent review of production code/parameters and exact migration/backup interfaces; no apply. | R, PW |
| S8 Wed 12-02 | Confirm operating costs, alert thresholds, patch/start/network/monitoring decisions and human second-person roles. | O, named operators |
| S9 Thu 12-03 | Review production plan and accepted-domain-on-QA evidence; recovery proof must precede P1. | O, R |
| S10 Fri 12-04 | S1 entry decision after REC proof; S2 repeats this entry check on 12-16, never claims an early pass. | O, named independent approver |

Legal review uses current [KVKK law and Article 9](https://www.kvkk.gov.tr/Icerik/6649/Personal-Data-Protection-Law) and the selected processor contracts; this document does not select a transfer mechanism. SMTP remains undecided, not implicitly ACS or Resend. Before P1: owned-domain integration accepted on QA, production names/DNS control approved, legacy-key decision recorded, recovery passed, live authority granted, named second-person roles and G2/deviation decisions recorded. Missing prerequisites keep production closed/unprovisioned as applicable.

Book the pen-test and a retest slot now: confirm by 10-30, hard stop 11-13 for the old 01-22 G5. Require signed scope, rules of engagement, NDA and synthetic test accounts; at least five tester-days on closed production, no customer data. S2 requires vendor rebooking because production is not ready for 01-11. Obtain the written report by V12 at the latest (S1 target 01-20; S2 02-01), and retest the V13 candidate. Legal/processor decisions are reconfirmed at V10.

## 7. Production foundation: fifteen working days, customers closed

Dates show S1 / S2. P2 validates the already implemented/reviewed S6 package; it is not first implementation. P1 requires named second-person roles and approved custody design; created-vault readback and completed credential custody must precede P4 use. Each live packet needs separate review/approval; reserved windows do not grant access. P6 creates the production app foundation on its own subnet. P12 must independently recreate the complete P3-P10 topology from code/config and recover it; reserve a distinct delegated subnet, NSG/private DNS and approved isolated hostname routing preserving image-bound origins, without changing live production routes.

| Day / S1 date / S2 date | Work / evidence | Lead |
| --- | --- | --- |
| P1 Mon 12-07 / Thu 12-17 | Recheck entry gates, human roles, approved estimate and reserved writer; accept precise plan. | O, independent approver |
| P2 Tue 12-08 / Fri 12-18 | Review production parameterized saved plans, guard tests, isolation and secret/state boundaries; changes need renewed review. | PW, R |
| P3 Wed 12-09 / Mon 01-04 | Execute reviewed network/host/disks/private backup foundation; read back RBAC and deny QA access. | O |
| P4 Thu 12-10 / Tue 01-05 | Approved trusted Supabase bootstrap with new production credentials, dual custody and guarded start. | O, second custodian |
| P5 Fri 12-11 / Wed 01-06 | Activate reviewed capture/WAL/object/age-alert configuration and verify private immutable backup path. | O/T |
| P6 Mon 12-14 / Thu 01-07 | Create app foundation/ACR/vault/identities/private DNS/TLS/logs from code; verify separate subnet and recreation contract. | O; PW/R evidence |
| P7 Tue 12-15 / Fri 01-08 | Apply exact-source migrations, status/catalog/runtime-grant checks and private buckets through owner channel. | O; D/R evidence |
| P8 Wed 12-16 / Mon 01-11 | Activate owned Auth DNS/TLS, private/admin edge, guarded redirects/CORS and issuer; web/API domain bindings wait for apps. | O/T |
| P9 Thu 12-17 / Tue 01-12 | Configure separate email credentials/sender DNS; re-escrow; invitation/reset and XFF/rate-limit checks with controlled users. | O/T |
| P10 Fri 12-18 / Wed 01-13 | Build production-bound images from qualified SHA in production context; deploy closed apps; then bind web/API domains/certificates and smoke actual images. | O; PW/R |
| P11 Mon 01-04 / Thu 01-14 | Verify certificates, actual-web invitation/reset link redemption/expiry/reuse (P9 proves delivery only), four-role/two-tenant negatives, no-demo checks, exact cleanup and alerts. | O/T |
| P12 Tue 01-05 / Fri 01-15 | Recreate the complete production-shaped topology from reviewed code in the reserved isolated target; execute section 5 recovery protocol on DB/bytes/config and actual application images. | Backup operator, T; R evidence |
| P13 Wed 01-06 / Mon 01-18 | Exercise N+1 rollback/rotation/reboot/operator incident response and measured pool/load limits. | O/T, backup operator |
| P14 Thu 01-07 / Tue 01-19 | Loader dry run, review result, then explicitly approved --apply --allow-remote of reviewed authoritative releases into closed production; verify seals/provenance/no demo rows. | O (loader custodian), D/domain reviewer |
| P15 Fri 01-08 / Wed 01-20 | Independent readiness evidence/handover; keep customer opening gated on G4/G5. | R, T, O |

Container Apps custom domains/certificates bind to existing apps, hence P10/P11, not P8. [Microsoft domain guidance](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates). LP4-01's supported onboarding is already delivered; live invitation/reset delivery via LP2-04 remains. Product factors, reports, TR/EN acceptance, limits and legal/domain decisions still require their own gate evidence. No local demo seed or broad cleanup in either cloud environment.

## 8. Qualification and opening: exact candidate before customers

S1 V1-V14 follow production readiness; V1-V5 include the vendor's five-day assessment while O/T executes disjoint synthetic acceptance scenarios. R reviews code/evidence only. If the vendor forbids concurrent tests, use separate approved tenants/windows or move dates. S2 runs the five-day assessment 01-21, 01-22, 01-25, 01-26, 01-27; fixes/capacity/recovery follow 01-28 to 02-02, V11/V12 equivalents by 02-02, final requalification/retest 02-03 to 02-04, G5 02-05. Those are minimum windows; material fixes move the pilot.

| Day / S1 date | Required evidence | Lead |
| --- | --- | --- |
| V1 Mon 01-11 | Confirm G1-G4 and freeze assessment candidate; exact-main CI/E2E/Integration, actual-image smoke; vendor starts signed scope. | O/T, V; R |
| V2 Tue 01-12 | Four-role/two-tenant, TR/EN/year/import and onboarding checks on candidate; vendor assessment day 2. | T/O, V |
| V3 Wed 01-13 | Validate exact production-loaded factor manifests/seals and independent reference cases; vendor day 3. | Domain reviewer, O, V |
| V4 Thu 01-14 | Domain review of those exact sealed releases, inventory/report reconciliation; vendor day 4. | Domain reviewer, T, V |
| V5 Fri 01-15 | Vendor day 5; triage reproducible findings and plan fix/retest scope. | V, O; R |
| V6 Mon 01-18 | Implement reserved code fixes; preserve evidence and release compatibility. | Assigned C/D/PW |
| V7 Tue 01-19 | Independent fix review; no first live release of that fix on its implementation day. | R |
| V8 Wed 01-20 | Receive written report; execute approved fix candidate and targeted retests. | V, O/T |
| V9 Thu 01-21 | Production-shaped load/PDF/import/memory/pool and abuse tests against pre-agreed budgets. | T/O; R |
| V10 Fri 01-22 | Security/privacy/legal checkpoint, processor/erasure decisions reconfirmed; any blocker reforecasts G5. | V, L, O |
| V11 Mon 01-25 | Final-candidate full-host recovery protocol; backup operator acts without owner assistance. | Backup operator, T; R |
| V12 Tue 01-26 | Final report deadline, vendor retest preparation, migration/rollback and operator evidence reconciliation. | V, T/O, R |
| V13 Wed 01-27 | Requalify final main SHA after fixes: CI, explicitly dispatched Integration, full local-stack E2E, actual-image/cloud acceptance and vendor retest on this candidate. | O/T, V; R |
| V14 Thu 01-28 | Current-candidate customer UAT/product/domain sign-off first; then complete evidence packet and owner G5 decision. | Pilot representative, domain reviewer, O, independent launch approver |

`release_checks.py` requires successful exact-SHA runs on **main**. `e2e.yml` uses a local stack, not the QA URL; run separate live acceptance. Explicitly dispatch Integration because path filters skip documentation-only commits. Freeze main from V13 until closed deployment; later source/image/config/secret/factor changes invalidate affected proof. Repeat V11 if a later change affects recovery, and independently review material fixes. No unresolved release-blocking findings or unapproved evidence substitutions.

| Opening action | S1 date | S2 date | Lead |
| --- | --- | --- | --- |
| Deploy G5 manifest to closed production; synthetic smoke, then clean exact fixtures | Mon 02-01 | Mon 02-08 | O, T |
| Supported holding onboarding with restricted first administrator, only if explicitly approved; otherwise dry-run and defer actual invitation to opening | Tue 02-02 / Wed 02-03 | Tue 02-09 / Wed 02-10 | O, pilot representative |
| Final operational rehearsal and pre-opening backup/alert/rollback checks | Thu 02-04 | Thu 02-11 | O, backup operator |
| Freeze and confirm operator coverage; no late customer UAT gate | Fri 02-05 | Fri 02-12 | O, independent approver |
| Invite agreed pilot users; **no deployment on opening day** | Mon 02-08 | Mon 02-15 | O, pilot representative |
| First five working days / first real close | Daily operations review / G6 after real reporting cycle | Same sequence | O, domain/customer owner |

Supported onboarding immediately sends the first-admin invitation; this plan does not invent a suppress-email option. Customer UAT belongs before G5 with approved test access, not after deployment. If the owner separately chooses the faster 02-01 opening, preserve the same order: 01-25 closed deploy/smoke, 01-26 explicitly restricted admin onboarding, 01-27 rehearsal, 01-28 backup/alerts, 01-29 freeze, 02-01 invitations. The old 01-25 stretch would require all 01-26 to 01-29 preparations completed before 01-25; do not compress them after opening.

## 9. Release controls, costs and evidence

- Bind source SHA, lockfile hash, migration order, API/web digests, target origins/JWKS/issuer, CA hash, runtime limits, cleanup hold and exact secret versions. Web `NEXT_PUBLIC_*` inputs are build-bound: a different environment, public anon-key rotation or bundled CA change requires the affected image rebuild and requalification; never copy QA secrets to production.
- Apply migrations via separate owner credential. The spurious `DROP INDEX activity_records_reporting_entity_period_category_key` must be removed during migration generation/review. At deployment require exact-source `migration-diff`, `prisma migrate status` and a catalog check of the raw NULLS NOT DISTINCT index and runtime grants. App rollback does not reverse a DB migration; prove N+1/N compatibility or use an approved maintenance/forward-fix plan.
- Failed containment, trust, isolation, migration, readiness or restore reconciliation stops the gate. Preserve state/private diagnostics; no automatic retry/import/force-unlock/destruction after partial apply, no reopening old credentials or contained endpoints. RPO/RTO remain measured requirements, never inferred from Key Vault escrow or disk locks.
- Production estimate explicitly includes always-on API (initial budget assumption **1 vCPU/2 GiB**, validate by load), web compute, Log Analytics ingestion/retention, production ACR, backup Blob + WAL/object growth, private endpoint/DNS, second recovery VM/disks, retained QA/old disks/IPs, Key Vault, network egress/email, and Bastion/Defender/WAF if selected. Credit eligibility/expiry/balance and SKU capacity remain unverified; the former TRY cap is not reinstated.
- Runbook 10's dated USD 100.96/month is only a replacement-plus-retained-resource component subtotal, not a QA/production budget. Refresh actual rates and include recovery overlap/taxes; agree operating thresholds and budget/forecast alerts. Alerts do not stop spend. Review consumption after seven days and each gate.
- Every gate records source/plan/executor hashes, resource/state identity, digests, exact secret version IDs (no values), migration/factor manifests, scenario outputs, times/clock offsets, human operator/reviewer and limitations. Live operations, legal/vendor sign-offs and restore measurements are not claimed by this documentation patch.

Implementation handoff requires Node 22 `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, appropriate infrastructure checks and honest cache/omission reporting. Use canonical B9 in the handoff; proposed roadmap decisions go there for Claude Code after owner merge. This document does not edit the ledger, README, runbooks, application or cloud. Next work remains Q1-Q3 design/N2 review before an exact R2 packet; the planning-date, staffing, G2 split, owner-run deviation and production-writer decisions remain with the owner.
