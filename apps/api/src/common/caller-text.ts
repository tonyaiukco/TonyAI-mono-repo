/*
 * Caller-controlled text — an upload's filename, a cell quoted back in a
 * refusal — made storable, safe to show, and bounded. ONE rule, because the
 * same text reaches more than one reader (a response, a log line, the audit
 * row).
 *
 * DROPPED, and so never stored: controls (Postgres refuses U+0000 in `jsonb`),
 * unpaired surrogates (so bounds count code points and a cut cannot split a
 * character), U+2028/U+2029, every format character (Cf), and the code points
 * Unicode reserves as invisible but has not assigned. Rendered, they disguise
 * text: `invoice_<U+202E>fdp.xlsx` reads as a PDF. Two kinds of format
 * character stay, because real text is made of them: ZWJ/ZWNJ, and the
 * prepended concatenation marks (Arabic, Syriac, Kaithi number signs), which
 * are drawn — listed by hand below because V8 has no property for them.
 *
 * KEPT THOUGH INVISIBLE: variation selectors, U+034F, the Hangul fillers, the
 * Khmer inherent vowels, the Mongolian free variation selectors. Dropping Cf
 * rather than every default-ignorable code point was a user decision
 * (2026-09-16) — so a QUOTE names every invisible character it meets, kept or
 * not, and no quote can read as text the file does not hold.
 */

/** Format characters and the two separators: general categories Cf, Zl, Zp. */
const FORMAT = /^[\p{Cf}\p{Zl}\p{Zp}]$/u;

/** Code points that render as nothing at all. */
const INVISIBLE = /^\p{Default_Ignorable_Code_Point}$/u;

/** Code points Unicode has not assigned. */
const UNASSIGNED = /^\p{Cn}$/u;

/** The format characters that stay: the joiners, and the marks that are drawn. */
const KEPT_FORMAT = new Set([
  // ZWNJ and ZWJ
  0x200c, 0x200d,
  // the prepended concatenation marks
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890,
  0x0891, 0x08e2, 0x110bd, 0x110cd,
]);

/**
 * Named in a quote although visible: the refusal's own syntax — `<` opens a
 * marker, `…` marks a cut, `"` delimits a quoted cell — so no file can forge
 * one; and U+2800, which renders blank and is what people paste as an
 * "invisible" character.
 */
const NAMED_ANYWAY = new Set([0x0022, 0x003c, 0x2026, 0x2800]);

/**
 * How much of one value a sentence may quote, in UNITS (a character, or a
 * whole marker). Enough to recognise a year, a figure, a unit or a period;
 * what it stops is multiplication — one XLSX shared string can back a cell on
 * every row, and a 12 KB workbook once came back as a 32 MB report.
 */
export const CALLER_TEXT_QUOTE_MAX_LENGTH = 40;

/**
 * The same quote in CODE POINTS, because a marker is one unit but tens of
 * characters. 58 keeps the longest header refusal — five quoted cells,
 * delimiters included — inside the 500 code points an audit row stores whole
 * (user decision, 2026-09-17); `bulk-upload.service.spec.ts` pins the
 * arithmetic.
 */
export const CALLER_TEXT_QUOTE_MAX_CODE_POINTS = 58;

/**
 * The text to STORE. The bound counts KEPT code points, so padding a cell with
 * dropped characters cannot push its visible text out of an excerpt. `cutMark`
 * is appended only when the bound cut kept text: a log line marks its cut with
 * `…`, the audit row asks for no mark at all.
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

/**
 * The text to QUOTE in a sentence: every character it cannot show is NAMED
 * where it stood, never removed without a trace. Every sentence that repeats
 * caller text uses it.
 *
 * Named, not dropped, because the header match is strict (user decision,
 * 2026-09-16): a quote that dropped what it could not show refused
 * `category` + U+200B as "Unrecognised column(s): category. Expected: …,
 * category, …". Quoted, it reads `category<U+200B>`. What is named: every
 * character `sanitiseCallerText` drops, every other invisible one, and the
 * sentence's own syntax (`NAMED_ANYWAY`).
 *
 * A run becomes ONE marker: its distinct code points in first-appearance
 * order, each with its count when it repeats (`<U+2063 x40>`), at most three
 * and then `…`. Two bounds: `maxUnits` counts characters and whole markers
 * alike, so padding cannot push a name out of the quote; `maxCodePoints`
 * bounds the text. The quote ends in `…` only when something past a bound was
 * cut. A marker is made of characters `sanitiseCallerText` keeps, so a stored
 * sentence holds every marker as the caller saw it.
 */
export function quoteCallerText(
  value: string | undefined,
  maxUnits = CALLER_TEXT_QUOTE_MAX_LENGTH,
  maxCodePoints = CALLER_TEXT_QUOTE_MAX_CODE_POINTS,
): string {
  const parts: string[] = [];
  const run = new Map<number, number>();
  let used = 0;
  const cut = () => `${parts.join('')}…`;
  // Adds one part, and is false when a bound left no room for it.
  const add = (part: string, cost: number) => {
    if (parts.length === maxUnits || used + cost > maxCodePoints) return false;
    parts.push(part);
    used += cost;
    return true;
  };
  // A marker is ASCII but for its own `…`, so its length counts code points.
  const endRun = () => {
    if (run.size === 0) return true;
    const named = marker(run);
    run.clear();
    return add(named, named.length);
  };
  for (const char of value ?? '') {
    if (isNamed(char)) {
      // Nothing more can fit, and counting the rest of a run would only walk a
      // 2 MiB cell to its end.
      if (parts.length === maxUnits) return cut();
      const code = char.codePointAt(0) ?? 0;
      run.set(code, (run.get(code) ?? 0) + 1);
    } else if (!endRun() || !add(char, 1)) {
      return cut();
    }
  }
  return endRun() ? parts.join('') : cut();
}

/** `<U+200B>`, `<U+2063 x40>`, `<U+200B x2 U+2060>`: three at most, then `…`. */
function marker(run: ReadonlyMap<number, number>): string {
  const named = [...run]
    .slice(0, 3)
    .map(([code, count]) =>
      count > 1 ? `${label(code)} x${count}` : label(code),
    );
  return `<${named.join(' ')}${run.size > 3 ? ' …' : ''}>`;
}

/**
 * The one spelling of a named code point. Exported because `parse-rows.ts`
 * names characters in its own refusals, and two spellings of `U+0000` in an
 * append-only table is a defect nobody would notice until it mattered.
 */
export function label(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** A control, half of a surrogate pair, or a character that disguises text. */
function isDropped(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  const unpaired = char.length === 1 && code >= 0xd800 && code <= 0xdfff;
  const format = FORMAT.test(char) && !KEPT_FORMAT.has(code);
  const reserved = UNASSIGNED.test(char) && INVISIBLE.test(char);
  return control || unpaired || format || reserved;
}

/** What a quote names rather than shows: anything invisible, and its syntax. */
function isNamed(char: string): boolean {
  return (
    isDropped(char) ||
    INVISIBLE.test(char) ||
    NAMED_ANYWAY.has(char.codePointAt(0) ?? 0)
  );
}
