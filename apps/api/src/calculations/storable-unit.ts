/**
 * A caller-supplied unit reduced to the spelling that may be stored.
 *
 * `trimmed` is not enough here, and the reason is the second half of
 * `canonicalUnit`. The lookup does `trim().toLowerCase().replace(/\s+/g, '_')`,
 * so a whitespace run does not have to VANISH to be ignored — it maps onto the
 * `_` of a multi-word key. `us`, a carriage return and `gallons` is
 * `us_gallons` to the vocabulary: a known, calculable, ten-character unit.
 * `passenger` + U+000A + `kilometres`, `cubic` + TAB + `metres`, and the same
 * with VT, FF, U+2028, U+00A0 or U+FEFF all validate the same way (measured),
 * and #111's derived aliases brought `kw` + CR + `h` down to four characters.
 *
 * Trimming reaches none of those, because none of them are at an end. What was
 * then stored was the raw spelling — into `activity_records.activity_unit`,
 * frozen into the record's immutable calculation snapshot as `inputUnit`,
 * copied into `audit_log`, and printed into the PDF, the Excel sheet and the
 * CSV. (`csvField` quotes a cell containing CR or LF, so the row structure
 * held; U+2028 and U+2029 are not in that test and shipped unquoted.)
 *
 * So this mirrors the lookup's own whitespace class exactly — the same `\s`
 * class, one plain space per run — and nothing else. It does NOT lowercase or
 * resolve the alias: `kWh` and `Sm³` are what the user reads back in the record
 * drawer and in every export, and `canonicalUnit`'s `kwh` is an internal key.
 * What it guarantees is narrower and checkable: a stored unit differs from the
 * one the vocabulary approved only in case and in alias, never in characters a
 * reader cannot see.
 *
 * NOT a general-purpose transform, which is why it is not `trimmed`. Collapsing
 * interior whitespace would mangle the reject and void DTOs' explanations,
 * where a newline is the user's paragraph.
 *
 * KNOWN GAP, deliberately not closed here: U+212A KELVIN SIGN lowercases to
 * ASCII `k`, so `U+212A` + `wh` is `kwh` to the lookup and stores a homoglyph
 * that renders as `Kwh`. It is not whitespace, so no whitespace rule reaches
 * it; closing it means storing the alias-resolved token and giving up the
 * user's spelling. Nothing groups or matches on this column today.
 */
export function storableUnit({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}
