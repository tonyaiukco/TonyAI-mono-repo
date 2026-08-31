/**
 * The audit query's page bounds, in a leaf both the service and its DTO can
 * import.
 *
 * They lived on `audit.service.ts` and the DTO imported them from there, while
 * the service imports the DTO — a genuine RUNTIME cycle, not one an
 * `import type` could excuse: `MAX_AUDIT_LIMIT` is read inside a `@Max()`
 * decorator, i.e. evaluated at class-definition time. It happened to work
 * because a `const` is initialised before the decorator runs, which is a
 * property of the current module order rather than a guarantee.
 */

export const DEFAULT_AUDIT_LIMIT = 50;

/**
 * Hard ceiling, enforced in the SERVICE as well as in the DTO. The DTO's `@Max`
 * only runs for HTTP callers going through the global ValidationPipe — an
 * internal caller (an export job, a second controller) could otherwise ask for
 * `take: 1e9` and pull the whole trail into memory. Both sides read this
 * constant so the two limits cannot drift.
 */
export const MAX_AUDIT_LIMIT = 200;
