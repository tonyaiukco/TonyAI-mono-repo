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

The five documents are the owner's originals (Turkish, untracked). They are not committed without the owner's word.

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
| 7 | `inc26-group-tree` | INC-2.6 §2, §3, §5: recursive tree, node types, controlled/associate, consolidation approach, roll-up, tree integrity, associates closed to data entry | WP6 | all three |
| 8 | `inc26-central-reporter-onboarding` | INC-2.6 §4, §7: owning and reporting entity, central reporter grant, single-entry rule, masterkey wizard | WP7 | all three |
| 9 | `inc28-fuel-bulk` | INC-2.8: three adapters, fuel-name rules, account mapping and unmatched tray, associate exclusion, batches as the review unit, dedupe keys, manual fuel screen (usage mandatory, card-fuel note), invoice no and supplier as bulk columns | parsers: none · integration: WP6–WP8 | all three |
| 10 | `inc29-evidence-assistant` | INC-2.9 §4–§5, INC-2.8 §7: fuel invoice reader by text extraction (no outside AI model), side-by-side panel, three soft states, period-shift and shared-invoice rules, multi-invoice PDF split, emergency off switch | WP9 | all three |
| 11 | ~~`uat4-self-generation-deferred`~~ | **Dropped (owner, 2026-11-24).** Self-generation stays as it is on QA; no work | — | — |

## 4. Schedule

Two lanes. Lane A is one session at a time, in order. Lane B is file-disjoint from Lane A until its integration
step, so it can run in a second session; without one, Lane B starts when Lane A reaches WP8.

| Day | Lane A (bugs, then access) | Lane B (fuel bulk, then assistant) | QA can retest |
|---|---|---|---|
| Tue 11-24 | Plan · WP1 | — | — |
| Wed 11-25 | WP2 · WP3 · WP4 | WP9 parsers and fuel-name rules against the real files | WP1 |
| Thu 11-26 | WP5 · WP6 starts · **forecast to the owner** | WP9 account mapping, unmatched tray | WP2–WP4 |
| Fri 11-27 | WP6 lands · WP7 | WP10 invoice reader against the golden invoice set | WP5 |
| Sat 11-28 | WP8 | WP9 integration: owning entity, batches in the review queue | WP6, WP7 |
| Sun 11-29 | Fixes from QA · whole local e2e suite · handover note | WP10 panel in the review queue | everything merged |
| Mon 11-30 | Acceptance run A1–A15 on hosted QA with the owner | | |

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

**Self-generation stays as it is (owner, 2026-11-24).** INC-2.5 Rev.3 §2 defers it ("not developed in this round"),
but it has been live on QA since #344 and #346 and was tested in UAT round 3. The owner chose to leave it: the section
on Data Entry and the block on the review sheet stay, nothing new is built for it, and WP11, which would have closed
its entry for the 1 December build, is dropped. It never changes a figure (Scope 2 is the grid import × the year's
factor). To check when the acceptance tests arrive (§7): if one of A1–A15 expects self-generation not to be offered,
the owner decides again.

Where the code departs from the documents and is left alone:

- **A missing gas basis answers 400** (`parameters_required`) where INC-2.5 §1.3 says 422. Not changed unless asked.

Technical risks the documents do not address:

- **Record uniqueness.** `activity_records` allows one record per entity, period, category and activity type. INC-2.8's batch (owning entity × invoice, about 900 a year, two half-month invoices per account) cannot be one record each under that key. WP9's design has to settle this first.
- **Scoped `super_admin` and renamed roles.** 15 RLS policies and the API guard treat `super_admin` as organisation-wide; INC-2.6 scopes it to assigned companies. The rename is not an expand-only migration: the old API image fails between the migration and the deploy, and the append-only audit log keeps the old names in its history.
- **Approval load.** Every `super_admin` entry waits for the one masterkey (INC-2.6 §1.1 notes this); today a second `super_admin` approves.

## 7. Inputs still missing

Needed by Wed 11-25 for Lane B, kept **outside the repository** (they carry real company data); the repository
gets synthetic fixtures in the same shapes.

- The handoff index (§4, acceptance tests A1–A15) and the Go-Live Readiness Review Rev.3.
- Real files: the 8 Shell exports, the Petrol Ofisi `SatisListesi`, the tanker file.
- The golden invoice set: 4 OZK and 23 Duman invoices (PDF), and one shared invoice (e.g. `OZK2025000011923`).

## 8. Working rules for this sprint

- OpenSpec for every package: `/opsx:propose`, then `/opsx:apply`, ticking `tasks.md` as work lands; archive in the package's own PR once its tasks are done (the owner asked for this on WP1, 2026-11-24).
- Verification by risk: WP1 gets typecheck, unit tests and its e2e specs; every other package adds `test:int`,
  the live API and the review pass. The whole e2e suite runs locally on built servers before the handover.
- Build on what exists: recall, `ImportBatch`, the inventory boundary, the equipment lines and `cvBasis` are
  already in the code; nothing is rebuilt.
- Migrations expand only this week (QA auto-deploys do not roll back). The one exception is WP6's role rename, which gets its own deploy note.
- A review finding that is not a correctness, security or data-integrity defect is filed, not fixed.

## 9. Ledger

| WP | State | Branch / PR | QA revision | Notes |
|---|---|---|---|---|
| 1 `uat4-quick-fixes` | merged 11-24 (`ce3b1911`) | `fix/uat4-quick-fixes`, [#355](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/355) | `ci90-1` | `openspec/changes/archive/2026-11-24-uat4-quick-fixes/`. Invoice number and supplier become bulk columns in WP9. QA retests BUG-09, 10, 11, 15 (screen part), 16 after the deploy |
| 2 `uat4-refill-rule` | merged 11-24 (Codex; #356 `251ddfd3`, #358 `e14ccb27`), archived | `fix/uat4-refill-rule-contract`, [#356](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/356); `fix/uat4-refill-rule`, [#358](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/358) | `ci91-1` (#356), `ci93-1` (#358) | `openspec/changes/archive/2026-11-24-uat4-refill-rule/`. The hosted `draft-reprice` run (dry run, then `--apply --allow-remote`) needs the owner's release. QA retests BUG-17 with 126.00 t and GV-8 |
| 3 `uat4-fire-suppression-entry` | PR open 11-25 (Claude Code) | `feat/uat4-fire-suppression-entry`, [PR #360](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/360) | — (after merge) | owner's rulings: Decisions 2026-11-24 (fifth) (supplementary edition, the dry powder or foam zero, CO2 at the device rates); four review seats, no blocking finding; after the deploy an owner release loads `tr-fire-2026-11/ipcc-fire.json` (dry run, then `--apply`); QA retests BUG-12 and decides Fire Suppression in a new boundary version. WP2's hosted `draft-reprice` dry run (every count zero, no apply) and BUG-17's retest on `ci93-1` passed |
| 4 `uat4-idle-session` | not started | — | — | hosted setting needs an owner release |
| 5 `uat4-review-resubmit` | not started | — | — | |
| 6 `inc26-roles-approval-chain` | not started | — | — | updates `CLAUDE.md`'s canonical roles and the seed users |
| 7 `inc26-group-tree` | not started | — | — | |
| 8 `inc26-central-reporter-onboarding` | not started | — | — | |
| 9 `inc28-fuel-bulk` | not started | — | — | waits for the inputs in §7 |
| 10 `inc29-evidence-assistant` | not started | — | — | waits for the invoice PDFs (§7) |
| 11 ~~`uat4-self-generation-deferred`~~ | dropped 11-24 (owner) | — | — | self-generation stays live as it is |
