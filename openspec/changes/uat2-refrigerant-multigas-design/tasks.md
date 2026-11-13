# Tasks

This change is design only. No task touches code, a migration, the API contract or the UI. LP7-07 builds the design after G6.

## 1. Fresh-eyes review of the design

- [x] 1.1 Ask an `architect`-seat reviewer to check `design.md` D1–D9 against the code. The reviewer gets a self-contained prompt: the branch, the design, and the code paths named in its Context. The checks are:
  - does the slot-derived set (D1, D2) match the uniqueness index;
  - is the per-record save (D3) safe under partial failure and concurrent edits;
  - is anything lost when the set form replaces the single-gas form (D4: Edit mode, Move, identity-change band, recall, void-copy);
  - does the evidence flow (D6) hold under the author-only and one-subsidiary rules.

  Fix every correctness finding in the design. File P3s under the design's Open Questions. Verify: the reviewer's list of what it checked and what it found is recorded for the PR body.
- [x] 1.2 Ask a `data-factors`-seat reviewer to check D10 (CO2). The checks are:
  - the row's value and source cite `Revision MD.md` §4.6 exactly;
  - the edition shape follows `tr-mgo-2026-11` (separate release, ordinal, `YEARS`);
  - `gas: 'CO2e'` with `all_ghg` is right for a CO2 refrigerant row;
  - the boundary mapping CHECK and its parity spec are the only schema touch;
  - fire extinguisher and suppression leak rates apply to CO2 as written.

  Fix every correctness finding in the design. Verify: the review is recorded for the PR body, and D10 states no value that is not in the signed package.

## 2. Status file

- [x] 2.1 Add a dated Decisions entry to `docs/roadmap_docs/project_status_roadmap_phases.md` with the owner's four answers of 2026-11-13:
  - save through today's per-record endpoints;
  - the set form replaces the single-gas form;
  - the gas on `/review` ships before the pilot as `uat2-review-shows-gas`, an exception to the pre-pilot rule;
  - CO2 is in LP7-07, as a new TR edition from §4.6.

  The entry also gives the "rejected → draft" mapping. Verify: the entry names this change and design D3, D4, D8 and D10.
- [x] 2.2 Update the LP7-07 card (B5) and its ledger row:
  - link `design.md`;
  - list the build's parts: the set form, the `/emissions` gas, and CO2 (catalogue, edition, the expand-only CHECK migration);
  - state that no new endpoint is needed;
  - state that the CO2 part can be moved ahead of the pilot on the owner's word.

  Verify: the card has no claim that the design does not make.
- [x] 2.3 Update Next up item 4:
  - change 6 `uat2-refrigerant-multigas-design` is done as a design;
  - change 7 `uat2-review-shows-gas` is the next change (owner, 2026-11-13).

  Add a Current status entry for change 6, applying the entry-count rule (move the oldest entries to the Archive if needed). Verify: Next up's head and Current status agree, and Current status stays within the rule's count.
- [x] 2.4 Ask the owner for the second run of the hosted read-only query of change 5 (after the `ci56-1` deploy). If a result is given, record it in change 5's Current status entry in place of "still to be done". If none is given, leave the note as it is. Verify: the entry either holds the counts or still says "still to be done".

## 3. Validation

- [x] 3.1 Run `openspec validate uat2-refrigerant-multigas-design --strict` and verify it passes with `skip_specs: true`.
- [x] 3.2 Check that every file path and migration named in `design.md` exists on the branch (`ls`/`grep` for each), and that `git diff --stat origin/main` lists only `openspec/changes/uat2-refrigerant-multigas-design/` and the status file. Verify: no code, migration or `docs/api` file in the diff.

## Workflow follow-up

- Commit and push only on the owner's word. The PR is docs-only, so the QA deploy skips it (non-image merge), and the owner merges.
- Archive the change (`/opsx:archive`; no specs to sync). It can be archived in the same PR before merge, because nothing deploys. If so, the LP7-07 card's link points at the archived path, `openspec/changes/archive/<date>-uat2-refrigerant-multigas-design/design.md`.
- Next: `/opsx:propose uat2-review-shows-gas` from a fresh branch off `origin/main`.
