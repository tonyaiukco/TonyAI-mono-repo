# Design

## Context

See `proposal.md` for the motivation. What the code holds today (read on `main` at `ce3b1911`):

- **One copy of the rule.** `capacityMethod` in `apps/api/src/calculations/tr-rules.ts` builds one
  `RefrigerantTerm` per equipment line (`capacityKg`, `leakRate`, `leakedKg = capacity × rate`, `refillKg`) and
  prices `Σ (leakedKg + refillKg)`. Its one caller is `CalculationsService.compute`, on the Türkiye branch only.
  Fire suppression is an equipment type of the same category, so it is the same code. The preview endpoint and the
  bulk dry run call the same engine. No web code computes the leak.
- **"No refill" is `refillKg: 0`.** The field is required in the DTO, the database CHECK and the bulk template
  ("Write 0 for none"); there is no null.
- **One reader re-derives a line's mass.** `apps/api/src/common/calculation-inputs.ts` prints
  `leakedKg + refillKg` in live reports, new issuances and their exports. Totals, dashboards and the anomaly
  baseline read only the stored `tCo2e`.
- **There is no rule or engine version.** `snapshotSchema` is 3. `compareSnapshots` treats any difference between
  the stored snapshot and a fresh calculation as stale, and submit and approve refuse a stale record with
  `calculation_stale` (K11). An unknown key counts as a difference.
- **The database refuses to rewrite a committed snapshot.** The trigger `activity_records_snapshot_immutable`
  raises when `calculation` or `parameters` change on a record that is not `draft` or `rejected`.
- **No path re-prices a draft.** A stale draft is found only when its author submits it. `update` is author-only
  and audits as `update`. The nearest operator tool, `packages/db/scripts/anomaly-recompute.mjs`, is plain
  JavaScript and cannot run the engine.

## Goals / Non-Goals

**Goals:**

- One rule, in one place, read by the engine and by the report text.
- A committed sum-rule snapshot and a new refill-rule snapshot can be told apart from the snapshot alone.
- Records the rule does not touch keep byte-identical snapshots.
- Open drafts are re-priced by a tool that cannot reach a committed record, even if its own checks were wrong.

**Non-Goals:**

- A general "re-price every stale draft" tool. This one selects by the refill rule's own condition.
- A rule or engine version on the snapshot.
- Any change to the equipment line's inputs, the leak rates or the ceiling's numbers.
- Changing how a stale submitted record is handled (decision 5).

## Decisions

### 1. A line is priced on its refill when `refillKg > 0`

`leak = refillKg` when `refillKg > 0`, otherwise `capacityKg × leak rate`, per equipment line; the record is the
sum of its lines × GWP. Zero already means "no refill" everywhere, so "known" needs no new input. The rule is per
line, not per record: BUG-17 states it for a piece of equipment, and a record holds several equipment types.

*Alternative:* a record-level rule (any refill on the record switches every line to refill). It would price a line
with no refill at zero, which no document asks for.

### 2. The snapshot marks a refill-priced line, and only that line

`RefrigerantTerm` gains an optional `pricedBy: 'refill'`. The engine writes it on a line with `capacityKg > 0` and
`refillKg > 0`, and on no other line. `leakedKg` stays `capacity × rate`: on a marked line it is the estimate that
was not added, which the report names. A shared helper gives a term's priced mass
(`pricedBy === 'refill'` → `refillKg`; otherwise `leakedKg + refillKg`), and both the engine's sum and the report
reader call it, so the rule has one reading.

A term with no marker reads as the sum. That is right for every committed sum-rule snapshot, and it is also right
for a new line with no refill (`leakedKg + 0`) or no capacity (`0 + refillKg`). So those snapshots are
byte-identical under both rules and K11 does not refuse them.

