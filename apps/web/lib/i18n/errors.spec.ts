import { describe, expect, it } from "vitest";
import { createTranslator } from "use-intl/core";
import { ApiError, apiError } from "@/lib/api";
import { MESSAGES } from "@/messages";
import type { Locale } from "@/lib/types";
import { describeApiError, type ErrorTranslator } from "./errors";

const translators: Record<Locale, ErrorTranslator> = {
  en: createTranslator({ locale: "en", messages: MESSAGES.en }) as unknown as ErrorTranslator,
  tr: createTranslator({ locale: "tr", messages: MESSAGES.tr }) as unknown as ErrorTranslator,
};
const describe_ = (e: unknown, locale: Locale) => describeApiError(e, translators[locale], locale);

describe("a code the catalogue knows", () => {
  it("is worded by the catalogue in both languages — the server's English never shown", () => {
    const e = new ApiError("This record was changed by someone else…", 409, "record_changed");
    expect(describe_(e, "tr")).toEqual({ title: MESSAGES.tr.errors.codes.record_changed });
    expect(describe_(e, "en")).toEqual({ title: MESSAGES.en.errors.codes.record_changed });
  });

  it("fills its params, period and category in the user's language and the year ungrouped", () => {
    const locked = new ApiError("Reporting period March 2025 is locked", 409, "period_locked", { period: "March", year: 2025 });
    expect(describe_(locked, "tr").title).toBe(
      "Mart 2025 raporlama dönemi kilitli — içindeki bir şeyin değişebilmesi için bir süper yöneticinin kilidi açması gerekir.",
    );
    expect(describe_(locked, "en").title).toMatch(/^Reporting period March 2025 is locked/);
    const evidence = new ApiError("x", 400, "evidence_required", { category: "Natural Gas" });
    expect(describe_(evidence, "tr").title).toMatch(/^Doğal gaz kategorisindeki/);
  });

  it("falls back to the status's sentence when a param it names did not arrive", () => {
    const e = new ApiError("Reporting period March 2025 is locked — …", 409, "period_locked", { period: "March" });
    expect(describe_(e, "tr")).toEqual({
      title: MESSAGES.tr.errors.codes.conflict,
      description: "Reporting period March 2025 is locked — …",
    });
    expect(describe_(e, "en")).toEqual({ title: "Reporting period March 2025 is locked — …" });
  });

  it("keeps an unknown period or category as sent rather than inventing one", () => {
    const e = new ApiError("x", 409, "period_locked", { period: "Week 3", year: 2025 });
    expect(describe_(e, "tr").title).toMatch(/^Week 3 2025 raporlama/);
  });

  it("a not-found code says which kind of thing, the same for everyone", () => {
    const e = new ApiError("Activity record not found", 404, "record_not_found");
    expect(describe_(e, "tr").title).toBe("Faaliyet kaydı bulunamadı — silinmiş olabilir.");
  });
});

describe("a calculation refusal keeps its lookup-specific English (independent review P3-7)", () => {
  const sentence = 'Unit "litres" is not valid for "Electricity". Accepted: kWh, MWh.';
  const refusal = new ApiError(sentence, 400, "unit_not_for_category");

  it("English: the server's sentence, which names the unit, category and accepted units — as before LP3-01", () => {
    expect(describe_(refusal, "en")).toEqual({ title: sentence });
  });

  it("Turkish: the catalogue's sentence, with the English detail beneath", () => {
    expect(describe_(refusal, "tr")).toEqual({ title: MESSAGES.tr.errors.codes.unit_not_for_category, description: sentence });
  });

  it("with no sentence to show, the catalogue's alone", () => {
    const bare = new ApiError("API 404", 404, "no_factor");
    expect(describe_(bare, "en")).toEqual({ title: MESSAGES.en.errors.codes.no_factor });
  });

  it("other specific codes are still worded by the catalogue alone", () => {
    const changed = new ApiError("This record was changed by someone else…", 409, "record_changed");
    expect(describe_(changed, "tr")).toEqual({ title: MESSAGES.tr.errors.codes.record_changed });
  });
});

