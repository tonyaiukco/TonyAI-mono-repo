import { describe, expect, it } from "vitest";
import { EVIDENCE_ASSISTANT_UNREAD_REASONS, EVIDENCE_SPLIT_NOT_ATTACHED_REASONS, type EvidenceAssistantInvoiceDTO } from "@/lib/types";
import { copyFor } from "@/lib/i18n/testing";
import {
  fileText,
  invoiceLevelText,
  latestOnly,
  lineChip,
  lineText,
  panelShown,
  periodLabel,
  shortInvoiceNo,
  splitSummary,
  unreadWording,
} from "./evidence-assistant-view";

/**
 * inc29-evidence-assistant task 9.1: the panel's words and figures, every
 * state and every unread reason, in English and in Turkish — the Turkish state
 * labels are the documents' own (INC-2.9 §5, INC-2.8 §7).
 */

const en = copyFor("evidenceAssistant", "en") as Parameters<typeof lineText>[2];
const tr = copyFor("evidenceAssistant", "tr") as Parameters<typeof lineText>[2];

const invoice: EvidenceAssistantInvoiceDTO = {
  invoiceNo: "DAU0000000000244", series: "DAU", periodText: "01.02.2025 - 15.02.2025", periodFrom: "2025-02-01", periodTo: "2025-02-15",
  buyerName: "ÖRNEK LOJİSTİK A.Ş.", buyerTaxId: "0000000000", file: { id: "f", fileName: "duman_petrol.pdf" }, pageFrom: 3, pageTo: 3,
};

describe("the comparison line (INC-2.9 §5's shape)", () => {
  it("reads as the documents print it, in Turkish", () => {
    expect(lineText({ fuel: "diesel", invoiceLitres: "7502.66", packageLitres: "7502.66" }, invoice, tr)).toBe(
      "Fatura: 7.502,66 L motorin (DAU…244, 01–15.02) | Paket: 7.502,66 L",
    );
  });

  it("reads in English with the English number format, as the other fuel screens print litres", () => {
    expect(lineText({ fuel: "petrol", invoiceLitres: "1168.00", packageLitres: "1218.5" }, invoice, en)).toBe(
      "Invoice: 1,168 L petrol (DAU…244, 01–15.02) | Package: 1,218.5 L",
    );
  });

  it("says which side has no figure for a fuel on one side only", () => {
    expect(lineText({ fuel: "petrol", invoiceLitres: null, packageLitres: "50.00" }, invoice, tr)).toBe(
      "Fatura: benzin satırı yok (DAU…244, 01–15.02) | Paket: 50 L",
    );
    expect(lineText({ fuel: "petrol", invoiceLitres: "10.00", packageLitres: null }, invoice, en)).toBe(
      "Invoice: 10 L petrol (DAU…244, 01–15.02) | Package: no petrol",
    );
  });

  it("labels the invoice-level figure as the invoice's rows in all packages", () => {
    expect(invoiceLevelText({ fuel: "petrol", invoiceLevelLitres: "456.21" }, tr)).toBe("Bu faturanın tüm paketlerdeki satırları: 456,21 L benzin");
    expect(invoiceLevelText({ fuel: "petrol", invoiceLevelLitres: null }, en)).toBeNull();
  });

  it("prints a period across months, a code as written, and the number short", () => {
    expect(periodLabel({ periodFrom: "2025-02-16", periodTo: "2025-03-02", periodText: null })).toBe("16.02.2025–02.03.2025");
    expect(periodLabel({ periodFrom: null, periodTo: null, periodText: "2025-03-02" })).toBe("2025-03-02");
    expect(periodLabel({ periodFrom: null, periodTo: null, periodText: null })).toBe("—");
    expect(shortInvoiceNo("OZK2025000011923")).toBe("OZK…923");
  });

  it("names the file and its pages", () => {
    expect(fileText(invoice, tr)).toBe("Dosya: duman_petrol.pdf, sayfa 3");
    expect(fileText({ ...invoice, pageFrom: 11, pageTo: 12 }, en)).toBe("File: duman_petrol.pdf, pages 11–12");
  });
});

