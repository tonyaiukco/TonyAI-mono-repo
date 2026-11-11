# TonyAI: API bounded access

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Bounded access contract (LP4-05)

**Live since PR C.** PR A (#157) published the shared types, client methods and
error vocabulary; PR B (#160) the runtime limits; PR C activates every route
below as one deliberate breaking change. The array clients (`listActivityRecords`,
`listEvidence`, `listPeriodLocks`, `listTargets`, `targetProgress`,
`listDenominators`) are deleted, and every screen reads pages: the review queue
(server-ordered `review_queue`, its count from metadata), Emissions History
(the bar's filters, the tab's category and the search applied by the server),
Data Entry's Entered records table, formerly Previous submissions (page-local selections, labelled "loaded" in
both locales; a deep link resolved by narrow server filters; each row's
`periodLocked` instead of a page of locks), the evidence vault and review sheet,
targets (progress only for each page's ids), denominators and the period-lock
drawer — each with **Load more**, none draining the list. Keyset indexes:
migration `20261023120000_lp4_05_keyset_indexes`.

`CursorPage<T>` is `{ items, limit, nextCursor }`, with a default limit of **50**,
maximum **100**, and `null` as the end cursor. A cursor is opaque and at most
2,048 characters. The server returns one envelope even for an empty or
parameterless request; it never switches between arrays and pages based on
query parameters. `Paginated<T>` retains its existing offset semantics for
audit. Invalid limits (including zero, fractions and values over the maximum),
malformed/version-invalid cursors and cursors for different normalized filters
or ordering answer **400 `validation_failed`**. There is no silent clamp or
restart at page one. Page clients reject old array responses and oversized or
non-progressing envelopes; they never fetch all remaining pages automatically.

| Bounded route | Client method / contract | Ordering or scope |
|---|---|---|
| `GET /activity-records` | `listActivityRecordPage(ActivityRecordPageParams)` → `CursorPage<ActivityRecordPageItemDTO>` | `newest` (default): `createdAt DESC, id DESC`; `review_queue`: `submittedAt ASC NULLS LAST, id ASC`. The latter does not implicitly change the status filter. |
| `GET /activity-records/metadata` | `activityRecordMetadata(ActivityRecordPageFilters)` → `{ total, latestReportingYear }` | Full tenant-scoped filtered set, independently of any page; null year if empty. Omit the year filter when asking for the newest available year. Register before the dynamic `/:id` route. |
| `GET /period-locks` | `listPeriodLockPage(PeriodLockPageParams)` | `createdAt DESC, id DESC`; exact subsidiary/year/period/periodValue filters can address one unique lock. |
| `GET /activity-records/:id/evidence` | `listEvidencePage(id, CursorPageParams)` → `CursorPage<EvidenceDTO>` | `createdAt DESC, id DESC`; each file's nested linked-record list stays complete under `EVIDENCE_MAX_LINKED_RECORDS`. A stored overflow is an integrity error, never a truncated sharing count. |
| `GET /targets` | `listTargetPage(TargetPageParams)` | `targetYear ASC, createdAt DESC, id DESC`. |
| `GET /targets/progress` | `targetPageProgress({ targetIds })` | Explicit comma-separated UUIDs, 1–100, no duplicates; request order, missing/inaccessible ids omitted identically. No omitted/empty-id fallback to every target. |
| `GET /denominators` | `listDenominatorPage(DenominatorPageParams)` | `year DESC, metric ASC, id ASC`; optional subsidiary/year filters. |

Activity page filters retain subsidiary/year/period/category/status and add
scope, location, period value and search. `locationId` omitted means all sites;
`null` serializes as `locationId=none` for company-level records; a UUID selects
one site. Search is a case-insensitive literal substring (not wildcard syntax),
at most 200 characters, across the displayed subsidiary name (nonempty trading
name, otherwise legal name), category, period value and variance reason. Escape
`%`, `_` and backslash in SQL LIKE patterns. Empty search or an empty status set
means no such filter. Period values require a period, use existing
canonicalization and must belong to that period. Empty identifier filters are
invalid; only `locationId` accepts null. Client methods send only the keys
documented for their endpoint; metadata never forwards pagination or sort keys.
`periodLocked` on each activity page item is advisory state for that record's
exact period. Absence from a general lock page must never mean "unlocked".

**Live traversal, not a snapshot.** Cursors are versioned and bound to the
endpoint, normalized filters and ordering. Every page reconstructs current
tenant access; cursor contents cannot authorize a read, and resolving an anchor
must neither read it unscoped nor require a deleted anchor to exist. A cursor
carries the sort-key tuple, no organisation/scope identity; acceptance depends
only on the cursor and request, never stored data. Filters come from the request
and decoded values are bound parameters (no `$queryRawUnsafe`). `review_queue`
needs an explicit NULL `submittedAt` branch. Rows with
unchanged ordering/filter membership do not shift merely because rows ahead of
them were inserted/deleted. Lifecycle changes, permissions and concurrent
inserts/deletes remain visible: metadata and a later page can differ. Refresh,
filter changes, local mutations and a stale cursor's `validation_failed` after
deployment reset the cursor chain. A short nonempty page may carry a continuation;
only `nextCursor: null` ends traversal. Entered records
and bulk/evidence selections must be page-local and labelled in both locales;
deep links use narrow server filters, not a search of the first page.
No compatibility shim may pretend the first page is the complete history.

**The cursor (`apps/api/src/common/keyset-cursor.ts`).** One helper for every
page route, the users list's included: base64url JSON `{ v, k, b, s }` — version
2, the endpoint, a truncated SHA-256 digest binding it to the sort and the normalised
filters, and the last row's sort-key tuple. It is not signed and needs no
secret: every page re-applies the caller's current access, so a forged or
another tenant's cursor names a position inside the caller's own rows and
nothing more (`tenant-isolation.int.spec.ts`, "pages and cursors"). Anything
this module did not write for the request — another endpoint, sort (its name
or its key columns) or filter, a non-canonical base64url spelling, a value the
column cannot hold (an extended-year date, an integer past int4, a key outside
the vocabulary), a NULL outside the NULLS LAST column — is 400
`validation_failed`, never a database 500. Each key column declares its kind; `timestamp3` is exact
only for a `TIMESTAMP(3)` column, which `keyset-columns.int.spec.ts` pins for
every column every sort names. Search escapes `%`, `_` and `\` itself: Prisma
6.19's `contains` passes them through as pattern syntax (measured); a control
character in it is 400. Request logs keep `search` and `cursor` by name only —
the cursor's filter digest is unkeyed, so a logged one would test guesses at the
search. Case folding is the database's ILIKE, not Turkish: `İ`/`ı` do not fold
to `i`/`I` (Open questions).

**Release and rollback (PR C).** Deploy the API and the web app together: an
old tab's array client receives an envelope and fails visibly (its next action
errors), and a reload loads the new client. Rolling back means rolling back
both, plus the migration's indexes if wanted (they are additive; leaving them
is harmless). Cursors from before the deploy — the users list's version 1 —
answer 400 once, and every paged screen then starts its list again from the
first page.

**Reserved refusals and partial outcomes.** PR B/C use **422
`query_too_broad`** for a read/export exceeding its complete-output or work
budget, with no partial inventory/report. Calculate budgets **after authorization
and only over the caller's accessible set**; inaccessible filters answer like an
empty set. This also applies to search and metadata work: metadata may answer
422, never a partial count. The refusal is a function of the code alone: fixed
message, no params or extra fields, including counts or limits. Use
`QueryTooBroadError`; the exception filter canonicalizes this code's entire body.

`ReportMetaDTO.recordLimit` advertises the server-configured positive safe-integer
export row budget, counting committed and withdrawn rows together. It is absent
on pre-PR-B servers (unknown, never unlimited); compare it with
`committedCount + voidedCount`, not `totalCount`. The client rejects malformed
advertised limits. PR B emits it and owns configuration/defaults; LP5-03 qualifies
the budget. There is no shared compile-time row cap or capacity claim. Export
rechecks current access, rows and limits; preview metadata reserves no capacity.
Byte, relationship and processing bounds are additional runtime controls.
Upload size remains **413 `payload_too_large`**;
quota/admission rejection is **429 `rate_limited`** with `Retry-After`.

Bulk upload and submit reserve the row code **`not_processed_deadline`** and an
additive `completion: completed | deadline_exceeded` field (absent on legacy
servers). PR B emits completion on every result, including dry runs. Deadline
means stop starting rows, settle the current mutation, finalize batch counts and
audit summaries, and return every applied and unstarted outcome. Each unstarted
row/id is an error with this code; the import's `accepted + errors = totalRows`
and submit's `submitted + failed = requested` invariants still hold. An import
counts records, not file rows: a refrigerant record's equipment lines are one
record (LP4-02 PR4), and its one outcome, deadline included, names every line's
row. The outcome
makes no existence or access claim: missing and inaccessible ids
receive identical outcomes at every deadline position, including after preflight.
An import stopped by deadline closes its batch as `failed`, retaining successful
records. Persisted `acceptedCount` counts accepted rows and `rejectedCount` only
examined, refused rows; unstarted rows equal
`totalRows - acceptedCount - rejectedCount`. Null counts on an interrupted or
processing batch mean unknown, never zero. This needs no new database column.
The response's error outcomes still include unstarted rows, so they are distinct
from the persisted rejected count. Batch labels display all
three counts without calling unstarted rows refused.

Non-refused import and submit audit diffs carry `completion` and
`notProcessedCount`; PR B writes both, including dry runs with no batch row.
Pre-PR-B append-only rows lack these fields and remain unchanged. Import audit
counts follow the persisted batch rule; submit `failedCount` includes unstarted
ids, and `notProcessedCount` is its deadline subset. `completed` in a response
only means processing finished, not that all
rows succeeded. Clients must never automatically retry successful rows or hide
the report behind a generic timeout. Locale-aware deadline labels and accepted/refused/unstarted
counts are wired in every bulk consumer.

**Runtime enforcement (LP4-05 PR B).** These are protection defaults, not
measured capacity. All settings are positive bounded integers; empty, zero,
negative, fractional, overflowing and incompatible values fail startup. The
API example environment lists each setting. Deployment accepts only registered
numeric `release.runtime_limits` overrides; omitted overrides select the defaults
in `infra/config/runtime-limits.json`. Configuration changes require a restart.

| Setting | Default | Applies to |
|---|---:|---|
| `RATE_IP_PER_MINUTE` | 120 | Non-probe requests before authentication/parsing (CORS preflight excluded) |
| `RATE_READ_PER_MINUTE`, `RATE_WRITE_PER_MINUTE` | 120 / 60 | Verified user, grouped across read/mutation routes (`POST /calculations/preview` only reads, so it counts as a read) |
| `RATE_EXPORT_PER_MINUTE`, `RATE_IMPORT_PER_MINUTE`, `RATE_SUBMIT_PER_MINUTE` | 5 / 5 / 10 | Verified user, grouped across each expensive operation |
| `RATE_MAX_KEYS` | 10,000 | Library throttle storage; new keys refused at capacity |
| `HTTP_MAX_INFLIGHT` | 32 | Authenticated work, after body reception |
| `HTTP_IP_MAX_INFLIGHT` | 8 | Requests receiving or executing per trusted client IP |
| `UPLOAD_CONCURRENCY` / `UPLOAD_USER_CONCURRENCY` | 2 / 1 | Buffered uploads globally / per verified user |
| `SHUTDOWN_GRACE_MS` | 120000 | Drain before provider destruction; at least max(bulk deadline, PDF timeout) + 50000, at most 3600000 |
| `MUTATION_CONCURRENCY`, `MUTATION_USER_CONCURRENCY` | 2 / 1 | Mutations globally and per verified user — never the read-only preview, which would otherwise refuse the same user's save or submit |
| `HTTP_HEADER_BYTES` | 16,384 | HTTP parser header bytes |
| `HTTP_HEADERS_TIMEOUT_MS`, `HTTP_BODY_TIMEOUT_MS`, `HTTP_KEEPALIVE_MS` | 10,000 / 30,000 / 5,000 | Header reception, body reception, idle keep-alive |
| `BODY_MAX_BYTES`, `BODY_MAX_PARAMETERS` | 102,400 / 100 | JSON/form body bytes and flat form parameters (LP3-04's declaration `PUT` reads up to its own 1 MB, set in code — "The write path") |
| `IMPORT_CONCURRENCY`, `IMPORT_PARSE_TIMEOUT_MS` | 1 / 5,000 | Import work after body reception; parsing checkpoints |
| `BULK_DEADLINE_MS` | 60,000 | Deadline for starting additional batch rows |
| `REPORT_CONCURRENCY`, `PDF_TIMEOUT_MS` | 1 / 30,000 | Export admission before assembly; PDF renderer |
| `REPORT_RECORD_LIMIT` | 5,000 | Committed plus withdrawn export rows; also each subsidiary-year an intensity or target-progress read sums (LP4-05 PR C) |
| `REPORT_EVIDENCE_LINK_LIMIT`, `REPORT_MAX_BYTES` | 10,000 / 20,971,520 | Export evidence links and source/output bytes |
| `DB_CONNECTION_LIMIT`, `DB_POOL_TIMEOUT_SECONDS` | 5 / 5 | Prisma connection pool and acquisition wait |
| `ACTIVITY_RECORD_METADATA_MAX_ROWS` | 100,000 | Rows `GET /activity-records/metadata` counts before 422 `query_too_broad` (LP4-05 PR C) |
| `AUTH_EMAIL_PER_IP_PER_MINUTE` | 5 | Password-reset requests per client address, at most 10,000 (LP4-01 S6; registered here since LP4-05 PR C, so an empty value now fails startup like the others) |

Slow body reception uses the per-IP cap and, for multipart, the global and
verified-user upload slots. HTTP work, mutation, import and export slots are
acquired after body reception; a refused or aborted upload settles its interceptor
and releases every slot. Incomplete previews cannot be applied: split the file
and preview it again. Report reads omit unused free-form `input` data.

On SIGTERM/SIGINT, admission stops before waiting for existing work and closing
Prisma/Chromium. Azure's termination grace follows `SHUTDOWN_GRACE_MS`; the drain
poll window includes an additional 30 seconds. This does not guarantee audit
persistence during database/network outage. Interactive deployments save and show
the plan, ask for confirmation, then drain and apply that exact plan.

Pool settings come from the runtime environment. Valid legacy URL values are
overridden; malformed or duplicate values fail startup. Hosted runtime secrets
must omit `connection_limit` and `pool_timeout`; secret verification rejects them.
Re-store and verify an exact secret version when migrating an existing URL.

The integration/E2E workflows set test-only rate quotas to 10000/minute because
all harness clients share loopback. E2E retains the production import quota
(5/minute) for its explicit isolation test. Local authorized harness runs should
set the same `RATE_*_PER_MINUTE` overrides; production defaults remain pinned by
DB-free tests. No local integration or E2E result is implied.


`PROXY_MODE=direct` is the default and ignores forwarded headers. `cidr` requires
explicit `TRUSTED_PROXY_CIDRS`; `azure` requires `AZURE_INGRESS_ONLY=true` and
uses Azure ingress's rightmost supplied forwarded address. Do not enable Azure
mode on a directly reachable Node listener. Staging verification must exercise
spoofed forwarded headers through the actual ingress before public acceptance.
Authentication and tenant scoping remain in the existing guard; limits use its
verified user identity. GET and HEAD exports share their budget (an export
refuses HEAD with 405 after the limits have counted it), as do
case variants accepted by Express. Exact public health/readiness probes are
exempt; authenticated synthetic checks are not.

Size refusals are 413, admission/quota refusals 429 with CORS-exposed
`Retry-After`, and scoped report-budget refusals the fixed 422 body. Malformed,
unsupported/compressed and timed-out request bodies receive controlled 4xx
responses. An uncertain mutation failure is never relabelled as safe to retry.
Non-preflight API responses carry CSP, frame denial, nosniff, referrer/permissions policies,
and production HSTS. Multipart has finite files/parts/fields plus a complete
request-byte ceiling; existing 2 MiB import, 10 MiB evidence, 1,000-row and
16 MiB XLSX expansion ceilings remain. Multipart ceilings are inclusive; fixed parser allowances are one file, four
16 KiB fields (shared evidence: two 64 KiB fields), and `UPLOAD_CONCURRENCY` simultaneous
multipart requests (default two). The whole request is additionally capped at the file ceiling
plus 64 KiB, including framing. Parser time is checked between bounded
chunks; it is not an OS preemption guarantee.

The batch deadline stops new rows, waits for the in-flight operation, and then
awaits final bookkeeping. Import batch closure and its final audit row share a
transaction. A stable internal audit UUID makes up to three finalization
attempts idempotent across lost acknowledgments. Persistent database failure is
logged and does not erase the enumerated response; successful persistence is
not guaranteed during an outage. Historic audit rows are unchanged. The
response deadline is cooperative, so final latency includes the settled row
and bounded finalization attempts. The retry count is bounded; Prisma transaction timers do not prove a strict wall-clock bound during COMMIT or a network outage. No automatic retry of successful rows occurs.

Only one PDF render owns Chromium at a time, even when `REPORT_CONCURRENCY`
is raised for other formats. Header expiry checks run at most one second apart.

The pilot uses one API replica/process with memory-local counters. A deployment
enters maintenance: the deployment tool deactivates old API revisions and
requires zero remaining replicas before applying the new revision. Failures
leave maintenance visible. Same-release retries leave the already active API
untouched; an existing inactive target requires a new reviewed manifest with a fresh `release_id`. The
tool does not automatically reactivate a possibly
overlapping revision. Counters reset on restart. Raising replica count requires
shared throttling and new qualification. API resources remain 1 CPU/2 GiB with a
768 MiB Node heap and an image-level process reaper; Compose additionally caps
PIDs. Chromium/native memory is covered by the container limit, not Node's heap.
The API image retains compiled runtime/CLI code, generated Prisma and production
dependencies; its default base remains the ECR Public mirror (CI explicitly
selects the official Docker Hub Node image after registry login).

PR C bounded the reads: every history list is a `CursorPage` (above); target
progress reads only the ids it is given, batched (one latest-year query, one
summary per subsidiary, year and scope, each within `REPORT_RECORD_LIMIT`);
intensity sums one bounded summary per subsidiary; an evidence page refuses
(422) a nested payload past `REPORT_EVIDENCE_LINK_LIMIT` links; the anomaly
baseline reads four columns of a pool the reporting-entity unique index bounds
at 1,212 rows; a record search and its cursor reach the request log as
`[redacted]` (`Retry-After` was already exposed through CORS). Period-lock history moved from
`reportingYear DESC, createdAt DESC` to `createdAt DESC, id DESC`, evidence from
ascending to descending creation order. Still open: an import whose role
backstop closes its batch `failed` writes no batch audit row (Open questions).
Neither the runtime guards nor the indexes establish production throughput,
tenant isolation in PostgreSQL or cloud acceptance; those claims require their
own live checks and LP5-03.
