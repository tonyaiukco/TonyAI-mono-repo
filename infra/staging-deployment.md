# TonyAI: Staging deployment runbook

> Moved from [`README.md`](../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Staging deployment (LP2-01)

> **Hosted phase (owner decision 2026-10-26, extended to the pilot on 2026-10-28).** For the
> next two to three months QA and the pilot run the database, Auth and Storage on **Supabase
> Cloud (Pro), North EU — Stockholm (`eu-north-1`)** and the web and API on **Azure Container
> Apps in Sweden Central (`swedencentral`)**, built from scratch,
> through the reviewed hosted path below, in the self-hosted QA's subscription but fenced
> into their own resource groups, prefix and Terraform backend. **Codex runs it.** The
> self-hosted route described in the next paragraphs is **paused, not removed**: it resumes
> on the owner's word after the pilot launch to move the Supabase side to Azure, and its CI
> gates run only by hand meanwhile (before any change to `infra/` code). Plan and status:
> [`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](../docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md).
> WP-2 supplies the regional retarget, exact hosted-QA target/backend exception and
> ACS Email foundation. L1 binds the checked-in exception to the reviewed subscription
> and owner-selected dedicated backend `tonyaiqtqabe`. The
> [L1 prerequisite checklist](runbooks/00-session.md#l1-prerequisite-evidence-before-provisioning)
> separates verified metadata, owner declarations and blockers; the
> [L1b identity packet](runbooks/01-azure.md#14-acs-email-identity-and-domain-preparation)
> requires its own approval after L1 closes. L1b completed on 2026-10-29 after
> the owner reconciled the existing application provenance: the approved service
> principal was created and both identities were verified without credentials.
> L2 completed and was independently read back on 2026-10-29. Separately approved
> L3 plan/apply created 17 foundation resources; SMTP username creation failed because
> its ARM child name equalled its login. The recovery fix separates `*-smtp-user`
> from the unchanged `*-smtp` login and repairs ACR lookup in session restoration.
> The separately approved recovery completed L3 (18 resources); L4/L4a and L5
> are verified. L6 completed after the transport repair (#257): all 42 migrations
> and the strict-TLS owner/runtime checks passed. L7's owner-run SMTP credential
> creation and Key Vault storage completed; the separate `r002` manifest preserves
> the immutable application candidate. The first runtime-grant PLAN was rejected:
> two intended grants plus two unexpected normalization updates, with no APPLY.
> The merged foundation fix (#258, `a9476eb`) models Azure's seven returned log categories (only
> Console/System enabled) and references the unchanged SMTP role UUID through its
> canonical subscription path; automatic CI and both required manual workflows passed.
> The separately approved runtime-grant PLAN/APPLY completed with two creates;
> the separately approved SMTP-grant PLAN/APPLY then completed with one create.
> Both APPLY runs matched their full refreshed plans before confirmation and exited
> 0 with no updates/destroys. Exact grant IDs and unchanged public outputs matched.
> Runtime/SMTP readiness is recorded applied; app readiness remains false. Protected
> inputs and immutable candidate/releases are unchanged. No independent grant/lease
> readback, secret-access or SMTP authentication/delivery test ran. Diagnostics
> destination and vault network-ACL findings remain open. No deployment occurred;
> L8 secret verification and deployment need separate preparation and approval.
> Offline L8 review confirms that `release_secrets.py verify` reads three exact
> secret values and uses the backend key for a Supabase Storage bucket-list GET;
> it does not prove SMTP authentication/delivery or API managed-identity access.
> Separately approved L8-M1 completed once: three exact ARM configuration GETs
> (environment, diagnostic setting, vault), with owner-token acquisition. The
> environment reports azure-monitor and the expected workspace/log categories;
> diagnostic destination type remains explicitly null and vault networkAcls is
> absent. Both findings remain open. Approval is consumed; no secret verification,
> deployment or automatic continuation is authorized.
> Separately approved L8-SV1 stopped with exit 1 before its first recorded GET.
> The exact local/token/verifier failure phase is unknown; token acquisition may
> have contacted Entra. Secret verification did not pass. No retry or deployment
> followed; approval is consumed. The failed packet/attempt are preserved, both
> findings stay open, and any token diagnostic or secret retry needs separate approval.
> Separately approved L8-TD1 completed its token-only diagnostic: CLI returned
> successfully, but the local audience comparison failed while tenant/owner/time
> checks passed. Actual audience value/type was not retained. This current mismatch
> does not establish SV1's original cause or justify widening the guard. No resource
> API or secret verifier ran; approval is consumed and no retry is authorized.
> Offline Microsoft documentation and installed CLI inspection support an exact
> Key Vault API-ID audience alias. Separately approved L8-SV2 completed once:
> all four GETs and source validators passed for the three exact secret versions
> and authenticated bucket-list read. Values stayed in memory; approval is consumed.
> Both findings remain open. Runtime identity access, SMTP authentication/delivery
> and deployment acceptance remain unproven; no follow-on operation is authorized.
> Separately approved L8-PRE1 collected four metadata observations: both app
> endpoints returned ARM404, the application container returned 200 with an
> available/unlocked lease, and the state blob returned 404/BlobNotFound.
> No response/state body, Terraform or lease write; approval is consumed.
> These observations support offline PLAN preparation only, not execution authority.
> Separately approved L8-AP1 completed one remote init and saved PLAN attempt:
> init0, plan2 and inspected exact two creates, zero updates/destroys. The accepted
> plan and bounded outcome passed independent QA/DevOps review. The plan is retained
> privately; new temporary work was removed. Backend blob HEAD
> changed from404/BlobNotFound to200/unlocked/available. This does not independently
> audit lease operations or prove unmanaged-app absence. Approval is consumed;
> no APPLY/deployment ran or is authorized. Diagnostics/vault findings remain open.
> L8-AA1 and a separately owner-requested byte-identical retry both stopped at
> the GitHub gate while entering E2E fetch. CI passed in memory by sealed control
> flow; no CI run ID/response remains. E2E completion and precise causes are unknown.
> Neither attempt reached integration, Azure authentication, Terraform or APPLY.
> Both approvals are consumed; the original failed journal remains intact.
> L8-E2E-D1 was separately approved and collected once at 2026-11-01 00:15:16 UTC:
> HTTP 200, zero returned/qualifying runs for exact candidate `6bceba82` on `main`.
> The E2E gate is blocked by missing evidence; this is not a failed E2E test and
> does not establish either historical fetch failure. Independent QA accepted
> the bounded observation. Approval is consumed; no Azure/deployment followed.
> The owner selected new-candidate qualification under the existing gates,
> with offline preparation only. Separately approved L8-NC-G1 collected four
> public metadata observations at 2026-11-01 01:47:59–01:48:00 UTC: `main` matched
> `a9476eb`, CI and E2E were successful, but Integration returned zero runs for
> that exact SHA/main. Integration evidence is the current missing gate.
> Approval is consumed; no workflow, candidate, image build or deployment started.
> L8-INT-D1 was separately approved with all three conditions and completed once:
> Integration run `41293973321` / attempt1 succeeded at 2026-11-01 09:44:03 UTC
> on exact `a9476eb`/`main`; the final list confirmed it as latest qualifying success.
> One POST,19 total HTTP requests,13 run observations. Approval is consumed;
> CI/E2E were not refreshed, so all current release gates are not newly accepted.
> L8-IB1 was separately approved once, then stopped after the environment ARM
> GET returned HTTP200 at 2026-11-01 10:18:05 UTC, before its binding receipt.
> Fresh main/CI/E2E/Integration, token, group and registry checks passed.
> The exact failure predicate is unretained; historical `Sweden Central` differs
> from the packet's literal `swedencentral` check, but is not proof of this cause.
> No Supabase key check, ACR login, build/push or new candidate/deployment followed.
> L8-ED1 was separately approved and completed once at 2026-11-01 10:32:59 UTC:
> one ARM token invocation and one environment GET200. Only the exact display
> location `Sweden Central` differed; ID/tags/provisioning/domain matched.
> The unchanged IB1 canonical-only guard rejects this current representation;
> its earlier failure cause is still unproven. Independent outcome QA/DevOps passed.
> L8-IB2 was separately approved and completed once; its outcome record was
> written at 2026-11-01 10:46:14 UTC (exact promotion/exit time was not captured).
> Both a9476eb images were built/pushed and exact-digest inspected; the browser
> asset guard/limited secret-marker scan passed. A new mode0400 candidate-r002
> was accepted, hash `e0dcf59698f7642b5c531c63caddf2bf5cb042c4f8f80c3208ab4a64a8cc86a8`.
> Independent outcome QA/DevOps and post-outcome local checks passed.
> IB2 approval is consumed. New release-r003 binds that candidate with only
> release ID/source/two image digests changed and the same three secret versions.
> SV3 was separately approved and completed once on 2026-11-01 at11:15:01–05 UTC:
> observed runner exit0, one owner token and four HTTP200 GETs; original secret
> validators passed. Three secret VALUES were read in memory and the backend
> key authenticated the bucket-list GET; no raw values were persisted.
> Independent SV3 outcome QA/DevOps and post-outcome Node22 checks passed.
> AP2 was separately approved and completed once at2026-11-01 11:29:07–18 UTC,
> observed executor exit0. New r003 saved plan contains exactly two app creates,
> zero updates/destroys; init/plan/show returned0/2/0. Existing empty state identity
> and full resource bodies passed the reviewed inspector. Final blob HEAD was
> unlocked/available; only new temporary work was cleaned.
> Independent outcome QA/DevOps and post-outcome Node22 checks passed
> (eight lint warnings; other tasks cached).
> AA2 was separately approved and attempted once. The observer recorded
> 2026-11-01 11:48:19–12:05:36 UTC (17m17s), executor exit1. Fresh gates/inventory
> passed; init/show/APPLY returned0. The API ARM GET returned200 and parsed, then
> ARM_READBACK stopped before revisions/web; exact cause was not retained.
> Deployment is INCOMPLETE, despite APPLY0. Temporary work was cleaned; no retry,
> rollback or extra cloud query followed. Approval is consumed.
> AD1 was separately approved and collected once, observed runner exit0 at
> 2026-11-01 12:25:30–33UTC: one owner ARM token and one API GET200. Only the
> canonical-location predicate differed: known display `Sweden Central` versus
> the unchanged `swedencentral` guard. Other adapter predicates and the original
> source prefix before revisions matched. This is a current diagnostic only;
> the historical AA2 cause and full deployment acceptance remain unproven.
> Approval consumed; no guard change, retry or further live operation followed.
> AR1 was separately approved and attempted once at2026-11-01 12:39:51–56UTC.
> One token and all three ordered API/revisions/web GETs succeeded (HTTP200),
> with the exact display-region mapping for both apps. Overall runner exited1
> at WEB_SOURCE, category SOURCE_SHAPE_OR_LOCAL_ERROR; exact field/exception
> was not retained. ARM readback remains INCOMPLETE; no accepted result exists.
> Approval consumed; no retry, mutation or further cloud query followed.
> Diagnostics/vault and functional/log/SMTP acceptance remain open. Old artifacts
> and the17 protected inputs stay intact; no seed, commit or push.
> WD1 is now prepared offline as one ARM token and one exact web metadata GET
> in `/private/tmp/tonyai-l8-web-diagnostic-plo9fupi`. Fixed field-shape categories
> and independent safe predicates cannot reconstruct AR1 or accept deployment.
> All 36 offline tests pass on Python 3.12/3.14; independent Security/QA/DevOps
> core reviews and Node22 lint/typecheck/build/test passed (8 lint warnings;
> typecheck/build/test cached). Final sealed packaging requires detached QA
> acceptance before the exact owner approval request. No live operation is
> approved or executed.

> WD1 was then separately approved and collected once on 2026-11-01 at 14:41:33–14:41:37 UTC.
> Runner/token exit0, all five claim guards true, one web GET200/parsed. Current
> `configuration.secrets` is NULL; the empty-web-secret-set predicate is
> NOT_EVALUABLE, while the other seven web predicates and six adapter predicates
> pass. This is current diagnostic evidence only; AR1 historical cause and full
> deployment/readback acceptance remain unproven. Nine original receipts are
> frozen; independent QA/DevOps accepted bounded diagnostic collection only.
> Post-outcome Node22 lint/typecheck/build/test passed (8 lint warnings; other
> tasks cached); final evidence packaging audit is separate.
> Approval consumed; no extra read, null repair, retry or mutation followed.

> LC1 now combines the remaining L8 readback and HTTP acceptance offline:
> one ARM token, three GETs, one exact-web listSecrets read action and six public
> health/readiness/login/auth-CORS checks. Null is mapped only on a web response
> copy after an independently confirmed empty inventory; original guards stay.
> All41tests pass on Python3.12/3.14; Security/QA/DevOps core reviews and Node22
> lint/typecheck/build/test passed (8 lint warnings; other tasks cached). Final
> sealed packaging audit and one new exact owner approval are required. No redeployment, retry or live call occurred;
> open vault/diagnostic findings and L9/L10 QA-handover obligations remain.

> LC1 was approved once but stopped at web listSecrets HTTP415 after three
> successful GETs. No inventory body, public checks or accepted readback followed.
> QA/DevOps accepted failure evidence only; L8 remains open and approval consumed.
> Offline urllib preprocessing reproduced implicit form Content-Type on the empty
> POST. LC2 will set application/json explicitly and test the real request
> preprocessing; the same acceptance scope needs a fresh exact approval.

> LC2 is now prepared offline at `/private/tmp/tonyai-l8-closure2-ev4fytf5`: only
> the exact POST media type changes to application/json; request body/scope and
> guards stay fixed.43tests include real urllib preprocessing and the missing-
> header regression on Python3.12/3.14. Security/QA/DevOps and Node22checks pass
> (8 lint warnings; other tasks cached); final sealed packaging audit precedes
> a fresh exact approval. No live retry or L8 acceptance. LC1 failure evidence and original receipts remain fixed.
> LC2 subsequently passed metadata, empty inventory, liveness and readiness,
> then stopped at web login without a response receipt. Overall acceptance failed;
> exact transport cause is unknown. Its one-attempt approval is consumed.
> LC3 preparation retains all checks with a 60-second public socket timeout
> and safe error categories; L8 and QA handover remain unaccepted.
> LC3 is prepared with the same ten checks and 60-second public socket timeout;
> 48 offline tests pass on Python3.12/3.14. Security/QA/DevOps and Node22 checks
> pass (8 lint warnings; other tasks cached). Final sealed packaging audit precedes
> fresh one-attempt approval; no live retry has run.
> LC3 subsequently received login HTTP200, but its blanket Link-header gate
> refused the response before HTML validation. Actual Link content is unknown;
> last three checks did not run. LC4 preparation will ignore Link only on the
> fixed login check while still requiring200/text-html and never following links.
> L8 remains incomplete; LC3 approval is consumed.
> LC4 subsequently completed once with exit0: all10requests passed. Exact
> source metadata, empty web inventory, SQL/three-bucket readiness, loginHTML,
> unauthenticated401 and allowed/untrusted CORS passed independent outcome review.
> L8 is complete for controlled synthetic QA; diagnostics/vault findings remain
> open. L9 onboarding/email and L10 smoke/recovery/QA handover remain separate.
> Node22 outcome lint/typecheck/build/test pass (8 lint warnings; other tasks
> cached); final sealed evidence audit is recorded privately.
> L9 binds the private QA roster and separates Auth prerequisites from onboarding
> and SMTP inbox acceptance. A0R1's two unchanged Auth-policy rounds and owner/ICU
> collation check are accepted. A1 then completed one approved nine-request
> born-banned/two-refresh AMR probe and exact-ID deletion with absence confirmed;
> recorded child exit0, no interruption or pending cleanup. Independent QA/DevOps
> accepted the bounded outcome; both approvals are consumed. Original evidence
> and the earlier failed A0 attempt remain preserved.
> A2P1 then passed one read-only owner/collision snapshot: all10predicates true,
> SQLexit0, no HTTP/write/email; independent outcome QA/DevOps accepted it.
> Its approval is consumed and the snapshot is not a reservation.
> A2 was approved once and stopped at DRY_RUN, child exit1, before any creation,
> Auth or SMTP attempt. Four failure receipts are preserved; independent QA/DevOps
> accepted this outcome. Its exception was discarded, so the cause is unknown.
> Approval is consumed: do not rerun A2 or resend an invitation.
> A2D1/D2 completed diagnostic collection but failed native macOS connection:
> P1011, narrowed by D2 to TRUST_OR_VALIDITY. SQL was not reached; the category
> does not identify the root cause. Receipts/outcome reviews are preserved and
> approvals consumed. Offline public-CA import passed without trust changes.
> A2L1 then passed strict Linux owner/read-only/profile-absence/source-dry-run
> checks and exact local-container cleanup; 17 receipts and independent QA/DevOps
> outcome acceptance are preserved. This is not a reservation or creation authority.
> A2L2 then completed one approved first-admin/holding/invitation operation:
> ten fresh preflight and thirteen exact-ID readback predicates passed, three Auth
> calls succeeded, one TR SMTP submission was accepted, and local cleanup passed.
> Twenty original receipts and independent QA/DevOps outcome acceptance are retained.
> The owner reports inbox arrival, then successful A3 password save/fresh sign-in,
> Turkish UI and no visible error. The dashboard shows subsidiaries, not the holding
> name; an empty register is expected because A2L2 created no subsidiary. UI success
> alone did not establish invitation/audit acceptance (known LP4-01 follow-up26).
> A3R1 subsequently passed all fifteen exact-ID read-only predicates, including
> correct tenant/profile and accepted invitation with its actor audit; disconnect
> and local cleanup passed. Original fifteen receipts/outcome reviews are retained.
> A4 owner reports successful subsidiary/site creation, four QA invitations,
> one data_entry grant and five users without error. All four emails arrived by
> owner report; second-admin Outlook delivery was in spam, an open quality finding.
> A4R1 completed its read-only snapshot:21predicates passed and six differed.
> Five profiles/roles, one subsidiary/site and the exact data_entry grant passed.
> Owner reports later metadata/access changes and at least one recipient Continue
> click; the clean initial-state baseline no longer describes all owner actions.
> No creation/mail failure or complete state acceptance is inferred. Evidence kept.
> Hosted QA is now r004 (owner/Claude deployment), fixed source 7d3e2e9 (#259/#261).
> API digest 4126b6ce1566… and web ded9a4f423a7… bind later acceptance; exact values
> and source/gate evidence are recorded in the existing hosted/status plans.
> Deploy helper c8ca4af (#263) and preparation main 88b80b4 (#264) do not retarget images.
> Prior evidence reports post-rollover verify-only/public/browser checks passed;
> L9 synthetic onboarding is COMPLETE: one holding, five individual accounts,
> delivered invitations and accepted recipients/correct data_entry access.
> All five r004 login/profile observations are owner-reported; four invited
> members also report company reads; no first-admin company-list proof is claimed.
> First-admin identity match is closed by later owner confirmation, preserving
> the original unobserved receipt. All role-attempt approvals are consumed.
> Fresh r004 email/reset/TR–EN/lifecycle and full workflow/RBAC/isolation/Storage/
> exports/audit/monitoring/handover remain L10/LP4-01 OPEN; LP2-HQ stays IN_PROGRESS.
> No further L9 live test is required. Remaining work uses a consolidated bounded
> checklist/batch for owner review, not per-role/per-click approval loops.
> The current runbook11 batch replaces the earlier blocked preparation. It uses
> separate clean helper/application sources and cached Linux Prisma/strict CA,
> a no-mail bootstrap plus two privately bound real inboxes (seven mail attempts),
> two synthetic subsidiaries, four declared Water slots and one synthetic boundary.
> It never seeds the cloud or substitutes demo factors. Protected QA accounts are
> not lifecycle targets; one consultant read-only session supplies foreign denials.
> The local Storage adapter proves authenticated absence and natural signed expiry;
> the lifecycle adapter confines the compiled-service fault seam and shipped CLI
> reconcile/offboard to the exact synthetic tenant, retaining its artefacts.
> Owner-selected maintenance design: one r005 rollback to oldr003 bytes, one r006
> return to exactr004 source/digests on the same QA hosts. QA may be unavailable;
> old web regressions temporarily return. This requires explicit live approval.
> Two native API metric rules and real operator/job delivery are proposed; backup
> metadata does not prove full restore. Full G2/Sentry/rotation/numerical gates,
> diagnostics/vault/spam/history/paused-route findings remain disclosed and open.
> Historical preparation: fa18ba3 passed both manual infrastructure workflows.
> The larger helper/Terraform package subsequently passed fresh review and all
> four final gates at `071e853`, then merged in #266 at `b59fac1`. The current
> follow-up changes documentation only; no live authorization is inferred.
> storage_cleanup_hold stays true; original r003/r004 and L9 evidence are preserved.
> Allowed evidence backup excludes the forbidden IB1 area.
> See [the hosted configuration contract](README.md).

**Paused self-hosted route (kept; resumes after the pilot launch).** The text from here to
the hosted LP4-01 handoff below describes it as it stood on 2026-10-28. The additive
[self-hosted Supabase runbook](runbooks/07-selfhost.md) describes an owner-run VM/network/disk
foundation in Sweden Central (D2as_v7 for QA, D4as_v7 for pilot production),
with separate QA and planned production resources. Provision QA first; production
resources are not authorized yet. Both application and data layers use Sweden
Central on this route. The former TRY 10,000 monthly limit has
been removed. On 2026-10-18 the owner set USD 5,000 as the credit planning
assumption for internal QA; balance, eligibility and expiry are not independently
verified. Documentary verification is deferred until production preparation. Separate owner-run helpers prepare
persistent disks and Docker, pin the official Supabase snapshot/images, generate
protected host credentials and test Auth before explicit HTTPS exposure.
The application is not yet connected; backups, recovery targets and cloud QA
acceptance remain unproven. The hosted path below retains its strict Supabase
Cloud assumptions and must not be pointed at the self-hosted VM.
The host exports an Azure-managed DNS name with reuse protection for temporary
QA HTTPS; the original IP remains locked for rollback. Custom-domain DNS access
can be deferred until the later cutover. Owner-only Key Vault escrow protects
runtime credentials against OS-disk loss, with exact-version readback and a
guarded start. Resource delete locks, disk export restrictions, boot diagnostics,
container IMDS/WireServer blocking (with DNS preserved) and fail-closed persistent
mounts complement this. Guarded recovery regenerates the gateway configuration
from a digest-verified template without repinning images. The HTTPS edge rejects
semicolon paths before upstream normalization.
Auth smoke uses service-specific JWT rejection codes and matching valid-session
controls; edge denials must have Caddy's exact body and no upstream timing header.
The runbook separates the reviewed host-upgrade procedure from local evidence;
live rollout and acceptance require the owner's separate approval.
Auth IP rate limits, ten-digit OTPs, narrow case-sensitive edge routes and
negative live tests are required before exposure. The selected subscription is
blocked from the hosted app roots except for WP-2's exact hosted-QA target. The
separate Sweden QA roots implement the paused application preparation; they never
remove that gate. Legacy HS256 service-key compatibility remains documented; it is
not a completed asymmetric API-key migration or production approval.

The paused [Sweden QA application integration runbook](runbooks/08-qa-application.md)
specifies separate foundation/application writers, creation-time subnet binding,
private database TLS with bounded Prisma pooling, credential separation and an
immutable build/release contract. QA preparation includes an r02 three-subnet
preflight, nonsecret discovery/readback command manifests and an exact initial
foundation saved-plan checker. Unit 4 has a separate runtime-secret transition
inspector: two exact API secret-name grants, a narrowly bounded source-tag update,
public version/role metadata receipts and a permanently blocked owner draft.
It preserves the initial four-false/15-create policy. Unit 5 now has a separate
OIDC transition inspector: 17 preserved resources, seven exact identity/federation/grant
creates, historical Unit 4 bindings, public Azure/GitHub prerequisite receipts and
a permanently blocked owner draft. Its offline provider mock proves policy compatibility
only; federation and independent human/JIT-host acceptance remain unexecuted.
Unit 7 also has an application binary/source/lock
inspector, complete revision receipts and a secret-free `BLOCKED_DRAFT` owner
packet; local candidate JSON and offline receipts do not authenticate live
provenance. These tools validate offline evidence only;
Unit 8 adds an independent saved-binary app-grant inspector: it preserves 24
foundation resources and creates only two Container Apps Contributor assignments
on the already accepted API/web apps. Separate historical Unit 5/7 source chains,
fresh unchanged-app snapshots and exact assignment deltas remain a permanently
`BLOCKED_DRAFT` owner packet. This permission can replace API code and indirectly
access runtime secrets; no automatic deployment executor is enabled.
The separate [Sweden smoke adapter](runbooks/08-qa-application.md#sweden-smoke-adapter)
is prepared and tested offline. It reuses the browser/export/two-tenant journey,
authenticates the candidate through the existing GitHub artifact reader, checks
the same Unit 7 release before/after, and takes the owner fixture DB URL through
a hidden terminal prompt outside the runtime vault. Preparing an ID journal is
`BLOCKED_DRAFT`, never permission to run. Auth-only cleanup retains application
and audit rows; no live smoke or full QA/UAT acceptance is established here.
R3/R4 acceptance, approved backend initialization and a separately approved
foundation apply remain prerequisites. The application is not deployed.
JWT issuer enforcement was integrated by #180; deployed selfhost issuer/JWKS and
exact-candidate acceptance remain to be verified. SMTP provider is
Azure Communication Services Email (owner decision 2026-10-27; data location Europe);
PD-3 remains open for potentially exposed DB-admin/Studio credentials. The
separately approved dashboard credential rotation/custody and one format-1 catalog
inventory completed on 2026-10-15; neither proves database integrity or revokes
other credentials. The owner need not locate the old password.
The [remediation procedure](runbooks/09-qa-integrity.md) makes clean Sweden
replacement with fresh credentials, old-trust retirement and preservation the
primary plan. No rebuild is authorized by those completed operations. Optional
comparison can establish only scoped consistency. The format-2 inventory hardening
is local-only and requires a new package/approval before use. Measured recovery
also remains open.

The [clean replacement execution design](runbooks/10-qa-clean-replacement.md)
specifies an additive generation in the existing selfhost state, preservation
and containment of the old environment, fresh credential custody and staged
acceptance. Historical 2026-10-15 Azure metadata confirmed the binding and reserved
apps subnet; current readback is required before provisioning. Local r02 Terraform writers and
`replacement_run.py` now prepare and bind a saved plan without backend init or
reconfiguration. Generation/disk/source guards, complete template classification,
separate recovery custody and bounded old/new credential probes have local
regression coverage; complete consumer and live recovery acceptance is still open.
Legacy selfhost plan/apply is now refused. Saved-plan writes use graceful SIGINT
and exclusive mode-0600 diagnostic files opened before Terraform starts, so
wrapper death or terminal closure cannot sever its diagnostic streams. Both
streams stay private on success/failure; real-child lifetime tests cover this
boundary. The attempt marker still forbids automatic retry. Runbook 10
[retains the historical pre-R2 design freeze](runbooks/10-qa-clean-replacement.md#q1-q3-design-freeze-and-r2-preparation):
The [database image gate](runbooks/10-qa-clean-replacement.md#database-image-qualification-before-r2)
records the replacement CLI 2.121.0/Postgres 17.11.0.004 candidate, supautils
3.4.4 and immutable provenance. The minimum is now supautils 3.4.2 because of
[GHSA-5pqj-rc76-r669](https://github.com/supabase/supautils/security/advisories/GHSA-5pqj-rc76-r669),
[GHSA-v9vh-54vv-7vfg](https://github.com/supabase/supautils/security/advisories/GHSA-v9vh-54vv-7vfg),
[GHSA-vxh6-6m4g-c39q](https://github.com/supabase/supautils/security/advisories/GHSA-vxh6-6m4g-c39q) and
[GHSA-xj9m-rx42-rfc7](https://github.com/supabase/supautils/security/advisories/GHSA-xj9m-rx42-rfc7).
The earlier 3.4.0 candidate and packet-01 are withdrawn; the replacement candidate was owner-accepted for #187 and consumed packet-02. CI pulls the reviewed
digest from GHCR, refuses CLI startup repository SQL, and binds actual
database content before repository migrations. Final-SHA Integration/E2E and informed owner acceptance accompanied #187.
Packet-02 completed R2 once on 2026-10-18 (ten creates, one VNet append, zero
destroys), with accepted control-plane readback; never replay or regenerate it.
Complete QA-composition qualification remains a separate pre-bootstrap gate. The shared
local CLI/stack is upgraded only by its owner. Runbook 05's reader pre-check
follows #186 and does not restore runtime Storage grants.
The CI action supplies `TONYAI_TEST_PASSWORD` to the disposable seed, E2E,
RLS probes and image smoke so the fixture meets the unchanged 12-character Auth
minimum. Local demo defaults remain unchanged; updating them belongs to the
shared stack's later owner-led upgrade. The override does not enable cloud seeding.

CI authenticates public Supabase pulls to GHCR with the job's ephemeral
`GITHUB_TOKEN` (`contents: read`, `packages: read`); no GHCR PAT is needed.
The database digest, CLI pin, advisory floor and running-image checks remain
unchanged. To stay under GHCR's limits, the stack action caches only the
reviewed database image, its largest (`actions/cache`, pinned, keyed by the
database image policy), and loads it in later jobs, where it is still accepted
only by its reviewed config digest; the other stack images run before the
running-image check, so they are never cached and are pulled as before, and an
archive that changes any other image tag is refused when it loads. A load that
fails just pulls, and a refused pull now says which limit it met
(`registry data-transfer limit` or `registry request-rate limit`).
Official Node build images and the migration-diff PostgreSQL service
use Docker Hub. Repository Actions secrets `DOCKERHUB_USERNAME` (Docker ID) and
`DOCKERHUB_TOKEN` (a [public-read-only Docker PAT](https://docs.docker.com/security/access-tokens/personal-access-tokens/))
are required for normal repository runs. The service uses credentials during job
initialization, before any step; image builds log in before Buildx runs. Fork and
Dependabot PRs still execute the full checks with anonymous Docker Hub pulls when
secrets are withheld, and can encounter registry limits. Authentication is not
an unlimited-pull guarantee. CI passes `NODE_IMAGE=docker.io/library/node:22-bookworm-slim`
to both Dockerfiles; owner candidate builds retain the default ECR Public source.
Documentation-only PRs continue to run the existing required jobs.

Private immutable Sweden backup storage belongs to a separate future writer/apply
packet, and any observed drift still fails closed. October 18 read-only
reconciliation evidence is retained privately; a future packet needs current
resource and state bindings. The owner declined QA VPN and deferred extra custody/recovery design
decisions until production preparation; retain them as open follow-ups.
R3 has its own source, target, qualification and approval gates. Intrinsic
custody must retain the first environment's byte binding. Separately approved R1 executed on 2026-10-15: the exact
containment NSG plan was applied, ten bound containers exited after SIGTERM,
and the retained old VM was deallocated. ARM readback confirmed unchanged disk,
NIC, IP, vault and lock metadata; nine fresh external TCP probes timed out.
Those probes ran from the operator /32: port-22 timeouts support deallocation,
not NSG denial of that permitted source.
The same state retained all fifteen resource IDs (serial 10 to 11). Private/VNet
probing, bootstrap qualification and the complete acceptance matrix remain open.
R2 created isolated replacement infrastructure; old QA is unavailable and the new
host is not bootstrapped. No application deployment or QA readiness is claimed.
PD-3 remains OPEN. Follow runbook 10's separate R1–R4
packages; the legacy selfhost apply command must not perform this replacement.

Bounded R3 preparation now includes pinned public artifact staging, a local
transfer archive, signature/package verification tooling and a separately approved
offline toolchain installer that leaves services persistently masked. A manual
GitHub Ubuntu 24.04 amd64 workflow prepares QA composition smoke using recorded hosted Docker versions on the
owner-selected disposable target. Its source/dispatch, full private regression,
Realtime consumer proof, offline transfer/install qualification and live
host/custody acceptance remain gates. A dispatch-only registry-denied transport run
(`r3-image-transport.yml`, not yet executed) imports the nine active images into an
empty pinned-Engine store in a loopback-only namespace and reads their identities
back; it starts no service. The private DB replacement-regression candidate
(`infra/scripts/r3_db_candidate/`, lock `infra/selfhost/r3-db-candidate.lock.json`) runs
through the dispatch-only `r3-db-candidate.yml` in `rehearsal` or single `attempt` mode
(not yet executed); it never reproduces the historical SIG11. Its separate package job retains a source-bound
vendor provenance receipt and five public metadata files for seven days; CI's
signed fixture is not vendor-artifact verification. Receipt issuance checks the
complete bundle source map against committed files and upstream pins, and hashes
the verified manifest/lock bytes. Verification failure blocks evidence upload.
Composition failures handled by the script emit only fixed phase and cleanup-state
codes, without exception text or runtime output. Cancellation or job timeout can
instead end with a Python traceback (source lines, exception classes and public
command arguments, but not captured child stdout/stderr), or with no status line.
A success summary is written only after
project cleanup succeeds; a failed attempt still requires separate retry approval.
The smoke interprets an omitted `create_host_path` as false only inside an explicit
bind object rendered by Compose 2.38.2, whose serializer omits that false value.
Other versions and ambiguous bind shapes retain strict validation; host validation
and the reviewed mount policy are unchanged.
A separate [native Noble fixture](runbooks/10-qa-clean-replacement.md#native-noble-fixture-a)
workflow is available for a separately approved, single diagnostic attempt on
that fresh hosted runner. It boots a pinned public Noble image in a disposable
VM without a NIC, retains raw outputs only inside owner-encrypted evidence,
and, by default, refuses unexpected package activity without changing trigger or
service policy. Its result does not substitute for Azure target inventory or close R3.
An initial foreign-process refusal also attempts one bounded private identity
snapshot (argv, process/unit relationships and fixed public-image file bytes).
The refusal remains unchanged; this context neither proves inactivity nor
authorizes a process exception or another attempt.
The separately selected [R3 maintenance policy](runbooks/10-qa-clean-replacement.md#opt-in-maintenance-installation-policy-r3-policy-01)
adds a declared five-unit isolation phase and exact reviewed man-db trigger/cache
accounting. It requires externally reviewed policy bytes and a new source-bound
execution approval; no runnable target policy is supplied or inferred. Native
triggers stay enabled and the five additions/holds remain exact. The original
diagnostic mode and format-2 strict installer remain available without this opt-in;
maintenance installation requires format 3. Unknown PackageKit activation, hook or
effect closure blocks preparation for execution. Option C's shared PackageKit state
module (`infra/scripts/r3_packagekit_state.py`, PR-C1) is the one predicate for the
installer and the validator; its reviewed values are not filled and the installer's gate
is not wired to it before PR-C2, so nothing becomes eligible, and it never masks, stops or
unmasks anything. No workflow, Azure installation,
unmask/reboot qualification or QA acceptance is established by this code.
The [policy evidence collection path](runbooks/10-qa-clean-replacement.md#collection-only-policy-evidence-a-and-b)
adds `purpose=policy-collection` for A and a new private B packet generator,
`infra/scripts/r3_policy_packet.py`. It captures bounded policy inputs without
entering maintenance, simulation, installation or holds. Both use the same
all-section validator; partial evidence stays private and never becomes an
executable policy. B requires a separately completed source/target/custody proposal
and fresh approval bound to the exact packet path and host-key fingerprint;
historical B is not rebound. Collection rejects APT line-comment redirection and
unit reload/warning drift, retains partial evidence without aggregate hashes, and
uses source-only controller imports plus replacement-independent Git checks.
Evidence format 2 records `/usr/bin/snap` in its own section: absent, a regular
file, or exactly the known `../lib/snapd/snapd` link, whose fixed target is opened
independently with no-follow and hashed (at most 64 MiB; a regular alias is
streamed under the same cap). A kernel's dpkg trigger-interest file is reviewed
only for a kernel the same inventory records installed. No link is followed
generally; other links, types or drift are refused. The section is collection
evidence only and never enters the aggregate policy hashes. A failure can retain
a fixed syscall stage, numeric errno and bounded cleanup errors inside the
encrypted evidence; format 1 documents and their context stay valid.
Evidence format 3 adds option C's PackageKit sections (the same reads the installer's
facts make) and reports `DISCOVERY_ONLY` - complete, never a policy input - until the
packaged-unit index is reviewed; formats 1 and 2 keep their meaning
(`predicate_contract: legacy`). PR-C1b grows format 3 in place: snapd's D-Bus servicedir,
evidence sections for the open O7/O11/O12 obligations (deb-systemd-helper state,
needrestart, session bus, root's user manager), discovery md5sums for the future
packaged-unit index and a path-free error locus; a PR-C1-shaped document is refused.
Source verification refuses Git filter/include/diff configuration, redirected or
partial-clone worktrees, and nonempty or symlinked Git info attributes before
status/object reads; lazy object fetching is disabled. Index or HEAD gitlinks
are refused before status can enter a child repository.
Collection remains evidence for
semantic review, not native installation qualification or bootstrap approval.

The draft `infra/scripts/r3_access_repair.py` recovery primitive is independently
scoped from collection. Synthetic tests exercise a bounded append to an existing
verified `authorized_keys` inode, preservation of its bytes and permissions, and
private before-state evidence. It refuses an already present key, including a
restricted entry or an equivalent RSA encoding, and never retries or rolls back a
partial append. `r3_access_repair_guest.py` adds local account, IMDS/boot identity,
descriptor-chain and cooperative deadline gates; it has no standalone CLI.
`r3_access_repair_packet.py` renders offline, exact-source drafts. Separate
`r3_access_repair_control.py` phases gate one conditional extension-enable PATCH
and one Managed Run Command PUT; `r3_access_repair_receive.py` gates a separate
strict-pinned private evidence fetch and local age encryption. Every phase needs
published source, an exact owner approval, fresh target/client bindings and an
exclusive attempt marker. Drafts with missing bindings remain unexecutable.
The owner must explicitly accept Microsoft's managed delivery component: its
binary cannot be pinned by our Python source hash. The guest payload preserves
accounts, sudo, SSH configuration and services; delivery-side handler installation,
state and logs are separate effects. No automatic retry, rollback or handler
cleanup occurs. Advisory locking cannot exclude uncooperative writers or parent
renames, and Managed Run Command PUT is not an atomic absent-only create.
A separately reviewed `--recovery-amendment` draft can bind a proven location-only
IMDS mismatch to a new append attempt. It accepts only the two anchored historical
source closures, rechecks both exact terminal predecessor commands, and preserves
strict guest identity equality. The corrected expected IMDS value is `SwedenCentral`;
ARM VM location remains `swedencentral`. Preparation grants no execution authority,
and private evidence fetch still needs a separate exact approval.
See [the recovery contract](runbooks/10-qa-clean-replacement.md#narrow-ssh-access-recovery-draft-separate-from-collection)
for phase budgets, custody and remaining live qualification requirements.
The r02 runtime source contract
rejects both legacy installation shells. Local tools now inspect pinned package
control/scripts and Node bytes, render offline guard files and a full source plan,
and verify an exact OCI transport archive without importing it. The installer
checks exact APT install/configure candidates, rejects unknown action/prose lines,
and uses `--no-remove` for simulation and installation. It retains an observed
package/Node receipt. The format-2 install approval binds the reviewed source,
contract and manifest hashes; the receipt additionally binds complete package
inventories, exact five-pin dpkg actions, APT output hashes and sampled
package-manager isolation. Simulation and installation pin `Dpkg::Use-Pty=0` to
keep dpkg in the observed APT process group. The observer requires systemd's
native empty `Job=` value. Apt timers/services must already be persistently
masked and inactive under a separately approved procedure; the installer does
not change them. Unexpected inventory/action/state changes refuse completion.
These guards have synthetic fixture tests, not target qualification. The pins
ship man-page payloads: a target with interested man-db triggers can be changed
by APT before the strict transaction guard refuses. Target trigger policy and a
real Noble fixture therefore block guest execution. OCI metadata rejects duplicate/case-colliding keys and
ambiguous descriptor/document fields. A separate dispatch-only offline-input analysis workflow retains public
evidence; target dependency closure, real image import, guard installation and
reboot qualification remain open. See [runbook 10](runbooks/10-qa-clean-replacement.md#disposable-qualification-proposal-and-evidence-boundary).
Local preparation authorizes no SSH transfer, bootstrap, network change or R4 activation.

The **hosted (QA and pilot)** LP4-01 [Auth and SMTP handoff](runbooks/03-deploy.md#35-api-smtp-parameters-lp4-01-production-preparation-for-lp2-04)
aligns hosted Auth with the local lifecycle policy (12-character passwords,
one-hour links and access tokens, signup off while email/password sign-in stays enabled). API mail
is an optional complete release configuration with a versioned Key Vault password
and an API-only grant; the SMTP provider is Azure Communication Services Email (decided
2026-10-27, data location Europe). These hosted commands do not configure self-hosted
Auth; the paused self-hosted SMTP/Auth handoff is in [runbook 08](runbooks/08-qa-application.md).
Production requires its own parameters and approval. Runbook 03 historically documents
both LP4-01 migration preconditions and recovery; [runbook 04](runbooks/04-verify.md#46-lp4-01-hosted-auth-and-first-organisation-owner-run)
requires hosted ban/refresh-AMR/collation evidence and first-organisation provisioning.
CI already excludes mailpit and onboarding integration tests use an in-memory mail
transport; delivered email remains an owner-run staging/production check.

**Paused self-hosted QA roots** (kept; resume after the pilot launch). The additive
QA roots in `infra/terraform/foundation/qa` and `infra/terraform/application/qa`
prepare the VNet-bound environment, ACR, Key Vault, Log Analytics, scoped identities,
private r02 DNS and digest/version-pinned API/web applications. The manual
`qa-candidate.yml` pipeline binds source, origins and a public DB CA to its image
candidate, with BuildKit provenance/SBOM. The independent public release/plan and
ARM-projection validators support owner review; they do not authorize execution.
Follow [runbook 08](runbooks/08-qa-application.md#application-preparation-and-owner-execution)
for placeholders, approval units, migration separation, draining and acceptance.
R3/R4, private PostgreSQL TLS, role/bucket checks and live acceptance remain prerequisites.
The [hosted implementation](README.md#hosted-route-for-qa-and-the-pilot-0006) is the
hosted phase's route for QA and the pilot: Sweden Central and `eu-north-1`, dedicated
`tonyai-qatmp-*` groups and `tonyaiqt` prefix, with a separate backend and ACS Email
in Europe. WP-2's exception checks reject the paused self-hosted targets. WP-3's
bucket/smoke/runbook implementation merged as #254; hosted rollout and owner-run
acceptance remain pending.

Hosted migration tooling now uses the separately reviewed Linux schema-engine
transport in [runbook 03 §3.2](runbooks/03-deploy.md#32-deploy-migrations-separately).
It preserves the selected application's source/candidate binding while pinning a
newer helper independently. The old `cloud_ops.py migrate` path is disabled because
Prisma CLI preflights expose the URL in child arguments. Local verification,
read-only hosted connection, migration, owner reconciliation, runtime activation
and runtime privilege verification are separate steps;
only the first is offline. Saved L5 runtime credentials are reused when resuming.

Cloud execution is performed by the project owner and remains required evidence: generated templates do not establish a working staging environment. Never run the local demo seed or demo-account RLS probes against cloud; the demo RLS harness now rejects non-loopback targets. The [LP2-02 release instructions](runbooks/03-deploy.md#34-lp2-02-release-sequence-d22d23) describe the hosted implementation of exact-SHA CI/full-E2E/PostgreSQL-integration gates, environment-bound candidate images, migration/lockfile fingerprints, protected staging OIDC workflows, saved-plan Terraform application and owner-run browser/export/API/PostgREST smoke with two dedicated synthetic tenants. Workflow deployment reads back image/secret identities but stays **smoke pending** until the exact deployed digests pass the owner-run check and exact-ID Auth cleanup. No cloud execution is implied by these tools. A fresh single-job JIT runner with EU static egress, a protected main ruleset and an independent staging reviewer are owner prerequisites; the [LP2-03 operations reference](runbooks/06-operations.md) separates process liveness
(`/api/v1/health`), bounded DB/private-Storage readiness (`/health/ready`) and an
authenticated probe (`/health/synthetic`). The optional owner-managed daily
Storage verification job alerts a named operator on problems or missing results;
application manifests require explicit cleanup-hold/sweep settings, and clearing a
live hold requires an owner acknowledgement after report review. API Sentry drops
HTTP/fetch breadcrumbs, allows only method and queryless URL in event request data,
and disables transaction telemetry regardless of the tracing environment setting. Cloud alert delivery,
rotation and schema-compatible rollback remain unexecuted owner acceptance gates.
CI also replays the migration chain in a disposable shadow database and compares
it with Prisma's schema. A separate read-only catalogue check proves the raw
unique index's full definition (including NULLS NOT DISTINCT and the voided
predicate) in that replayed database; it requires exactly the seven-column key ending in `activity_type` (LP3-03). Only after this succeeds can an empty diff
or the exact known representation DROP pass; the DROP is never applied. CI also
proves the guard rejects missing/weakened indexes using rolled-back mutations.
The schema diff itself covers only Prisma-visible differences;
RLS policies, grants, CHECK constraints and triggers remain guarded by `rls-probe`
and `test:int`.
