# Proposal

## Why

UAT round 2 (BUG-R2-02, P1) found that a Mobile Combustion record can be submitted for review with no evidence file, while a Natural Gas record cannot, and that the evidence upload area never appears for those categories. The evidence-required list was set on 2026-07-06, when only Electricity, Natural Gas and Fuel had factors, and was not revisited when Mobile Combustion, Refrigerants and Fugitive Gas became calculable (LP4-02). The owner decided on 2026-11-10 (K3) that evidence is required for every Scope 1 and Scope 2 category.

## What Changes

- **Evidence-required set:** Mobile Combustion, Refrigerants and Fugitive Gas join Electricity, Natural Gas, Fuel and Water in `EVIDENCE_REQUIRED_CATEGORIES`. The list stays explicit, and a new invariant pins that every Scope 1 and Scope 2 category is in it. Water stays required (the WP17 exception). The other Scope 3 categories stay exempt.
- **Approve gate:** approving a record in an evidence-required category with no attached file is refused, under the row lock, after the period-lock check and before C8. Today only submit checks evidence, so a record submitted before this change could still be approved without a file. **BREAKING** for the review queue: such records must be rejected so their author can attach a file and submit again.
- **Approve refusal code:** a new stable error code tells the approver to return the record to its author, with TR and EN copy. Submit keeps `evidence_required`.
- **Data Entry pre-check:** on Submit, a record in an evidence-required category with no file is saved as a draft, stays open with the evidence vault visible, and the user is told to attach a file. The request is not sent. The API stays the final word.
- **Copy:** the vault's "required" note names the kinds of evidence these categories use (fuel receipts or cards, service records, leak reports) in TR and EN.
- **Follow-on behaviour with no code of its own:** bulk import warns `evidence_required` on these rows, import batches hold them back from "Send N drafts", bulk submit skips them, and the dashboard tracking matrix treats a committed record with no file as incomplete. All of these read the same list.

Not in this change: Scope 3 categories other than Water; a single evidence package for multi-equipment refrigerant records (K5, parked); the Data Entry layout that moves the vault (BUG-R2-05); any exemption of existing records by date or audit row (rejected as forgeable for C8).

## Capabilities

### New Capabilities

- `record-evidence`: which activity categories need supporting files, and the lifecycle rules that enforce it (submit and approve gates, bulk import and bulk submit treatment, completeness).

### Modified Capabilities

- `activity-data-entry`: the Data Entry form's Submit checks evidence before sending, and shows the vault for a newly saved record.

## Impact

- **Contract (`@tonyai/shared-types`):** `EVIDENCE_REQUIRED_CATEGORIES` and its docs; one new error code in the registry with its params. `dist` must be rebuilt for the API and web.
- **API:** `ActivityRecordsService.approve` gains the evidence check and a new error class beside `EvidenceRequiredError`. No new endpoint, no migration, no table change. The only approve path is `POST /api/v1/activity-records/:id/approve`.
- **Web:** `apps/web/app/data-entry/page.tsx` (`handleSubmit`), the evidence and errors catalogues (TR and EN), a stale comment in `apps/web/lib/bulk-submit-view.ts`. The vault badge and the bulk-submit checkbox follow the list unchanged.
- **Tests:** shared-types invariants; API unit tests for submit and approve; bulk-upload expectations for MGO and refrigerant rows; the tracking matrix; one integration test; one e2e flow.
- **Data:** none migrated. On hosted QA, committed records in the three categories with no file show as incomplete on the dashboard, and those still in review can no longer be approved. QA data is synthetic and the pilot has not started.
- **Docs:** `docs/md_docs/data_entry_page.md`, `docs/api/endpoints.md`, `docs/development/testing.md`, `.claude/skills/e2e-flow/SKILL.md`, seed comments, and the status file.
