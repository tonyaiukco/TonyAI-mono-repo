# TonyAI: API report datasets

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Inventory coverage and report datasets (LP3-04 contract)

`ReportDataset`, `InventoryBoundarySnapshot` and `ReportIssuance` are additive
contracts exported by `@tonyai/shared-types`. LP4-03 changed the live side
("Live reports and issued reports", below): `ReportMetaDTO` carries the
report's own summary, its Scope 3 disclosure and the boundary's coverage, and
live assembly reads in one snapshot. The boundary's
storage and its reader are shipped (LP3-04 PR B, below), its routes write and
serve it ("The write path", below), a dataset is captured, retained and
served ("The capture", below), and a retained dataset is issued as a retained
PDF through the final gate ("The issuance", below). The live "approved" badge
is review status and says so; it certifies nothing: only an issuance's `final` does.

The dataset records one bounded, consistent capture of the declared boundary,
records and their unchanged calculation snapshots, evidence references, period
locks and factor/conversion release standing, read in one consistent database
snapshot and retained; every total and format of an issuance derives from it.
Renderers never query current metadata separately. Capture
and persistence happen before rendering; an issuance exists only after the
immutable dataset and exact PDF bytes are retained. Storage failures require a
recoverable implementation, not a successful issuance with a missing artifact.

- **Boundary:** `super_admin` owns per-year decisions. A boundary version is
  immutable once confirmed or captured into any dataset. `entities` retains
  every boundary company/site operating in any reporting-year month and its
  actual first/last month; sources at that entity must agree with those months.
  D11 chooses company or sites and one activity cadence per subsidiary/year/category,
  across all activity types. `attribution` holds exactly one policy per boundary
  subsidiary × Scope 1/2 category. A missing or duplicate policy, or a `sites`
  policy with no operating site entity, raises a final-blocking
  `applicability_undetermined` gap naming the company entity and category.
  For every boundary subsidiary and Scope 1/2 category,
  every operating site (or the company entity for company attribution) has exactly
  one `applicability` decision: included, excluded with a nonblank reason, or
  undetermined. Missing cells raise `applicability_undetermined`, identifying the
  entity and category even if no source exists, and block final. Included cells
  name a nonempty set of matching included mapped sources. Every included mapped
  source is named by exactly one included cell selected by D11, with matching
  `(subsidiaryId, locationId, category)`. Excluded and undetermined cells hold no
  included source. A breach is an invalid boundary (`attribution_conflict`); its
  affected records raise `unmapped_record` and are never counted. Included sources are
  unique by `(subsidiaryId, locationId, category, activityType)`; two named meters
  sharing a record identity cannot both claim one record. Obligations exhaust
  active months at the category cadence, without gaps/overlaps, clipped to actual
  operating months. Unsupported included or undetermined sources raise
  `unsupported_source` and block final. Unsupported sources excluded with a
  nonblank reason are named exclusions: disclosed, never counted, and do not
  block final. Exclusions have no amount. D05's pilot source list remains external.
- **Review:** disjoint approved, unapproved and voided sets exhaust captured records.
  The approved set includes both `approved` and `locked`: a period lock flips
  approved records to locked. Final requires every satisfying record in that set.
- **Coverage:** included activity and evidence obligations are assessed separately
  from review. Voided records never appear in coverage obligation `recordIds` or
  satisfy activity/evidence periods. Only-voided obligations are `missing` with a
  `missing_record` gap; after D04 re-entry only the replacement can satisfy them.
  Only non-voided records in `COUNTED_STATUSES` (`submitted`, `under_review`,
  `approved`, `locked`) satisfy **activity** coverage and appear in obligation
  `recordIds`. Draft/rejected-only slots remain missing with `missing_record`.
  Evidence coverage remains independent of this activity-status requirement.
  Evidence references' `recordIds` are a subset of captured `records`. Until an
  evidence-period schema exists, only a linked non-voided record's own period
  assigns evidence: an annual link cannot satisfy monthly invoices. The source
  declares evidence cadence (or none), and each required evidence period retains
  a result and assigned file IDs. Unknown assignments remain missing.
  Every non-voided captured record must attach to exactly one included obligation.
  Otherwise `unmapped_record` blocks final and the record is never counted. This
  includes records outside boundary subsidiaries, excluded/undetermined/unsupported
  sources, months outside operation, and D11 attribution mismatches. Conflicting
  records are listed in gaps, never silently dropped or included in totals.
- **Provenance:** each non-voided record's calculation standing; both factor and
  conversion participate. Legacy, uncalculated, placeholder, fixture and withdrawn
  paths cannot certify final. Gas coverage and a declared year fallback are
  disclosed separately; an approved sourced fallback is not automatically an error.
  D09's inventory-year GWP set must also be consistent across counted records;
  different authoritative GWP sets still block final (`gwp_set_mismatch`).
  CO2-only paths may have null GWP metadata without introducing another set.
