/**
 * The fuel upload's server-side budgets (inc28-fuel-bulk D15), set from task
 * 10.4's measurement (2026-11-27, capped built servers: API heap 768 MB): a
 * Petrol Ofisi workbook of the documented scale, 44,902 rows across 40
 * accounts and 560 invoices (3.2 MB), previewed in 2.0 s and applied in 4.5 s,
 * its 560 batches formed in one step of 17.2 s (`BULK_DEADLINE_MS` 60 s), the
 * API's resident memory 373 MiB at its peak and the liveness probe answering
 * throughout (95 probes, none timed out, slowest 18 ms). Every budget below
 * keeps at least a sixfold margin over those figures. The row and size limits a
 * screen states live in `@tonyai/shared-types` (`FUEL_UPLOAD_MAX_ROWS`,
 * `FUEL_UPLOAD_MAX_SIZE_BYTES`, `FUEL_TANKER_MAX_DELIVERIES`).
 */

/** What one fuel workbook may unpack across every part it opens. */
export const FUEL_XLSX_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

/** The sheet is parsed in slices of this size, yielding to the event loop between them. */
export const FUEL_XLSX_SLICE_BYTES = 64 * 1024;

/** How long reading one fuel file may take before it is refused. */
export const FUEL_PARSE_TIMEOUT_MS = 30_000;
