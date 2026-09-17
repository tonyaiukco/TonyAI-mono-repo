/**
 * Trim a string field, leaving anything else alone.
 *
 * `blankToNull` beside this file does the same for an OPTIONAL field, where a
 * blank should collapse to the one representation of "not set". A required
 * field has no such spelling: emptying it is an error, and `@MinLength(1)`
 * says so far more usefully than the `@IsString` failure a `null` produces —
 * a user who typed spaces should not be told their reason is not a string.
 *
 * The reject and void DTOs each carried this exact lambda inline. One copy,
 * because it is one rule.
 *
 * Deliberately only a trim. `activityUnit` needs its whitespace collapsed as
 * well, and takes `storableUnit` instead: that rule mirrors the unit
 * vocabulary's own lookup and would be wrong here, where a newline inside an
 * explanation is the user's paragraph.
 */
export function trimmed({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
