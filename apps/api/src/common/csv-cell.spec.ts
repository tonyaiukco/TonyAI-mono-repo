import { describe, it, expect } from 'vitest';
import { csvField, isFormulaLead, neutraliseCell } from './csv-cell';

/** The four characters a spreadsheet reads as "this cell is code". */
const LEADS = ['=', '+', '-', '@'];

/**
 * Every way to put whitespace in front of one of them. The first cut anchored
 * the guard at index 0, so all six of these evaded it; `\r` alone was caught
 * incidentally, by the quote test rather than by the neutraliser.
 */
// Escapes, not literals: an editor or a formatter that normalises
// invisible characters would turn the NBSP into a plain space and leave
// the test green while testing something weaker.
const PREFIXES = ['', ' ', '   ', '\t', '\r\n', '\u00A0', '\uFEFF'];

describe('isFormulaLead', () => {
  it.each(
    LEADS.flatMap((lead) =>
      PREFIXES.map((p) => [JSON.stringify(p + lead), p + lead] as const),
    ),
  )('flags %s', (_label, value) => {
    expect(isFormulaLead(`${value}SUM(A1)`)).toBe(true);
  });

  it.each([
    ['ordinary text', 'Electricity'],
    ['a lead that is not leading', 'Q1=Q2'],
    ['a period label', '2026-01'],
    ['a date-like period', 'January'],
    ['an already-neutralised value', "'=SUM(A1)"],
    ['the empty string', ''],
    ['whitespace only', '   '],
  ])('does not flag %s', (_label, value) => {
    expect(isFormulaLead(value)).toBe(false);
  });
});

describe('what the class deliberately does NOT cover', () => {
  /**
   * `\s` is a CHOICE, and every other assertion in this file uses the same
   * class the implementation does — so the suite pins the anchoring and
   * assumes the class. These characters are the same evasion idea and are
   * outside it. Asserting the shipped behaviour makes widening the class a
   * deliberate act with a failing test behind it, instead of a silent one.
   *
   * They are unaddressed because no spreadsheet is known to skip them; if one
   * ever is, this test is the thing that should fail.
   */
  it.each([
    ['U+200B ZERO WIDTH SPACE', '\u200B'],
    ['U+0085 NEXT LINE', '\u0085'],
    ['U+2060 WORD JOINER', '\u2060'],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', '\u180E'],
  ])('%s is NOT treated as leading whitespace', (_label, ch) => {
    expect(isFormulaLead(`${ch}=SUM(A1)`)).toBe(false);
    expect(csvField(`${ch}=SUM(A1)`)).toBe(`${ch}=SUM(A1)`);
  });
});

describe('neutraliseCell', () => {
  it('prefixes without trimming: the value still says what it said', () => {
    // NOT '=SUM(A1)'. Trimming would be a silent edit to a cell inside a
    // compliance artifact; the apostrophe is visible and reversible by a human.
    expect(neutraliseCell('   =SUM(A1)')).toBe("'   =SUM(A1)");
    expect(neutraliseCell('\t=HYPERLINK("evil")')).toBe('\'\t=HYPERLINK("evil")');
  });

  /**
   * The pair that stops the obvious "just drop `-` from the class" regression.
   * `-` leads a formula AND leads every negative number; the branch has to
   * split on the JS type, not on the character.
   */
  it('leaves a negative NUMBER summable and still neutralises negative TEXT', () => {
    expect(neutraliseCell(-12.5)).toBe('-12.5');
    expect(neutraliseCell('-12.5')).toBe("'-12.5");
  });

  it.each([
    [0, '0'],
    [1000, '1000'],
    [0.44, '0.44'],
    [-0.001, '-0.001'],
  ])('writes the finite number %s unprefixed', (value, expected) => {
    expect(neutraliseCell(value)).toBe(expected);
  });

  it('treats a non-finite number as text, because that is what it prints as', () => {
    // `String(-Infinity)` leads with `-`, so it takes the string path and is
    // prefixed like any other hostile text rather than shipping as a bare lead.
    expect(neutraliseCell(-Infinity)).toBe("'-Infinity");
    expect(neutraliseCell(NaN)).toBe('NaN');
  });
});

describe('csvField', () => {
  it('neutralises BEFORE quoting, so the apostrophe lands inside the quotes', () => {
    // Reversing the order yields `'"…"`, which no parser reads as one field.
    expect(csvField('=HYPERLINK("evil"),Total')).toBe(
      '"\'=HYPERLINK(""evil""),Total"',
    );
  });

  it('quotes a bare carriage return: unquoted it forges a second ledger row', () => {
    expect(csvField('one\rtwo')).toBe('"one\rtwo"');
  });

  it('leaves an ordinary cell alone', () => {
    expect(csvField('Electricity')).toBe('Electricity');
    expect(csvField(1000)).toBe('1000');
  });
});
