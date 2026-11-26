/**
 * The fuel upload's server-side budgets (inc28-fuel-bulk D15). Provisional:
 * task 10.4 measures a workbook of the documented scale (44,902 rows) on capped
 * built servers and sets these from the numbers. The row and size limits a
 * screen states live in `@tonyai/shared-types` (`FUEL_UPLOAD_MAX_ROWS`,
 * `FUEL_UPLOAD_MAX_SIZE_BYTES`, `FUEL_TANKER_MAX_DELIVERIES`).
 */

/** What one fuel workbook may unpack across every part it opens. */
export const FUEL_XLSX_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

/** The sheet is parsed in slices of this size, yielding to the event loop between them. */
export const FUEL_XLSX_SLICE_BYTES = 64 * 1024;

/** How long reading one fuel file may take before it is refused. */
export const FUEL_PARSE_TIMEOUT_MS = 30_000;
