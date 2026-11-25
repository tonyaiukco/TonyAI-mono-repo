import { describe, expect, it } from "vitest";
import { createTranslator } from "use-intl/core";
import { MESSAGES } from "@/messages";
import type { Locale, RecordTrailEventKind } from "@/lib/types";
import { RECORD_TRAIL_EVENT_KINDS } from "@/lib/types";
import { recordWordsFor } from "@/lib/i18n/testing";
import {
  formatTrailChange,
  formatTrailValue,
  trailValueKey,
  trailFieldLabel,
  trailKindLabel,
  TRAIL_KIND_STYLE,
  type TrailTranslator,
} from "./record-trail-view";

const rootFor = (locale: Locale): TrailTranslator =>
  createTranslator({ locale, messages: MESSAGES[locale], onError: (e) => { throw e; } }) as unknown as TrailTranslator;

const tFor = (locale: Locale): TrailTranslator =>
  createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace: "recordTrail",
    onError: (e) => {
      throw e;
    },
  }) as unknown as TrailTranslator;

describe("record trail — kinds", () => {
  it("reads the four steps of a revised record in Turkish", () => {
    const t = tFor("tr");
    const label = (kind: RecordTrailEventKind) => trailKindLabel({ kind, action: kind }, t);
    expect(label("recalled")).toBe("Geri çekildi");
    expect(label("returned")).toBe("İade edildi");
    expect(label("edited")).toBe("Düzenlendi");
    expect(label("resubmitted")).toBe("Yeniden gönderildi");
  });

  it("labels every kind in both languages", () => {
    for (const locale of ["en", "tr"] as const) {
      for (const kind of RECORD_TRAIL_EVENT_KINDS) {
        expect(trailKindLabel({ kind, action: "reprice" }, tFor(locale)).length).toBeGreaterThan(0);
      }
    }
  });

  it("gives every kind a mark and a colour of its own", () => {
    const styles = RECORD_TRAIL_EVENT_KINDS.map((k) => TRAIL_KIND_STYLE[k]);
    expect(new Set(styles.map((s) => s.mark)).size).toBe(styles.length);
    expect(new Set(styles.map((s) => s.dot)).size).toBe(styles.length);
  });

  it("gives recalled, returned, edited and resubmitted four colours and marks of their own", () => {
    const four = (["recalled", "returned", "edited", "resubmitted"] as const).map((k) => TRAIL_KIND_STYLE[k]);
    expect(new Set(four.map((s) => s.dot)).size).toBe(4);
    expect(new Set(four.map((s) => s.mark)).size).toBe(4);
    // ... and none of them is shared with another kind.
    const others = RECORD_TRAIL_EVENT_KINDS.filter((k) => !["recalled", "returned", "edited", "resubmitted"].includes(k));
    for (const s of four) {
      for (const k of others) expect(TRAIL_KIND_STYLE[k].dot).not.toBe(s.dot);
    }
  });

  it("labels a self-approval apart from an approval, in its own colour (inc26-roles-approval-chain)", () => {
    expect(trailKindLabel({ kind: "self_approved", action: "self_approve" }, tFor("en"))).toBe("Self-approved");
    expect(trailKindLabel({ kind: "self_approved", action: "self_approve" }, tFor("tr"))).toBe("Kendi kaydını onayladı");
    expect(trailKindLabel({ kind: "approved", action: "approve" }, tFor("en"))).toBe("Approved");
    expect(TRAIL_KIND_STYLE.self_approved.dot).not.toBe(TRAIL_KIND_STYLE.approved.dot);
    expect(TRAIL_KIND_STYLE.self_approved.mark).not.toBe(TRAIL_KIND_STYLE.approved.mark);
  });

  it("names an operator's action by its own label, and an unknown one as stored", () => {
    expect(trailKindLabel({ kind: "other", action: "reprice" }, tFor("en"))).toBe("Figure recalculated");
    expect(trailKindLabel({ kind: "other", action: "relink" }, tFor("en"))).toBe("relink");
  });
});

