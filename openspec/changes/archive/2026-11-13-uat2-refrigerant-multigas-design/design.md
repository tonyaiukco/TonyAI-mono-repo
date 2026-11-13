# Design

This is the design for LP7-07, the multi-gas refrigerant form. This change builds nothing. The motivation and scope are in `proposal.md`. The owner answered the design's approach questions on 2026-11-13 (D3, D4, D8, D10 and D10's erratum).

## Context

What exists today (code read 2026-11-13, `origin/main` a28c68bb, checked by the `architect` and `data-factors` reviews):

- **One record is one gas.** A Refrigerants record keeps its gas in `activity_type` and its quantity in kg. Under TR rules its equipment lines live in `parameters.equipment[]` as `{equipmentType, capacityKg, refillKg, leakRateChoice}`. A DB CHECK allows at most one line per equipment type. The record's value must equal the sum of its capacities (`equipment_sum_mismatch`), and a TR record without lines is refused (`parameters_required`). TR rules are annual and kg only (`calculations.service.ts:623-644`). The capacity method computes Σ(capacity × leak rate + refill) × the gas's GWP (`tr-rules.ts:123-157`). Leak rates are read from the pricing factor's own release (`factor-lookup.ts:212-213`). The snapshot keeps each line's terms. Geography is set per location (`page.tsx:442`). Outside TR there are no lines, and a record may be monthly or quarterly.
- **The uniqueness slot** is `(subsidiary_id, location_id, reporting_year, reporting_period, period_value, category, activity_type) NULLS NOT DISTINCT WHERE status <> 'voided'` (`20261004120000_lp3_03_factor_model:344-348`). Several gases already share one subsidiary, location and year. The same gas twice is refused (`record_duplicate`). Trigger TA002 refuses a slot that mixes a typed and an untyped record (`activity_type_slot_conflict`, 409).
- **Every write and every step is per record:**
  - create, update and delete each run in their own transaction and write their own audit row;
  - edit is author-only, on `draft` or `rejected`;
  - submit, recall, approve and reject each act on one record;
  - D01, `seenSubmittedAt` and the period lock are checked per record.

  The anomaly baseline is filtered by gas (`activity-records.service.ts:914-925`), so one gas's write never changes another gas's verdict.
- **Batch paths and previews:**
  - `POST /activity-records/bulk-submit {recordIds}` accepts **drafts only**. A rejected record answers `not_submittable` (`bulk-submit.service.ts:271-279`).
  - The update path has no version check from the client.
  - There is no preview route for records. The web preview is `POST /calculations/preview`, which returns the calculation snapshot. The anomaly verdict comes back with the saved record (`page.tsx:1446-1473`).
  - `previewCreate` is internal to the bulk import.
- **Evidence:**
  - `POST /evidence` (`uploadForRecords`) links one file to many records. The upload is refused unless every record is in one subsidiary, is the user's own, is editable and is in an open period. It is all or nothing, with at most 1000 links (`evidence.service.ts:253-389`).
  - Refrigerants require evidence, checked at submit and at approve.
  - Option A shipped the accepted-documents list and the shortcut that attaches one file to the year's other gas records.
- **Drafts and rejected records count nothing** (`COUNTED_STATUSES`).
- **Gaps:**
  - `/review` (queue and sheet) and `/emissions` show the category but not the gas.
  - The gas catalogue has no `CO2`. The reviewer-signed TR package (`docs/md_docs/Revision MD.md` §4.6) lists "CO2 = 1" among its AR6 GWPs. The IPCC release `TONYAI-EF-TR-UK-2026.11-AR6-SEALED` (ordinal 1, `tr-2026-11/ipcc.json`) did not take that row.
  - The boundary mapping CHECK `inventory_sources_mapping_check` is the only database object that lists the gases (`20261110120000_uat2_marine_gas_oil_mapping`, parity spec `boundary-schema-parity.spec.ts`).

## Goals / Non-Goals

