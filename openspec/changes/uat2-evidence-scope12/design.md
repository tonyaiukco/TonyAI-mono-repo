# Design

## Context

See proposal.md for why. The evidence rule is one shared list, `EVIDENCE_REQUIRED_CATEGORIES` in `packages/shared-types/src/index.ts`, with two helpers: `isEvidenceRequired(category)` and `needsEvidenceBeforeSubmit({ category, evidenceCount })`. Every consumer reads them:

```text
 EVIDENCE_REQUIRED_CATEGORIES (shared-types)
   |
   +--> API submit gate        activity-records.service.ts submit()
   +--> evidenceReadyWhere()   import batch "send drafts" query
   +--> bulk-upload warning    bulk-upload.service.ts
   +--> bulk-submit codes      bulk-submit.service.ts
   +--> tracking matrix        emissions.service.ts (evidenceMissing)
   +--> web vault badge/note   evidence-vault.tsx
   +--> web bulk checkbox      bulk-submit-view.ts
   x    API approve()          <-- no check today
   x    Data Entry Submit      <-- relies on the server's 400
```

Files can be attached or detached only on draft and rejected records (`evidence.service.ts`), and a detach takes the record's row lock, so a count read under that lock holds until the status changes. The only approve path is `POST /api/v1/activity-records/:id/approve`.

## Goals / Non-Goals

**Goals:**
- One list change reaches every consumer above; the two `x` gaps are closed by hand.
- The approve check is as strong as the submit check: under the row lock, in a fixed position in the refusal order.

**Non-Goals:**
- No new evidence storage, no evidence types, no per-category file kinds.
- No data migration and no exemption of existing records.
- No move of the vault in the form's layout (BUG-R2-05).

## Decisions

### D1. Keep the list explicit and pin it with an invariant

Add the three categories to the list in `CATEGORIES` order. Do not derive the list from `CATEGORY_SCOPE_MAP`.
- **Why:** Water is a Scope 3 exception (WP17). A derived rule would need an exception anyway, and a reader of the explicit list sees the whole rule.
- **Guard:** a shared-types test asserts that every category with scope 1 or 2 is in the list, and that among Scope 3 categories only Water is. Today's gap could not recur unnoticed: a future Scope 1 category that is missing from the list fails the test.
- **Alternative rejected:** derive the list as "scope 1 or 2, plus Water". It is shorter, but it hides Water's reason, and it would quietly require evidence for a new Scope 1–2 category without anyone deciding that.

### D2. Gate approve, not only submit (owner, 2026-11-10)

`approve()` counts evidence links under the row lock after the self-approval (D01) and period-lock checks, and before C8 and K11.
- **Why:** records submitted before this change would otherwise reach the inventory without a file. This is the C8 precedent (2026-10-13): a new commit-time rule is enforced at both submit and approve.
- **Order:** the order matches submit (period lock → evidence → C8 → K11). Evidence goes first among the content checks because its remedy (reject, attach, resubmit) also covers the other two: the author saves the record again on resubmit.
- **Exemptions:** none by date or audit row, which C8 rejected as forgeable.
- **Count:** the count query runs only when the category could need a file, as at submit.
- **Alternative rejected:** gate submit only, and accept that pre-change records can still be approved. That leaves a known hole in a compliance rule.

### D3. A separate refusal code at approve

The new class sits beside `EvidenceRequiredError` in `apps/api/src/activity-records/errors.ts` and uses a new code, `approval_evidence_missing` (noun-first like `self_approval_forbidden`; first drafted as `approve_evidence_missing` and renamed after the architect review, before merge), with params `['category']`. Its English message says the category has no evidence file and that the approver should reject the record so its author can attach one.
- **Wiring:** the code is registered in the shared-types error registry with HTTP 400 and a frozen param list. It is added to both catalogues following the `localise-ui` skill, and the existing parity tests cover it.
- **Why:** `evidence_required`'s copy says "before submitting", and an approver does not submit. The approver can only reject.
- **Alternative rejected:** reuse `evidence_required` with a `stage` param. That puts a branch in every consumer's copy, and the bulk-submit and import codes, which are submit-only, would have to ignore it.

### D4. Data Entry pre-check mirrors the anomaly pre-check

In `handleSubmit` (`apps/web/app/data-entry/page.tsx`), after `persist()` succeeds and the saved record becomes current, the form checks `needsEvidenceBeforeSubmit({ category, evidenceCount })` before the anomaly check. When it is true, the form shows a toast and returns without calling the API.
- **Count:** the saved record's own `evidenceCount`. Create returns 0 and update returns the record's live link count, so the check reads the server's number from the save it just made rather than the vault's client state.
- **Why this works:** the form already keeps the saved record current, so its id is set and the vault renders. This closes QA's "the upload area never appears".
- **Alternative rejected:** show the vault before the first save. The vault needs a record id to upload against, and adding that is a layout and flow change that belongs to BUG-R2-05.

### D5. Copy

The evidence catalogue's `requiredNote` is broadened in TR and EN to cover fuel receipts or fuel cards, service records and leak reports. It names no category, because the vault shows the category beside it. The pre-check toast gets a new `dataEntry` key in both catalogues.

## Risks / Trade-offs

- **[Records in review on hosted QA]** Records in the three categories, submitted with no file, stop being approvable after deploy. → Note it in the PR and the status file. Reviewers reject them. QA data is synthetic.
- **[Approved records on hosted QA]** Approved records without a file turn their matrix cells incomplete and cannot gain a file. → Accepted (pilot not started). Void and re-enter (D04) if a clean dashboard is needed.
- **[Bulk import of fleet and refrigerant data]** These rows can no longer be bulk-submitted without one file per record. → Accepted by K3. A shared evidence package is K5's question.
- **[Stale `dist`]** The API and web import shared-types from `dist`. → Rebuild before the test runs, and let CI's build order catch it.
- **[Exact-array assertions]** Specs that assert exact warning lists for MGO and refrigerant rows break. → Run every suite (unit, integration, e2e) and fix the expectations, not the rule.
- **[Refusal order drift]** A later gate could be inserted before evidence at approve. → A unit test pins approve's order against period lock, C8 and K11.

## Migration Plan

- **Schema:** none. No migration, no backfill.
- **Deploy:** the normal QA deploy. After it, a read-only count of committed records with no file in the three categories, per status, tells the owner what QA will see.
- **Rollback:** revert the PR. No data depends on it.
