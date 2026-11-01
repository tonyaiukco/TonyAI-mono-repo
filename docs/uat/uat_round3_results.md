# TonyAI — UAT Round 3: Pre-pass Results

> **What this is:** an agent-run pass over [`uat_round3.md`](uat_round3.md), driven through the real UI and API. It finds defects before people spend time on them.
> **What this is not:** the catalogue's sign-off. §10 (judgement) and §11 (named testers, verdicts) still belong to people, and nothing here accepts a case marked **Waits on LP4-02 PR C**.

**Build SHA tested:** `a9476eb` (`main`, 2026-11-01), also the source of the hosted application candidate. Fixes made after this run are named in the findings.
**Date:** 2026-11-01 · **Run by:** Claude Code, for the owner · **Data:** synthetic only.

## Environment and how it differs from the catalogue

- Local Supabase after `pnpm db:reset`; production builds on Node 22.23.3 (`node dist/main.js`, `next start`), not `pnpm dev`, because of the 16 GB machine.
- Headless Chromium via Playwright, plus direct API calls and mailpit. Screens were read as text; only some were looked at (screenshots, the issued PDFs).
- **Raised for this run only:** `RATE_IP_PER_MINUTE`, `RATE_READ_PER_MINUTE`, `RATE_WRITE_PER_MINUTE` = 10000, as `e2e.yml` does: one IP drove every account. Export, import and submit limits kept their defaults. `STORAGE_SWEEP_INTERVAL_SECONDS=0`.
- The §7 tables have EN and TR columns only: EN ran in Tenant A and TR in Tenant B, unless a row says otherwise. Boundary and report cases reached a **counted** dataset in Tenant B only.

## Result

**358 cells passed · 1 failed · 8 waiting on LP4-02 PR C (not accepted) · 2 not run · 1 owner decision.** No cross-tenant leak, no role escalation, and no quantity changed by a language switch.

| Section | Passed | Failed | Waits | Not run | Owner |
| --- | --- | --- | --- | --- | --- |
| §2.2 Baseline | 9 | 0 | 0 | 0 | 0 |
| §3 Round-1 close-out | 49 | 0 | 5 | 0 | 1 |
| §4 Tenant B | 9 | 0 | 0 | 1 | 0 |
| §5.1 super_admin | 50 | 0 | 0 | 0 | 0 |
| §5.2 data_entry | 48 | 0 | 0 | 0 | 0 |
| §5.3 consultant | 28 | 0 | 0 | 0 | 0 |
| §5.4 executive_viewer | 30 | 0 | 0 | 0 | 0 |
| §5.5 Isolation | 23 | 0 | 0 | 0 | 0 |
| §6 Emails | 18 | 0 | 0 | 0 | 0 |
| §7.1 Bulk upload | 16 | 0 | 2 | 0 | 0 |
| §7.2 Shared evidence | 17 | 0 | 0 | 0 | 0 |
| §7.3 Turkish numbers | 9 | 0 | 0 | 0 | 0 |
| §7.4 Boundary | 19 | 0 | 0 | 0 | 0 |
| §7.5 Issued reports | 27 | 0 | 1 | 0 | 0 |
| §7.6 Refusal wording | 4 | 0 | 0 | 1 | 0 |
| Extra checks | 2 | 1 | 0 | 0 | 0 |

## Findings

Severity follows the catalogue's §11. Under the working rule, S2 and security items are fixed; S3 items go to Open questions unless the owner says otherwise.

