# Tasks

## 1. Record the decisions (status file)

- [x] 1.1 Add the Decisions log entry "2026-11-12 — UAT round 2 team decisions (K1, K2, K4, K5, S1–S3) and the owner's follow-ups" above the 2026-11-11 entries. It covers each item's option, the nine typo ceilings with their sources (team: Enerya V8-2; owner 2026-11-12), consultant approval with D01 kept, no per-subsidiary scoping for consultants, and S2 split into the seal date (now) and the source publication date (LP7). Verify that the entry names all eight items.
- [x] 1.2 Strike through the Open questions entries "MGO outside TR" (S3: stays Mobile Combustion; a future DESNZ loader maps "Fuels" MGO rows to Mobile Combustion) and the refrigerant-evidence wording entry (K5: this change). Verify both carry their resolution and date.
- [x] 1.3 Add three bullets to the LP7 task card: K1 option C, K5 option B build, and S2's source publication date as a write-once field with the seal date in issued reports. Add matching ledger rows marked DEFERRED. Verify the ledger and the card agree.
- [x] 1.4 Replace the Next up item "Then K1, K2, K4 and K5 once the team answers" with the ordered list: changes 1–6 (`uat2-team-decisions-copy`, `uat2-user-access-clarity`, `uat2-consultant-approval`, `uat2-standalone-default-subsidiary`, `uat2-anomaly-typo-ceiling`, `uat2-refrigerant-multigas-design`), then the S1 QA operation after change 1 deploys. Verify that no other file holds status.

## 2. Names of the three tiers (organisation-hierarchy)

- [x] 2.1 Rewrite the TR catalogue strings by meaning, following design D1. Cover common, users, subsidiaries, boundary, dashboard, completeness, dataEntry, errors and audit:
  - Kuruluş → Ana Şirket.
  - Lokasyon, Saha and Konum (where they mean a location row) → İşletme / Tesis in headings and labels, tesis in running text, with the Turkish suffixes fixed.
  - Şirket bütünü and tüm şirket → Bağlı şirketin tamamı.
  - The subsidiary's place field → Adres / Konum.
  - In `inputs.marineGasOilScope`: kuruluşunuz → şirketiniz.

  Leave the keys unchanged. Verify that searching the tr catalogues for `Lokasyon|lokasyon|Saha|Kuruluş|kuruluş|Şirket bütünü` returns nothing, and that every remaining "konum" is either the address label or "konum bazlı".
- [x] 2.2 Apply the same mapping to the EN catalogues:
  - Organisation → Parent company.
  - Location and Site (a location row) → Facility.
  - Whole company → Whole subsidiary.
  - The subsidiary's place field → Address.
  - your organisation → your company in the MGO note.

  Verify that searching the en catalogues for `\b[Ss]ites?\b|[Oo]rganisation|Whole company` returns nothing, and that every remaining "location" is the address field's key or "location-based".
- [x] 2.3 Update the server copy:
  - `apps/api/src/reports/i18n/{tr,en}.json` (`wholeCompany`, `unnamedSite`, `excelOrganisation`).
  - `apps/api/src/report-issuances/i18n/{tr,en}.json` (`organisation`).
  - `bulk-upload/template-workbook.ts`: the reference sheet's `Location` header → `Facility`, and "your organisation" → "your parent company".

  Leave the records sheet's column keys and the Scope 2 "konum bazlı" wording unchanged. Verify that `pnpm --filter api test` passes after updating `report-vocabulary.spec.ts`, `reports.service.spec.ts` and `template-workbook.spec.ts`.
- [x] 2.4 Update the web Vitest assertions that pin the old copy: `subsidiaries-view.spec.ts`, `void-view.spec.ts`, `completeness-view.spec.ts`, `i18n/turkish-views.spec.ts`, `record-edit-view.spec.ts`, and any others the search finds. Verify that `pnpm --filter web test` passes.
- [x] 2.5 Update the e2e selectors that use the old copy: `locations.spec.ts`, `subsidiary-panel.spec.ts`, `grid-regions.spec.ts`, `ui-fixes.spec.ts`, `smoke.spec.ts`, `subsidiary-create-locations.spec.ts`, `completeness-dashboard.spec.ts`, `data-entry-layout.spec.ts`, `data-entry-happy.spec.ts`, `void-record.spec.ts` and `drafts-bulk-submit.spec.ts`. Verify that searching `e2e/` for `'Add location'|'Manage locations'|'Location'|Whole company|'Locations'` returns nothing, and that those specs pass locally.
- [x] 2.6 Add a terminology note to `docs/md_docs/ui_spec.md` with the D1 table: tier, TR heading, TR running text, EN, and the terms that keep their meaning. Verify that the note links the `organisation-hierarchy` spec.

## 3. First-period anomaly notice (anomaly-check)

- [x] 3.1 Add `anomaly.firstPeriod.headline` and `anomaly.firstPeriod.detail` to both catalogues, with the D3 copy. Remove `notEvaluated.noHistory` if nothing references it after 3.2. Verify that `messages.spec.ts` and `pnpm typecheck` pass.
- [x] 3.2 In `lib/anomaly-view.ts`, map a record with a figure and a prior count of 0 to the first-period statement (tone `not_evaluated`, qualified). Leave every other branch as it is. Verify with new cases in `anomaly-view.spec.ts`:
  - a first-period record yields the first-period headline and detail in TR and EN;
  - a record without a figure still yields `noFigure`;
  - the legacy `scoredBefore` and zero-average cases are unchanged;
  - no output mentions a number of periods for a first-period record.
