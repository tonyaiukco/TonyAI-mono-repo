// The decorator needs the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { IsActivityUnit } from './is-activity-unit.decorator';

// Built from code points, never typed: escape sequences typed into this repo
// have arrived in files as the literal, invisible character.
const char = (code: number) => String.fromCharCode(code);

class Probe {
  @IsActivityUnit()
  activityUnit!: unknown;
}

/** The decorator's own sentence about `value`, or `undefined` when it passes. */
function refusal(value: unknown): string | undefined {
  const probe = new Probe();
  probe.activityUnit = value;
  return validateSync(probe)[0]?.constraints?.isActivityUnit;
}

describe('IsActivityUnit', () => {
  it('accepts a unit the engine knows, under any of its spellings', () => {
    for (const unit of ['kWh', 'm3', 'cubic_metres', ' Standard cubic metres ']) {
      expect(refusal(unit)).toBeUndefined();
    }
  });

  it('names the unit it refuses', () => {
    expect(refusal('furlongs')).toBe(
      'activityUnit "furlongs" is not a unit this system understands',
    );
  });

  it('quotes forty code points of a long value, never the whole of it', () => {
    // A bulk import repeats this sentence in its report, where a
    // 100,000-character cell came back as a 100,053-character message.
    expect(refusal('k'.repeat(100_000))).toBe(
      `activityUnit "${'k'.repeat(40)}…" is not a unit this system understands`,
    );
  });

  it('names the characters that disguise the value it quotes', () => {
    // On screen, a U+202E reverses everything after it — and a unit quoted
    // with them dropped in silence read as a unit the system should know.
    expect(refusal(`k${char(0x202e)}W${char(0)}h${char(0x200b)}x`)).toBe(
      'activityUnit "k<U+202E>W<U+0000>h<U+200B>x" is not a unit this system understands',
    );
  });

  it('cannot be made to repeat the value through class-validator’s own tokens', () => {
    // The framework replaces `$value` in the finished sentence with the raw
    // value, as a `String.replace` replacement string — so `$'` expands as
    // well, and a value built from those tokens put the whole of itself back
    // into the sentence: a 99,994-byte body returned an 18,563,231-byte 400.
    const tokens = `${'$value'.repeat(7)}${"$'".repeat(50)}`;
    const message = refusal(tokens) ?? '';

    expect(message).not.toContain('$');
    expect(message.length).toBeLessThanOrEqual(120);
    // The sentence itself appears once: `$'` pastes everything after the match.
    expect(message.match(/is not a unit/g)).toHaveLength(1);
  });

  it('refuses a value that is not a string, naming what it got', () => {
    expect(refusal(42)).toBe(
      'activityUnit "42" is not a unit this system understands',
    );
  });
});
