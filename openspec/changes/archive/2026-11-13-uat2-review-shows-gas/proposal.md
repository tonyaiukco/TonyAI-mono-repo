# Proposal

## Why

Under K5 option A, which the pilot runs, a facility enters one Refrigerants record per gas, so one site and year can have two to four Refrigerants records. The review queue row shows only the category, and so does the review sheet's title. A reviewer therefore sees identical rows and cannot tell which gas's figure they are approving or rejecting (design D8 of `uat2-refrigerant-multigas-design`). The owner made this display a pre-pilot exception to the rule that a non-defect finding is filed, not fixed (Decisions 2026-11-13 (second), item 3).

The same gap exists for every category that has activity types. The uniqueness key includes `activity_type`, so two Fuel records (diesel and LPG) or two Mobile Combustion records of one site and period can also differ only by type. Data Entry's records table already names the type for every category. The owner chose on 2026-11-13 to show the type on `/review` for every typed category, not only for Refrigerants.

## What Changes

- **Review queue row:** the Category cell names the record's activity type with its catalogue label in the user's language, for example "Refrigerants (R-410A)" or "Soğutucu Akışkanlar (R-410A)". It does this for every category that has activity types. A record without a type, or in a category that has none, shows the category alone, as today. The anomaly and first-period markers stay where they are.
- **Review sheet:** the title names the type in the same way, for example "Refrigerants (R-410A) · Annual 2026".
- **Labels:** the label comes from the activity-type catalogue that Data Entry uses (`dataEntry.activityTypes`, TR and EN). A value outside its category's list is shown as stored. The legacy `unspecified` type shows the existing "not specified" wording. No new message copy is added.
- **One web helper:** a pure helper in `apps/web/lib/vocabulary.ts` (an `activity` word on `RecordWords`, plus `categoryWithActivity`) does the resolution and is unit-tested. Data Entry's own copies are not changed in this change.
- No API, `@tonyai/shared-types` contract, Prisma or migration change. The list endpoint the queue uses already returns `activityType` on every row, and the sheet reuses that row.

Out of scope: the gas in the `/emissions` drawer and History table (LP7-07, after G6); merging Data Entry's three local label helpers into the new one (filed under Open questions).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `record-lifecycle`: ADDED a requirement that the review queue row and the review sheet name each record's activity type with its catalogue label, in Turkish and English.

## Impact

- `apps/web/app/review/page.tsx`: the Category cell and the sheet title.
- `apps/web/lib/vocabulary.ts` and its spec: the `activity` word and `categoryWithActivity`.
- `e2e/`: a new spec that seeds two Refrigerants records differing only by gas and checks the queue and the sheet in EN and TR. Existing `/review` specs are rechecked for exact-text matches on the Category cell.
- `docs/roadmap_docs/project_status_roadmap_phases.md`: the owner's scope choice of 2026-11-13 in the Decisions log. Current status and Next up are updated in the archive PR, as for changes 1 to 6.
- Deploy: an image-affecting web change, so the merge deploys QA automatically. There is no migration and no preflight.
