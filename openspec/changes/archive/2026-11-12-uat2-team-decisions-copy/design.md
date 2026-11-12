# Design

## Context

See proposal.md (Why) for the motivation. The current state that shapes the approach:

- **Terms.** The web catalogues (`apps/web/messages/{tr,en}/*.json`) name a Location in four ways:
  - "Lokasyon": subsidiaries, dataEntry, errors.
  - "Tesis": dashboard, completeness, common.
  - "Saha": boundary.
  - "Konum": dashboard KPIs and the per-location matrix.

  "Konum" also labels the subsidiary's free-text `location` field, which is an address such as "Istanbul, Turkey". "Kuruluş" (EN "organisation") names the tenant in users, errors, audit and subsidiaries. "Şirket bütünü" (common, dashboard) and the server's "Şirketin tamamı" mean "the subsidiary, no Location". The server holds its own copies in `apps/api/src/reports/i18n`, `apps/api/src/report-issuances/i18n` and the EN-only `bulk-upload/template-workbook.ts`.
- **Anomaly view.** `apps/web/lib/anomaly-view.ts` `anomalyStatement` maps `anomalyBaselinePriorCount === 0` to `notEvaluated.headline` + `notEvaluated.noHistory`, with tone `not_evaluated` and `qualified: true`. The screens use it as follows:
  - The review sheet (`app/review/page.tsx` ~746) and Data Entry (~2123) already render a qualified not-flagged statement.
  - The emissions record view renders `.detail`.
  - The review queue row (~517) shows an icon only when the record is flagged.
- **Evidence card.** `components/data-entry/evidence-vault.tsx` `RequiredNote()` takes no props. It renders when an evidence-required record has no file (~253 for held files, ~433 for a saved record). The vault already receives `category`.
- **Attach step.** The one-file-to-several-records step lives in `components/data-entry/records-table.tsx`: `startAttach()` ~319, `attachableIds`, `api.uploadEvidenceForRecords`. It starts with nothing ticked. The table's filters (year, status, category) are applied by the API with paging.
- **Seal date.**
  - `factor_releases.sealed_at` is set by the database when the loader seals a release.
  - It is in neither `FactorReleaseSnapshot` nor `FactorReleaseDTO`.
  - Calculation snapshots name their release by id: the factor's release, and the conversion's release where one applies.
  - The snapshot is immutable once committed (emission-calculation, "Snapshots stay immutable and readable"). A snapshot shape change also means a new snapshot version and staleness handling.
  - Issued PDFs read `dataset.provenance.releases`, which is fixed at capture and covered by the dataset fingerprint (report-finals, "Retained data stays valid").

## Goals / Non-Goals

**Goals:**
- One name per tier in every TR and EN screen, every new report and issuance, and the bulk template.
- First-period wording that asks for an evidence and unit check, with the verdict unchanged.
- Refrigerant-specific evidence guidance, and a one-step path to the existing multi-record attach.
- The seal date visible wherever a screen names the release behind a figure, with no snapshot change.
- The status file records every answered decision and the post-pilot items.

**Non-Goals:**
- No change to anomaly logic, thresholds or stored verdicts. The typo ceiling is change 5, `uat2-anomaly-typo-ceiling`.
- No change to user access, approval roles or the default subsidiary. Those are changes 2–4.
- No new way to link an already-stored file to another record.
- No seal date on issued PDFs or in report datasets. It goes to LP7 with the source publication date.
- No renaming of message keys, API fields, DB columns or identifiers. Only the copy changes. Keys such as `wholeCompany` and `locations.*` keep their names, so the code diff stays small.
- No header display of the parent company's name.

## Decisions

### D1 — One term table, applied by meaning, not by search-and-replace

Each catalogue string is classified by what it refers to, then mapped:

| Refers to | TR before | TR after | EN before | EN after |
|---|---|---|---|---|
| Tenant organisation | Kuruluş | Ana Şirket (running text: "ana şirket") | Organisation | Parent company |
| Location row (heading, column, label) | Lokasyon / Tesis / Saha / Konum | İşletme / Tesis (plural "İşletmeler / Tesisler") | Location / Site | Facility (plural "Facilities") |
| Location row (running text, counts) | lokasyon / tesis / saha / konum | tesis | location / site | facility |
| Subsidiary as a whole | Şirket bütünü / Şirketin tamamı / tüm şirket | Bağlı şirketin tamamı | Whole company | Whole subsidiary |
| Subsidiary's free-text place | Konum | Adres / Konum | Location | Address |
| GHG location-based Scope 2 | konum bazlı | unchanged | location-based | unchanged |
| GHG reporting company (`inputs.marineGasOilScope`) | kuruluşunuz | şirketiniz | your organisation | your company |

