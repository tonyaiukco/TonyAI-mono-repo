# Proposal

## Why

UAT round 4 (`docs/uat/v4/TonyAI_BUG_Report_v4.md`, Rev.3 of 2026-11-24) lists four small findings from the Çorum soft-launch that carry no engine, schema or access change. They ship first, as work package 1 of [`Pilot_launch_v4.md`](../../../docs/roadmap_docs/Pilot_launch_v4.md), so QA can retest them while the larger packages are built.

## What Changes

- **BUG-10 — default icon.** The site answers `/favicon.ico` with the TonyAI mark. Today the title and the linked icons are branded, but the default path answers 404.
- **BUG-11 — gas in kWh starts on the bill's basis.** On a TR natural gas record in kWh or MWh, the basis choice comes with gross selected and is worded in plain words: "kWh on the bill (upper calorific value)" first, "Net kWh (lower calorific value)" second. This reverses `ng-kwh-form`'s "no default" rule, by the team's decision of 2026-11-24: a bill's kWh is gross, and marking it net by mistake overstates the result by about 11%. A stored basis still wins on an opened or copied record. The API and bulk upload still require an explicit basis.
- **BUG-16 — invoice number and supplier.** Two optional text fields in Additional context for every category, saved in the record's `input`, never used by the calculation, shown on the review sheet. Electricity's existing utility provider is its supplier.
- **BUG-15 (screen part) — a way to the entries from the top.** A control above the form, "View or edit your entries" with the record count, scrolls to the records table and focuses it.
- **BUG-09 — password show/hide.** Already shipped (`uat3-ui-polish`); retested on the build, no change.

Not in this change: BUG-15's recall and resubmit workflow (WP5), BUG-12 and BUG-17 (WP2, WP3), BUG-13 (WP4), and invoice number and supplier as bulk-upload columns (WP9, where the bulk path is reworked for fuel files).

## Capabilities

### New Capabilities
- `web-branding`: how the web application identifies itself in a browser tab: the default icon path answers with the product's mark.

### Modified Capabilities
- `activity-data-entry`: the gas basis choice gets a default (gross) and new wording; a record gets an optional invoice number and supplier; Data Entry gets a control at the top that leads to the records table.
- `record-lifecycle`: the review sheet shows a record's invoice number and supplier.

## Impact

- **Web:** `apps/web/app/favicon.ico` (new); `lib/record-inputs-view.ts`, `components/data-entry/record-inputs.tsx`, `lib/context-fields.ts`, `app/data-entry/page.tsx`, `components/data-entry/records-table.tsx`, `app/review/page.tsx`, `lib/review-view.ts`; the `dataEntry` and `review` catalogues in TR and EN.
- **API:** the record write DTOs check the two new `input` keys (text, length); no new route, no migration.
- **Shared types:** the two keys, their limits and the supplier lookup, in one place for web and API.
- **Tests:** unit specs beside each touched file; `e2e/natural-gas-energy-bill.spec.ts` updated for the default, new e2e cases for the two fields, the top control and the icon.
- **Docs:** `docs/api/endpoints.md` (the two `input` keys); the planning file and the sprint ledger in the same PR.
- **Data:** none. Existing records and their figures are untouched; a gas draft saved before this change keeps its stored basis.
