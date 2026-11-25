import { describe, expect, it } from "vitest";
import { MESSAGES } from "@/messages";

/**
 * WP5 (`uat4-review-resubmit`, owner decision 2026-11-25): the reviewer's action
 * is a return in both languages, the stored status keeps `rejected`, and a
 * record sent again is "Revised". Pinned here because these words are what QA
 * retests; a key rename would also fail the catalogue parity spec.
 */
describe("the reviewer's action is worded as a return", () => {
  it("in Turkish", () => {
    const tr = MESSAGES.tr;
    expect(tr.review.sheet.reject).toBe("İade et");
    expect(tr.review.toast.rejected).toMatch(/iade edildi/);
    expect(tr.recordStatus.label.rejected).toBe("İade edildi");
    expect(tr.review.revised.label).toBe("Revize");
    expect(tr.recordStatus.label.under_review).toBe("İncelemede");
  });

  it("in English", () => {
    const en = MESSAGES.en;
    expect(en.review.sheet.reject).toBe("Return");
    expect(en.review.toast.rejected).toMatch(/^Record returned/);
    expect(en.recordStatus.label.rejected).toBe("Returned");
    expect(en.review.revised.label).toBe("Revised");
  });

  it("leaves no reviewer's reject wording in the review, status and record error copy", () => {
    for (const locale of ["en", "tr"] as const) {
      const m = MESSAGES[locale];
      // The sentences only: keys such as `rejected` keep their names.
      const values: string[] = [];
      const walk = (node: unknown) => {
        if (typeof node === "string") values.push(node);
        else if (node && typeof node === "object") Object.values(node).forEach(walk);
      };
      walk([m.review, m.recordStatus, m.bulkSubmit, m.emissions]);
      const copy = values.join("\n");
      expect(copy, locale).not.toMatch(locale === "en" ? /reject|sent back|send it back/i : /reddet|reddedil|geri gönder/i);
    }
  });
});