*Alternatives:* (a) write `leakedKg: 0` on a refill-priced line and keep the term shape: the sum then reads right
with no marker, but the field would stop meaning `capacity × rate`, the estimate would be lost, and a sum-rule line
could not be told from a new one in the report text. (b) Bump `snapshotSchema` to 4: every open Türkiye record,
gas and electricity included, would be refused as stale for no change in its figure. (c) Mark every line with its
basis: every open refrigerant record would be stale, including the ones whose figure does not move.

### 3. Reports explain the mass used for a marked line

`calculation-inputs.ts` picks `inputsLineRefill` for a marked term and keeps `inputsLine` for every unmarked
term, including a refill on a zero-capacity line. The new key goes into both catalogues (`reports/i18n` and
`report-issuances/i18n`) and names the refill as the released mass, the capacity and rate, and the exclusion of
the estimate. Live and issued PDF and XLSX use their Turkish or English locale. Live and issued CSV use the
English calculation-inputs text and keep their existing columns.

`ISSUANCE_RENDERER` moves to `tonyai-issuance-pdf-v6` and `ISSUED_TABLES_RENDERER` moves to
`tonyai-issuance-tables-v6`. The issued workbook names the tables version on its Summary sheet. A previously
issued PDF is served from its stored bytes.

*Alternative:* one sentence for both, with the estimate shown as `0`. It would print arithmetic the engine did
not do.

### 4. Re-pricing is an API command, narrow by selection and safe by the record lock

A new `DraftRepriceService` and `draft-reprice.cli.ts` under `apps/api/src/activity-records/`, with a
`draft-reprice` package script, built on a Nest application context like the factor-release and onboarding CLIs.

- **Selection:** records in category Refrigerants, status `draft` or `rejected`, whose stored `parameters` hold
  a line with `capacityKg > 0` and `refillKg > 0`. Only a Türkiye record can hold equipment lines (the engine
  refuses parameters elsewhere), so the condition is the rule's own. `rejected` counts as an open draft
  (owner, 2026-11-24). The review queue lists `submitted` and `under_review` records whose stored snapshot
  has an unmarked term with both masses above zero. A new-rule snapshot has markers on those terms and stays
  out of that list. If a candidate lacks the terms needed to identify the rule, report it separately as
  unclassified. Every review-queue candidate is read-only for this command.
- **Per record:** recompute with the engine from the stored inputs, outside any transaction (the engine reads the
  library in its own REPEATABLE READ snapshot and must not be handed a transaction client). If the result equals
  the stored snapshot (`compareSnapshots`), nothing is written: this is what makes a second run a no-op. A refusal
  from the engine is reported and nothing is written.
- **Write:** under the record's lock, in the existing lock protocol: the status is still `draft` or `rejected`,
  the period identity and engine inputs are the ones that were read (`samePeriod` and `sameEngineInputs`),
  and the period is open. Compare the locked snapshot with the recomputed one using `compareSnapshots`.
  If they match, report the record as already up to date with no write or audit, including when another
  run just re-priced the row. If the locked snapshot differs structurally from the initial read, report
  `snapshot_changed` and skip it.
  Otherwise re-derive the anomaly verdict and write the `calculation`, the three anomaly columns, and one
  `reprice` audit row with a null user and the figure before and after in the same transaction. Status,
  author, inputs and evidence stay as read under the lock.
- **Scope of the engine call:** the record's own subsidiary. The command is an operator tool over the whole
  database, like `anomaly:recompute`; it takes no tenant from a request.
- **Switches:** dry run by default, `--apply` to write, `--allow-remote` required for `--apply` off a loopback
  database, as `factor-release` has it.