- [x] 3.3 Add a neutral first-period marker to the review queue row in `app/review/page.tsx`: an info icon with an accessible label, distinct from the flag's amber triangle. Verify with an e2e step in `e2e/anomaly-short-history.spec.ts`: a series' first record shows the marker and "İlk dönem kaydı" / "First-period record" in the sheet, and submits without a variance reason.
- [x] 3.4 Confirm that Data Entry and the emissions record view show the new statement through the shared view, with no extra code. Verify the Data Entry anomaly note in the same e2e spec.

## 4. Refrigerant evidence guidance and the attach shortcut (record-evidence)

- [x] 4.1 Make `RequiredNote` in `components/data-entry/evidence-vault.tsx` take the category. For `Refrigerants`, render the four-document list from new `evidence.refrigerantNote.*` keys (TR and EN). Leave the general note for other categories. Verify with a component or view test: a refrigerant record shows the list, and a natural gas record shows the general note.
- [x] 4.2 Give `components/data-entry/records-table.tsx` a prop-driven attach request, `{ nonce, year, category, preselectIds }`. It sets the table's year and category filters, starts attach mode with the visible attachable ids from `preselectIds` ticked, and scrolls into view. Ticking stays bound by `attachableIds` and the cap. Verify with a test of the pre-tick logic in `records-table-view.spec.ts`: ids that are not attachable are never ticked.
- [x] 4.3 Add the shortcut button to the saved-record vault. It shows on a refrigerant record when the subsidiary and year hold at least two attachable refrigerant records, and is wired through `app/data-entry/page.tsx` to the request from 4.2. Add the copy in TR and EN. Verify with a new e2e spec, `e2e/refrigerant-evidence.spec.ts`: three gas drafts for one subsidiary and year, then the shortcut on one, all three ticked, one file attached, all three listing it. Also verify that the shortcut is absent when only one gas record exists.

## 5. Package seal date (emission-factor-library)

- [x] 5.1 Add `SealedFactorReleaseDTO` (`FactorReleaseSnapshot` plus `sealedAt: string`) to `@tonyai/shared-types`, with a doc comment: database-set at seal, never taken from the file, no reviewer, withdrawer or notes. Leave `FactorReleaseSnapshot` unchanged. Verify that `pnpm typecheck` passes across the workspace.
- [x] 5.2 Add `GET /api/v1/factors/releases` on `CalculationsController`, with a service method that reads `factor_releases` where `sealed_at` is not null, ordered by publisher and ordinal, selecting only the snapshot columns and `sealed_at`, and maps to `SealedFactorReleaseDTO`. Verify with a DB-free spec in `calculations.service.spec.ts` / `calculations.controller.spec.ts`:
  - unsealed rows are excluded;
  - withdrawn rows are included;
  - `sealedAt` is serialised as ISO.

  Also verify with an integration or e2e probe that an unauthenticated request gets 401 and a data_entry user gets 200.
- [x] 5.3 Document the route in `docs/api/endpoints.md`: response shape, auth, and that it is not tenant-scoped. Verify that the doc matches the DTO.
- [x] 5.4 Add `listFactorReleases()` to `apps/web/lib/api.ts`, and a hook that loads it once and returns a release-id → seal-date lookup, failing silently. Verify with a unit test of the lookup: a known id yields its date, and an unknown or missing id yields nothing.
- [x] 5.5 Show "Paketin mühürlenme tarihi" / "Package sealed on" with the locale-formatted date in three places:
  - Data Entry's conversion note (`lib/conversion-view.ts`, preview release);
  - the emissions record view (stored calculation's factor release);
  - the review sheet.

  Add the copy to both catalogues. Verify with `conversion-view.spec.ts` cases (with and without a date), and with an e2e check that a previewed TR natural gas record shows the seal date of the loaded TR release.

## 6. Integration and review

- [x] 6.1 Run `pnpm typecheck`, `pnpm build` and `pnpm test` from the root. Verify that all are green.
- [x] 6.2 Run the touched e2e specs against the local stack, with CI's rate-limit env and `TONYAI_TEST_PASSWORD` (see memory). Verify that they pass, apart from the known local-only failures.
- [x] 6.3 Check against the running app, in TR and EN: Subsidiaries, the facilities drawer, Users, the Dashboard, Data Entry (first-period note, refrigerant guidance and shortcut, seal date), Review and Emissions. Verify that no old term remains on these screens.
- [x] 6.4 Run the fresh-eyes review before the PR: `architect` (the shared-types contract and the new route) and `qa-auditor` (test coverage, terminology sweep, anomaly behaviour unchanged), in parallel. Verify that their findings are fixed or filed under Open questions per the pre-pilot rule.

## Workflow follow-up

- Commit and open the PR when the owner asks; the owner merges.
- The merge deploys QA. The owner checks the TR screens on hosted QA.
- Start the S1 QA operation after the deploy: reject and resubmit the 7 pending records in Emre Test Holding with evidence, then a staged D04 run (approve → lock → unlock → void → copy to new draft → re-enter with evidence), following an English checklist in `docs/uat/`.
- Add the Current status entry, then archive the change with `/opsx:archive`.
