import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/messages";
import {
  API_ERROR_CODES,
  API_ERROR_PARAMS,
  CATEGORIES,
  PERIOD_VALUES,
  REPORTING_PERIODS,
  SUPPORTED_LOCALES,
} from "@/lib/types";

/** Every leaf of a catalogue, as `dotted.key → message`. */
function leaves(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    for (const [k, v] of leaves(value, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
  }
  return out;
}

/** The ICU arguments a message names. Catalogues hold simple `{name}`
 *  arguments only — the test below fails on anything richer, which would need
 *  a real parser here first. */
function args(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/** A control, bidi or zero-width code point — built from numbers, because
 *  the characters themselves would be invisible in this file too. */
function hasInvisible(message: string): boolean {
  return [...message].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (
      c <= 0x1f ||
      c === 0x7f ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff
    );
  });
}

const en = leaves(MESSAGES.en);

describe("the catalogues", () => {
  it.each(SUPPORTED_LOCALES.filter((l) => l !== "en"))("%s has exactly English's keys", (locale) => {
    const other = leaves(MESSAGES[locale]);
    expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== "en"))("%s names the same ICU arguments in every message", (locale) => {
    const other = leaves(MESSAGES[locale]);
    for (const [key, message] of en) expect(args(other.get(key) ?? ""), key).toEqual(args(message));
  });

  it.each(SUPPORTED_LOCALES)("%s: no empty message, no message left untranslated as a key path", (locale) => {
    for (const [key, message] of leaves(MESSAGES[locale])) {
      expect(message.trim(), key).not.toBe("");
      expect(message, key).not.toBe(key);
    }
  });

  it.each(SUPPORTED_LOCALES)("%s: only simple {name} arguments (no plural/select the test cannot check)", (locale) => {
    for (const [key, message] of leaves(MESSAGES[locale])) {
      const braces = message.match(/[{}]/g)?.length ?? 0;
      expect(braces, key).toBe(args(message).length * 2);
    }
  });

  it("has no control, bidi or zero-width character (they render invisibly and survive review)", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, message] of leaves(MESSAGES[locale])) {
        expect(hasInvisible(message), `${locale} ${key}`).toBe(false);
      }
    }
  });
});

describe("the error codes", () => {
  it("every registered code has a sentence — and no sentence is for a code that does not exist", () => {
    const keys = [...en.keys()].filter((k) => k.startsWith("errors.codes.")).map((k) => k.slice("errors.codes.".length));
    expect(keys.sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it("each sentence names exactly the params its code carries (API_ERROR_PARAMS)", () => {
    for (const code of API_ERROR_CODES) {
      expect(args(en.get(`errors.codes.${code}`) ?? ""), code).toEqual([...(API_ERROR_PARAMS[code] ?? [])].sort());
    }
  });
});

describe("the canonical vocabularies", () => {
  it("every category has a label, keyed by its canonical value", () => {
    expect(Object.keys(MESSAGES.en.categories).sort()).toEqual([...CATEGORIES].sort());
  });

  it("every period value and granularity has a label", () => {
    expect(Object.keys(MESSAGES.en.periods.granularity).sort()).toEqual([...REPORTING_PERIODS].sort());
    expect(Object.keys(MESSAGES.en.periods.values).sort()).toEqual(Object.values(PERIOD_VALUES).flat().sort());
  });

  it("English labels are the canonical values themselves — the screen reads as it did", () => {
    for (const c of CATEGORIES) expect(MESSAGES.en.categories[c]).toBe(c);
    for (const v of Object.values(PERIOD_VALUES).flat()) {
      expect(MESSAGES.en.periods.values[v as keyof typeof MESSAGES.en.periods.values]).toBe(v);
    }
  });
});
