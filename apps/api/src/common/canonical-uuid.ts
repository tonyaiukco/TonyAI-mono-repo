/**
 * Every spelling of a uuid that reaches the SAME row, reduced to the one
 * Postgres stores.
 *
 * A `@db.Uuid` column holds a 128-bit value, not text: the database accepts
 * several spellings of one id and returns exactly one. Anything that keys a
 * uuid in JavaScript — a `Set`, a `Map`, a composite key — compares the
 * spelling instead, so one location written five ways becomes five keys while
 * the database still sees one row. That gap is what this closes.
 *
 * THE ACCEPTED SET IS PRISMA'S, NOT POSTGRES'S, and the two genuinely differ.
 * Measured against the local stack (Prisma 6.19 / Postgres 17), each spelling
 * of a seeded id read back through the API's own client:
 *
 * | spelling                       | Postgres | Prisma |
 * | ------------------------------ | -------- | ------ |
 * | `a0ee…0a11` hyphenated         | yes      | yes    |
 * | `A0EE…0A11` any hex case       | yes      | yes    |
 * | `{a0ee…0a11}`                  | yes      | yes    |
 * | `urn:uuid:a0ee…0a11`           | NO       | yes    |
 * | `a0ee…0a11` without hyphens    | yes      | yes    |
 * | `{a0ee…0a11}` without hyphens  | yes      | NO     |
 * | `a0ee-bc99-9c0b-…` in fours    | yes      | NO     |
 * | `URN:UUID:a0ee…0a11`           | NO       | NO     |
 *
 * Prisma parses the value itself and refuses what it cannot with `P2023`,
 * so Postgres's more liberal reader is never reached and Prisma's grammar is
 * the one that decides which spellings are the same row. The repo persists
 * ONLY through Prisma (see CLAUDE.md), which is what makes that the whole
 * story — a raw-SQL path would widen this table and this function with it.
 *
 * Being NARROWER than the database is safe; being wider is not, and the cost
 * is not symmetrical. A spelling this refuses is keyed as it was written,
 * exactly as before — a duplicate goes undetected, which is the state we were
 * already in. A spelling it wrongly folded is worse than a refused row:
 * `canonicaliseEntityCells` REWRITES the cell, so the folded value is what
 * reaches `create` and what gets stored. A mis-grouped id that the database
 * would have refused outright (`P2023`) becomes a real entity's id, and the
 * row is filed against a site nobody named — wrong attribution, silently, in
 * an inventory. Loosening this function is therefore never a small change.
 *
 * That asymmetry is why `urn:uuid:` is matched case-sensitively: Prisma
 * rejects `URN:UUID:`, so accepting it here would invent an equivalence the
 * database does not have.
 *
 * The output always satisfies `UUID_SHAPE` in `parse-uuid-param.pipe.ts`,
 * which validates that one canonical form.
 */

/** 8-4-4-4-12. */
const HYPHENATED_LENGTH = 36;
const BRACED_LENGTH = HYPHENATED_LENGTH + 2;
/** Lowercase only: Prisma refuses `URN:UUID:`. */
const URN_PREFIX = 'urn:uuid:';
const URN_LENGTH = HYPHENATED_LENGTH + URN_PREFIX.length;
const HYPHEN_POSITIONS = [8, 13, 18, 23];
const HEX32 = /^[0-9a-fA-F]{32}$/;

/**
 * The canonical lowercase hyphenated form, or `null` when the text is not a
 * uuid the database would resolve.
 *
 * Whitespace is NOT tolerated — Prisma refuses a padded value — so a caller
 * that trims its input must trim before calling.
 */
export function canonicalUuid(value: string): string | null {
  let body = value;
  if (body.length === URN_LENGTH && body.startsWith(URN_PREFIX)) {
    body = body.slice(URN_PREFIX.length);
  } else if (
    body.length === BRACED_LENGTH &&
    body.startsWith('{') &&
    body.endsWith('}')
  ) {
    body = body.slice(1, -1);
  }
  if (body.length === HYPHENATED_LENGTH) {
    // Positions checked before the hyphens come out. Prisma reads the 36
    // characters positionally, so a value grouped any other way is refused
    // there; folding it here would hand a neighbouring id's key to a row the
    // database never matched. A hyphen ANYWHERE ELSE survives into `HEX32`,
    // which then fails on the short length — no separate test needed.
    if (HYPHEN_POSITIONS.some((i) => body[i] !== '-')) return null;
    body = body.replace(/-/g, '');
  }
  if (!HEX32.test(body)) return null;
  const hex = body.toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
