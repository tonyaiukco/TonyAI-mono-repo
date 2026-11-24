# Design

## Context

See `proposal.md` for the motivation. What the code holds today (read on `main` at `3618f458`):

- **Fire suppression is already calculable, inside `Refrigerants`.** `EQUIPMENT_TYPES` holds
  `fire_suppression_system`, `fire_extinguisher` and `transformer_breaker` beside six cooling devices. The sealed
  TR package (`tr-2026-11/ipcc.json`, IPCC ordinal 1) prices HFC-227ea and SF6 under `Refrigerants` and carries all
  nine leak rates. CO2 is in no catalogue and no release.
- **The factor lookup matches the category exactly.** A record of another category finds none of the
  `Refrigerants` rows. Leak rates are read from the release of the factor that priced the record.
- **The refrigerant rules are keyed on the literal `'Refrigerants'`**, not on the parameter shape: the engine's
  rule choice and its release-parameters read, three rules of the release-import validator, the first-period
  ceiling and its SQL mirror, the bulk equipment-row grouping, and on the web the evidence note, the year's-gas
  shortcut and its reads.
- **A category is spelled out in six CHECK constraints**, each pinned by md5 in `runtime-role.mjs`:
  `activity_records_scope_check`, `activity_records_parameters_check`, the two boundary category checks,
  `inventory_sources_mapping_check` and `report_datasets_schema_check`. Fugitive Gas (commit `94b55602`) is the
  recipe: plain `DROP` and `ADD`, a new dataset schema version, parity specs.
- **A Scope 1 record without a figure breaks a final.** An uncalculated record makes its scope `partial`
  (`dataset-assessments.ts`) and raises `non_authoritative_calculation` at the issuance gate. Water never met this
  because it is Scope 3. The uncalculated snapshot also carries no activity type and no equipment lines, and its
  stored wording says the record is "tracked by invoice".
- **The web cannot ask which gases are priced.** `GET /factors/coverage` answers per geography and year only.
- **Every layer is in kilograms**: the field names, the DTO, the database jsonpath, the ceilings, the report text.
  No web input converts a display unit before sending.
- **D10 (owner, 2026-11-13)** planned CO2 as an erratum: IPCC ordinal 3 superseding the sealed edition, with CO2
  under `Refrigerants`. It is not implemented. Superseding withdraws the whole ordinal-1 release, so every open
  draft priced by it, in every category, answers `calculation_stale` until saved again; no tool re-prices them.

## Goals / Non-Goals

**Goals:**

- Fire suppression is a category of its own wherever a user, a boundary or a report sees categories.
- No formula, leak rate or existing factor value changes, and no committed record is rewritten or re-read.
- Every figure of the new category, the zero included, comes from a sealed library row with its source.
- The capacity-method rules have one definition that both categories use.

**Non-Goals:**

- Moving existing `Refrigerants` records that hold fire devices or fire gases, or refusing them.
- A stored display unit, or grams anywhere outside the Data Entry form.
- A gas list computed from the library at run time.
- A general tool that re-prices drafts after an edition.

## Decisions

### 1. `Fire Suppression` is a real category

The v4 documents treat each sheet of the data request form as a category, list its evidence apart from the
refrigerant list, and assign boundaries and users by category. A second entry point that stored `Refrigerants`
would satisfy none of these outside Data Entry. `CATEGORIES` gains `'Fire Suppression'` in Scope 1, with unit
`kg`, labels "Fire Suppression" / "Yangın söndürme" and matrix short labels "Fire" / "Yangın".

*Alternative:* one category with two Data Entry entries. Cheaper (one CHECK), but the matrix, the boundary, the
reports and the evidence list would still show one category, and a gas offered by both entries would collide on
the record's uniqueness key.

### 2. One definition of "priced by the capacity method"

`recordParameterShape` returns `'refrigerant'` for both categories, and shared-types gains one predicate for it.
Each `'Refrigerants'` literal that means "has equipment lines" becomes a call to that predicate: the engine's TR
rule choice and `releaseParameters`, the validator's three refrigerant rules, `firstPeriodCeiling` and the probe's
SQL mirror, and the bulk grouping. `draft-reprice` keeps its literal: no fire-suppression record was ever priced
by the sum rule.

