import { describe, expect, it } from "vitest";
import { LOCALE_COOKIE, localeCookie, negotiateAcceptLanguage, resolveLocale } from "./locale";

describe("negotiateAcceptLanguage", () => {
  it.each([
    ["tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7", "tr"],
    ["en-GB,en;q=0.9,tr;q=0.8", "en"],
    ["de-DE,de;q=0.9,tr;q=0.5,en;q=0.4", "tr"],
    ["en;q=0.4,tr;q=0.9", "tr"],
    ["TR", "tr"],
    ["fr, de", null],
    ["tr;q=0, en;q=0.1", "en"],
    ["*", null],
    ["tr;q=abc,en", "en"],
    ["", null],
  ] as const)("%j → %s", (header, expected) => {
    expect(negotiateAcceptLanguage(header)).toBe(expected);
  });

  it("keeps the header's order between equal weights", () => {
    expect(negotiateAcceptLanguage("tr,en")).toBe("tr");
    expect(negotiateAcceptLanguage("en,tr")).toBe("en");
  });
});

describe("resolveLocale: cookie, then Accept-Language, then English", () => {
  it("prefers a valid cookie", () => {
    expect(resolveLocale("tr", "en-GB")).toBe("tr");
    expect(resolveLocale("en", "tr-TR")).toBe("en");
  });

  it("ignores a cookie it does not recognise", () => {
    expect(resolveLocale("de", "tr-TR")).toBe("tr");
    expect(resolveLocale("TR", undefined)).toBe("en");
    expect(resolveLocale("tr-TR", null)).toBe("en");
  });

  it("falls back to English", () => {
    expect(resolveLocale(undefined, undefined)).toBe("en");
    expect(resolveLocale(undefined, "fr-FR")).toBe("en");
  });
});

describe("localeCookie", () => {
  it("is a year-long, site-wide, Lax cookie; Secure on https", () => {
    expect(localeCookie("tr", false)).toBe(`${LOCALE_COOKIE}=tr; Path=/; Max-Age=31536000; SameSite=Lax`);
    expect(localeCookie("en", true)).toMatch(/; Secure$/);
  });
});