- **Scopes and zero:** counted records are non-voided, in `COUNTED_STATUSES`,
  and attached to exactly one included obligation under D11. Attribution-conflicting
  or unmapped rows are never summed. Scope 1/2 `tCo2e` is the sum of calculated
  figures from its counted records, or null when none is calculated. An actual
  calculated zero is distinct from missing data. `covered` requires every included
  obligation of that scope satisfied, no gap for that scope, and every counted
  record calculated; otherwise `partial`.
  Scope 3 is `not_covered` with no amount; its records (including Water) are outside
  Scope 1/2 assessments. A Scope 3 context yields an empty partial extract.

Final issuance requires a confirmed complete boundary, every included obligation
satisfied by approved or locked records, locked periods, no coverage/attribution
gap, authoritative calculations and consistent GWP sets. Lock keys match exactly
on `(subsidiaryId, reportingYear, reportingPeriod, periodValue)`; an annual obligation needs
an `Annual` lock, not twelve monthly locks. `selection === 'extract'` always
produces `partial` with `filtered_extract`, even when selected records are approved.
Final has no gaps; partial has at least one. The issuance applies these to the
retained dataset alone ("The issuance", below).

For **both dataset and issuance**, every lookup (capture, list, metadata, PDF
retrieval and CSV/Excel projection) first requires requester `organisationId` to
match dataset `organisationId` (and issuance `organisationId`). Then require a
**nonempty** referenced-subsidiary set computed from the built dataset: explicit
`context.subsidiaryId`, boundary subsidiaries/entities/applicability/sources/
attribution, records, evidence, locks, coverage-gap entities and resolved IDs.
Every referenced ID must be within the requester's **current** access on every
request. Empty sets fail closed. Capturers and issuers have no bypass; `datasetId`,
`issuanceId`, `artifactId` and fingerprints are never capabilities. Refusals are
indistinguishable from not-found. Never redact retained data. All-accessible
is not all-owned: an inventory selection covers the entire declared boundary.

`datasetId` identifies retained facts; `issuanceId` identifies a particular
language/template/renderer output. PDF, CSV and Excel projections of the same
dataset carry its identity and fingerprint and reconcile (LP4-03 K5). Re-downloading an
issuance retrieves the retained PDF bytes, not a regeneration. Later withdrawal
of a factor release changes neither those bytes nor the retained dataset; a new
capture discloses its current standing without recalculating historic records.
An issuance is append-only like `audit_log`: no field is ever updated or
re-pointed. Creation verifies `datasetFingerprint` against the retained dataset's
recomputed fingerprint with the same canonicalization tag, and `pdf.fingerprint`
against SHA-256 of the stored bytes. Status and gaps derive solely from the
retained dataset; corrections require a new capture or issuance.
Opaque artifact IDs replace signed URLs in retained metadata. Retention duration
and erasure/offboarding exceptions remain D20/D21 and legal-owner decisions.

**Fingerprint encoding, version `tonyai-report-dataset-v1`:** take the complete
`ReportDataset` except its top-level `datasetId`, `capturedAt` and `fingerprint`.
All other fields, including boundary versions, actor IDs, record timestamps,
calculation snapshots, labels, evidence hashes and release standing, participate.
Normalize typed timestamps to `Date.prototype.toISOString()` spelling (UTC with
milliseconds, e.g. `2026-10-11T00:00:00.000Z`) before capture; retained calculation
snapshots remain unchanged and their producer must already supply canonical
values. Optional absent properties are omitted before canonicalization; a present
key or array element whose value is `undefined` is rejected, never silently
removed or changed to null. Null is distinct from omission. Reject nonfinite
numbers and non-JSON objects: only null, booleans, strings, finite numbers, dense
arrays and plain objects with `Object.prototype` or null prototype are accepted;
Date instances, Decimal, Buffer, class instances, accessors, symbol/non-enumerable
object properties and custom `toJSON` serialization are refused. Arrays permit
only own index properties 0…length−1 with no holes, plus the standard `length`;
custom array properties are refused. Null-prototype
objects use the same own enumerable string-key representation as plain objects.