The devices differ by category, so shared-types also states which devices a category accepts (`Refrigerants`:
the nine it accepts today; `Fire Suppression`: the three) and which the form offers for a new line
(`Refrigerants`: the six cooling devices; `Fire Suppression`: the three). The DTO, the web and the bulk path read
the accepted list; the database CHECK mirrors it and a parity spec pins the two.

*Alternative:* a new parameter shape for fire suppression. It would duplicate the DTO, the snapshot term and the
report reader for an identical structure.

### 3. The factors come as a supplementary edition (revises D10; owner to confirm)

A new directory `packages/db/factor-releases/tr-fire-2026-11/` builds `TONYAI-EF-TR-FIRE-2026.11-AR6`: IPCC
ordinal 3, authoritative, AR6, TR 2024 to 2026, `kg`, superseding nothing. It holds, under `Fire Suppression`:

| Activity type | kgCO2e/kg | Source cited |
|---|---|---|
| `HFC-227ea` | 3,600 | TR package §4.6 (IPCC AR6), as the refrigerant row |
| `SF6` | 25,200 | TR package §4.6 (IPCC AR6), as the refrigerant row |
| `CO2` | 1 | TR package §4.6 (`CO2 = 1`; IPCC AR6) |
| `dry_powder_or_foam` | 0 | the owner's UAT round 4 decision, BUG-12 (decision 4) |

and three default `leak_rate` parameters: fire suppression system 0.02, fire extinguisher 0.04, transformer
breaker 0.0001 (§4.6). The build script takes the three GWPs and the three rates from the TR build's own tables
(exported for the purpose), so each number has one copy; its spec asserts equality with `ipcc.json`.

Why not D10's erratum: D10 was decided when CO2 was to be one more `Refrigerants` gas, a row missing from the
package. With its own category the fire rows are new coverage, as marine gas oil was, and overlap nothing. A
supplement withdraws no release, so no draft in any category becomes stale in the middle of the UAT week. It
repeats three leak rates, not nine, and because the engine reads rates from the pricing release, a
fire-suppression record can only ever find the three fire devices' rates. The cost D10 named stays: a later
correction to one of these three rates must supersede two editions.

**This reverses an owner decision, so the edition is not built until the owner confirms it** (task 1.1). If the
owner keeps the erratum, decision 3 and task group 4 are rewritten; the specs change only in the
`emission-factor-library` delta.

*Alternatives:* (a) D10's erratum carrying the `Fire Suppression` rows: every IPCC-priced open draft goes stale.
(b) Mapping the category to the `Refrigerants` rows in the lookup, with no new rows: a fire-suppression snapshot
would cite a `Refrigerants` factor, CO2 would have to join the refrigerant catalogue for the validator to accept
its row, and the zero row would still need an edition.

### 4. Dry powder and foam are a zero factor row, not an uncalculated record (owner to sign)

`dry_powder_or_foam` is an activity type of the category, priced by its own row of value 0. The record is then an
ordinary calculated record: snapshot schema 3 with its factor, release, lines and terms, a figure of 0, counted
as calculated and authoritative. Nothing new is needed in totals, datasets, the issuance gate, staleness or the
screens.

The zero is not a measured emission factor. It states that the agent holds no greenhouse gas, which is the
owner's v4 document's statement (BUG-12). The row cites that decision and not the TR package, its methodology
says what the zero is, the owner signs the edition, and the value joins the external reviewer's list. This is the
one number in the change that does not come from the signed package, and it is named as such wherever it is
recorded.

*Alternatives:* (a) An uncalculated record with a second reason code: a Scope 1 record without a figure makes
every final holding it partial and raises `non_authoritative_calculation`; its snapshot drops the option and the
lines; four screens print the stored English reason. (b) No record at all, only a statement on screen: the
category stays "missing" in the matrix for a company whose extinguishers are all dry powder, and the declaration
has no evidence. (c) Pricing the option as zero in the engine without a row: a figure with no factor, release or
source.

### 5. The gas list is the category's catalogue; "Other gas" exists only on the form

