import { describe, expect, it } from 'vitest';
import {
  CALLER_TEXT_QUOTE_MAX_LENGTH,
  quoteCallerText,
  sanitiseCallerText,
} from './caller-text';

// Built from code points, never typed: escape sequences typed into this repo
// have arrived in files as the literal, invisible character.
const char = (code: number) => String.fromCodePoint(code);
const label = (code: number) =>
  `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
const byLabel = (codes: number[]) =>
  codes.map((code) => [label(code), code] as const);
const ZWSP = char(0x200b);
const ZWJ = char(0x200d);
// The refusal's own bounds live in `parse-rows.ts`. Here the unit bound is the
// one under test, unless a test passes its own.
const quote = (value: string | undefined, units = 40, codePoints = 400) =>
  quoteCallerText(value, units, codePoints);

describe('sanitiseCallerText', () => {
  it.each(
    byLabel([
      // C0 controls, DEL and C1 controls
      0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x85, 0x9f,
      // bidi embeddings, overrides and isolates, and the bidi marks
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
      0x200e, 0x200f, 0x061c,
      // zero-width space, word joiner, BOM
      0x200b, 0x2060, 0xfeff,
      // soft hyphen, Mongolian vowel separator, the invisible operators and
      // the deprecated format characters
      0x00ad, 0x180e, 0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206f,
      // interlinear annotation, and the hieroglyph, shorthand and musical
      // format controls
      0xfff9, 0xfffa, 0xfffb, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173,
      0x1d17a,
      // the language tag, and the tag characters, which spell out unseen ASCII
      0xe0001, 0xe0020, 0xe0041, 0xe007f,
      // line and paragraph separators
      0x2028, 0x2029,
      // reserved as invisible, and still unassigned
      0x2065, 0xfff0, 0xfff8, 0xe0000, 0xe0080, 0xe01f0,
      // either half of a surrogate pair, alone
      0xd800, 0xdfff,
    ]),
  )('drops %s', (_label, code) => {
    expect(sanitiseCallerText(`a${char(code)}b`, 10)).toBe('ab');
  });

  it.each(byLabel([0x200c, 0x200d]))(
    'keeps %s — some scripts and emoji need it',
    (_label, code) => {
      expect(sanitiseCallerText(`a${char(code)}b`, 10)).toBe(`a${char(code)}b`);
    },
  );

  it.each(
    byLabel([
      0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890,
      0x0891, 0x08e2, 0x110bd, 0x110cd,
    ]),
  )('keeps %s — a format character that is drawn', (_label, code) => {
    // A prepended concatenation mark spans the digits after it. Dropped, it
    // would change real text in a row that can never be corrected.
    expect(sanitiseCallerText(`${char(code)}123`, 10)).toBe(`${char(code)}123`);
  });

  it.each(
    byLabel([
      // Just outside the edge of every dropped range, and the text a widened
      // range would eat: Latin-1 and Turkish letters, dashes, curly quotes,
      // `…`, private use, fullwidth forms, U+FFFD, emoji.
      0x20, 0x7e, 0xa0, 0xe7, 0xfc, 0x131, 0x15f, 0x200a, 0x2013, 0x2019, 0x2026,
      0x202f, 0xe000, 0xff01, 0xfffd, 0x1f600,
      // Beside the format characters dropped since 2026-09-16: the not sign,
      // the registered sign, the Arabic semicolon, end of text mark and cube
      // root, the hyphenation point, a mathematical space, superscript zero,
      // the object replacement character, and the hieroglyph, shorthand and
      // musical characters on either side of their format controls.
      0xac, 0xae, 0x61b, 0x61d, 0x606, 0x2027, 0x205f, 0x2070, 0xfffc,
      0x1342f, 0x13440, 0x1bc9f, 0x1d172, 0x1d17b,
      // Unassigned but NOT reserved as invisible: the rule takes invisibility,
      // not absence from the standard.
      0x0378,
    ]),
  )('keeps %s', (_label, code) => {
    // A range widened by one careless bound would strip real text from rows
    // that can never be corrected.
    expect(sanitiseCallerText(`a${char(code)}b`, 10)).toBe(`a${char(code)}b`);
  });

  it.each(
    byLabel([
      // variation selectors: U+FE0F gives an emoji its colour
      0xfe00, 0xfe0f, 0xe0100,
      // the combining grapheme joiner, the Hangul fillers, the Khmer inherent
      // vowels and a Mongolian free variation selector
      0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5, 0x180b,
    ]),
  )('stores %s — invisible, but not a format character', (_label, code) => {
    // Format characters, not every default-ignorable one: a user decision
    // (2026-09-16). This failing is that decision being changed. A QUOTE names
    // them all the same, which is the test below.
    expect(sanitiseCallerText(`a${char(code)}b`, 10)).toBe(`a${char(code)}b`);
  });

  it('counts code points, so the cut never lands inside a character', () => {
    // A UTF-16 slice to 3 would keep half of the emoji.
    const emoji = char(0x1f600);
    expect(sanitiseCallerText(`ab${emoji}c`, 3)).toBe(`ab${emoji}`);
  });

  it('counts only KEPT characters against the bound, and marks nothing', () => {
    // Padding must not push the visible text out of the excerpt. The audit
    // row has never carried a cut mark, nor a marker.
    expect(sanitiseCallerText(`${ZWSP.repeat(50)}tco2e`, 5)).toBe('tco2e');
    expect(sanitiseCallerText('abcd', 3)).toBe('abc');
  });

  it('reads a missing value as empty', () => {
    expect(sanitiseCallerText(undefined, 10)).toBe('');
  });

  it('leaves no break in the log line a cleaned value is written into', () => {
    // WHY the separators are dropped, asserted at the reader rather than at
    // the rule: `sanitiseCallerText` feeds the audit row's `reason` and
    // `fileName`, the report's messages and `BatchFailureLog`, and all of
    // those end up inside one `JSON.stringify` line. A consumer that splits
    // on the Unicode line-break set (Python's `str.splitlines()`, some log
    // agents, browsers) must find only the breaks the logger itself wrote.
    const breaks = [0x85, 0x2028, 0x2029];
    const forged = `a${char(0x2028)}${char(0x85)}{"level":"error"}${char(0x2029)}b`;

    // The premise, so this cannot pass by the encoder changing underneath it:
    // these three are the ones `JSON.stringify` does NOT escape. U+000A and
    // U+000D are absent on purpose — the encoder turns them into two ASCII
    // characters, so asserting them here would assert the encoder, not this.
    const dirty = JSON.stringify({ reason: forged });
    for (const code of breaks) expect(dirty).toContain(char(code));

    // BOTH exits. 500 leaves the value whole; 5 forces the bound's early
    // return, which is the half that a separator removed from the RESULT
    // instead of inside `isDropped` would leave open — measured there, a
    // `fileName` at cap 10 came back as ten raw separators and no filename.
    for (const max of [500, 5]) {
      const line = JSON.stringify({ reason: sanitiseCallerText(forged, max) });
      for (const code of breaks) expect(line).not.toContain(char(code));
    }
    expect(sanitiseCallerText(forged, 5)).toBe('a{"le');
  });
});

describe('quoteCallerText', () => {
  it('names a dropped character where it stood', () => {
    // Dropped silently, `category` + U+200B was quoted as `category`, in the
    // sentence refusing it for not being `category`.
    expect(quote(`category${ZWSP}`)).toBe('category<U+200B>');
    expect(quote(`t${char(0)}co${char(0x202e)}2${ZWSP}e`)).toBe(
      't<U+0000>co<U+202E>2<U+200B>e',
    );
  });

  it('names a cell of nothing but named characters, rather than quote nothing', () => {
    expect(quote(ZWSP)).toBe('<U+200B>');
  });

  it.each(
    byLabel([
      // kept in storage, because emoji and some scripts are made of them
      0x200c, 0x200d, 0xfe0f, 0xe0100, 0x034f, 0x3164, 0x180b,
      // dropped from storage since 2026-09-16, and named here too
      0xe0080,
    ]),
  )('names %s, which a quote cannot show either', (_label, code) => {
    // Shown as they are, all of these quoted `category` + the character as a
    // bare `category`, beside "Expected: …, category, …".
    expect(quote(`category${char(code)}`)).toBe(`category<${label(code)}>`);
  });

  it('shows a mark that is drawn, because it is not invisible', () => {
    expect(quote(`${char(0x600)}123`)).toBe(`${char(0x600)}123`);
  });

  it('shows ordinary whitespace, rather than naming it', () => {
    // A space is not invisible. Named, every header cell with one in it would
    // come back as markers.
    expect(quote('my column')).toBe('my column');
    expect(quote(`my${char(0xa0)}column`)).toBe(`my${char(0xa0)}column`);
  });

  it('names U+2800, the blank people paste for an invisible character', () => {
    // Unicode files it as a symbol, not as invisible, so nothing else catches
    // it — and it renders as nothing at all.
    expect(quote(`${char(0x2800).repeat(6)}tco2e`)).toBe('<U+2800 x6>tco2e');
  });

  it('names the characters its own syntax is made of, so a file cannot forge them', () => {
    // Typed out, `category<U+200B>` quoted exactly like a real zero-width
    // space, a typed `…` like the mark of a cut, and a typed `"` like the
    // delimiter the refusal puts around each cell.
    expect(quote('category<U+200B>')).toBe('category<U+003C>U+200B>');
    expect(quote('category<U+200B>')).not.toBe(quote(`category${ZWSP}`));
    expect(quote('abc…')).toBe('abc<U+2026>');
    expect(quote('my "column"')).toBe('my <U+0022>column<U+0022>');
  });

  it('writes a run as one marker, counting what repeats', () => {
    expect(quote(`${char(0x2063).repeat(40)}tco2e`)).toBe('<U+2063 x40>tco2e');
    expect(quote(`${ZWJ.repeat(40)}tco2e`)).toBe('<U+200D x40>tco2e');
    // Distinct code points in the order they FIRST APPEAR, not by how often.
    expect(quote(`a${char(0x2060)}${ZWSP}${ZWSP}b`)).toBe('a<U+2060 U+200B x2>b');
  });

  it('ends a run at the first character it shows', () => {
    // A drawn mark between two runs makes two markers, not one.
    expect(quote(`${ZWSP}${char(0x600)}${ZWSP}1`)).toBe(
      `<U+200B>${char(0x600)}<U+200B>1`,
    );
  });

  it('names at most three code points in one marker', () => {
    const run = (codes: number[]) => codes.map(char).join('');
    expect(quote(`a${run([0x01, 0x02, 0x03])}b`)).toBe(
      'a<U+0001 U+0002 U+0003>b',
    );
    expect(quote(`a${run([0x01, 0x02, 0x03, 0x04])}b`)).toBe(
      'a<U+0001 U+0002 U+0003 …>b',
    );
  });

  it('labels a supplementary or an unpaired code point in full', () => {
    expect(quote(char(0xe0041))).toBe('<U+E0041>');
    expect(quote(char(0xd800))).toBe('<U+D800>');
    // Two halves that pair are one character, and that character is shown.
    expect(quote(char(0x1f600))).toBe(char(0x1f600));
  });

  it('quotes what it shows exactly as it is', () => {
    const shown = [0xe7, 0x600, 0x1f600].map(char).join('');
    expect(quote(`a${shown}b`)).toBe(`a${shown}b`);
  });

  it('counts a marker as ONE unit against the first bound', () => {
    expect(quote(`${ZWSP.repeat(1000)}tco2e`, 6)).toBe('<U+200B x1000>tco2e');
    // Not free, and not as long as its text.
    expect(quote(`${ZWSP}ab`, 2)).toBe('<U+200B>a…');
  });

  it('bounds the quote in code points too, so a refusal fits the audit row', () => {
    // A marker is one unit but up to about 54 code points, so twenty of them
    // in one quote wrote a sentence the audit row could only store cut — in
    // half of a marker, turning a count of forty into four.
    const cell = `a${char(0x2063).repeat(40)}`.repeat(20);
    const quoted = quote(cell, 40, 60);
    expect([...quoted].length).toBeLessThanOrEqual(61);
    expect(quoted.endsWith('…')).toBe(true);
    // Padding by ONE run still cannot push a name out: that marker is short.
    expect(quote(`${char(0x2063).repeat(1000)}${'n'.repeat(39)}`, 40, 60)).toBe(
      `<U+2063 x1000>${'n'.repeat(39)}`,
    );
    // A character costs ONE code point, whatever its UTF-16 length.
    expect(quote(char(0x1f600).repeat(5), 40, 5)).toBe(char(0x1f600).repeat(5));
  });

  it('ends in `…` only when something past a bound was cut', () => {
    expect(quote('abcd', 3)).toBe('abc…');
    expect(quote('abc', 3)).toBe('abc');
    // A run past the bound is part of the cell too.
    expect(quote(`abc${ZWSP}`, 3)).toBe('abc…');
    expect(quote(`ab${ZWSP}`, 3)).toBe('ab<U+200B>');
    // And a cut in the middle of the cell is marked like any other.
    expect(quote(`abc${ZWSP}d`, 3)).toBe('abc…');
    // The CODE-POINT bound cuts as well, and a trailing run whose marker will
    // not fit is a cut like any other. Unmarked, a cell refused FOR an
    // invisible character would be quoted as though it held none.
    expect(quote(`ab${ZWSP}`, 40, 9)).toBe('ab…');
    expect(quote(`ab${ZWSP}`, 40, 10)).toBe('ab<U+200B>');
  });

  it('survives the audit rule unchanged', () => {
    // The refusal's sentence is also the audit row's `reason`, cleaned again
    // there: a marker the rule could strip would store a different sentence.
    const hidden = [0x00, 0x202e, 0xe0041, 0x2063].map(char).join('');
    const quoted = quote(`x${hidden}y`);
    expect(quoted).toBe('x<U+0000 U+202E U+E0041 …>y');
    expect(sanitiseCallerText(quoted, 500)).toBe(quoted);
  });

  it('reads a missing value as empty', () => {
    expect(quote(undefined)).toBe('');
  });

  it('quotes at most forty kept code points, and marks the cut', () => {
    // Pinned as a literal: a bound derived from the constant under test passes
    // with the constant widened to 32,000.
    expect(CALLER_TEXT_QUOTE_MAX_LENGTH).toBe(40);
    expect(quoteCallerText('y'.repeat(41))).toBe(`${'y'.repeat(40)}…`);
    expect(quoteCallerText('y'.repeat(40))).toBe('y'.repeat(40));
  });

  it('names padding rather than dropping it, and still shows the value', () => {
    // #110 dropped it in silence, which is the confusion the 2026-09-16
    // decision ended: a row refused FOR an invisible character quoted its
    // value as though the value held none.
    const padded = `${char(0x202e)}${char(0)}${char(0x200b).repeat(100)}2024`;
    expect(quoteCallerText(padded)).toBe('<U+202E U+0000 U+200B x100>2024');
  });

  it('cuts between characters, never inside one', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(quoteCallerText(emoji.repeat(41))).toBe(`${emoji.repeat(40)}…`);
  });
});
