import { describe, expect, it } from 'vitest';
import { sanitiseCallerText } from './caller-text';

// Built from code points, never typed: escape sequences typed into this repo
// have arrived in files as the literal, invisible character.
const char = (code: number) => String.fromCharCode(code);
const label = (code: number) =>
  `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

describe('sanitiseCallerText', () => {
  it.each(
    [
      // C0 controls, DEL and C1 controls
      0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x80, 0x85, 0x9f,
      // bidi embeddings, overrides and isolates
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
      // zero-width space, word joiner, BOM
      0x200b, 0x2060, 0xfeff,
      // either half of a surrogate pair, alone
      0xd800, 0xdfff,
    ].map((code) => [label(code), code] as const),
  )('drops %s', (_label, code) => {
    expect(sanitiseCallerText(`a${char(code)}b`, 10)).toBe('ab');
  });

  it.each([0x200c, 0x200d].map((code) => [label(code), code] as const))(
    'keeps %s — some scripts and emoji need it',
    (_label, code) => {
      expect(sanitiseCallerText(`a${char(code)}b`, 10)).toBe(`a${char(code)}b`);
    },
  );

  it.each(
    [
      // Just outside the edge of every dropped range, and the text a widened
      // range would eat: Latin-1 and Turkish letters, dashes, curly quotes,
      // `…`, private use, a variation selector, fullwidth forms, U+FFFD, emoji.
      0x20, 0x7e, 0xa0, 0xe7, 0xfc, 0x131, 0x15f, 0x200a, 0x2013, 0x2019, 0x2026,
      0x202f, 0xe000, 0xfe0f, 0xff01, 0xfffd, 0x1f600,
    ].map((code) => [label(code), code] as const),
  )('keeps %s', (_label, code) => {
    // A range widened by one careless bound would strip real text from rows
    // that can never be corrected.
    const kept = String.fromCodePoint(code);
    expect(sanitiseCallerText(`a${kept}b`, 10)).toBe(`a${kept}b`);
  });

  it('counts code points, so the cut never lands inside a character', () => {
    // A UTF-16 slice to 3 would keep half of the emoji.
    const emoji = String.fromCodePoint(0x1f600);
    expect(sanitiseCallerText(`ab${emoji}c`, 3)).toBe(`ab${emoji}`);
  });

  it('counts only KEPT characters against the bound', () => {
    // Padding must not push the visible text out of the excerpt.
    expect(sanitiseCallerText(`${char(0x200b).repeat(50)}tco2e`, 5, '…')).toBe(
      'tco2e',
    );
  });

  it('marks the cut only when kept text was cut', () => {
    expect(sanitiseCallerText('abcd', 3, '…')).toBe('abc…');
    expect(sanitiseCallerText('abc', 3, '…')).toBe('abc');
    // Past the bound there is only text that is dropped anyway.
    expect(sanitiseCallerText(`abc${char(0x200b)}${char(0)}`, 3, '…')).toBe('abc');
    // No mark asked for, none added — the audit row's shape.
    expect(sanitiseCallerText('abcd', 3)).toBe('abc');
  });

  it('reads a missing value as empty', () => {
    expect(sanitiseCallerText(undefined, 10)).toBe('');
  });
});