`CATEGORY_ACTIVITY_TYPES['Fire Suppression']` is `HFC-227ea`, `SF6`, `CO2` and `dry_powder_or_foam`, exactly the
types the edition prices, and the validator admits no other. The form appends a web-only "Other gas" item that is
never an activity type: while it is selected the form holds the preview and the save and shows the statement. The
catalogue label of `HFC-227ea` becomes "FM200 (HFC-227ea)" in both categories and both languages, with its
`"activity <label>"` report keys, because the label is one per value.

On an environment where the edition is not loaded, the four types are offered and every preview is refused with
`no_factor`, as any unpriced type is today. That window is closed by loading the edition, not by code.

*Alternative:* a new read that lists the types the engine would price, and a list built from it. It closes the
window and would also fix the five refrigerant gases the library does not price, but it is a new endpoint, DTO
and client call for a state that lasts until one owner release. Filed in Open Questions.

### 6. Grams are a form concern

The equipment-line draft of the fire-suppression form gains a unit (`g` or `kg`) beside its typed capacity and
refill. `equipmentParameters` converts a gram line to kilograms (`value / 1000`, normalised to 15 significant
digits so that 35 g is 0.035 kg) before the preview, the total and the save. A gram field shows its kilogram
figure. Changing a line's unit clears the line's two fields, as a unit change clears a natural gas quantity today.
A stored record opens in kilograms with the selector on kilograms: the unit is not stored, and showing the stored
figure in its stored unit needs no guess. The refrigerant form passes no unit and is unchanged.

*Alternatives:* (a) Storing the unit per line: a new key in the parameters CHECK, the DTO, the snapshot inputs and
the report text, to remember a display choice. (b) A `g` activity unit converted by the engine: grams would then
reach bulk, reports and the ceilings. (c) One selector for the whole record: an extinguisher is weighed in grams
and a suppression system in kilograms, and the documents put the selector on capacity and refill.

### 7. Existing `Refrigerants` records are left alone

The API, the database and the bulk path keep accepting the nine devices and the twelve gases on `Refrigerants`.
Only the form changes what it offers for a new record or line; an opened record keeps its own gas and devices
selectable. No record changes category. The same extinguisher can therefore be entered under both categories, as
any source can be entered twice today; the two forms' lists make it unlikely and the review step is the guard.

*Alternative:* refusing fire devices on `Refrigerants`. It would strand open drafts and bulk files that hold them
and needs a data move for records the database forbids rewriting once committed.

### 8. One expand-only migration re-creates the six CHECKs

Each is dropped and added in the migration's transaction, copied from its last definition with only the addition:

- `activity_records_scope_check`: `WHEN 'Fire Suppression' THEN "scope" = 1`.
- `activity_records_parameters_check`: a `Fire Suppression` branch equal to the refrigerant one with three
  devices, the default rate only, and at most one line per device.
- `inventory_attribution_policies_category_check`, `inventory_applicability_cells_category_check`: the category
  joins the list.
- `inventory_sources_mapping_check`: the category joins the mapped list as a typed category with its four
  activity types.
- `report_datasets_schema_check`: `"schema_version" IN (1, 2, 3)`.

No existing row is in the new category, so each new constraint validates at once. The md5 pins are re-measured
on a freshly migrated database with `runtime-role.mjs check`, which prints the observed hash. The migration is
written with `--create-only` and inspected, and the spurious
`DROP INDEX activity_records_reporting_entity_period_category_key` is deleted from it.

### 9. Dataset schema 3 and existing boundaries follow the Fugitive Gas precedent

`REPORT_DATASET_SCHEMA_VERSION` becomes 3; `BOUNDARY_CATEGORIES_BY_DATASET_SCHEMA[3]` is spelled out as the seven
categories; `boundaryMatchesVersion` reads version 3; schema 1 and 2 datasets recompute under their own lists. A
boundary version confirmed before the category has no cell for it, which reads `applicability_undetermined`: live
coverage and new captures of that version are partial until a new version decides the category (`copyOf` is the
remedy). Failing closed is deliberate, as it was for Fugitive Gas.

### 10. Evidence note and shortcut take the category

