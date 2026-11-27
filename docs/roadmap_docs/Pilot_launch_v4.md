# Pilot launch v4 — UAT round 4 delivery plan

**Written:** 2026-11-24 (Claude Code) · **QA handover:** 2026-11-29 · **Acceptance run:** 2026-11-30 · **Go-live (per the UAT v4 pack):** 2026-12-01

This file is the working plan for one sprint: the UAT round 4 bug list and the four increment specs under
[`docs/uat/v4/`](../uat/v4/). It exists on the owner's instruction (2026-11-24). Status, decisions and history
still live in [`project_status_roadmap_phases.md`](project_status_roadmap_phases.md); each package's PR records
itself there, and this file only tracks the sprint's ledger below. When the sprint closes, its outcome is folded
into the planning file and this file stops being updated.

## 1. Sources

| Document | What it asks for |
|---|---|
| `TonyAI_BUG_Report_v4.md` (Rev.3) | BUG-09 … BUG-17; BUG-05 (geolocation) stays deferred |
| `tonyai_increment_v2.5_…` (Rev.3) | Natural gas in kWh (BUG-11); self-generation is deferred, so nothing is built for it; what is already live stays (§6) |
| `tonyai_INC-2.6_…` (Rev.3) | Roles, approval chain, recall and resubmit, recursive group tree, consolidation, owning entity and central reporter, onboarding |
| `tonyai_INC-2.8_…` (Rev.3) | Fuel bulk ingestion: Shell, Petrol Ofisi and tanker adapters, account mapping, batch review |
| `tonyai_INC-2.9_…` (Rev.3) | Bulk framework, evidence reading rules, review-queue evidence assistant (fuel only at go-live) |

The five documents are the owner's originals (Turkish), tracked in the repository since `204618d4`.

## 2. Where the code stands (measured 2026-11-24, `main` at `3ff43127`)