- **Output:** counts, and per record its id, status, and tCO2e before and after; skipped records with the reason
  (`locked_period`, `no_longer_open`, `inputs_changed`, `snapshot_changed`, the engine's refusal).
  List legacy review-queue records and unclassified review-queue records separately.
- **Audit verb:** `reprice` joins `AUDIT_ACTIONS`. `rescore` is the precedent: a system act with no user, kept
  apart from `update` so "who changed this figure" stays answerable. The audit viewer gets its label in both
  catalogues.

The database trigger is the second wall: a write to a committed record fails there even if the status check were
wrong. An integration test proves both walls.

*Alternatives:* (a) a SQL migration that rewrites the drafts: a second copy of the rule in SQL, applied by the
QA auto-deploy with no dry run. (b) Re-price at API start-up: the same, and hidden. (c) Extend
`anomaly-recompute.mjs`: it cannot run the engine. (d) Call `update()`: it is author-only, audits as `update`
with the author's name, and re-runs gates that belong to an edit.

### 5. Submitted and under-review records are left to K11

A `submitted` or `under_review` record with both masses is refused `calculation_stale` at approval, returns to its
author (reject, or recall while `submitted`), and is priced under the new rule when saved again. This is what the
spec already says for any record priced by an earlier rule, and the database forbids the alternative. Until then
the record counts in totals at its sum-rule figure, as it does today. The command lists these records so the
owner knows which ones will come back.

The owner's decision 8 names approved, locked and draft records; it does not name these two statuses. **The owner
confirmed this reading on 2026-11-24:** `submitted` and `under_review` records are left to the stale refusal, and
the command only lists them.

*Alternative:* return them to `draft` by the command and re-price them. It would be a new status transition made
by no user, on records a reviewer may have open, and the lifecycle spec allows only the author's recall.

### 6. The refill ceiling keeps its numbers

`min(1.25 × capacity, 500 kg)` stays. Under the new rule the refill is the whole leak of its line, so the check
matters as much as before. Its comment in `shared-types` and its paragraph in
`docs/md_docs/validation_anomaly_rules.md` cite the sum formula and are corrected. The probe's SQL mirror holds
numbers only and does not change.

*Alternative:* a new ratio. No document asks for one, and a number is not invented here.

### 7. Wording on screen and in the template

`dataEntry.inputs.equipmentHelp` (TR and EN) and the bulk template's refill column note say "the refill, when
there was one, is the line's leak; the estimate from the capacity applies only without a refill". The leak-rate
choice stays on every line: it is still stored, and it prices the line again if the refill is removed. WP3
reshapes this form, so nothing else moves here.

## Risks / Trade-offs

- [Submitted records with both masses are refused at approval after the deploy] → The command lists them; the
  refusal text already says the record returns to its author. Named in the PR's QA note.
- [The number of affected drafts on hosted QA is unknown] → The dry run answers it before anything is written;
  running it there is an owner release, not part of this PR.
- [A re-priced draft's `updatedAt` moves] → An author with the draft open on an older version gets the existing
  `record_changed` answer on save and reloads. Correct, and rare.
- [A line with both masses and a leak rate of zero gets the marker although its figure is the same] → No release
  holds a zero rate; the record would be re-priced to the same figure.
- [The alternative rate has no effect on a line with a refill, yet is still offered] → Kept on purpose
  (decision 7); the help text says how the line is priced.
- [WP3 touches the same form, catalogues and equipment line type] → This change lands first and keeps the input
  shape unchanged.
- [A reader outside the API that sums `leakedKg + refillKg`] → None exists today (the one reader is
  `calculation-inputs.ts`); the helper in `shared-types` is the one way to read a term from now on.

## Migration Plan

1. Merge; the QA auto-deploy rolls out the API and web images. No database migration.
2. From the deploy on, new saves and previews follow the new rule. Committed records are unchanged. Open drafts
   with both masses are refused at submit until re-priced or saved again.
3. Owner release: run `draft-reprice` on hosted QA as a dry run, review its list, then `--apply --allow-remote`.
4. Rollback: the previous image is safe only before the first marked snapshot is saved. After the first such
   write, use a fallback revision verified to render both stored rules correctly or fix forward. The previous
   image reads the FM200 example's marked term as 36 kg released while its stored figure remains 126.00 tCO2e.
   Verify compatibility using an unmarked sum-rule and a marked refill-rule record in live reports and
   on-demand issuance exports. Previously issued PDF bytes stay as issued.
