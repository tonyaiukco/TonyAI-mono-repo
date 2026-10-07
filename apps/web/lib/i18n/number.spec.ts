import { describe, expect, it } from "vitest";
import {
  checkActivityValue,
  formatDecimalInput,
  formatNumber,
  parseLocaleDecimal,
  reformatDecimalInput,
} from "./number";

/**
 * D15 / F09's acceptance cases: every one has an explicit, tested outcome in
 * both locales. A misread quantity is the failure that matters — so the
 * refusals below are as much the contract as the readings.
 */
describe("parseLocaleDecimal — the F09 table", () => {
  it.each([
    // input,          Turkish,                         English
    ["1.234,5", { value: 1234.5, grouped: true }, "invalid"],
    ["1,5", { value: 1.5, grouped: false }, "wrong_decimal_separator"],
    ["1.234", { value: 1234, grouped: true }, { value: 1.234, grouped: false }],
    ["1,234", { value: 1.234, grouped: false }, { value: 1234, grouped: true }],
    ["1234.5", "wrong_decimal_separator", { value: 1234.5, grouped: false }],
    ["1.23", "wrong_decimal_separator", { value: 1.23, grouped: false }],
    ["1,234.5", "invalid", { value: 1234.5, grouped: true }],
    ["1.234.567,89", { value: 1234567.89, grouped: true }, "invalid"],
    ["1,234,567.89", "invalid", { value: 1234567.89, grouped: true }],
    ["45000", { value: 45000, grouped: false }, { value: 45000, grouped: false }],
    ["0", { value: 0, grouped: false }, { value: 0, grouped: false }],
    ["0,5", { value: 0.5, grouped: false }, "wrong_decimal_separator"],
    ["0.5", "wrong_decimal_separator", { value: 0.5, grouped: false }],
    ["-5", { value: -5, grouped: false }, { value: -5, grouped: false }],
    ["-1.234,5", { value: -1234.5, grouped: true }, "invalid"],
    ["-0", { value: 0, grouped: false }, { value: 0, grouped: false }],
    ["  12  ", { value: 12, grouped: false }, { value: 12, grouped: false }],
  ] as const)("%s → tr %j · en %j", (input, tr, en) => {
    for (const [locale, expected] of [["tr", tr], ["en", en]] as const) {
      const got = parseLocaleDecimal(input, locale);
      if (typeof expected === "string") expect(got, `${locale}`).toEqual({ ok: false, reason: expected });
      else expect(got, `${locale}`).toEqual({ ok: true, ...expected });
    }
  });

  it.each([
    "",
    "   ",
  ])("%j is empty, in both", (input) => {
    expect(parseLocaleDecimal(input, "tr")).toEqual({ ok: false, reason: "empty" });
    expect(parseLocaleDecimal(input, "en")).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    "1e3",
    "1E3",
    "+5",
    "1 234",
    `1${String.fromCharCode(0xa0)}234`,
    ",5",
    ".5",
    "5,",
    "5.",
    "12.34,5",
    "1..234",
    "1,,234",
    "--5",
    "5-",
    "abc",
    "Infinity",
    "NaN",
    "0x10",
    "١٢٣",
    "１２３",
    "12.3.4",
    "1,2,3",
  ])("%j is refused in both locales — never guessed", (input) => {
    const tr = parseLocaleDecimal(input, "tr");
    const en = parseLocaleDecimal(input, "en");
    expect(tr.ok, `tr ${JSON.stringify(tr)}`).toBe(false);
    expect(en.ok, `en ${JSON.stringify(en)}`).toBe(false);
  });

  it("refuses a number too large to be finite rather than storing Infinity", () => {
    expect(parseLocaleDecimal("9".repeat(400), "en")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("checkActivityValue — Data Entry's rule", () => {
  it("accepts a positive number in the user's locale", () => {
    expect(checkActivityValue("1.234,5", "tr")).toEqual({ ok: true, value: 1234.5, grouped: true });
    expect(checkActivityValue("1,234.5", "en")).toEqual({ ok: true, value: 1234.5, grouped: true });
  });

  it.each(["0", "-1", "-0,5", "0,0"])("refuses %j (tr) as not above zero", (input) => {
    expect(checkActivityValue(input, "tr")).toEqual({ ok: false, reason: "not_positive" });
  });

  it("passes the parser's reasons through", () => {
    expect(checkActivityValue("", "tr")).toEqual({ ok: false, reason: "empty" });
    expect(checkActivityValue("1234.5", "tr")).toEqual({ ok: false, reason: "wrong_decimal_separator" });
    expect(checkActivityValue("1e3", "en")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("formatDecimalInput — what an input field shows", () => {
  it("uses the locale's decimal separator and never groups", () => {
    expect(formatDecimalInput(1234.5, "tr")).toBe("1234,5");
    expect(formatDecimalInput(1234.5, "en")).toBe("1234.5");
    expect(formatDecimalInput(640, "en")).toBe("640");
    expect(formatDecimalInput(1234567, "tr")).toBe("1234567");
  });

  it("writes no exponent, at either end", () => {
    expect(formatDecimalInput(1e21, "en")).toBe("1000000000000000000000");
    expect(formatDecimalInput(1e-7, "tr")).toBe("0,0000001");
  });

  it("round-trips: reading back what it wrote gives the same number, in both locales", () => {
    const values = [0, 1, 0.1, 0.2, 0.3, 1.5, 12.25, 640, 1234.5, 45000, 99999.999, 1234567.891, 0.000123, 3.14159265358979, 1e-7, 1e15, 2 ** 53 - 1];
    for (let i = 0; i < 500; i++) values.push(Number((Math.random() * 10 ** (i % 12)).toFixed(i % 7)));
    for (const value of values) {
      for (const locale of ["tr", "en"] as const) {
        const text = formatDecimalInput(value, locale);
        const back = parseLocaleDecimal(text, locale);
        expect(back, `${locale} ${value} → ${text}`).toEqual({ ok: true, value, grouped: false });
      }
    }
  });

  it("writes nothing for a value that is not a number", () => {
    expect(formatDecimalInput(Number.NaN, "en")).toBe("");
    expect(formatDecimalInput(Number.POSITIVE_INFINITY, "tr")).toBe("");
  });
});

describe("a language change cannot change a quantity", () => {
  it.each([
    ["1.234", "tr", "en", "1234"],
    ["1.234,5", "tr", "en", "1234.5"],
    ["1,234.5", "en", "tr", "1234,5"],
    ["1.234", "en", "tr", "1,234"],
    ["0,5", "tr", "en", "0.5"],
  ] as const)("%j typed in %s reads the same in %s (%j)", (text, from, to, expected) => {
    const before = parseLocaleDecimal(text, from);
    const moved = reformatDecimalInput(text, from, to);
    expect(moved).toBe(expected);
    const after = parseLocaleDecimal(moved, to);
    expect(before.ok && after.ok && after.value === before.value).toBe(true);
  });

  it("keeps text it cannot read as typed, rather than inventing a number", () => {
    expect(reformatDecimalInput("12a", "tr", "en")).toBe("12a");
    expect(reformatDecimalInput("1234.5", "tr", "en")).toBe("1234.5");
  });

  it("is the identity within one locale", () => {
    expect(reformatDecimalInput("1.234", "tr", "tr")).toBe("1.234");
  });
});

describe("formatNumber — display", () => {
  it("groups and separates by the locale", () => {
    expect(formatNumber(1234.5, "tr", { maximumFractionDigits: 1 })).toBe("1.234,5");
    expect(formatNumber(1234.5, "en", { maximumFractionDigits: 1 })).toBe("1,234.5");
  });

  it("English is British: what every screen formatted with before LP3-01", () => {
    expect(formatNumber(1234567.891, "en", { maximumFractionDigits: 3 })).toBe(
      new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(1234567.891),
    );
  });
});