Notes on the table:
- **Short text in the facility rows.** Running text uses "tesis" alone: "İşletme / Tesis" inside a sentence reads badly, and it does not fit compact UI.
- **Turkish suffixes.** In Turkish, the suffixes of the old word go with it ("lokasyonu" → "tesisi", "lokasyondan" → "tesisten"). Every changed TR string is therefore rewritten by hand, not substituted.
- **Error codes.** Error codes such as `location_not_found` keep their codes; only their copy changes.

*Alternative considered:* a blanket substitution of "Lokasyon" with "Tesis". It was rejected because it breaks Turkish suffixes, turns the address field and "konum bazlı" into facilities, and misses "Saha" and "Konum".

### D2 — Server copy follows; issued documents stay as issued

- **Server catalogues.** `reports/i18n` and `report-issuances/i18n` (`organisation`, `wholeCompany`, `unnamedSite`, `excelOrganisation`) and the bulk template headers (`Location` → `Facility`) take the D1 names.
- **Issued PDFs.** An issued PDF is stored as a file and never regenerated, so only new issuances carry the new names. The PDF renderer version moves to `tonyai-issuance-pdf-v4`.
- **Issued Excel and CSV.** These are written on request from the current catalogue, never stored, so a re-download of an older issuance carries the new wording. Their renderer version moves to `tonyai-issuance-tables-v4`, and the identity row names it. Figures, rows and the dataset fingerprint do not change.
- **Live CSV.** The `reporting_entity` value of a subsidiary-level row changes from `Whole company` to `Whole subsidiary`. `docs/api/endpoints.md` records this one-time change.
- **Retained datasets.** A dataset holds data, not labels, so its fingerprint does not change.
- **Bulk template.**
  - The `Location` header that changes is on the reference sheet's "Your reporting entities" table (`template-workbook.ts:239`). Uploads ignore that sheet.
  - The records sheet's column keys (`locationId` and the others) stay as they are.
  - So the import parser is untouched, and templates that users downloaded earlier still upload.
  - The sheet's "your organisation" sentence becomes "your parent company".

### D3 — First period is a presentation of the existing verdict

- **Statement.** `anomalyStatement` gains a branch before the legacy `scoredBefore` branch, for a record with a figure whose prior count is 0. It returns tone `not_evaluated` and `qualified: true`, with new copy keys:
  - `anomaly.firstPeriod.headline`: TR "İlk dönem kaydı", EN "First-period record".
  - `anomaly.firstPeriod.detail`: TR "Geçmiş karşılaştırma verisi yok — lütfen kanıt dokümanını ve birimi kontrol edin.", EN "There is no earlier period to compare with — please check the evidence document and the unit."
- **Old keys.** `notEvaluated.noHistory` remains for any caller that is not a screen (none today). It is otherwise unused, and the implementation removes the key if nothing references it.
- **Review queue row.** It adds a neutral marker when the statement is first-period: an info icon with an accessible label and a tooltip of the headline. The amber triangle stays reserved for flags.
- **Unchanged.** The verdict, the stored fields, the dashboard's not-checked count and the export wording are untouched.

*Alternative considered:* a new verdict state stored with the record. It was rejected because it changes the record contract and the stored verdicts for a wording request.

### D4 — Refrigerant guidance and the attach shortcut reuse existing pieces

- **Guidance note.** `RequiredNote` takes the category. For `Refrigerants` it renders the four-document list (new keys under `evidence.refrigerantNote.*`). For every other category it keeps `requiredNote`.
- **Shortcut placement.** The shortcut is a button in the saved-record vault ("Bu belgeyi yılın diğer gaz kayıtlarına da ekle" / "Attach this document to the year's other gas records"). It shows only when at least two attachable refrigerant records exist for the subsidiary and year.
- **What the button does.** It calls up to the Data Entry page, which drives the records table:
  1. Set the table filters to the record's reporting year and category Refrigerants. This guarantees that the ticked rows are on screen, since the API filters and pages the table.
  2. Start attach mode with the visible attachable ids pre-ticked.
  3. Scroll the table into view.