**Goals:**
- One Data Entry form for all of one facility's refrigerant gases in one period. It writes, edits and removes one record per gas, through the paths that exist today.
- A wrong gas is rejected and corrected on its own; the other gases go on to approval.
- One upload per file offers it to every gas in the set that the user may attach to. A gas that is still missing a file is named.
- CO2 extinguishers and CO2 systems can be entered and priced from the signed package.
- Draft requirements, so that LP7-07 starts with its spec deltas written.

**Non-Goals:**
- A record holding several gases (option C, rejected by the team).
- Any change to calculation, the snapshot shape, the anomaly ceilings or reports. Every gas is still its own record.
- An all-or-nothing save across gases (owner, 2026-11-13; D3).
- A new API endpoint, including a record preview.
- Fugitive Gas, which has a fixed type and no lines.
- The bulk import.

## Decisions

### D1. One set = one subsidiary, one location (or whole company), one period

A set is the uniqueness slot with `activity_type` left free: Refrigerants, one subsidiary, one `location_id` (null means the whole company), one reporting year, one period and one period value.

- **Under TR** the period is fixed to annual. Rows have equipment lines, and the total capacity is computed.
- **Elsewhere** the header takes the period and period value. Rows take a quantity in kg, as today's single-gas form does.

The team counts gases per facility (K5 question 2), and equipment sits at a facility. Refrigerants records of the same subsidiary, location and year in another period are listed under the set as "outside this set", with Open and Move.