describe("the states (INC-2.9 §5)", () => {
  it("words each state with the documents' Turkish, and translates it", () => {
    expect(lineChip({ state: "consistent", periodShift: false }, tr)).toEqual({ label: "tutarlı görünüyor", tone: "consistent" });
    expect(lineChip({ state: "consistent", periodShift: true }, tr)).toEqual({ label: "dönem kayması — komşu faturayla dengeleniyor", tone: "consistent" });
    expect(lineChip({ state: "possible_difference", periodShift: false }, tr)).toEqual({ label: "olası fark (> tolerans — bir bakın)", tone: "difference" });
    expect(lineChip({ state: "consistent", periodShift: false }, en).label).toBe("looks consistent");
    expect(lineChip({ state: "consistent", periodShift: true }, en).label).toBe("period shift — balanced by the neighbouring invoice");
    expect(lineChip({ state: "possible_difference", periodShift: false }, en).label).toBe("possible difference (> tolerance — take a look)");
  });

  it("words every unread reason in both languages, by cause (B17)", () => {
    for (const reason of [...EVIDENCE_ASSISTANT_UNREAD_REASONS, "failed" as const]) {
      for (const copy of [en, tr]) {
        const words = unreadWording(reason, copy);
        expect(words.ask, reason).toBe(copy.locale === "tr" ? "lütfen manuel kontrol edin" : "please check manually");
        if (reason === "no_evidence") {
          expect(words).toMatchObject({ title: copy.locale === "tr" ? "kanıt eklenmedi" : "no evidence attached", detail: null });
        } else {
          expect(words.title, reason).toBe(copy.locale === "tr" ? "güvenle okunamadı" : "could not be read reliably");
          expect(words.detail, reason).toMatch(/\S/);
        }
      }
    }
  });
});

describe("a split upload's summary (D10)", () => {
  it("counts packages, names every invoice not attached with its reason, and asks for a retry on a failure", () => {
    const split = {
      invoices: 3,
      attached: [{ invoiceNo: "OZK0000000000001", fuelBatchId: "a" }, { invoiceNo: "OZK0000000000001", fuelBatchId: "b" }, { invoiceNo: "OZK0000000000002", fuelBatchId: "c" }],
      notAttached: EVIDENCE_SPLIT_NOT_ATTACHED_REASONS.map((reason, i) => ({ invoiceNo: `OZK000000000000${i + 6}`, reason })),
      failedTargets: [{ invoiceNo: "OZK0000000000009", fuelBatchId: "d", reason: "attachment_failed" as const }],
    };
    const words = splitSummary(split, tr);
    expect(words.attached).toBe("Faturaya göre bölündü: 3 pakete eklendi.");
    expect(words.heading).toBe("Şu faturalar eklenmedi:");
    expect(words.notAttached).toHaveLength(4);
    expect(words.notAttached[0]).toBe("OZK0000000000006 — bu numarayı taşıyan açık bir paketiniz yok");
    expect(words.failed).toMatch(/aynı PDF'i yeniden ekleyin/);
    const one = splitSummary({ invoices: 23, attached: [{ invoiceNo: "DAU0000000000003", fuelBatchId: "a" }], notAttached: [], failedTargets: [] }, en);
    expect(one).toEqual({ keptWhole: null, attached: "Split by invoice: attached to 1 package.", heading: null, notAttached: [], failed: null });
  });

  it("says the package keeps the PDF whole when it already held it, and counts only the packages that received a part", () => {
    const split = { invoices: 3, attached: [{ invoiceNo: "OZK0000000000002", fuelBatchId: "b" }], notAttached: [], failedTargets: [] };
    expect(splitSummary(split, en, true)).toMatchObject({ keptWhole: "This package already holds the whole PDF and keeps it.", attached: "Split by invoice: attached to 1 package." });
    expect(splitSummary({ ...split, attached: [] }, tr, true)).toMatchObject({ keptWhole: "Bu pakette PDF'in tamamı zaten var ve öyle kalıyor.", attached: null });
  });
});

describe("the panel's request", () => {
  it("is hidden only when the assistant is off", () => {
    expect(panelShown({ enabled: false })).toBe(false);
    expect(panelShown(null)).toBe(true);
    expect(panelShown({ enabled: true, tolerancePercent: 1, unread: { reason: "no_evidence" } })).toBe(true);
  });

  it("drops a late answer to an earlier request", () => {
    const guard = latestOnly();
    const first = guard.next();
    const second = guard.next();
    expect([guard.isLatest(first), guard.isLatest(second)]).toEqual([false, true]);
    guard.cancel();
    expect(guard.isLatest(second)).toBe(false);
  });
});