Reject duplicate record/evidence/release/source IDs within each named collection;
entity identity is `(subsidiaryId, locationId)`, with null meaning company. Boundary
subsidiary IDs, entity keys, attribution `(subsidiaryId, category)` keys and
applicability `(subsidiaryId, locationId, category)` keys are unique;
obligation IDs are unique across the entire boundary, not only
one source. Reference-ID lists are sets and cannot repeat IDs. Recursively sort
object keys by UTF-16 code-unit order. Recursively canonicalize array members and
sort their resulting JSON strings by that same order (arrays here are semantic
sets; preserve multiplicity while rejecting forbidden duplicates).
Encode keys/strings/numbers with ECMAScript `JSON.stringify`, no whitespace,
UTF-8, no BOM; negative zero becomes zero. Do not normalize Unicode or round
quantities. For non-JavaScript producers see [RFC 8785 §§3.2.2–3.2.4](https://www.rfc-editor.org/rfc/rfc8785#section-3.2.2)
and [ECMAScript Number::toString](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-tostring).
This format differs from RFC 8785 by sorting semantic-set arrays. Compare dataset
fingerprints only when canonicalization tags match. SHA-256 uses 64 lowercase
hexadecimal characters; the PDF fingerprint hashes its exact stored bytes.
The package ships no hashing runtime; the API implements the encoding
(`apps/api/src/report-datasets/dataset-fingerprint.ts`, LP3-04 PR C), refusing
a dataset that breaks any rule above rather than coercing it.

Contract acceptance examples (not executed database/UAT evidence):

| Captured facts | Required interpretation |
| --- | --- |
| One approved January record, eleven missing months | Approved existing record; incomplete coverage; partial issuance |
| Jan–Nov approved and calculated, December a calculated draft | December activity missing; missing_record; total covers Jan–Nov; Scope 2 partial and partial issuance |
| Approved record voided, not re-entered | Obligation missing; withdrawal disclosed; partial |
| Voided then re-entered and approved | Satisfied by the replacement only; locks/evidence/provenance still required |
| Confirmed boundary omits a site/category cell | applicability_undetermined; final blocked |
| Missing attribution policy for a boundary subsidiary/category | applicability_undetermined naming the company entity and category; final blocked |
| Included source under an excluded cell | Invalid boundary: attribution_conflict; affected records unmapped_record and never counted; partial |
| Excluded fleet has an approved diesel record | unmapped_record; not counted; partial |
| Site opens in July but has an approved March record | unmapped_record outside operating months; not counted; partial |
| Scope 2 obligations satisfied but one counted record uncalculated | Partial coverage; only calculated figures summed, or null if none |
| Empty referenced-subsidiary set or a requester from another organisation | Dataset/issuance lookup refused indistinguishably from not-found |
| Site opens in July | July–December obligations only, independently of when its database row was created |
| Applicable source lacks a usable factor | Named gap/uncalculated provenance; never zero; partial |
| No fleet, explicitly excluded with a reason | Named exclusion, no fleet obligations and no fleet amount |
| Unsupported source excluded with reason (heat: "No purchased heat") | Named exclusion disclosed, never counted; no unsupported_source gap and does not block final |
| Approved calculated zero-consumption record | Measured zero; approval, evidence, lock and provenance rules still apply |
| Authoritative factor plus placeholder conversion | Non-authoritative calculation; final blocked |
| Factor release withdrawn after an issuance | Old PDF unchanged; next capture discloses withdrawal |
| Annual record but missing monthly invoices | Evidence gap remains; annual granularity does not close it |
| Filtered subset of an otherwise complete inventory | Partial extract, never a final whole-inventory claim |

**Boundary storage (LP3-04 PR B; Decisions 2026-10-15 (second), W1–W13).** Six
tables hold an organisation's declared boundary for a reporting year, one
**version** per row of `inventory_boundaries`: the subsidiaries it declares
(each also its company entity) and their sites with the months each operates
(W6); one attribution policy per subsidiary × Scope 1/2 category (D11 — its key
makes a duplicate impossible); one applicability decision per entity × category
cell (D12); and every named source, an unsupported one too, with its reason
(D05). Obligations, evidence periods, an included cell's sources and every gap
are derived (`apps/api/src/inventory-boundary/boundary-snapshot.ts`), never
stored. The database holds what it can: same-organisation composite keys (a
version declares its own organisation's subsidiaries and their own sites, a
cell or source sits at a declared entity); CHECKs on the categories, levels,
cadences and reasons (the factor library's free-text rule), a mapped source's
scope from `CATEGORY_SCOPE_MAP` and, for a typed category alone, one of its own
activity types (`recordActivityTypesFor`, follow-up (21); a parity spec pins
the lists); an included mapped source's cadence is its category's policy's — a
composite key that follows a change of the policy; and only included mapped
sources are unique by entity, category and activity type, so a named exclusion
can sit beside the meter it is not (D05). A site operates inside its
subsidiary's months (a subsidiary acquired in July has no site in the inventory
before it). No index is partial or NULLS NOT DISTINCT: the company entity's
site key is the nil uuid (never a site), and a source's claim key is null unless
it is included and mapped. **A frozen version takes no change**
(`inventory_boundary_frozen`, SQLSTATE `TA014`, every writer, the owner
included, `TRUNCATE` too): a version is born open and freezes once — when it is
confirmed (a confirmed version is frozen, CHECK) or captured into a dataset (W8,
PR C) — in a READ COMMITTED transaction of its own (a stricter snapshot could
freeze a row committed while it waited, unseen), at the database's clock as the
freeze runs, which also stamps its confirmation; freezing copies the
subsidiaries' names (trading, else legal) and geography codes and the sites'
into it (W7), and an open version is read with today's. Nothing but an open
version's decision and freeze changes its header; its rows are written in READ
COMMITTED only (a stricter writer's snapshot could miss another writer's site,
as records' TA003); and every row keeps its key
(its version and entity, a policy's or cell's category too; a source its id and
entity) — a change of one is a delete and an add, so a policy is never re-keyed
under its sources. **A declared subsidiary or
site is not deleted while its version stands** (W9): the guard refuses the
cascade, and `DELETE /subsidiaries/:id` and `DELETE /locations/:id` count the
versions first and answer 409 — a frozen one keeps the subsidiary for good
("set it inactive"), an open one is a blocker to clear; the panel's summary
agrees (no new DTO field). The one delete a frozen version admits is its
organisation's own, the owner's alone (W10). RLS is on (never FORCE) with
SELECT-only policies — a row with its subsidiary (LP1-03's predicate), the
header for its organisation's org-wide readers or a user granted a subsidiary
it declares (W3) — and the client roles, the service role included, hold
SELECT alone; the runtime role reads them and writes them through the routes
below — rows inserted, never updated, and deleted only a subsidiary's whole
declaration at a time (its keys cascade); a header inserted open and
undecided, changed only in its decision and freeze, deleted while open
(`20261018120000_lp3_04_boundary_write_grants`, grants only). The seed declares no boundary
until D05's source list arrives (W11); `rls:probe` plants and removes its own.

**One capture snapshot, one factor lookup.** `readInventoryBoundary` reads a
version whole and answers it as `InventoryBoundarySnapshot`, bound to the
organisation it is asked under and to the caller's current access (a version
declaring a subsidiary outside it is not found — W3). It reads, like the factor
lookup, inside a `CaptureSnapshot` (`apps/api/src/common/capture-snapshot.ts`):
a transaction at REPEATABLE READ or SERIALIZABLE (READ COMMITTED, the root
client and a snapshot not opened by `CaptureSnapshot.open` are refused), so a capture's
boundary, records and factor candidates are one moment's — another session's
rename or erratum committed meanwhile does not reach it. **The factor library
is selected in one place**, `apps/api/src/calculations/factor-lookup.ts`
(`lookupFactorPath`): the engine calls it with a snapshot of its own (its
REPEATABLE READ batch, unchanged) and is never handed a transaction (a record
writer's must stay READ COMMITTED, TA003). Its mode that reads inside a
caller's `CaptureSnapshot` has no consumer: a dataset takes each record's stored
calculation and its releases' standing now, and recalculates nothing
(Decisions 2026-10-15 (ninth), V4). A source scan
(`factor-lookup.single-source.spec.ts`) lists every other read of the library's
rows — the catalogue, the loader's re-read, the seed's accepted second copy —
and fails on a new one. Issuance with its storage recovery (PR D) and the
editor's screen (LP4-03 PR C, "The boundary editor") came later; the routes read through their own
reader (below), which answers an empty version and a data_entry user's part —
the capture's reader reads none.

**The write path (LP3-04 W1, W13; Decisions 2026-10-15 (fifth), E1–E9).** The
contract — the request and response types
(`packages/shared-types/src/inventory-boundary.ts`), the DTOs that hold a body
to them (`apps/api/src/inventory-boundary/dto/`), five error codes and the audit
taxonomy — and the routes and their service
(`apps/api/src/inventory-boundary/inventory-boundaries.{controller,service}.ts`);
the screen's `api.ts` functions came with LP4-03 (the list in PR B, the rest in PR C). The routes, under `/api/v1`:

| Method | Route | Does |
| --- | --- | --- |
| `GET` | `/inventory-boundaries?reportingYear=` | One year's versions, newest first (summaries) |
| `GET` | `/inventory-boundaries/:id` | A version: its snapshot, its `boundaryGaps` and its `view` |
| `POST` | `/inventory-boundaries` | A new open version, empty or a copy (`copyOf`, any year — a rollover starts from last year's) |
| `PUT` | `/inventory-boundaries/:id/subsidiaries/:subsidiaryId` | One subsidiary's whole declaration — months, sites, policies, cells, sources — replacing the stored one |
| `DELETE` | `/inventory-boundaries/:id/subsidiaries/:subsidiaryId` | Removes it from an open version — the blocker W9's 409 asks to clear |
| `POST` | `/inventory-boundaries/:id/confirm` | Confirms and freezes it |
| `DELETE` | `/inventory-boundaries/:id` | An open version only |

`super_admin` alone writes and confirms (E2; D12's matrix is theirs);
consultant and `executive_viewer` read; a `data_entry` user reads only its
granted subsidiaries' part (`view: 'granted_subsidiaries'`, W3), never captured
— as the boundary's RLS does, its list holds only the versions declaring a
subsidiary it is granted, and a version declaring none of them is
`boundary_not_found`, byte for byte as a missing one.
One body per subsidiary is one validation unit — every rule the database holds
sits inside one subsidiary — so the DTOs refuse (`validation_failed`) whatever
the CHECKs, keys and guard would: months outside 1–12 or reversed, a site
outside its subsidiary's months, an entry twice, a cell or source at an
undeclared site, free text outside the library's rule, a mapped source sending
a scope or cadence (both derived) or naming another category's activity type,
an included mapped source without its category's policy, two included mapped
sources on one key (a site that is not the route's subsidiary's own is
`location_not_found`). What is stored but blocks a final is reported in
`boundaryGaps`, each gap at its entity (`InventoryBoundaryGap` lists the
rules): a missing policy, a `sites` policy with no site, a missing or
`undetermined` cell, a mapped source left `undetermined`
(`applicability_undetermined`); an unsupported source not excluded
(`unsupported_source`); an included cell with no included source — never a
covered zero — or an included source no selected included cell holds
(`attribution_conflict`). A year has one open version at most, the
newest: a create takes the highest version + 1 and answers
`boundary_draft_open` while one is open (E4); deleting it frees its number.
A copy takes its source's declarations as they are, months included, read
under the source's header lock. Edits serialise on the header's
row lock with no revision precondition — the last writer of a subsidiary wins,
and each audit row holds what it replaced (E5). **Confirm** (`super_admin`)
refuses `boundary_frozen` when already confirmed,
`boundary_confirm_requires_copy` when the version froze unconfirmed in a capture
(copy it, confirm the copy), and `boundary_incomplete` when it declares no
subsidiary or has any `boundaryGaps` (E3). Every write to a frozen version is
`boundary_frozen`; another organisation's version is `boundary_not_found`.
The service checks all of this before it writes, so a `TA014` that still
reaches it is a defect — `internal_error`, logged (E7). `decidedBy` and
`createdBy` are profile ids the API writes from the verified token, never a
body field, with no foreign key (E6: every delete action would break W10 or
D20/D21's erasure). Audit: entity `inventory_boundary` (`entityId` the
version); `create` (a copy names `copyOf`), `update` (a subsidiary's
declaration, before and after), `delete`, and the new action `confirm` — each in
its write's transaction.

How the service holds it. Every write runs in READ COMMITTED — the only
isolation the guard admits a row write or a freeze in — and takes the
version's header `FOR UPDATE` as its first statement (`boundary-lock.ts`; PR
B's (6): a later freeze in the same transaction would otherwise wait on
another writer's share lock and deadlock); a copy reads its source under the
source header's `FOR SHARE`. A `PUT` deletes the subsidiary's row — its keys
cascade to its sites, policies, cells and sources — and inserts the new
declaration (`boundary-declaration.ts` derives the company entity's key, a
mapped source's scope and cadence and its claim key, by the CHECKs' own rules);
nothing is ever updated, so no key changes and no policy carries its sources
along. The guard's other rules are the DTOs' (a site within its subsidiary's
months) and the subsidiary and site delete paths' (W9). Two creates of a year's
next version are decided by its key — the loser answers `conflict` — as is a
subsidiary or site deleted between the check and the write (`conflict`, by the
key that broke; any other key's failure is a defect). `boundaryGaps(snapshot)`
(`boundary-gaps.ts`) is pure, one step per rule `InventoryBoundaryGap` lists,
each gap at its entity and a source's naming that source; a version's routes
report them, `confirm` refuses on them, and PR C's dataset starts from them.
Reads run in one REPEATABLE READ snapshot through the routes' own reader
(`boundary-version.ts`, on `buildBoundarySnapshot`): every reader but
data_entry gets the whole declared inventory; data_entry's view filters every
collection and gap to its granted subsidiaries — the gaps are the whole
version's, which equals its part's alone, since every rule stays inside one
subsidiary. The `PUT`'s body has a cap of its own, **1 MB, set in code**
(`INVENTORY_DECLARATION_BODY_MAX_BYTES`, never an environment value): one
subsidiary is one body, and the global 100 KB held only about a hundred sites
attributed per site, below the DTOs' limits (500 sites, 2,000 sources) — those
fit at ordinary name lengths. Every other route, the boundary's included,
keeps `BODY_MAX_BYTES`; the declaration's parser is registered before the
global one, which then passes the read body by. A body is parsed before
authentication, but a write is refused before it is validated — the global
pipe's work grows with a body's rows — by guards (`boundary-writer.guard.ts`):
anyone but a `super_admin` is `forbidden`, and a declaration's list past the
DTO's limits is `validation_failed` by its count alone.

**The capture (LP3-04 PR C; Decisions 2026-10-15 (ninth), V1–V12).** A
`ReportDataset` is captured from one boundary version, retained as its exact
`JSON.stringify` text — from which its fingerprint is recomputed: parse it,
canonicalise it ("Fingerprint encoding"), SHA-256; the stored bytes themselves
are not what is hashed — and served back as stored (`apps/api/src/report-datasets/`):

| Method | Path | What | Who |
|---|---|---|---|
| `POST` | `/report-datasets` | Capture a version (`boundaryId`) — the whole declared inventory, or an extract by `subsidiaryId`, `scope` and/or `category`; 201 with a `ReportDatasetSummary` | `super_admin`; a consultant only a version already frozen |
| `GET` | `/report-datasets?year=` | A year's datasets the caller may read, newest first (at most 50) | every role but data_entry |
| `GET` | `/report-datasets/:id` | One dataset, its retained text byte for byte (`application/json`) | every role but data_entry |

**Two transactions.** The first, READ COMMITTED — the only isolation the
boundary guard freezes in (TA014) — locks the version's header FOR UPDATE and
makes every refusal the request decides before anything changes: another
organisation's or an unknown version and one declaring no subsidiary or one
outside the caller's access (`boundary_not_found`, W3), an extract's
subsidiary the version does not declare or outside access (`subsidiary_not_found`
— of an undeclared one no source is selected, and every scope would read
covered over nothing), a capture certain to read
more than `REPORT_RECORD_LIMIT` records or `REPORT_EVIDENCE_LINK_LIMIT` evidence
links (`query_too_broad`; only the 20 MB text cap is known after the freeze),
and a consultant
before an open version (`forbidden`: freezing is a header write, E2's). Then,
if the version is open, it **freezes it unconfirmed** — conditionally
(`frozenAt: null`; none changed means it was frozen already) — and audits the
freeze (`inventory_boundary` / `freeze`). The second, REPEATABLE READ
(`CaptureSnapshot`), asserts the version frozen, reads the boundary, the
records, their evidence, the year's locks and the named releases in **one
snapshot**, assesses and fingerprints the dataset and retains it with its audit
row (`report_dataset` / `capture`), atomically. **A capture that fails after its
freeze leaves the version frozen and audited, with no dataset**: a retry
captures it as it stands (no second freeze), and an unconfirmed version, once
captured, is confirmed only as a copy (`boundary_confirm_requires_copy`).

**What is captured.** The year is the version's; `selection` is derived — no
filter is an `inventory`, any filter an `extract`, which still embeds the whole
boundary (W3) but assesses only the selection's sources, obligations and gaps,
an unselected scope reading `partial` with no amount. An inventory resolves the
version's declared subsidiaries (`resolvedSubsidiaryIds`), a subsidiary extract
that declared one: every Scope 1/2 record of them in the year, every status (the review
sets exhaust them). A record counts only where it attaches to an obligation of
an included, mapped source named by no attribution conflict — exactly on entity,
category and activity type (null is null) and on its period; every other live
record is an `unmapped_record`, beside an `overlapping_periods` when it holds
another granularity's months of such a source; obligations no record can meet
(an unsupported or conflicting source's) are listed `missing` with
`missing_record`. Evidence follows W5's interim rule: a linked live record's
own period, so only an evidence cadence equal to the activity cadence can be
met. A gap holds back the scopes of its category, sources and records, and one
with none of these (`boundary_unconfirmed`) both. Provenance comes from each
record's stored calculation and its releases' standing **now** — authoritative
only when the factor's and the conversion's releases are, in the snapshot and
now; a release no longer in the library reads withdrawn — and D09 compares the
GWP sets of the counted all-GHG calculations alone. Records carry the
snapshot's live names; the boundary its frozen ones (W7).

**Retained** (`report_datasets`, `20261019120000_lp3_04_report_datasets`): the
dataset's `JSON.stringify` as **text**, not jsonb — Prisma rounds a double to
16 significant digits on a jsonb write, and the fingerprint must be
recomputable from what is stored — with its fingerprint, context, selection,
capturer (opaque, E6) and the set of subsidiaries it references (every
`subsidiaryId` it holds at any depth, the declared and the resolved ones). The
guard (`report_datasets_guard`, SQLSTATE `TA016`, every writer, the owner
included) admits an insert only for a **frozen** version of its organisation
and year whose columns agree with its content, and whose content agrees with the
version as stored — its number and decision, its declared subsidiaries exactly
the version's rows, its resolved ones what the selection takes of them — the
referenced set recomputed from it, every one its organisation's; a missing or
malformed set fails closed, and so do a key named twice in any object (jsonb
keeps the last; the text is served whole), a `subsidiaryId` that is not a
string and a uuid spelled otherwise than the API spells it — and then refuses every change, every
delete but the organisation's own (as W10) and `TRUNCATE`. RLS is on with no
client policy and no client grant, the service role included: the API is the
only reader. **Every function in `public`** — definer or invoker — is pinned to
`search_path = pg_catalog, pg_temp`: with `''` alone PostgreSQL still searches
the session's temporary schema first for type names, so a caller's temporary
domain shadowing `jsonb`, `timestamptz` or `text` ran its check as whoever the
function ran as — a definer's owner (reproduced as the runtime login,
`security-rls`), and so an invoker a definer calls (the factor event recorders'
actor helper ran the loader's domain as `postgres` — Codex's review, reproduced
from a fresh loader login) or a trigger an FK cascade reaches. `runtime-role.mjs
check` holds every function in `public` to that path, registered or not, and
every definer elsewhere that our two logins can set running to `pg_temp` last
— which is why the runtime role holds no USAGE on Supabase's `storage`
(*Security model*). **The read rule** (README above), once, in the API: the caller's
organisation, then every referenced subsidiary in the caller's current access —
else `report_dataset_not_found`, the same answer as an unknown id; a dataset
referencing a subsidiary since deleted is no one's to read, never redacted. The
capture and one dataset's read take the report exports' quota and their
one-at-a-time lease (EXPORT); the list is a read.

**The issuance (LP3-04 PR D; Decisions 2026-10-21, K1–K5).** A retained
dataset is issued as a PDF whose exact bytes are retained; the PDF, its
SHA-256 and the status the final gate derived are the issuance
(`apps/api/src/report-issuances/`):

| Method | Path | What | Who |
|---|---|---|---|
| `POST` | `/report-issuances` | Issue a retained dataset (`datasetId`, `template`; `language` — D16: else the issuer's `profiles.language` —, `includeMethodologyNotes`, `includeEvidenceSummary`, both default false); 201 with its `ReportIssuance` | `super_admin`; a consultant a partial only |
| `GET` | `/report-issuances?year=&status=` | A year's issuances the caller may read, newest first: at most 50 summaries, `truncated` past them, and the year's current final (LP4-03 K7) | every role but data_entry |
| `GET` | `/report-issuances/:id` | One issuance's `ReportIssuance` | every role but data_entry |
| `GET` | `/report-issuances/:id/pdf` | Its retained PDF, byte for byte, as an attachment — re-hashed first, never rendered again | every role but data_entry |

**Read, then verified before it is trusted (K2).** One REPEATABLE READ snapshot
reads the retained row under the read rule (`report_dataset_not_found`
otherwise, as for the dataset's own routes), the issuer's language, a repeat of
the same issuance, and the frozen version rebuilt from its stored rows. Then,
outside any transaction, the dataset's text is held to its row: its fingerprint
recomputed from it, parsed and canonicalised; its referenced set recomputed;
its review, coverage, provenance and scope assessments **recomputed from its own
retained facts** (the releases as the capture found them standing) and required
equal to the retained ones; and its boundary required to be the frozen version
as stored, compared whole under the dataset's `schemaVersion` (PR C follow-up
(9); a later schema adds its own comparison, so a historic dataset is never held
to a newer shape). Schema 2 (LP4-02) added Fugitive Gas to the categories a
boundary must decide: a schema 1 dataset is still recomputed under the five it
was captured with (`BOUNDARY_CATEGORIES_BY_DATASET_SCHEMA`), and its fingerprints
stay pinned. A new capture of a version confirmed before the category existed is
partial, with `applicability_undetermined` on Fugitive Gas, until a new version
decides it. TA016 binds a dataset to its version's header and declared
subsidiaries only; these checks hold a row written past the API to its own
facts and its version — a self-consistent forgery (statuses, locks or standings
restated and everything recomputed) by a database-credential holder is beyond
any check of the row against itself. Any mismatch is a defect: logged, answered
as an internal error, nothing rendered or stored.

**The final gate (D13, K4; `issuance-gate.ts`).** Status and gaps derive from
the retained dataset alone — nothing is recalculated and no factor is read
(V4). Final requires, of the selection's included obligations: the inventory,
not an extract (`filtered_extract`); no coverage gap — `boundary_unconfirmed`,
missing records or evidence, attribution, applicability and unmapped records
among them, one `coverage_gap` each; every satisfying record approved or locked
(`unapproved_record`, per obligation); every obligation's period locked, matched
exactly on `(subsidiaryId, reportingYear, reportingPeriod, periodValue)` — twelve
monthly locks never hold an annual obligation (`unlocked_period`, one per missing
lock, naming every obligation it holds back); every counted figure authoritative
(`non_authoritative_calculation`: a placeholder, fixture or withdrawn release,
an uncalculated or legacy figure); and one GWP set across the counted all-GHG
calculations (`gwp_set_mismatch` — the capture names two disagreeing sets, and
the gate also fails closed on a null set beside a named one, K4). Anything else
is partial, every gap named; final has none. A final is `super_admin`'s (W4):
a consultant is refused one (`report_final_forbidden`, 403) after the read
rule, before anything is rendered. **Today no release can be authoritative**
(the publisher registry admits only the prototype and test publishers until
LP4-02), so every issuance with counted records is partial; the only final is
a confirmed boundary whose every category is excluded with its reason.

**The PDF (D16, D20).** A pure function of the dataset and the gate's result
(`issuance-html.ts`), in the issuance's language from the module's own en/tr
catalogue (`i18n/`, parity-tested): status and the gaps that block a final, the
Scope 1/2 figures as retained (a figure the dataset does not hold reads "Not
calculated", never 0; a scope with no included source, or one an extract's
scope or category filter leaves out, reads so; Scope 3 not covered), the boundary and selection, and the named exclusions with their
reasons; the GHG Protocol detail template adds the coverage gaps, the counted
ledger and the withdrawn records with their reasons; the options add
the releases as they stood at capture and the evidence by file name; and an
identity table — issuance, dataset, dataset fingerprint, capture time, renderer.
Every string a person wrote is escaped; no actor is printed (the bytes are
retained and cannot be erased). It is printed on the replica's **one Chromium**,
`PdfRenderer` (`apps/api/src/common/pdf-renderer.ts`, one instance from `PdfRendererModule`), shared with the report
exports and one render at a time (429 while one runs); `rendererVersion` records
the renderer and the browser that printed it.

**Retained, recoverably (LP1-02).** `beginUpload` → the bytes uploaded to the
private `report-artifacts` bucket (PDF only, 20 MiB — `REPORT_MAX_BYTES`'s
default; `supabase/config.toml` and the seed) under `<organisation>/<artifact>.pdf`,
never overwriting → read back and hashed: the issuance's `pdf.fingerprint` is the
SHA-256 of the **stored** bytes → one transaction: the intent adopted first, the
row, its audit row (`report_issuance` / `issue`: dataset, fingerprint, status,
gaps by code, language, template, options, renderer, the PDF's artifact id,
SHA-256 and size). A failure **before** that transaction — the upload, the
read-back, a hash that differs — removes the object whatever became of its
intent (`abandonUnadoptedUpload`): no row can own it, even bytes that landed
after the sweeper took a slow upload's intent (Codex's B9 review of #198). A
failure **in or after** it abandons the upload only while its intent stands
(`abandonUpload`), so a committed issuance whose acknowledgement was lost keeps
its bytes; an upload the sweeper abandoned before the row adopted it answers
`upload_expired` (409). The object's key never leaves the API — `artifactId` is
opaque.

**Retained table** (`report_issuances`, `20261021120000_lp3_04_report_issuances`):
append-only like `audit_log` (K1: finals are not limited — the newest final of
a year is the current one; a restatement chain is contract follow-up (3)). One
issuance per dataset, language, template and options (K5, the unique key):
a repeat is `report_already_issued` (409) — download the retained PDF instead;
another language or template is another issuance of the same dataset. The guard
(`report_issuances_guard`, SQLSTATE `TA017`, SECURITY DEFINER, every writer, the
owner included) admits an insert only of a retained dataset of its own
organisation whose year, canonicalization, fingerprint and referenced set the
row repeats, whose gaps are the contract's codes, and — for a final — of an
inventory whose boundary was confirmed and whose stored coverage holds no gap;
it stamps `issued_at` from the database's clock; then it refuses every change,
every delete but the organisation's own (as W10) and `TRUNCATE`. Flat CHECKs
hold the rest: final ⇔ no gap, language, template, lowercase-hex SHA-256 and
fingerprint, size, the object key the row's own. RLS is on with no client policy
and no client grant, the service role included. An organisation's deletion takes
its issuances; their objects become orphans that `storage:reconcile
--reclaim-orphans` removes (never the sweeper on its own).

**Download.** The retained bytes, re-hashed against the issuance before they
are sent: bytes that differ are never served (an internal error, reported);
bytes that are gone answer `report_artifact_missing` (404, reported to
operators by id, never by key). `storage:reconcile --verify` hashes every
issuance's object too. The issue and the download take the report exports'
quota and lease (EXPORT); the list and one issuance's metadata are reads. The
screen and the web client (`api.ts`) are LP4-03 PR B's (E9).
