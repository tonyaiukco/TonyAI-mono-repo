import { ACTIVITY_UNITS } from '@tonyai/shared-types';
import { canonicalUnit, isKnownUnit } from './normalization';

/**
 * A caller-supplied unit with its whitespace normalised: trimmed, one plain
 * space per run. The `@Transform` on every DTO that carries a unit.
 *
 * `canonicalUnit` trims AND collapses `\s+` to `_` before it looks a unit up,
 * so `us`, a carriage return and `gallons` is a valid `us_gallons` to the
 * vocabulary; without this the raw spelling reached the snapshot's
 * `inputUnit`, the audit row and every export. It mirrors the lookup's own
 * whitespace class and nothing else: case and alias are left to the service
 * (see `storedUnit`), so the spelling the user typed still reaches the
 * calculation snapshot and the refusals that quote it.
 *
 * Not `trimmed`, deliberately: collapsing interior whitespace would mangle the
 * reject and void DTOs' explanations, where a newline is a paragraph.
 */
export function storableUnit({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

/**
 * The spelling `activity_records.activity_unit` stores for a unit the
 * vocabulary knows: the `ACTIVITY_UNITS` value (`kWh`, `MWh`, `cubic_metres`,
 * …), which is what the web select offers, the template lists and
 * `unitSymbol` / `appliesUnitConversion` key on.
 *
 * Before this, the column held whatever the caller wrote — `kw h`, `KWH` and
 * `MWH` all priced correctly but were stored as three different units, so an
 * export or a GROUP BY split one unit three ways and `unitSymbol` fell back to
 * the raw text. The alias resolves at the write, once; the entered spelling is
 * kept in the immutable snapshot as `inputUnit`. Also closes the U+212A
 * KELVIN SIGN homoglyph the old transform documented as open: the stored
 * token is now the resolved one.
 *
 * A unit the vocabulary does not know comes back whitespace-normalised, so a
 * refusal can still quote it — but `@IsActivityUnit` refuses those before any
 * service runs. A known rule key with no `ACTIVITY_UNITS` entry (today only
 * `normal_cubic_metres`, which is blocked) stores as the key.
 */
export function storedUnit(unit: string): string {
  const normalised = storableUnit({ value: unit }) as string;
  if (!isKnownUnit(normalised)) return normalised;
  const key = canonicalUnit(normalised);
  return ACTIVITY_UNITS.find((u) => u.value.toLowerCase() === key)?.value ?? key;
}