- **Records table.** It exposes a `startAttach(preselectIds?)` entry point, through a prop-driven request with a nonce rather than an imperative ref, to match how the page already drives the table. Ticking stays bound by `attachableIds` and the existing cap.
- **Upload.** The upload is the existing `POST /evidence` with `recordIds`. There are no API changes.

*Alternative considered:* a new "link an existing file" endpoint. It was rejected for the pilot because the schema's invariant only creates links together with an upload. The team asked for the existing step to be visible, not for a new capability.

### D5 — Seal date read at display time through a release list

- **Endpoint.** `GET /api/v1/factors/releases` on `CalculationsController` returns `SealedFactorReleaseDTO[]` for releases with `sealed_at IS NOT NULL`, ordered by publisher then ordinal.
  - `SealedFactorReleaseDTO` is the snapshot's columns (`RELEASE_SNAPSHOT_SELECT`) plus `sealedAt` (an ISO timestamp). The existing `FactorReleaseDTO` is not used: it carries reviewer, withdrawer and free-text notes, which this path has no need to expose.
  - The guard requires a session, and no tenant scoping applies: releases are global reference data, like `GET /factors`.
- **Web.** `lib/api.ts` gains `listFactorReleases()`. A small hook loads it once per page and builds `Map<releaseId, sealedAt>`. On error the dates are left out silently: a missing date must not block Data Entry.
- **Where the date is shown.**
  - Data Entry's conversion note (`lib/conversion-view.ts`): the preview's `conversion.release.id`, and the factor release where there is no conversion.
  - The emissions record view and the review sheet: the stored calculation's factor release id.
- **Rendering.** The date is rendered with the locale date formatter (date only).

*Alternatives considered:*
- **(a) Add `sealedAt` to the snapshot.** Rejected: it changes the snapshot version, makes drafts read stale, and never reaches committed snapshots.
- **(b) Decorate every record response server-side.** Rejected: it touches every endpoint and aggregation that returns calculations.
- **(c) Show `publishedAt`.** Rejected: its meaning is mixed today (the package compile date), which is what S2 is about.

### D6 — Status file

The status file gets these updates:
- A Decisions log entry "2026-11-12 — UAT round 2 team decisions (K1, K2, K4, K5, S1–S3) and the owner's follow-ups". It records each decision, the typo ceilings, consultant approval and the deferred S2 source date.
- The Open questions entries for MGO outside TR (S3) and the refrigerant evidence wording (K5) are struck through with their resolution.
- LP7 gains three items:
  - K1 option C, one email across several organisations;
  - K5 option B, the multi-gas form build (its design is change 6);
  - S2's source publication date, as a write-once field on sealed releases, plus the seal date in issued reports.
- Next up lists changes 1–6 and the S1 QA operation in order.
- A Current status entry is added once the change merges.

## Risks / Trade-offs

- **[Tests break]** The many e2e and Vitest assertions on "Location", "Add location", "Whole company" and similar strings break. → One task updates every listed assertion to the new copy. Searching for the old EN and TR terms across `e2e/`, `apps/web/lib/*.spec.ts` and `apps/api/src/**/*.spec.ts` must return only the intentional leftovers (the "konum bazlı" Scope 2 term and the error-code identifiers).
- **[Uneven Turkish]** Turkish suffixes go wrong, or a "tesis" is left in a heading. → Every TR string changed is listed in the PR. A Turkish reader (the owner) checks the screens on QA before the change is closed.
- **[Catalogue drift]** A key is added in one language only. → `apps/web/lib/i18n/messages.spec.ts` and the typed message keys (`message-keys.typecheck.ts`) run in `pnpm test` and `pnpm typecheck`. New keys are added to both catalogues in the same edit.
- **[Seal date unavailable]** The release list fails or is slow. → The date is optional, failure is silent, and the list is small (a few dozen rows).
- **[Pre-tick mismatch]** The shortcut's pre-tick hides records past the table's page size. → The table filters to one category and one year, and refrigerant records are annual (one per gas), so the set is small. Anything unticked can still be ticked by hand.

## Migration Plan

- **Rollout:** no migration, no new grant and no data change. Merge, and QA auto-deploys.
- **Rollback:** revert the PR. Nothing persists that depends on the change.
- **After deploy:**
  1. The owner checks the TR screens on hosted QA.
  2. The S1 QA operation (reject and resubmit the 7 pending records, then a staged D04 run) starts after this deploy.
