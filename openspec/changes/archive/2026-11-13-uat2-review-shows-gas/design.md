# Design

## Context

See `proposal.md` (Why). The requirements are in `specs/record-lifecycle/spec.md`.

Current state (observed on `origin/main` 3861708d):
- `/review` is a single file, `apps/web/app/review/page.tsx`. The queue loads `api.listActivityRecordPage({ …, sort: "review_queue" })`, and its rows are `ActivityRecordDTO`s. The sheet opens on the row object itself (`setSelected(row)`) and fetches no detail.
- The API's `listPage` maps every row through `toDTO`, which carries `activityType` (`activity-records.service.ts`, `toAuditSnapshot`). `ActivityRecordDTO.activityType` is `string | null`, optional only for old fixtures. So the data is already on the screen, and the change is web-only.
- The Category cell renders `recordWords.category(row.category)` plus the anomaly icon and the first-period marker. The sheet title is `t("sheet.title", { category, period, year })`, with the message `"{category} · {period} {year}"`.
- Activity-type labels live in one flat catalogue, `dataEntry.activityTypes.<value>` (TR and EN), whose parity `lib/i18n/messages.spec.ts` checks. The per-category list is `recordActivityTypesFor(category)` in `@tonyai/shared-types`. Data Entry resolves labels in three page-local helpers (`categoryWithActivity` in `components/data-entry/records-table.tsx`, `activityLabel` in `app/data-entry/page.tsx`, and an inline copy there), plus `bulkActivityLabel` in `lib/bulk-upload-view.ts`.
- `RecordWords` (`lib/vocabulary.ts`) names status, period and category in the user's language. Every instance comes from `recordWordsOf`, through `useRecordWords` and through `recordWordsFor` in tests.

## Goals / Non-Goals

**Goals:**
- One tested, pure resolver of "category (type)" in `lib/`, used by both `/review` surfaces.
- No new message copy, so no new term needs the owner's Turkish review.

**Non-Goals:**
- Consolidating Data Entry's local helpers onto the new resolver. That is a refactor with no defect behind it, so under the pre-pilot rule it is filed under Open questions. Records-table's raw `unspecified` fallback stays as it is.
- The `/emissions` drawer and History table (LP7-07).
- Any API, contract, Prisma or audit change.

## Decisions

### D1. Extend `RecordWords` with an `activity` word, and add `categoryWithActivity` beside it

`recordWordsOf` gains `activity(category, activityType)`. It returns the label, or `null` when there is nothing to show. `categoryWithActivity(words, record)` returns `"Category (Label)"`, or the category alone when `activity` returns `null`. Both live in `lib/vocabulary.ts`.

The resolution rules, in order:
1. An empty or null type: `null`.
2. `UNSPECIFIED_ACTIVITY_TYPE`: `dataEntry.notSpecifiedLegacy`.
3. A value in `recordActivityTypesFor(category)` whose catalogue key the messages own: `dataEntry.activityTypes.<value>`.
4. Anything else: the stored value.

Rule 3 uses `recordWordsOf`'s existing own-key check, so a prototype key such as `constructor` cannot render as a key path.

*Why here:* every `RecordWords` comes from `recordWordsOf`, so adding a member breaks no hand-built instance. The page already holds `recordWords`, and Vitest collects only `lib/**`, so a resolver left in the page would go untested.

*Alternatives:*
- Moving records-table's `categoryWithActivity` out unchanged. Rejected: it shows `unspecified` raw, which is English text inside the Turkish UI.
- A standalone function taking a translator. Rejected: it duplicates `recordWordsOf`'s own-key guard.

### D2. Inline "Category (Type)" in the cell, not a new column or a second line

The Category cell's text becomes `categoryWithActivity(recordWords, row)`, followed by the markers as today. This matches Data Entry's records table, so a reviewer and an author read a record by the same words.

*Alternatives:*
- A new column. Rejected: it changes the empty and skeleton rows' `colSpan` and widens a table that already has eight columns.
- A muted second line, as the location uses. Rejected: it reads as a different attribute, and the type is part of what the record is.

### D3. The sheet title passes the combined word as `{category}`

`sheet.title` keeps its message. Its `category` argument becomes `categoryWithActivity(recordWords, selected)`. No catalogue key changes, so `admin-screens-turkish` and the parity specs are unaffected.

### D4. Every typed category, not only Refrigerants

This is the owner's choice of 2026-11-13. It uses the same code path. Implicit categories (Fugitive Gas) have no types, so rule 1 or the category list leaves them unchanged.

## Risks / Trade-offs

- [An existing `/review` e2e matches the Category cell's exact text] → Task 3.1 rechecks `review-queue*.spec.ts`, `anomaly-*`, `bounded-reads`, `data-entry-tr-inputs`, `uat2-team-decisions` and `review-gate` for exact-text matches. The known matches (`hasText: 'Natural Gas'`, `t.includes(...)`) are substring matches and still pass.
- [Long labels wrap the Category cell, for example "Mobile Combustion (Heavy goods vehicle, diesel)"] → The cell wraps today; the markers stay in the flex row. Checked by eye at phone width in the browser check (task 3.4).
- [A record's type is not in its category's list, for example after a catalogue change] → It is shown raw, not hidden (rule 4), so two such rows still differ.

## Migration Plan

No migration, no preflight and no hosted query. An image-affecting web change, so the merge deploys QA automatically. Rollback means redeploying the previous web image; no data is touched.

## Open Questions

None that affect this change. The Data Entry helper consolidation is filed under Open questions in the status file (task 4.2).