| ID | Severity | Finding | Evidence | Recommended |
| --- | --- | --- | --- | --- |
| F-A | **S2, security** | The login page ships the seed admin's credentials in every build, production included: the form is prefilled with `admin@tonyai.local` / `TonyAI!2026` and a hint prints them. No environment condition. The hosted candidate has the same page. Hosted environments are not seeded, so the password opens nothing there today; any environment ever seeded would publish a working admin login, and a pilot customer would read this text. | `apps/web/app/login/page.tsx:36`, `:37`, `:116` at `a9476eb` | **Fixed in [#259](https://github.com/tonyaiukco/TonyAI-mono-repo/pull/259)**, merged as `6c377d1`. Removed outright, since a hidden hint would still ship in the bundle. The hosted candidate keeps the old page until a new one is built |
| F-B | S3 | An invitation counts as accepted at **Continue**, before a password exists. Someone who leaves at that step holds a dead link that says to ask for a new invitation, while a re-send answers `invitation_closed` and the operator command reports `accepted`, `resent: false`. **Forgot your password?** does recover them, as seen in this run and since pinned in `onboarding.int.spec.ts`. | `apps/web/app/auth/confirm/confirm-email-link.tsx:56` at `a9476eb` | **Reworded on `main` after this run:** the dead-link page now offers the reset. The acceptance moment is unchanged and stays filed. With a session still in that browser, **Request a new link** lands on the dashboard, signed in and without a password. The hosted candidate keeps the old page until a new one is built |
| F-C | S3 | `@vercel/analytics` renders on a non-Vercel host. A signed-out load gets `/_vercel/insights/script.js` redirected to `/login`, and the HTML is parsed as script, raising an uncaught `Unexpected token '<'`: exactly once in each of the 174 sessions that logged it. A signed-in hard load gets a 404 and no error. | `apps/web/app/layout.tsx:63` at `a9476eb` | **Removed on `main` after this run.** The hosted candidate keeps it until a new one is built |
| F-D | S3 | The natural issuance flow hits the export limit: capture, check, issue, then PDF 200, Excel 429, CSV 429 for one user. Retained files count against the same 5 per minute as generation. It recovers after a minute, and the toast says so beside a lingering *download started*. | Run `X-EXPORT-LIMIT` | File under LP5-03: should a retained download count? |
| F-E | S3 | A user-facing refusal carries roadmap wording: the Sm³ refusal ends *bu prototipte henüz yok — Faz 4 faktör kütüphanesiyle gelecek*. | ERR-05 | Reword with LP4-02 PR C |

### What the failure-hunting did not find

The hardest cases all held: foreign and random ids answer byte-identical 404s across six resources, in both directions for issuances; a viewer's and a data_entry's writes are refused with the catalogue's codes; `1.234,5` stores as `1234.5` and survives a language switch and reload; unreadable context text refuses the save; a retained PDF stays byte-identical after the live figures change; and a complete locked year issues as **Partial** with the non-authoritative gap (12 records, 12,660 kWh × 0.44 placeholder = 5.5704 tCO₂e, the same in CSV, workbook and PDF). The English PDF names the release *NOT authoritative*, standing *Placeholder*.

## Catalogue drift

None of these is a product defect. The catalogue's sentences are corrected in the same change as this file.

| ID | Case | Catalogue said | The build does |
| --- | --- | --- | --- |
| D-1 | DE-9 (EN) | *No emission factor covers this category… yet.* | Shows the server's sentence naming category, geography and year. TR matches |
| D-2 | DE-4 | With no gas chosen, a refusal sentence | **Save draft** is disabled first; the sentence never shows. The API still refuses `activity_type_required` |
| D-3 | ENT-10 | `{"legalName":"x"}` answers 403 | One letter fails validation first (400). A valid body answers 403 `forbidden` |
| D-4 | CON-01 | The target note beside an absent **Add target** | It is an empty-state line; Tenant A's seeded targets hide it |
| D-5 | CON-04 | The vault reads *Rolünüz kanıt ekleyemez.* | The vault just has no upload or remove control. The sentence belongs to the attach-several flow |
| D-6 | ISO-07 | Foreign row: *Bilinmeyen raporlama birimi*, per row | The whole file is refused (`bad_request`) with an English server sentence under a Turkish title. Isolation holds; nothing is imported |
| D-7 | BLK-04 | **Send N drafts** after an import | An evidence-required category first says a file is needed. Correct, but the catalogue's own example category is one |
| D-8 | EVI-03 | Vault: *1. çeyrek 2026 kilitli.* | Reads *Bu kayıt kilitli durumda ve artık düzenlenemez*. Read only, as intended |
| D-9 | §7.5, ISS-04 | *Every* dataset carries the non-authoritative gap | Only datasets with **counted** records do (`issuance-gate.ts:245`). Uncounted records give coverage gaps and no tonnage at all, which is the honest outcome |

