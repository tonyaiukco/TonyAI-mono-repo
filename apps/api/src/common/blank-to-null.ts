/**
 * Trim, and turn a blank into `null`.
 *
 * Without it the phone column ends up with THREE representations of "no phone"
 * — `null`, `''` and `'   '` — because `@IsOptional` only skips null/undefined
 * and `@IsString` happily accepts whitespace. A panel then renders an empty
 * string where it should render its empty state, and "clear this field" behaves
 * differently depending on whether the user pressed space. Email escapes the
 * same fate only because `@IsEmail` rejects whitespace; it is trimmed here too,
 * so a pasted address with a trailing space is saved rather than refused.
 */
export function blankToNull({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