`RequiredNote` picks the refrigerant list, the fire-suppression list (`evidence.fireSuppressionNote.*`, TR and
EN) or the general note. The shortcut helper and the page's year read take the open record's category in place
of the `"Refrigerants"` literal and never cross categories.

### 11. Bulk rows

The equipment-row grouping uses decision 2's predicate, so `Fire Suppression` rows with the equipment columns
form one record per gas, in kilograms, through the same create service and DTO as the form. The template's
reference sheet gains the category, its gases and devices from the catalogue, and its equipment note says the
masses are kilograms for both categories.

### 12. One pull request, contract first

One PR for the package (owner's standing preference), with the commits in this order so that each is green alone:
shared-types contract; migration and pins; API; the edition and its load in the integration helper; web; e2e and
docs. The fresh-eyes pass before the PR opens has four seats, each on its own tree: `security-rls`, `qa-auditor`,
`architect` (schema and contract) and `data-factors` (the edition and its citations).

## Risks / Trade-offs

- [Confirmed boundaries on hosted QA read as partial for Fire Suppression after the deploy] → Named in the PR's QA
  note; a new boundary version that decides the category clears it. The same happened with Fugitive Gas.
- [Between the deploy and the edition's load, the category prices nothing] → Every preview answers `no_factor`
  with its existing message. The load is one owner release (dry run, then apply); the PR's note says so.
- [The zero for dry powder and foam is not from the signed package] → Its own row, source and methodology; the
  owner's signature; the external reviewer's list (decision 4). If the reviewer rejects it, a superseding edition
  removes the row and the option's drafts answer `no_factor`.
- [The 4% and 2% rates are applied to CO2 equipment, whose basis (IPCC 2006 Vol. 3 Ch. 7) is written for
  fluorinated gases] → The package gives its rates by device with no limit by gas, and BUG-12 multiplies device
  rate by gas GWP. Listed for the external reviewer (D10's open question).
- [Two live editions hold the three fire leak rates] → Equal by construction and pinned by the edition's spec; a
  correction supersedes both.
- [The same equipment entered under both categories] → Decision 7; the forms no longer offer the overlap.
- [A gram figure typed with the selector on kilograms] → The per-line ceiling flags a line above 500 kg in a first
  period. A kilogram figure typed as grams is 1,000 times too small and is not caught by any check; the kilogram
  figure beside the field is the guard.
- [The catalogue label of HFC-227ea changes for existing refrigerant records] → The stored value is unchanged;
  only the shown name gains "FM200".
- [Rollback] → The previous image does not know the category or dataset schema 3. It is safe only until the first
  Fire Suppression record, the first boundary policy, cell or mapped source naming Fire Suppression, or the first
  dataset capture of any kind (every capture after the deploy is schema 3, and `report_datasets` is append-only) is
  saved; after that, fix forward.
- [The package is larger than the sprint plan assumed for WP3] → If it slips more than the plan allows, the parts
  that can leave with the owner's approval, in this order: the bulk rows (decision 11), the fire-suppression
  shortcut (decision 10), the "Other gas" item.

## Migration Plan

1. Merge. The QA auto-deploy applies the migration and rolls out the API and web images. From here the category
   exists and prices nothing.
2. Owner release on hosted QA: load `tr-fire-2026-11/ipcc-fire.json` as `tonyai_factor_loader`, dry run first,
   then `--apply`, only after the owner's approval of the edition is in the Decisions log. No `--supersedes`.
3. QA confirms a boundary version that decides Fire Suppression where a final is wanted, and retests BUG-12.
4. Rollback: see Risks. An applied edition is never removed; a correction is a further edition.

## Open Questions

- **A gas list that follows the library.** A read of the types the engine would price would serve this category
  and the refrigerant list, which offers five unpriced gases today. Post-pilot unless the owner asks.
- **R-744.** Whether CO2 as a refrigerant joins the refrigerant catalogue, and under which name (LP7-07, from D10).
- **Fire devices on `Refrigerants`.** Whether they are refused there once no open record holds them.
- **Grams on reopen.** Whether an opened record should show grams again; it needs a stored unit (decision 6).
- **The Turkish label of `Refrigerants`** ("Soğutucu akışkanlar") and of the transformer breaker device against
  the form's wording ("Transformatör Kesici Gazı").