| Item | Today | Gap | Size |
|---|---|---|---|
| BUG-09 password toggle | Done (`components/auth/password-input.tsx`) | Retest only | — |
| BUG-10 title and favicon | Title and icons done | No `favicon.ico`, so `/favicon.ico` answers 404 | XS |
| BUG-11 gas in kWh | Engine and form done (#340, #342); gross priced by the release's 8250/9155 | Gross is not preselected; option wording | S |
| BUG-12 fire suppression | Entered as refrigerant equipment lines, kg only; no CO2 gas | Device × gas entry, CO2 (GWP 1) factor row, "no greenhouse gas" option, g/kg selector | M–L |
| BUG-13 session | Login and register are separate routes; no idle timeout anywhere | 1-hour idle sign-out, client and server | S–M |
| BUG-14 super_admin company | `super_admin` is organisation-wide; only `data_entry` holds grants | Solved by INC-2.6 roles | (WP6) |
| BUG-15 edit visibility, resubmit | Recall exists (`submitted → draft`); records list sits below the form | Top anchor to the list; "Revised" badge; field-level audit diff | M |
| BUG-16 invoice no, supplier | Not present | Two optional fields (form, review sheet, bulk columns) | S |
| BUG-17 refill rule | `capacity × rate + refill` (`calculations/tr-rules.ts`) | "Refill if known, else estimate"; new vector 126.00 t; open drafts re-priced | M |
| INC-2.6 roles | Four roles, 572 role-name hits in the API alone, 11 migrations with role-keyed RLS | `masterkey`, company-scoped `super_admin`, category-scoped standard user, auditor, approval routing | XL |
| INC-2.6 group tree | Organisation → Subsidiary → Location, flat | Recursive tree, controlled/associate, roll-up, integrity rules | L |
| INC-2.6 owning entity, wizard | Not present; onboarding is a CLI plus `/register` | Owning and reporting entity, central reporter grant, masterkey wizard | L |
| INC-2.8 fuel bulk | Generic CSV/XLSX import, 1,000 rows, per-record review, `ImportBatch` exists | Three adapters, fuel-name rules, account mapping, unmatched tray, batch as the review unit, 51,300-row scale | XL |
| INC-2.9 evidence assistant | Evidence stored and linked; no text extraction, no AI, no feature flags | Invoice reader, side-by-side panel, three soft states, emergency off switch | XL |

No new factor value is needed except **CO2 as a fire-suppression gas (GWP 1)**, which needs its own edition.
All golden vectors in the v4 checklist exist in the tests except the BUG-17 refill vector.

## 3. Work packages

One package = one OpenSpec change = one branch = one PR. The owner merges; every image-affecting merge
deploys to hosted QA by itself, so QA receives the sprint as a rolling handover, not one drop on the last day.

| WP | OpenSpec change | Covers | Depends on | Review pass |
|---|---|---|---|---|
| 1 | `uat4-quick-fixes` | BUG-10 favicon, BUG-11 gross preselected + wording, BUG-16 invoice no and supplier (form and review sheet), BUG-15 anchor to the entries list, BUG-09 retest | — | `qa-auditor` on the basis default |
| 2 | `uat4-refill-rule` | BUG-17 in the engine, the preview, the refill ceiling, the docs; draft re-pricing; vector 126.00 t | — | `security-rls` + `qa-auditor` |
| 3 | `uat4-fire-suppression-entry` | BUG-12: fire suppression as its own Scope 1 entry, device and gas dropdowns (gases the library prices, plus CO2 from a new edition), "dry powder / foam — no greenhouse gas", g/kg selector defaulting to grams | WP2 | `security-rls` + `qa-auditor` + `architect` |
| 4 | `uat4-idle-session` | BUG-13: 1-hour idle sign-out in the web, the hosted Auth inactivity setting and its policy digest, no silent resume | — | `security-rls` + `qa-auditor` |
| 5 | `uat4-review-resubmit` | BUG-15 workflow, INC-2.6 §1.2: `under_review` closes recall, atomic recall-vs-approve, "Revised" badge, audit trail with field-level before → after | — | `security-rls` + `qa-auditor` |
| 6 | `inc26-roles-approval-chain` | INC-2.6 §1, §6: stored roles renamed to the document's (`masterkey`, `super_admin`, `standard_user`, `auditor`), existing consultants become auditors, `super_admin` scoped to several companies (BUG-14), category-scoped standard user, approval routing with fallback, `self_approve` audit | WP5 | all three |
| 7 | `inc26-group-tree` | INC-2.6 §2, §3, §5: recursive tree, node types, controlled/associate, consolidation approach, roll-up, tree integrity, associates closed to data entry; from WP6 (R6): a `super_admin` creating child companies under their own, and a `super_admin` writing their own company's inventory boundary on the node (the masterkey writes it until then) | WP6 | all three |
| 8 | `inc26-central-reporter-onboarding` | INC-2.6 §4, §7: owning and reporting entity, central reporter grant, single-entry rule, masterkey wizard; from WP6 (R6): converting carried-over standard users with several companies into a main entity plus a central reporter grant | WP7 | all three |
| 9 | `inc28-fuel-bulk` | INC-2.8: three adapters, fuel-name rules, account mapping and unmatched tray, associate exclusion, batches as the review unit, dedupe keys, manual fuel screen (usage mandatory, card-fuel note), invoice no and supplier as bulk columns | parsers: none · integration: WP6–WP8 | all three |
| 10 | `inc29-evidence-assistant` | INC-2.9 §4–§5, INC-2.8 §7: fuel invoice reader by text extraction (no outside AI model), side-by-side panel, three soft states, period-shift and shared-invoice rules, multi-invoice PDF split, emergency off switch | WP9 | all three |
| 11 | ~~`uat4-self-generation-deferred`~~ | **Dropped (owner, 2026-11-24).** Self-generation stays as it is on QA; no work | — | — |

## 4. Schedule

Two lanes. Lane A is one session at a time, in order. Lane B is file-disjoint from Lane A until its integration
step, so it can run in a second session; without one, Lane B starts when Lane A reaches WP8.

| Day | Lane A (bugs, then access) | Lane B (fuel bulk, then assistant) | QA can retest |
|---|---|---|---|
| Tue 11-24 | Plan · WP1 | — | — |
| Wed 11-25 | WP2 · WP3 · WP4 | WP9 parsers and fuel-name rules (on synthetic fixtures; the real files are QA's, §7) | WP1 |
| Thu 11-26 | WP5 · WP6 starts · **forecast to the owner** | WP9 account mapping, unmatched tray | WP2–WP4 |
| Fri 11-27 | WP6 lands · WP7 | WP10 invoice reader against the golden invoice set | WP5 |
| Sat 11-28 | WP8 | WP9 integration: owning entity, batches in the review queue | WP6, WP7 |
| Sun 11-29 | Fixes from QA · whole local e2e suite · handover note | WP10 panel in the review queue | everything merged |
| Mon 11-30 | QA's full acceptance test on hosted QA (A1–A15, the real files), approved by QA | | |

## 5. Feasibility and the cut line

The bug list (WP1–WP5) fits the five days with room to spare. The three increments do not fit comfortably:
WP6–WP10 are each larger than any change shipped in UAT rounds 2 and 3, and every one of them touches a path
(auth, tenant scope, record lifecycle, calculation) that requires the fresh-eyes review pass before its PR.

| Confidence by 11-29 | Packages |
|---|---|
| High | WP1–WP5 |
| Medium | WP6, WP7, WP9 parsers and account mapping |
| Low | WP8 wizard, WP9 batch review at full scale, WP10 |

**The owner's rule (2026-11-24):** a slip of one or two days moves the date; a larger one narrows the scope, and
only with the owner's approval. On Thu 11-26, after WP5, the owner gets a forecast per package. If scope has to be
narrowed, the order proposed is, last first:

1. **WP10 ships switched off** (INC-2.9 §5: approval never waits for the assistant; the reviewer checks by eye).
2. **The masterkey wizard (WP8) is replaced by the existing screens**, used in the wizard's order.
3. **The central reporter grant (WP8) is deferred**: the masterkey uploads the fuel files.

Each of the three departs from the documents ("every open item ships on 1 December"), so none is taken silently.

What is never cut to save the date: tenant isolation, the approval chain's correctness, append-only audit,
factor immutability, and the review pass on a risky PR.

## 6. Decisions (owner, 2026-11-24)

The owner's direction: proceed as the documents say.

| # | Question | Decision |
|---|---|---|
| 1 | Where does the 1 December build run? | **Hosted QA** (`qa.tonyai.io`). The production environment, the pen-test and G5 stay as planned |
| 2 | Role identifiers | **As the document:** the stored roles become `masterkey`, `super_admin`, `standard_user`, `auditor` (INC-2.6 §1) |
| 3 | Existing `consultant` users | **Become auditors**; `consultant` is retired |
| 4 | Masterkey self-approval | **As the document** (INC-2.6 §1.1): allowed, logged as `self_approve`, visible to the auditor |
| 5 | How the assistant reads an invoice | **Text extraction** for the two known fuel layouts, under INC-2.9's rules; no outside AI model. Anything else shows ⚪ |
| 6 | Fire-suppression gases | **Only gases the library prices**; CO2 (GWP 1, IPCC AR6) comes as a new edition for the owner to sign. An unpriced gas is refused, never estimated |
| 7 | Idle timeout | **As the document** (BUG-13): one hour idle, then sign-in again; the hosted Auth setting needs an owner release |
| 8 | Refill rule and approved records | **As the document** (BUG-17) for new figures; approved and locked records **stay as they are**; open drafts are re-priced |
| 9 | If time runs short | A slip of one or two days moves the date; beyond that the scope narrows with the owner's approval (§5) |

Following the documents also settles one point the plan had left open: fire suppression is **its own Scope 1 entry**
(BUG-12).

**WP6's six rulings (owner, 2026-11-25; planning file, Decisions 2026-11-25 (sixth)).** The owner had the five v4
documents read again and approved these answers, each taken from their text:

| # | Ruling | Where the documents say it |
|---|---|---|
| R1 | Every existing `super_admin` becomes a `masterkey`. Nobody is made a masterkey in the product. A masterkey's record is decided by that masterkey alone, as a `self_approve` | INC-2.6 §6 (no row for assigning a masterkey), §1.1 ("kendisi onaylar"), §6 ("super_admin girişleri + kendi + yedek"); INC-2.8 §9. The carry-over is Claude Code's reading, approved by the owner |
| R2 | `executive_viewer` accounts become `auditor` with the consultants; an auditor only reads | INC-2.6 §1 ("`executive_viewer` → `auditor`", "Read-only… düzenleme yok"); the consultants follow decision 3 above |
| R3 | The matrix is literal: a masterkey does not assign standard users, and decides a standard user's record only when the company has no super_admin. A disabled super_admin, or one who has not accepted the invitation, counts as none | INC-2.6 §1, §6, §7.1–7.2; §1.1 and INC-2.8 §6 ("yoksa → masterkey"). The reading of "none" is Claude Code's, approved by the owner |
| R4 | Powers no document lists stay with the masterkey (period lock, void, a colleague's draft, targets, intensity, report capture and issue, role changes, disabling accounts); a `super_admin` reads the trail of every record in their companies; the organisation audit page is read by the masterkey and the auditor | INC-2.6 §1 (a closed list for `super_admin`; "godmode" for the masterkey), §6 ("Hesap izi / audit oku") |
| R5 | A standard user's categories bound what they enter and what they see | INC-2.6 §1 ("Tek ana entity, tikli kategori sınırı"), §7.3 ("yalnız atanmış entity + kategoriler") |
| R6 | One company per standard user for every new or changed assignment; carried-over accounts with several keep them until WP8 converts them. Child companies wait for the tree (WP7). A `super_admin`'s own-company boundary lands in WP7 with the node's boundary field | INC-2.6 §1, §4.1, §2, §6 |

**Self-generation stays as it is (owner, 2026-11-24).** INC-2.5 Rev.3 §2 defers it ("not developed in this round"),
but it has been live on QA since #344 and #346 and was tested in UAT round 3. The owner chose to leave it: the section
on Data Entry and the block on the review sheet stay, nothing new is built for it, and WP11, which would have closed
its entry for the 1 December build, is dropped. It never changes a figure (Scope 2 is the grid import × the year's
factor). When QA runs the acceptance tests (§7): if one of A1–A15 expects self-generation not to be offered, the owner
decides again.

Where the code departs from the documents and is left alone:

- **A missing gas basis answers 400** (`parameters_required`) where INC-2.5 §1.3 says 422. Not changed unless asked.
- **The reviewer's action keeps its stored names** (owner, 2026-11-25; INC-2.6 §1.2): the screens and sentences say
  "İade et" / "Return" and "İade edildi" / "Returned", while the status stays `rejected`, the route
  `POST /activity-records/:id/reject`, the audit action `reject` and the error codes keep their names (WP5).

Technical risks the documents do not address:

- **Record uniqueness.** `activity_records` allows one record per entity, period, category and activity type. INC-2.8's batch (owning entity × invoice, about 900 a year, two half-month invoices per account) cannot be one record each under that key. WP9's design has to settle this first.
- **Scoped `super_admin` and renamed roles.** 15 RLS policies and the API guard treat `super_admin` as organisation-wide; INC-2.6 scopes it to assigned companies. The rename is not an expand-only migration: the old API image fails between the migration and the deploy, and the append-only audit log keeps the old names in its history.
- **Approval load.** Every `super_admin` entry waits for the one masterkey (INC-2.6 §1.1 notes this); today a second `super_admin` approves.

## 7. Inputs and acceptance

**WP9 (owner, 2026-11-27): the real fuel files, the handoff index §4 (A1–A15) and the Go-Live Readiness
Review Rev.3 are not inputs to the build.** WP9 is built and tested on synthetic fixtures in the documented
shapes (`apps/api/test/fixtures/fuel/`). After the deploy, **QA tests it in full on hosted QA** — A1–A15 with
the real files (the 8 Shell exports, the Petrol Ofisi `SatisListesi`, the tanker file) — and approves it. A
difference QA finds (a header row, a sheet name, a cell type, a figure) comes back as a fix.

**WP10 (owner, 2026-11-27; K1 = B, Decisions 2026-11-28): the golden invoice set, the Readiness Review's values
and the handoff index §4 are not inputs to the build.** WP10 is built and tested on synthetic invoice fixtures in
the documented layouts (`apps/api/test/fixtures/invoices/`, PR B). After the deploy, **QA runs the reader's gate
and its acceptance tests on hosted QA** with the real invoices (4 OZK and 23 Duman invoices, and one shared
invoice such as `OZK2025000011923`, kept **outside the repository** because they carry real company data) — this
moves INC-2.8 §7's "before every release" gate to QA. A difference QA finds comes back as a fix.

## 8. Working rules for this sprint

- OpenSpec for every package: `/opsx:propose`, then `/opsx:apply`, ticking `tasks.md` as work lands; archive once its tasks are done (the owner asked for this on WP1, 2026-11-24). The OpenSpec tree and its archive stay local and are never committed (owner, 2026-11-25); the planning file and the PR description carry what a reader of the repository needs.
- Verification by risk: WP1 gets typecheck, unit tests and its e2e specs; every other package adds `test:int`,
  the live API and the review pass. The whole e2e suite runs locally on built servers before the handover.
- Build on what exists: recall, `ImportBatch`, the inventory boundary, the equipment lines and `cvBasis` are
  already in the code; nothing is rebuilt.
- Migrations expand only this week (QA auto-deploys do not roll back). The one exception is WP6's role rename, which gets its own deploy note.
- A review finding that is not a correctness, security or data-integrity defect is filed, not fixed.

## 9. Ledger

| WP | State | Branch / PR | QA revision | Notes |
|---|---|---|---|---|
| 1 `uat4-quick-fixes` | merged 11-24 (`ce3b1911`) | `fix/uat4-quick-fixes`, [#355](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/355) | `ci90-1` | `uat4-quick-fixes` (archived 2026-11-24). Invoice number and supplier become bulk columns in WP9. QA retests BUG-09, 10, 11, 15 (screen part), 16 after the deploy |
| 2 `uat4-refill-rule` | merged 11-24 (Codex; #356 `251ddfd3`, #358 `e14ccb27`), archived | `fix/uat4-refill-rule-contract`, [#356](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/356); `fix/uat4-refill-rule`, [#358](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/358) | `ci91-1` (#356), `ci93-1` (#358) | `uat4-refill-rule` (archived 2026-11-24). The hosted `draft-reprice` run (dry run, then `--apply --allow-remote`) needs the owner's release. QA retests BUG-17 with 126.00 t and GV-8 |
| 3 `uat4-fire-suppression-entry` | merged 11-24 (`da5b8924`; Claude Code), archived locally | `feat/uat4-fire-suppression-entry`, [PR #360](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/360) | `ci95-1` | owner's rulings: Decisions 2026-11-24 (fifth) (supplementary edition, the dry powder or foam zero, CO2 at the device rates); four review seats, no blocking finding; the owner loaded `tr-fire-2026-11/ipcc-fire.json` on hosted QA (2026-11-24 23:37 UTC, dry run then `--apply`) and ran the boundary step (2026-11-25); QA retests BUG-12 and decides Fire Suppression in a new boundary version. WP2's hosted `draft-reprice` dry run (every count zero, no apply) and BUG-17's retest on `ci93-1` passed |
| 4 `uat4-idle-session` | merged 11-25 (Codex; `452a7aaf`) | `fix/uat4-idle-session`, [#362](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/362) | `ci98-1` | two review rounds (`security-rls`, `qa-auditor`); round 1's blocker fixed with a 2 h server backstop (Decisions 2026-11-25 (third)); the owner's Auth release set `QA_AUTH_POLICY_DIGEST` (`authpolicy-v1:961dc410…3229`) and the manual QA deploy passed its gate; ten notes under Open questions; QA retests BUG-13 |
| 5 `uat4-review-resubmit` | merged 11-25 (`5072cfa0`; Claude Code), archived locally | `feat/uat4-review-resubmit`, [#363](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/363) | `ci99-1` | owner's rulings: Decisions 2026-11-25 (fifth); one expand-only migration (`submission_count`, backfilled); three review seats; the PR also records WP3's hosted load and WP4 (Decisions 2026-11-25 (fourth)); after the deploy QA retests BUG-15's workflow (open closes recall, "Revised", the history, the return wording) |
| 6 `inc26-roles-approval-chain` | merged 11-25 (`b7edcb96`; Claude Code), archived locally | `feat/inc26-roles-approval-chain`, [#364](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/364) | `ci100-2` | owner's rulings R1–R6 (§6, Decisions 2026-11-25 (sixth)) and the evidence ruling (seventh); one migration, not expand-only (deploy note in the PR); three review seats; e2e 311/311; `CLAUDE.md`'s canonical roles and seed users updated; hosted QA per-role counts read 11-26 (34 masterkey, 8 auditor, 10 standard user, 0 super_admin = 52) |
| 7 `inc26-group-tree` | merged 11-26 (Claude Code), after seven owner reviews | [#365](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/365) (`02e6a246`) | QA `ci101-1` (run 45818614665) | the owner's direction and readings RD1–RD14 (Decisions 2026-11-25 (eighth)); one expand-only migration with the carry-over and triggers TA018–TA023; a `super_admin`'s child companies and own-company declarations (R6); hosted readback 11-26: one root per organisation (20), 52 nodes and carry-over rows, 0 records on closed nodes; reference total 2026 Scope 1+2: 17 records, 371.540681472944 tCO2e |
| 8 `inc26-central-reporter-onboarding` | merged 11-26 (`1d58203a`; Claude Code), archived locally | `feat/inc26-central-reporter-onboarding`, [#366](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/366) | `ci102-1` | the owner's direction (the documents decide) and C1–C11 approved as written, no cut (Decisions 2026-11-26); two expand-only migrations, triggers TA024–TA027, the central reporter grant, single entry in both halves, the eight-step wizard; hosted readback part 1 11-26 (21 organisations, 25 access rows all assigned, 0 stored reporting entities, 2026 reference total unchanged: 17 records, 371.540681472944 tCO2e); **part 2 owed**: which of the 3 R6 accounts are converted, by the owner's decision |
| 9 `inc28-fuel-bulk` | merged 11-27 (Claude Code): PR A (`0e0d3d91`); PR B, groups 4–10 (`e10684e8`, after six owner reviews; 44,902 rows measured) | `feat/inc28-fuel-bulk-contract`, [#367](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/367) (PR A); `feat/inc28-fuel-bulk`, [#368](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/368) (PR B) | `ci103-1` (PR A) · `ci104-1` (PR B) | C1–C20 approved as written, two PRs (Decisions 2026-11-27); PR A: three tables, the slot key widened by the batch, TA028, TA029, RLS by D14's matrix, the shared contract, synthetic fixtures; three review seats (one P1 fixed) and two owner reviews (ten findings fixed); e2e 324/324. The real files and A1–A15 are QA's full acceptance test after the deploy, not build inputs (owner, 11-27; §7) |
| 10 `inc29-evidence-assistant` | in progress (Claude Code): PR A, the contract and the expand-only migration, in review | `feat/inc29-evidence-assistant-contract` (PR A) | — | K1 = B and C1–C11 approved as written, two PRs (Decisions 2026-11-28); the real invoices are QA's acceptance test, not build inputs (§7) |
| 11 ~~`uat4-self-generation-deferred`~~ | dropped 11-24 (owner) | — | — | self-generation stays live as it is |