*Alternative considered:* a set per subsidiary and year, across locations (the option A shortcut's scope). Rejected: it mixes facilities and breaks one row per gas (D5).

### D2. A set is derived from the slot; no group id

The form loads every non-voided Refrigerants record in the slot as a gas row, so records entered one by one or by the bulk import join with no backfill.

**An untyped record** (written before LP3-03) shows as a row whose gas must be named first. Until it is named or removed, no new row is offered, because TA002 would refuse every new gas in that slot.

*Alternatives considered:*
- A new `entry_group_id` column: it needs a migration, leaves existing records outside every group, and can disagree with the slot.
- Reusing `importBatchId`: its meaning is "came from one file", and bulk submit acts on it.

### D3. Saving goes through today's per-record endpoints (owner, 2026-11-13)

**Before saving**, each new or changed row gets today's calculation preview (`POST /calculations/preview`). Each row then shows its own calculation, or the refusal it would get.

**An out-of-date figure is a change too** (owner review 2026-11-13, P2-3). When the set loads, each of the user's own editable rows is previewed from its stored inputs. A row whose stored snapshot differs from the preview is marked "figure out of date", and Save includes it, typically after a factor edition such as D10's erratum withdrew the release it was priced on. K11 refuses such a row at submit (`calculation_stale`). Save sends it as a `PATCH` with its unchanged inputs, the audited re-save K11 asks for, which recomputes the snapshot. If a submit still answers `calculation_stale`, because the library changed after the set loaded, the row is marked the same way and the user saves again. The comparison is made by the existing staleness rule (`snapshot-staleness.ts`), shared with the web or mirrored there, so the form and K11 cannot disagree.

**On Save**, the form first re-reads the slot. Any loaded row whose `updatedAt` or status has changed since it was opened is refused as "changed since opened" (best effort, see Risks). The form then sends one call per changed row:

| Change in the form | Call |
| --- | --- |
| New gas row | `POST /activity-records` |
| Changed row, editable by the user (own draft or rejected record, open period), or marked "figure out of date" | `PATCH /activity-records/:id`, the update Edit mode uses. A change of quantities or equipment lines keeps the record's identity and shows no band. A change of the row's **gas** is an identity change, handled as D5 says. |
| Own draft or rejected row removed | the existing delete. Deleting a rejected row is allowed today; its review history then lives only in the audit log. |

**Running the calls:**
- The calls run in sequence. A refusal on one row does not stop the next.
- A 401, a 403, a network error or a 5xx stops the run, and the rows after it are "not attempted".
- The form then reloads the slot. Each row shows whether it was saved, refused (with the server's reason) or not attempted, and refused rows keep their input.
- Rows that were saved stay saved. They are drafts and count nothing.
- **A row is "clean"** when its on-screen input equals its stored record, its last save did not fail and was not skipped, it is not marked "figure out of date", and none of its chosen files is still unuploaded or failed. Submit takes only clean rows (D7).

**The anomaly verdict and the variance-reason prompt** come back with each row's create or update response, as they do today. A flagged row asks for its reason before Submit.

*Alternatives considered:*
- An endpoint that writes the whole set in one transaction. Not chosen (owner): it needs a new contract and a refactor of `create` and `update` to share a transaction, while a partial set of drafts harms nothing and the reload shows exactly what exists.
- A record preview with the anomaly verdict before saving. It would need a new endpoint.

### D4. The set form replaces the single-gas form for Refrigerants (owner, 2026-11-13)

When Refrigerants is chosen, Data Entry shows the set:
- a header with the subsidiary, location, year, and the period outside TR;
- one row per gas, with a gas picker, its equipment lines under TR (today's `<EquipmentLines>`) or a quantity elsewhere, and the computed total.

A set with one gas is today's form. What today's form does carries over as follows:

- **Opening and Edit:** opening a refrigerant record, or choosing Edit on one, opens its set with that row in focus. Edit mode's rules apply per row: only the author's draft or rejected rows in an open period are editable. Other rows show their status and are read-only, with Recall offered on the author's own submitted row.
- **Header:** free on a new set, fixed on a loaded one, because it defines the set.
- **Move:** moving one gas record to another location, period, year or category is a correction of that record. A row action, "Move…", opens today's identity-change band for that record alone, and the record leaves the set when saved. A whole set entered under the wrong location takes one Move per gas.
- **Copy a voided record:** opens the target slot's set with a new pre-filled row. If that gas is already in the set (not voided), the copy is refused with an explanation.
- **Switching category:** switching category with unsaved rows asks before discarding them.
- **Other parts:** files chosen before saving (D6), the factor coverage legend and the evidence guidance stay on the set form.

### D5. One row per gas; one line per equipment type

A set holds at most one row per gas, mirroring the uniqueness index. A new row's gas picker hides the gases already in the set. Changing a row's gas is that record's update, and the new gas must not already be in the set. It is an identity change (`activityType`), so the row keeps today's Edit-mode band for that record (owner review 2026-11-13, P2-2, `activity-data-entry` "Edit mode saves identity changes to the same record" and "Edit mode states what happens to attached files"):
- the band shows the old and the new gas;
- each linked file gets a keep or remove choice, with the warning that a file backing no other record will be deleted;
- the band is shown before that row's save is sent; with no choice made, the files stay linked, as today.

An R-32 equipment document therefore never stays silently on a record that has become SF6. Several gas changes in one Save each show their own band. A row keeps the rule of at most one line per equipment type. A duplicate that still reaches the server gets `record_duplicate` on that row (D3).

### D6. One evidence pack, offered to every gas

- **Choosing files:** files chosen in the set form are held until Save, as BUG-R2-05 does today.
- **After the save:** the form offers each file to every attachable row of the set: the user's own draft or rejected rows in an open period, whether changed in this Save or not. Rows with no file yet are ticked in advance, and rows that already hold a file are not, which keeps option A's "no second copy unasked" rule. One `POST /evidence` call per file links the ticked rows. The set is one subsidiary, so `uploadForRecords`' one-subsidiary rule holds. Each upload is all or nothing.
- **Files chosen but nothing saved:** if files were chosen and no row was saved, the files are still offered to the attachable rows.
- **Rows of other authors** that have no file are named as needing their author's upload, because only the author may add evidence (`uat2-consultant-approval`).
- **A failed upload** leaves the saved drafts, as the requirement "A failed upload leaves a saved draft" says today. Every row the failed file was meant for keeps "upload failed" until the file is uploaded again or the user drops it, and that row is not clean (D3), so it cannot be submitted with its earlier evidence in place of the new file.
- **What stays:** the accepted-documents list stays on the set's Evidence section. The records table shortcut stays for records reached outside the form.

### D7. Review and rejection stay per record

- **Review:** a reviewer approves or rejects each gas record on its own, and `record-lifecycle` is unchanged. Rejecting R-32 leaves FM200 and R-410A free to be approved.
- **Correcting:** in the set form, the rejected row shows the reviewer's note and is editable, while the other rows follow their status. The team memo's "rejected → draft" is today's `rejected` state, which the author edits and resubmits. No new transition is needed.
- **Submit takes only clean rows (owner review 2026-11-13, P2-1).** The API submits what is stored, never what is on screen. A row whose newer input failed to save would otherwise send its old stored value: 100 kg stored, 120 kg on screen, and 100 kg submitted.
  - Submit therefore offers only the user's own rows that are clean (D3).
  - A row that is not clean is left out, with its reason: unsaved changes, save refused, not attempted, figure out of date, or upload failed.
  - Submit does not save on the user's behalf. The user saves first, and the form offers Submit only when at least one row is clean.
  - Clean draft rows go through `POST /activity-records/bulk-submit` (ids; drafts only; author only; one result per id). Clean rejected rows go one by one through `POST /activity-records/:id/submit`.
  - The form merges both answers per row. The evidence gate, the variance reason and K11 are still checked per record by the server.
- **The gas must be visible to the reviewer:** the queue and the review sheet gain it before the pilot (D8). LP7-07 adds it to the `/emissions` drawer.

### D8. The gas on `/review` ships before the pilot, in its own change (owner, 2026-11-13)

Under option A, which the pilot runs, a facility already has 2 to 4 refrigerant records, and nothing in the queue tells them apart. A small, web-only change, `uat2-review-shows-gas`, adds the gas to the review queue rows and to the review sheet: `activityType`, with its catalogue label. It is proposed next. The record already carries `activityType`, so no API contract changes. The owner chose this as an exception to the pre-pilot rule. It is not part of LP7-07.

### D9. What stays per record

Every gas is still its own record, so none of these change:
- the calculation snapshot;
- the anomaly verdict and the first-period ceilings per equipment line;
- the variance reason;
- D01, `seenSubmittedAt` and the period lock;
- the audit rows: one per record mutation, and no "set" audit row;
- the report rows.

### D10. CO2 joins the gas catalogue from the signed package, as an erratum (owner, 2026-11-13)

**The release is an erratum.** It is a new IPCC edition with ordinal 3, loaded with `--supersedes=TONYAI-EF-TR-UK-2026.11-AR6-SEALED` and a reason that names the omitted §4.6 row.
- **Contents:** every row and parameter of `tr-2026-11/ipcc.json` unchanged, plus the CO2 row. The edition stays inside the coverage it supersedes, plus that one identity. The MGO edition (ordinal 2) does not overlap and stays live.
- **Owner's choice:** the owner chose the erratum over a supplementary edition like MGO, following `factor-release-import`'s rule that a missing row is an erratum. It keeps one live set of leak rates. A supplement would have had to repeat all of them, and a later leak-rate correction would then need to supersede two editions.
- **The cost:** drafts priced by the old edition become `calculation_stale` and are recalculated on their next save (K11). Committed snapshots keep citing the withdrawn edition, unchanged.

**The CO2 row**, one per year in `YEARS`:
- `category: 'Refrigerants'`, `activityType: 'CO2'`, `gas: 'CO2e'`, `gasCoverage: 'all_ghg'`, `factorValue: 1`, kg to kg;
- the methodology string built as for the other gases;
- `source` as the other refrigerant rows give it (`build.mjs:214`, "IPCC AR6 WGI Table 7.15, via" the package §4.6).

GWP-100 of CO2 is 1 by definition, and §4.6 states it. Nothing is chosen at load.

**The edition carries the package's leak rates.** The validator refuses a TR refrigerant factor without a default `leak_rate` in its release (`index.ts:4050-4054`), and the engine reads rates from the factor's own release. Since the erratum carries every row of the edition it supersedes, all nine §4.6 `leak_rate` parameters, with their defaults and alternatives, come with it. Its spec asserts they equal `ipcc.json`'s. Nothing ties a gas to an equipment type, so a CO2 chiller line, for example, is priced at the chiller rate.

**Metadata:**
- `reviewedBy: 'TonyAI Sustainability Team'` (a team, not a person);
- `publishedAt` stays the package's seal date, 2026-11-04;
- `reviewedAt` is the date of the owner's review of the new row.

The edition joins the external review list (Decisions 2026-11-09 (5)) with its own question: **do §4.6's fire extinguisher (4%) and fire suppression (2%) rates apply to CO2 equipment?** The package lists its rates by equipment type with no limit by gas, so applying them to CO2 follows its table. Its cited basis, IPCC 2006 Vol. 3 Ch. 7, is written for fluorinated gases.

**The other parts:**
- **Catalogue:** `{ value: 'CO2', label: 'CO2 (carbon dioxide)' }` under Refrigerants, with TR and EN labels, plus its `"activity <label>"` entry in `apps/api/src/reports/i18n/{en,tr}.json` (keyed by the catalogue label, enforced by `report-vocabulary.spec.ts`). The catalogue uses ASHRAE names, in which CO2 is `R-744`. LP7-07 decides whether the bulk import accepts `R-744` as an alias.
- **Boundary CHECK:** a migration re-creates `inventory_sources_mapping_check` with `'CO2'` added to the Refrigerants list (the MGO pattern, with its parity spec). It only admits more, and no row is rewritten.
- **Reports:** CO2 appears as its own gas, because it is its own record (team, K5 question 1). No report column groups gases today. A future per-gas disclosure must map CO2 to CO2, not to HFCs.
- **Order:** the catalogue and the migration deploy first, because the validator accepts only a catalogued `activityType`. A dry run follows, then `--apply`.

This part does not depend on the set form. It also works with today's single-gas form, so the owner may move it ahead of the pilot as its own change. By default it ships with LP7-07. `factor-release-import`'s note on IPCC ordinals gains this edition's place in the load order.

*Alternatives considered:*
- A supplementary edition (not chosen, above).
- Mapping CO2 to an existing gas (wrong).
- Treating CO2 extinguishers as "not covered" (the team listed them as typical).

## Draft requirements for LP7-07

LP7-07 copies these into its spec deltas and refines the wording there.

**`activity-data-entry`**
- ADDED *Refrigerants are entered as a gas set.* When Refrigerants is chosen, Data Entry SHALL show one form for one subsidiary, one location (or the whole company), one reporting year and one period, with one row per gas. Each row is that gas's record.
  - *Scenario:* three gases at one TR facility → saving creates three annual records, one per gas, in one action.
  - *Scenario:* an existing slot → opening one of its records shows every non-voided gas record of that slot.
- ADDED *A gas appears once per set.* A gas already in the set SHALL NOT be offered for another row.
- ADDED *A save reports each gas.* Save SHALL re-read the slot, write each changed row through the per-record endpoints, continue past a row's refusal, stop on an authentication, permission, network or server error, reload the set, and show for each row whether it was saved, refused (with the reason) or not attempted.
  - *Scenario:* R-32 is refused and two others are saved → two drafts exist, and the R-32 row shows its refusal and keeps its input.
  - *Scenario:* a row changed in another tab since it was opened → that row is refused as changed, and the others are saved.
- ADDED *Submit takes only clean rows.* A set's Submit SHALL offer only the user's own rows whose on-screen input is stored, with no failed or skipped save, no out-of-date figure and no failed upload, and SHALL name each row it leaves out and why.
  - *Scenario:* R-32 is stored at 100 kg, the user types 120 kg and the save is refused → Submit leaves R-32 out as "save refused", and 100 kg is never submitted from this form.
- ADDED *An out-of-date figure is re-saved.* On load, a row whose stored snapshot differs from a recompute of its inputs SHALL be marked out of date, and Save SHALL re-save it with its inputs unchanged.
  - *Scenario:* after an erratum withdraws its release, an unchanged R-410A draft → it shows "figure out of date", Save re-prices it, and its submit passes K11.
- ADDED *A gas change keeps the identity band.* Changing a stored row's gas SHALL show the old and new gas and a keep or remove choice for each linked file, as Edit mode does today.
  - *Scenario:* R-32 with an equipment document becomes SF6 → before the save, the band shows R-32 → SF6 and offers keep or remove for the document, with the deletion warning.
- ADDED *Rows follow their record's status.* Only the user's own draft or rejected rows in an open period SHALL be editable. Other rows SHALL show their status and stay read-only.
- ADDED *An untyped record blocks new gases until named.*
- ADDED *One record leaves the set by Move.*
- MODIFIED *Catalogue for the pilot's Scope 1 sources*: adds the gas `CO2`.
- MODIFIED *Files can be chosen before the record is saved* and *The first save uploads the chosen files*: in a set, each file is offered to every attachable row, with rows that have no file ticked in advance.

**`record-evidence`**
- MODIFIED *A shortcut attaches one document to the year's gas records*: it remains in the records table. The set form's Evidence section offers a new file to the set's attachable rows and names the rows of other authors that still need a file.

**`record-lifecycle`**
- ADDED *One gas of a set is rejected alone.*
  - *Scenario:* R-32 is rejected while FM200 and R-410A are submitted → only R-32 is `rejected`, and the other two can be approved.
- ADDED *A set's Submit sends drafts in bulk and rejected rows one by one.*

**`emission-factor-library` / `emission-calculation`**
- ADDED or MODIFIED: a TR Refrigerants factor for `CO2` at GWP 1 from the signed package, in an erratum edition that carries the package's leak rates, priced by the capacity method like any gas.

(The `/review` gas display has its own requirements in `uat2-review-shows-gas`, D8.)

## Risks / Trade-offs

- [A save stops partway, and the user believes every gas was saved] → The per-row results after Save and the reload show exactly which records exist. Drafts count nothing.
- [Submit sends a stale stored value while newer input sits unsaved on screen] → Submit takes only clean rows, and the rest are listed with their reason (D3, D7).
- [A gas change carries the old gas's documents] → The gas change keeps today's identity band with a keep or remove choice for each file (D5).
- [After a factor edition, a draft cannot be submitted and the user cannot tell why] → On load, a row whose stored figure differs from its preview is marked "figure out of date", and Save re-saves it unchanged (D3).
- [Concurrent edits] → Edit is author-only, so two users never write the same row.
  - A colleague who adds the same gas gets `record_duplicate` on that row.
  - A `super_admin` deleting a draft causes a 404 on that row.
  - The same author in two tabs would overwrite silently, because the update has no client version check. D3's re-read before Save catches most such cases, best effort only; a server version check would be a new contract.
- [Evidence leaves a gas without a file] → D6 offers each file to every attachable row and names other authors' rows. The submit and approve gates still refuse a gas without a file.
- [The pilot has no CO2 entry until LP7-07, which waits for G6] → The CO2 part is independent of the form, so the owner may move it forward.
- [The erratum makes IPCC-priced drafts stale] → This is the K11 path: the set form marks those rows "figure out of date" and Save re-saves them unchanged (D3), and committed figures do not change. Loading it in a quiet window, with a note to QA or the pilot that drafts re-price, limits the surprise.
- [The 4% and 2% rates applied to CO2] → They follow the package's table as written, and the question goes to the external reviewer.
- [A large CO2 flooding system (> 500 kg on one line) in its first period] → It passes the 500 kg line ceiling (`REFRIGERANT_LINE_CEILING_KG`) and needs a variance reason, as any gas would.
- [A whole set entered under the wrong location] → One Move per gas (D4). This is acceptable for a rare correction.

## Migration Plan

- **This change:** nothing to deploy. It touches docs and the status file only, so its merge touches no image.
- **LP7-07 (for its own plan):**
  - the web set form and the `/emissions` gas;
  - CO2: the catalogue, the expand-only CHECK migration, deploy, then the erratum's dry run and `--apply` on hosted QA;
  - no new API endpoint;
  - rollback is the previous image, because set-form records are ordinary per-gas records. An applied erratum is not rolled back; a correction is a further edition.

## Open Questions

- **The set form's layout on a phone** (2 to 13 gas rows with their lines): to be worked out in LP7-07's UI work.
- **When the external reviewer checks the CO2 row and the 4% and 2% question:** with the rest of the TR external review list, or when LP7-07 starts.
- **Whether the bulk import accepts `R-744` as an alias for `CO2`:** an LP7-07 detail.