describe("a generic code, or none (decision K5)", () => {
  it("English: the server's own sentence, exactly as before LP3-01", () => {
    const e = new ApiError("Only super_admin may manage targets", 403, "forbidden");
    expect(describe_(e, "en")).toEqual({ title: "Only super_admin may manage targets" });
  });

  it("Turkish: the generic sentence, with the server's English beneath it", () => {
    const e = new ApiError("Only super_admin may manage targets", 403, "forbidden");
    expect(describe_(e, "tr")).toEqual({
      title: "Bu işlem için yetkiniz yok.",
      description: "Only super_admin may manage targets",
    });
  });

  it("a code this build does not know is shown by its status", () => {
    // `api.ts` drops an unregistered code, so it arrives as none.
    const e = new ApiError("A newer refusal", 409);
    expect(describe_(e, "tr")).toEqual({ title: MESSAGES.tr.errors.codes.conflict, description: "A newer refusal" });
    expect(describe_(e, "en")).toEqual({ title: "A newer refusal" });
  });

  it.each([
    [401, "unauthorized", "Invalid or expired token"],
    [429, "rate_limited", "ThrottlerException: Too Many Requests"],
    [500, "internal_error", "Internal server error"],
    [503, "internal_error", "Internal server error"],
  ] as const)("%i: the catalogue's sentence in both — the server's adds nothing", (status, code, message) => {
    const e = new ApiError(message, status, code);
    expect(describe_(e, "en")).toEqual({ title: MESSAGES.en.errors.codes[code] });
    expect(describe_(e, "tr")).toEqual({ title: MESSAGES.tr.errors.codes[code] });
  });

  it("a 401 keeps the session-expired sentence the pages always used", () => {
    expect(describe_(new ApiError("Unauthorized", 401), "en").title).toBe("Your session has expired — please sign in again.");
  });

  it("a body with no sentence (a proxy's 413) is worded by the catalogue alone", () => {
    const e = new ApiError("API 413", 413);
    expect(describe_(e, "en")).toEqual({ title: MESSAGES.en.errors.codes.payload_too_large });
    expect(describe_(e, "tr")).toEqual({ title: MESSAGES.tr.errors.codes.payload_too_large });
  });
});

describe("not an API answer", () => {
  it("a failed fetch is a network problem", () => {
    expect(describe_(new TypeError("Failed to fetch"), "tr")).toEqual({ title: MESSAGES.tr.errors.network });
  });

  it("anything else is unexpected — its text is never shown", () => {
    expect(describe_(new Error("Cannot read properties of undefined"), "en")).toEqual({ title: MESSAGES.en.errors.unexpected });
    expect(describe_("boom", "tr")).toEqual({ title: MESSAGES.tr.errors.unexpected });
  });
});

describe("apiError — what api.ts keeps from a failed response", () => {
  const response = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("keeps a registered code and plain params", async () => {
    const e = await apiError(response(409, { statusCode: 409, message: "locked", code: "period_locked", params: { period: "March", year: 2025 } }));
    expect(e).toMatchObject({ status: 409, message: "locked", code: "period_locked", params: { period: "March", year: 2025 } });
  });

  it("drops a code it does not know, and a prototype key", async () => {
    expect((await apiError(response(409, { message: "x", code: "from_the_future" }))).code).toBeUndefined();
    expect((await apiError(response(409, { message: "x", code: "constructor" }))).code).toBeUndefined();
  });

  it("drops params that are not plain strings or finite numbers", async () => {
    const e = await apiError(
      response(409, { message: "x", code: "period_locked", params: { period: "March", year: 2025, html: { a: 1 }, list: [1], n: null } }),
    );
    expect(e.params).toEqual({ period: "March", year: 2025 });
    expect((await apiError(response(409, { message: "x", params: ["a"] }))).params).toBeUndefined();
  });

  it("joins a validation list and survives a non-JSON body", async () => {
    expect((await apiError(response(400, { message: ["a must be x", "b must be y"], code: "validation_failed" }))).message).toBe(
      "a must be x, b must be y",
    );
    const proxy = await apiError(new Response("<html>413</html>", { status: 413 }));
    expect(proxy).toMatchObject({ status: 413, message: "API 413", code: undefined });
  });
});
