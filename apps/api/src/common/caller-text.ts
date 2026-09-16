/*
 * Caller-controlled text — an upload's filename, a header cell quoted back in
 * a refusal — made storable and safe to show, and bounded.
 *
 * Two shapes made the audit write fail: U+0000, which Postgres refuses inside
 * `jsonb` (busboy decodes `filename*=UTF-8''probe%00.csv` into exactly that),
 * and a string cut mid-emoji by a UTF-16 `.slice`, which kept half of a
 * surrogate pair. So control characters and unpaired surrogates are dropped,
 * and the bound counts code points: the cut can no longer land inside a
 * character.
 *
 * WHAT IS DROPPED, and so never stored: controls, unpaired surrogates, the
 * line and paragraph separators U+2028 and U+2029, every format character
 * (general category Cf), and the code points Unicode reserves as invisible but
 * has not assigned (U+2065, U+FFF0-U+FFF8 and most of the U+E0000 block).
 * Rendered, they disguise text: `invoice_<U+202E>fdp.xlsx` read as a PDF in the
 * audit drawer, a zero-width space made two different names indistinguishable,
 * and the tag characters spell out ASCII nobody sees. Two kinds of format
 * character stay, because real text is made of them:
 * - ZWJ and ZWNJ, which some scripts and emoji need;
 * - the prepended concatenation marks: the Arabic number signs U+0600-U+0605,
 *   U+0890 and U+0891, the ends of ayah U+06DD and U+08E2, the Syriac
 *   abbreviation mark U+070F and the Kaithi number signs U+110BD and U+110CD.
 *   They are drawn, each spanning the digits after it, so dropping one would
 *   change real text in a row that can never be corrected.
 *
 * WHAT IS KEPT THOUGH INVISIBLE: the variation selectors (U+FE0F gives an
 * emoji its colour), U+034F, the Hangul fillers, the Khmer inherent vowels and
 * the Mongolian free variation selectors. Dropping format characters rather
 * than every default-ignorable one was a user decision (2026-09-16), so stored
 * text can still carry them — but a QUOTE names every invisible character it
 * meets, kept or not, so no quote can read as text the file does not hold.
 *
 * `\p{Cf}`, `\p{Cn}` and `\p{Default_Ignorable_Code_Point}` are the running
 * Node's Unicode data, so a code point assigned later moves category with it.
 * The marks are listed by hand because V8 has no property for them: a new one
 * would be dropped until it is added here.
 *
 * ONE rule, because the same text reaches more than one reader: the header
 * refusal is both the 400 the import panel shows and the audit row's `reason`.
 * While only the audit copy was cleaned, the panel rendered whatever the
 * file's header cell carried.
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
 * Named in a quote although they are visible: the characters the refusal's own
 * syntax is made of — `<` for a marker, `…` for a cut, and `"`, which delimits
 * each quoted cell — so that no file can forge one. U+2800 joins them because
 * it renders blank and is what people paste when they want an invisible
 * character, though Unicode files it as a symbol rather than as invisible.
 */
const NAMED_ANYWAY = new Set([0x0022, 0x003c, 0x2026, 0x2800]);

/**
 * How much of one caller-supplied value a sentence may quote: units first
 * (a character, or a whole marker), then the code points those units may add
 * up to.
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
 * The same quote in code points, because a marker is one unit but tens of
 * characters. It is what keeps the longest header refusal — five quoted cells,
 * delimiters included — inside the 500 code points an audit row stores whole:
 * bounded in units alone, a crafted header wrote a 1,479-code-point sentence of
 * which the row kept 500, cutting a marker in half and storing a count of forty
 * as four. `bulk-upload.service.spec.ts` pins that arithmetic.
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
 * The text to QUOTE in a sentence: every character this cannot show is NAMED
 * where it stood, never removed without a trace. Every sentence that repeats
 * the caller's own text uses it — the header refusal, the row refusals, the
 * unit and period messages — so one rule decides what any of them can say.
 *
 * A header is matched on its cell as written (trimmed), and that match is
 * strict (user decision, 2026-09-16), so a quote that simply dropped what it
 * could not show would name a column the file got right: `category` + U+200B
 * was refused as "Unrecognised column(s): category. Expected: …, category, …",
 * and a cell holding only U+200B as "Unrecognised column(s): . Expected: …".
 * Quoted, they read `category<U+200B>` and `<U+200B>`. What is named is every
 * character `sanitiseCallerText` drops, every other invisible one (ZWJ, a
 * variation selector and the Hangul fillers are kept in storage but would read
 * the same way here), and the characters the sentence's own syntax uses, so
 * that no file can write text which reads as a marker, as the mark of a cut,
 * or as the end of one quoted cell and the start of the next. A header cell
 * that really holds a `"` is quoted the noisier for it (`2<U+0022> pipe`),
 * which is the price of a delimiter a file cannot close; no canonical column
 * contains one.
 *
 * A run becomes ONE marker: its distinct code points in the order they first
 * appear, each with its count when it repeats (`<U+2063 x40>`), at most three
 * and then `…`.
 *
 * TWO bounds, because a marker is one unit but up to about 50 code points.
 * `maxUnits` counts characters and whole markers alike, so padding cannot push
 * a name out of the quote. `maxCodePoints` bounds the text itself, which is
 * what keeps the refusal short enough for the audit row to store whole: with
 * units alone, five cells of twenty markers wrote a sentence of which the row
 * kept the first 500 code points, cutting a marker in half and storing a count
 * of forty as four. The quote ends in `…` only when something past a bound,
 * text or a run, was cut. A marker is made of characters `sanitiseCallerText`
 * keeps, so the audit row's `reason` holds every marker as the panel showed it.
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

function label(code: number): string {
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