Also corrected: TB-05's *to confirm* held (the operator's rows appear in Tenant B's trail, actor *system*). ENT-09's grants note needs a version the user can read, so it appears only after §7.4; the case and §8's order now say so.

## Not covered

- **§4.4** (re-provisioning after a reset): a second reset would wipe Tenant B, kept for the owner's review.
- **ERR-04** on screen: no screen offers a role-only action to the wrong role. The API answers 403 `forbidden`.
- **DE-2** checked the cell colours and the renamed figure only, not round 2's GATE-01→04 sequence. The nightly `e2e.yml` was green on this SHA.
- **Hosted behaviour:** Azure Communication Services delivery, hosted Auth and Storage belong to live operations L9 and L10.
- **Judgement:** the Turkish domain terms, layout and whether an expert would accept the reports.

## Left for the owner

The five §10 questions and the §11 table. From this run, for §10.2 and §10.5: English server sentences under Turkish titles appear in ADM-04 and ISO-07; raw role codes appear on the review gate card (`data_entry`, `executive_viewer`). §3's SUB-3 still asks whether the missing Google Places autofill blocks the pilot.

## Per-case results

Cells passed out of cells run. `W` waits on LP4-02 PR C.

| Case | Passed | Note |
| --- | --- | --- |
| BASE-3/24 | 1/1 |  |
| BASE-banner/emissions | 2/2 |  |
| BASE-banner/reports | 2/2 |  |
| BASE-dash | 4/4 |  |
| DASH-1 | 1/1 |  |
| DASH-2 | 2/2 |  |
| DASH-3 | 2/2 |  |
| DE-1 | 2/2 |  |
| DE-2 | 2/2 |  |
| DE-3 | 4/4 |  |
| DE-3 calculation | 0/1 | W: not accepted |
| DE-4 | 4/4 | Drift D-2 |
| DE-4 factor | 0/1 | W: not accepted |
| DE-5 | 4/4 |  |
| DE-5 factor | 0/1 | W: not accepted |
| DE-6 | 4/4 |  |
| DE-6 TR factor value | 0/1 | W: not accepted |
| DE-7 | 3/3 |  |
| DE-8 | 6/6 |  |
| DE-9 | 8/8 | Drift D-1 |
| DE-9 other factor years | 0/1 | W: not accepted |
| EM-1 | 2/2 |  |
| SUB-1 | 2/2 |  |
| SUB-2 | 1/1 |  |
| SUB-3 | 2/3 | Owner decision |
| TB-01 | 1/1 |  |
| TB-02 | 1/1 |  |
| TB-03 | 1/1 |  |
| TB-04a | 1/1 |  |
| TB-04b | 1/1 |  |
| TB-05 | 2/2 |  |
| TB-06 | 2/2 |  |
| §4.4 | 0/1 | Not run; see above |
| ADM-01 | 4/4 |  |
| ADM-02 | 4/4 |  |
| ADM-03 | 6/6 |  |
| ADM-04 | 4/4 |  |
| ADM-05 | 4/4 |  |
| ADM-06 | 4/4 |  |
| ADM-07 | 4/4 |  |
| ADM-08 | 4/4 |  |
| ADM-09 | 4/4 |  |
| ADM-10 | 4/4 |  |
| ADM-11 | 4/4 |  |
| ADM-12 | 4/4 |  |
| ENT-01 | 4/4 |  |
| ENT-02 | 4/4 |  |
| ENT-03 | 4/4 |  |
| ENT-04 | 4/4 |  |
| ENT-05 | 4/4 |  |
| ENT-06 | 4/4 |  |
| ENT-07 | 4/4 |  |
| ENT-08 | 4/4 |  |
| ENT-08b | 4/4 |  |
| ENT-09 | 4/4 |  |
| ENT-10 | 4/4 | Drift D-3 |
| ENT-11 | 4/4 |  |
| CON-01 | 4/4 | Drift D-4 |
| CON-02 | 4/4 |  |
| CON-03 | 4/4 |  |
| CON-04 | 4/4 | Drift D-5 |
| CON-05 | 4/4 |  |
| CON-06 | 4/4 |  |
| CON-07 | 4/4 |  |
| VIE-01 | 4/4 |  |
| VIE-02 | 4/4 |  |
| VIE-03 | 4/4 |  |
| VIE-04 | 4/4 |  |
| VIE-05 | 6/6 |  |
| VIE-06 | 4/4 |  |
| VIE-07 | 4/4 |  |
| ISO-01 | 6/6 |  |
| ISO-02 | 2/2 |  |
| ISO-03 | 7/7 |  |
| ISO-04 | 1/1 |  |
| ISO-05 | 2/2 |  |
| ISO-06 | 1/1 |  |
| ISO-07 | 2/2 | Drift D-6 |
| ISO-08 | 2/2 |  |
| MAIL-01 | 1/1 |  |
| MAIL-02 | 1/1 |  |
| MAIL-03 | 1/1 |  |
| MAIL-04 | 2/2 |  |
| MAIL-05 | 5/5 |  |
| MAIL-06 | 3/3 |  |
| MAIL-07 | 1/1 |  |
| MAIL-08 | 1/1 |  |
| MAIL-09 | 1/1 |  |
| MAIL-10 | 2/2 |  |
| BLK-01 | 2/2 |  |
| BLK-02 | 2/2 |  |
| BLK-03 | 2/2 |  |
| BLK-04 | 2/2 | Drift D-7 |
| BLK-05 | 2/2 |  |
| BLK-06 | 2/2 |  |
| BLK-07 | 2/2 |  |
| BLK-08 | 2/2 |  |
| BLK-09 | 0/2 | W: not accepted |
| EVI-01 | 2/2 |  |
| EVI-02 | 2/2 |  |
| EVI-03 | 5/5 | Drift D-8 |
| EVI-04 | 2/2 |  |
| EVI-05 | 2/2 |  |
| EVI-06 | 2/2 |  |
| EVI-07 | 2/2 |  |
| NUM-01 | 1/1 |  |
| NUM-02 | 1/1 |  |
| NUM-03 | 2/2 |  |
| NUM-04 | 1/1 |  |
| NUM-05 | 1/1 |  |
| NUM-06 | 1/1 |  |
| NUM-07 | 1/1 |  |
| NUM-08 | 1/1 |  |
| BND-01 | 3/3 |  |
| BND-02 | 2/2 |  |
| BND-03 | 2/2 |  |
| BND-04 | 2/2 |  |
| BND-05 | 2/2 |  |
| BND-06 | 2/2 |  |
| BND-07 | 6/6 |  |
| ISS-01 | 2/2 |  |
| ISS-02 | 2/2 |  |
| ISS-03 | 2/2 |  |
| ISS-04 | 3/3 | Drift D-9 |
| ISS-05 | 5/5 |  |
| ISS-06 | 3/3 |  |
| ISS-07 | 2/2 |  |
| ISS-08 | 2/2 |  |
| ISS-09 | 6/6 |  |
| ISS-10 | 0/1 | W: not accepted |
| ERR-01 | 1/1 |  |
| ERR-02 | 1/1 |  |
| ERR-03 | 1/1 |  |
| ERR-04 | 0/1 | Not run; see above |
| ERR-05 | 1/1 |  |
| X-ABANDON | 1/1 |  |
| X-ANOMALY | 1/1 |  |
| X-EXPORT-LIMIT | 0/1 | natural flow, statuses pdf 200, xlsx 429, csv 429 |
