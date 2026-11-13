# Proposal

## Why

UAT round 2 (BUG-R2-08, SORU-3) found that a facility with 2 to 4 refrigerant gases needs 2 to 4 separate Data Entry passes. Typical gases are a CO2 extinguisher, an FM200 system, R-410A or R-32 air conditioners and SF6 in a transformer. The team answered K5 on 2026-11-11 (Decisions 2026-11-12). Option A shipped in `uat2-team-decisions-copy`: one record per gas, an easy way to attach one file to all of them, and the accepted-documents guidance. Option B is next: one form takes several gas lines and writes one record per gas. A reviewer rejects only the wrong gas, and reports stay per gas. Option C, a true multi-gas record, was rejected. The build is LP7-07 and waits for G6. This change produces its design now, while the team's answers and the code are fresh, so LP7-07 starts from settled decisions.

## What Changes

- **A design document for LP7-07, and nothing that runs.** It contains no code, no migration, no API contract and no UI change, and the system's behaviour is unchanged. The change opts out of spec deltas (`skip_specs: true`). Specs describe behaviour, and none changes here. The draft requirements LP7-07 will carry as its spec deltas are written in `design.md`, so the build copies them instead of re-deriving them.
- **The design settles:**
  - what one form covers: one subsidiary, one location (or the whole company) and one reporting year;
  - how the form maps onto today's one-record-per-gas slots, including existing records;
  - how a save writes, edits and removes gas records, and what happens when only part of a save succeeds;
  - how one evidence pack reaches every gas record;
  - how a reviewer sees and rejects one gas;
  - what stays per record (anomaly verdict, calculation snapshot, D01, lock).
- **The owner's answers (2026-11-13) to the design's approach questions:**
  - Save through today's per-record endpoints, not a new all-or-nothing endpoint.
  - The set form replaces the single-gas form for Refrigerants.
  - The gas shown on `/review` ships before the pilot, in its own small change (`uat2-review-shows-gas`, next). Today, under option A, a reviewer facing three refrigerant records for one facility cannot tell from the queue which gas each one is. The owner chose this as an exception to the pre-pilot rule.
  - CO2 is in the design. There is no CO2 gas type or factor row today, so the team's "CO2 extinguisher" example cannot be entered. The reviewer-signed TR package lists CO2's GWP as 1. LP7-07 adds it through an erratum of the TR IPCC edition (owner, 2026-11-13). The erratum, rather than a supplementary edition, follows the rule that a missing row is an erratum.
- **A fact recorded, not changed:** the team memo's "rejected → draft" wording is today's `rejected` state, which the author edits and resubmits. No new transition is needed.
- **Status file:**
  - The LP7-07 card points to the design and lists its decisions.
  - The Decisions log records the owner's answers.
  - Next up lists `uat2-review-shows-gas` as the next change.

## Capabilities

### New Capabilities

None. This change is design only (`skip_specs: true`). LP7-07 will modify `activity-data-entry`, `record-evidence` and `record-lifecycle`. The draft requirements are in `design.md`.

### Modified Capabilities

None.

## Impact

- **Code, API, database, shared types:** none.
- **Docs:**
  - `openspec/changes/uat2-refrigerant-multigas-design/design.md`, which is the deliverable. After archiving, it lives under `openspec/changes/archive/`, and the LP7-07 card links it.
  - `docs/roadmap_docs/project_status_roadmap_phases.md`: the LP7-07 card, Decisions and Next up.
- **Deploy:** none, because the change touches no image.
- **Later (LP7-07, not this change):**
  - web: Data Entry gets the gas-set form for Refrigerants, and the `/emissions` drawer shows the gas;
  - no new endpoint (design D3);
  - CO2: a catalogue entry, an erratum TR IPCC edition carrying the package's leak rates, and one expand-only migration that widens the boundary mapping CHECK (design D10);
  - tests: unit, e2e.
