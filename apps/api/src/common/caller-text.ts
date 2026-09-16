/**
 * Caller-controlled text — an upload's filename, a header cell quoted back in
 * a refusal — made storable and safe to show, and bounded.
 *
 * Two shapes made the audit write fail: U+0000, which Postgres refuses inside
 * `jsonb` (busboy decodes `filename*=UTF-8''probe%00.csv` into exactly that),
 * and a string cut mid-emoji by a UTF-16 `.slice`, which kept half of a
 * surrogate pair. So control characters and unpaired surrogates are dropped,
 * and the bound counts code points: the cut can no longer land inside a
 * character. The bidi embeddings, overrides and isolates go too, and so do
 * U+200B, U+2060 and U+FEFF — rendered in the audit drawer,
 * `invoice_<U+202E>fdp.xlsx` read as a PDF, and a zero-width space made two
 * different names indistinguishable. ZWJ and ZWNJ stay: some scripts and emoji
 * need them.
 *
 * WHAT IT DOES NOT DROP: every other format character. The bidi marks (U+200E,
 * U+200F, U+061C), the soft hyphen, the invisible operators U+2061-U+2064 and
 * the tag characters pass through, and can still pad or hide text.
 *
 * ONE rule, because the same text reaches more than one reader: the header
 * refusal is both the 400 the import panel shows and the audit row's `reason`.
 * While only the audit copy was cleaned, the panel rendered whatever the
 * file's header cell carried.
 *
 * The bound counts KEPT code points, so padding a cell with dropped characters
 * cannot push its visible text out of an excerpt. `cutMark` is appended only
 * when the bound cut kept text: the header refusal marks its cut with `…`, the
 * audit row never has.
 */
export function sanitiseCallerText(
  value: string | undefined,
  max: number,
  cutMark = '',
): string {
  const kept: string[] = [];
  // `for…of` walks code points; an unpaired surrogate arrives on its own.
  for (const char of value ?? '') {
    if (isDropped(char)) continue;
    if (kept.length === max) return `${kept.join('')}${cutMark}`;
    kept.push(char);
  }
  return kept.join('');
}

/** A control character, half of a surrogate pair, or one that disguises text. */
function isDropped(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  const unpaired = char.length === 1 && code >= 0xd800 && code <= 0xdfff;
  const disguise =
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200b ||
    code === 0x2060 ||
    code === 0xfeff;
  return control || unpaired || disguise;
}

/**
 * How much of one caller-supplied value a sentence may quote, in kept code
 * points.
 *
 * Forty is the header refusal's fragment, and it is enough to recognise a
 * value: a year, a figure, a unit or a period is a handful of characters, so a
 * value longer than this is wrong already and the sentence only has to say
 * which one it is. What the bound stops is multiplication. One XLSX shared
 * string can back a cell on every row of a file, and every row's refusal quoted
 * it whole: a 12,416-byte workbook came back as a 32,092,008-byte report
 * (measured).
 */
export const CALLER_TEXT_QUOTE_MAX_LENGTH = 40;

/**
 * One caller-supplied value as a sentence quotes it: cleaned by the rule
 * above, cut at `CALLER_TEXT_QUOTE_MAX_LENGTH`, and marked `…` where the cut
 * kept text.
 *
 * For the sentence only. Look the raw value up and quote this; looked up
 * cleaned, `category` + U+200B would match `category`.
 */
export function quoteCallerText(value: string | undefined): string {
  return sanitiseCallerText(value, CALLER_TEXT_QUOTE_MAX_LENGTH, '…');
}