describe("record trail — fields and values", () => {
  it("writes 1200.5 as 1.200,5 in Turkish and 1,200.5 in English", () => {
    expect(formatTrailValue("activityValue", 1200.5, { t: tFor("tr"), locale: "tr" })).toBe("1.200,5");
    expect(formatTrailValue("activityValue", 1200.5, { t: tFor("en"), locale: "en" })).toBe("1,200.5");
  });

  it("writes the figure in tCO2e to three decimals and a year ungrouped", () => {
    expect(formatTrailValue("figure", 0.53041, { t: tFor("tr"), locale: "tr" })).toBe("0,53 tCO2e");
    expect(formatTrailValue("reportingYear", 2026, { t: tFor("tr"), locale: "tr" })).toBe("2026");
  });

  it("writes an absent value as a dash, and a period by the record's words", () => {
    expect(formatTrailValue("input.invoice_no", null, { t: tFor("en"), locale: "en" })).toBe("—");
    const words = recordWordsFor("tr");
    expect(formatTrailValue("periodValue", "Q2", { t: tFor("tr"), locale: "tr", words })).toBe(words.period("Q2"));
  });

  it("labels the listed fields in Turkish, an equipment line by its number", () => {
    const t = tFor("tr");
    expect(trailFieldLabel("activityValue", t)).toBe("Faaliyet değeri");
    expect(trailFieldLabel("input.invoice_no", t)).toBe("Fatura no");
    expect(trailFieldLabel("parameters.equipment.1.refillKg", t)).toBe("2. ekipman satırı: dolum (kg)");
    expect(trailFieldLabel("parameters.cvBasis", t)).toBe("Isıl değer esası");
  });

  it("writes an empty string as a dash, a yes/no in the user's language, and a category by its name", () => {
    const tr = tFor("tr");
    expect(formatTrailValue("input.notes", "", { t: tr, locale: "tr" })).toBe("—");
    expect(formatTrailValue("input.flag", true, { t: tr, locale: "tr" })).toBe("Evet");
    expect(formatTrailValue("input.flag", false, { t: tr, locale: "tr" })).toBe("Hayır");
    const words = recordWordsFor("tr");
    expect(formatTrailValue("category", "Natural Gas", { t: tr, locale: "tr", words })).toBe(words.category("Natural Gas"));
    expect(words.category("Natural Gas")).not.toBe("Natural Gas");
  });

  it("refuses an odd path or a prototype key in an equipment part", () => {
    const t = tFor("en");
    expect(trailFieldLabel("parameters.equipment.0.constructor", t)).toBe("parameters.equipment.0.constructor");
    expect(trailFieldLabel("input.a b", t)).toBe("input.a b");
    expect(trailFieldLabel("fields.toString", t)).toBe("fields.toString");
  });

  it("shows a path it has no label for as stored", () => {
    const t = tFor("en");
    expect(trailFieldLabel("parameters.futureBlock.x", t)).toBe("parameters.futureBlock.x");
    expect(trailFieldLabel("input.total_kwh", t)).toBe("input.total_kwh");
    expect(trailFieldLabel("parameters.equipment.0.newPart", t)).toBe("parameters.equipment.0.newPart");
    expect(trailFieldLabel("constructor", t)).toBe("constructor");
  });
});

describe("record trail — the owner review of 52ceb7e8", () => {
  it("never writes two different small figures alike", () => {
    const tr = { t: tFor("tr"), locale: "tr" as const };
    expect(formatTrailChange("figure", 0.00024, 0.00048, tr)).toEqual({ before: "0,0002 tCO2e", after: "0,0005 tCO2e" });
    expect(formatTrailChange("figure", 1.2341, 1.2344, tr)).toEqual({ before: "1,2341 tCO2e", after: "1,2344 tCO2e" });
    // A difference the usual precision shows keeps it.
    expect(formatTrailChange("figure", 0.442, 0.5304, tr)).toEqual({ before: "0,442 tCO2e", after: "0,53 tCO2e" });
  });

  it("never writes a non-zero figure as zero", () => {
    expect(formatTrailValue("figure", 0.00024, { t: tFor("en"), locale: "en" })).toBe("0.0002 tCO2e");
    expect(formatTrailValue("figure", 0, { t: tFor("en"), locale: "en" })).toBe("0 tCO2e");
  });

  it("words a stored code by its label in Turkish", () => {
    const copy = { t: tFor("tr"), locale: "tr" as const, root: rootFor("tr") };
    expect(formatTrailChange("reportingPeriod", "monthly", "quarterly", copy)).toEqual({ before: "Aylık", after: "Çeyreklik" });
    expect(formatTrailValue("parameters.selfGenerationSource", "natural_gas_chp", copy)).toBe("Doğal gaz kojenerasyonu");
    expect(formatTrailValue("parameters.cvBasis", "gross", copy)).toBe("Brüt");
    expect(formatTrailValue("parameters.equipment.1.leakRateChoice", "alternative", copy)).toBe("alternatif oran");
    expect(formatTrailValue("parameters.equipment.0.equipmentType", "chiller", copy)).toBe("Chiller (soğutma grubu)");
  });

  it("shows a code it has no word for, or an odd one, as stored", () => {
    const copy = { t: tFor("tr"), locale: "tr" as const, root: rootFor("tr") };
    expect(formatTrailValue("reportingPeriod", "fortnightly", copy)).toBe("fortnightly");
    expect(formatTrailValue("reportingPeriod", "constructor", copy)).toBe("constructor");
    expect(trailValueKey("input.notes", "monthly")).toBeNull();
    expect(trailValueKey("reportingPeriod", "a.b")).toBeNull();
  });
});

describe("record trail — the second owner review", () => {
  it("tells apart values below twelve decimals", () => {
    const en = { t: tFor("en"), locale: "en" as const };
    const shown = formatTrailChange("figure", 1e-13, 2e-13, en);
    expect(shown.before).not.toBe(shown.after);
    expect(shown.before).not.toMatch(/^0 tCO2e$/);
    expect(formatTrailValue("figure", 1e-13, en)).not.toBe("0 tCO2e");
  });

  it("words the legacy unspecified fuel as the other screens do", () => {
    const copy = { t: tFor("tr"), locale: "tr" as const, root: rootFor("tr") };
    expect(formatTrailValue("activityType", "unspecified", copy)).toBe(MESSAGES.tr.dataEntry.notSpecifiedLegacy);
  });
});
