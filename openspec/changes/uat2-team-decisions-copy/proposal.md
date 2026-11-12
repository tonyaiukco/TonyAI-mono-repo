# Proposal

## Why

The team answered the UAT round 2 questions that were parked on 2026-11-10: K1, K2, K4, K5 and S1–S3. The answers are in the team decision memo of 2026-11-11, and the owner answered the plan's follow-up questions on 2026-11-12.

Most of these answers need their own change. Five parts, however, need only copy and screen work, or a decision record. This change ships those five parts first, so that QA sees the decided wording before the larger changes land.

- **K1, names.** The three tiers have no consistent names on screen.
  - The tenant organisation is called "Kuruluş".
  - A Location is called "Lokasyon" on one screen, "Tesis" or "Saha" on the next, and "Konum" on the dashboard.
  - "Şirket bütünü" stands for a subsidiary as a whole, which now reads as the parent company.

  The team decided on **Ana Şirket** (organisation), **Bağlı Şirket** (subsidiary) and **İşletme / Tesis** (location).
- **K4-3a, option A.** A record with no earlier period is labelled "Anormallik kontrolü yapılmadı". The team wants that record called what it is, a first-period record, and wants the reviewer told to check the evidence and the unit.
- **K5, option A.** One record per gas stays. However, nothing on the refrigerant form says which documents count as evidence for an estimated, capacity-based record, and nothing points the user to the existing step that attaches one file to several records.
- **S2, partly.** The team asked for a package seal date and a source publication date. The owner deferred the source publication date to after the pilot (2026-11-12). The seal date already exists (`sealedAt`, set by the database when a release is loaded), but no screen shows it.
- **Decision record.** The status file still lists K1–K5 and S1–S3 as waiting for the team. Two of its open questions are answered:
  - S3: MGO stays under Mobile Combustion.
  - K5: what counts as refrigerant evidence.

## What Changes

- **Names, TR and EN.**
  - **Organisation:** "Kuruluş" → "Ana Şirket" (EN "Organisation" → "Parent company").
  - **Location:**
    - "Lokasyon", "Saha" and "Konum" (where it means a Location row) → "İşletme / Tesis" in headings, column headers and field labels, and "tesis" in running text. EN "Location" and "Site" → "Facility".
    - The subsidiary's free-text place field ("Konum", EN "Location", e.g. "Istanbul, Turkey") becomes "Adres / Konum" (EN "Address"), so it no longer reads as a facility.
  - **A subsidiary as a whole:** "Şirket bütünü" / "Şirketin tamamı" → "Bağlı şirketin tamamı" (EN "Whole company" → "Whole subsidiary").
  - **Left unchanged:**
    - "Bağlı Şirket" (EN "Subsidiary").
    - The GHG Protocol term "konum bazlı" (location-based Scope 2).
    - The MGO scope note, where "kuruluş" means the reporting company.
  - **Where:** web catalogues, the report and issuance catalogues on the server, and the bulk upload template's headers.
- **First-period anomaly notice.**
  - Data Entry, the review sheet and the emissions record view name a record with no earlier period a **first-period record**. They say there is no history to compare with, and ask the user to check the evidence document and the unit.
  - The review queue row marks such a record, as it marks a flagged one.
  - The verdict itself does not change: the record is still not flagged and is still counted as not checked.
- **Refrigerant evidence guidance.**
  - On a refrigerant record, the Evidence card's "file required" note lists the accepted documents:
    - the equipment inventory list (signed or stamped);
    - the authorised service maintenance or periodic inspection form;
    - a nameplate photo or technical specification page;
    - the annual refill or maintenance invoice, if there is one.
  - The card also offers **"Attach this document to the year's other gas records"**. This opens the records table's existing one-file-to-several-records step, with the year's attachable refrigerant records of the selected subsidiary already ticked.
- **Package seal date on screen.**
  - **New read-only endpoint `GET /api/v1/factors/releases`.** It lists the library's sealed releases, including withdrawn ones, with each release's seal date. Any signed-in user may call it, as with `GET /factors`.
  - **Where the date appears.** Data Entry's conversion note, the emissions record view and the review sheet show **"Paketin mühürlenme tarihi"** (EN "Package sealed on") beside the release that priced the figure.
  - **How it is read.** The date is matched at read time through the release id that the calculation snapshot already holds. Stored snapshots are not changed.
- **Status file.**
  - A Decisions log entry records the team's answers (2026-11-11) and the owner's (2026-11-12).
  - The MGO-category and refrigerant-evidence open questions are closed.
  - Three items are added to LP7 as post-pilot work:
    - **K1 option C:** one email across several organisations.
    - **K5 option B:** the build of a multi-gas form that writes one record per gas.
    - **The rest of S2:** a source publication date field, write-once on sealed releases.

## Capabilities

### New Capabilities
- `organisation-hierarchy`: the three tiers a tenant's data sits in (parent company, subsidiary, facility) and the names every screen, report and template uses for them. K1's later changes (the default subsidiary for a standalone customer, clearer subsidiary access) add their requirements here.

### Modified Capabilities
- `anomaly-check`: a record with no earlier period is presented as a first-period record that asks for an evidence and unit check, and the review queue row marks it.
- `record-evidence`: a refrigerant record states the documents it accepts as evidence, and offers to attach one document to the year's other gas records.
- `emission-factor-library`: the API lists sealed releases with their seal date, and the screens that name the release behind a figure show that date.

## Impact

- **API:**
  - The new `GET /factors/releases` route on `CalculationsController`, and a service method that reads `factor_releases`.
  - It is read-only, with no audit, no RBAC beyond sign-in, no migration and no new grant. `factor_releases` already has the runtime role's SELECT grant.
  - Copy changes in `reports/i18n`, `report-issuances/i18n` and `bulk-upload/template-workbook.ts`.
  - Issued PDFs are stored as issued and are not regenerated. Only new issuances use the new names.
- **Shared types:**
  - A new `SealedFactorReleaseDTO`: the release snapshot's columns plus `sealedAt`, with no reviewer, withdrawer or notes.
  - The snapshot types (`FactorReleaseSnapshot`, `ActivityCalculationSnapshot`) do not change.
- **Web:**
  - Every catalogue that holds the old terms, en and tr: common, users, subsidiaries, boundary, dashboard, completeness, dataEntry, errors, audit, anomaly and evidence.
  - `lib/anomaly-view.ts`, `app/review/page.tsx`, `app/emissions/page.tsx` and `app/data-entry/page.tsx`.
  - `components/data-entry/evidence-vault.tsx` and `components/data-entry/records-table.tsx`.
  - `lib/conversion-view.ts` and `lib/api.ts`.
- **Tests:**
  - E2E specs and web/API Vitest specs that assert "Location", "Locations", "Add location", "Manage locations", "Whole company", "Site (name unavailable)", "lokasyon" or "Şirket bütünü" are updated to the new names.
  - The anomaly-view specs gain the first-period wording.
  - New specs cover the releases endpoint, the seal-date display and the refrigerant attach shortcut.
- **Docs:** `docs/api/endpoints.md` (the new route), `docs/md_docs/ui_spec.md` (a terminology note), and the status file.
- **Out of scope:**
  - The issued PDF's release line. Adding the seal date there needs a report dataset schema version and new fingerprints. It moves to LP7 with the rest of S2.
  - Showing the parent company's name in the header.
  - The anomaly wording in reports and CSV exports.
- **Review:** the change adds a shared-types contract field and a factor-library read path, so `architect` and `qa-auditor` review it before the PR.
