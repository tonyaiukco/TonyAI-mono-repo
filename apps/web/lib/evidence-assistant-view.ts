/**
 * The evidence assistant's words and figures (inc29-evidence-assistant, D10):
 * the comparison line in the documents' shape —
 * `Fatura: 7.502,66 L motorin (DAU…244, 01–15.02) | Paket: 7.502,66 L`
 * (INC-2.9 §5) — the state as a chip, an unread reason as copy, and a split
 * upload's summary. No English here: every sentence comes from the
 * `evidenceAssistant` catalogue the screen passes (LP4-04, M2).
 */
import type {
  EvidenceAssistantDTO,
  EvidenceAssistantInvoiceDTO,
  EvidenceAssistantLineDTO,
  EvidenceAssistantUnreadReason,
  EvidenceSplitDTO,
  EvidenceSplitNotAttachedReason,
  Locale,
  ManualFuel,
} from "@/lib/types";
import { formatLitresText } from "@/lib/fuel-upload-view";
import { formatNumber } from "@/lib/i18n/number";
import type { ViewCopy } from "@/lib/i18n/view-translator";

export type AssistantKey =
  | "states.consistent"
  | "states.possible_difference"
  | "states.periodShift"
  | "states.unread"
  | "states.noEvidence"
  | "manualCheck"
  | "line"
  | "lineNoInvoice"
  | "lineNoPackage"
  | "invoiceLevel"
  | "fuels.diesel"
  | "fuels.petrol"
  | "fuels.lpg"
  | "fuels.marine_gas_oil"
  | `unreadReasons.${Exclude<EvidenceAssistantUnreadReason, "no_evidence"> | "failed"}`
  | "split.keptWhole"
  | "split.attachedOne"
  | "split.attachedMany"
  | "split.notAttached"
  | `split.reasons.${EvidenceSplitNotAttachedReason}`
  | "split.failed"
  | "filePages"
  | "filePage";

type Copy = ViewCopy<AssistantKey>;

/** Litres as the screens print them: every decimal the figure has, in the reader's locale. */
export function assistantLitres(litres: string, locale: Locale): string {
  const separator = formatNumber(1.5, locale, { minimumFractionDigits: 1 }).replace(/\d/g, "");
  return formatLitresText(litres, (value) => formatNumber(value, locale, { maximumFractionDigits: 0 }), separator);
}

/** `DAU0000000000244` → `DAU…244`, as the documents print it. */
export function shortInvoiceNo(invoiceNo: string): string {
  return invoiceNo.length > 7 ? `${invoiceNo.slice(0, 3)}…${invoiceNo.slice(-3)}` : invoiceNo;
}

/** A period printed as two dates: `01–15.02` within a month, else both dates; else the text as printed. */
export function periodLabel(invoice: Pick<EvidenceAssistantInvoiceDTO, "periodFrom" | "periodTo" | "periodText">): string {
  const { periodFrom: from, periodTo: to } = invoice;
  if (from && to) {
    const [fy, fm, fd] = from.split("-");
    const [ty, tm, td] = to.split("-");
    if (fy === ty && fm === tm) return `${fd}–${td}.${tm}`;
    return `${fd}.${fm}.${fy}–${td}.${tm}.${ty}`;
  }
  return invoice.periodText ?? "—";
}

export type ChipTone = "consistent" | "difference";

/** A line's state as a chip: the documents' words, never a verdict (B1). */
export function lineChip(line: Pick<EvidenceAssistantLineDTO, "state" | "periodShift">, copy: Copy): { label: string; tone: ChipTone } {
  if (line.state === "consistent") {
    return { label: copy.t(line.periodShift ? "states.periodShift" : "states.consistent"), tone: "consistent" };
  }
  return { label: copy.t("states.possible_difference"), tone: "difference" };
}

/** `Fatura: 7.502,66 L motorin (DAU…244, 01–15.02) | Paket: 7.502,66 L`. */
export function lineText(
  line: Pick<EvidenceAssistantLineDTO<ManualFuel>, "fuel" | "invoiceLitres" | "packageLitres">,
  invoice: EvidenceAssistantInvoiceDTO,
  copy: Copy,
): string {
  const values = {
    fuel: copy.t(`fuels.${line.fuel}`),
    number: shortInvoiceNo(invoice.invoiceNo),
    period: periodLabel(invoice),
  };
  if (line.invoiceLitres === null) return copy.t("lineNoInvoice", { ...values, package: assistantLitres(line.packageLitres ?? "0", copy.locale) });
  if (line.packageLitres === null) return copy.t("lineNoPackage", { ...values, invoice: assistantLitres(line.invoiceLitres, copy.locale) });
  return copy.t("line", {
    ...values,
    invoice: assistantLitres(line.invoiceLitres, copy.locale),
    package: assistantLitres(line.packageLitres, copy.locale),
  });
}

/** The figure compared at invoice level, labelled as the invoice's rows in all packages — never as the invoice's figure. */
export function invoiceLevelText(line: { fuel: "diesel" | "petrol"; invoiceLevelLitres: string | null }, copy: Copy): string | null {
  if (line.invoiceLevelLitres === null) return null;
  return copy.t("invoiceLevel", { litres: assistantLitres(line.invoiceLevelLitres, copy.locale), fuel: copy.t(`fuels.${line.fuel}`) });
}

/** The file the invoice was read from, with its pages in that file. */
export function fileText(invoice: EvidenceAssistantInvoiceDTO, copy: Copy): string {
  return invoice.pageFrom === invoice.pageTo
    ? copy.t("filePage", { name: invoice.file.fileName, page: formatNumber(invoice.pageFrom, copy.locale) })
    : copy.t("filePages", { name: invoice.file.fileName, from: formatNumber(invoice.pageFrom, copy.locale), to: formatNumber(invoice.pageTo, copy.locale) });
}

/**
 * ⚪ by cause (B17): "kanıt eklenmedi" with no file, "güvenle okunamadı"
 * otherwise — a failed or unanswered request included — each with "lütfen
 * manuel kontrol edin" and a line saying why.
 */
export function unreadWording(reason: EvidenceAssistantUnreadReason | "failed", copy: Copy): { title: string; ask: string; detail: string | null } {
  return {
    title: copy.t(reason === "no_evidence" ? "states.noEvidence" : "states.unread"),
    ask: copy.t("manualCheck"),
    detail: reason === "no_evidence" ? null : copy.t(`unreadReasons.${reason}`),
  };
}

/** What a split upload did, for the uploader (D10): attached to N packages; these were not. */
export function splitSummary(
  split: EvidenceSplitDTO,
  copy: Copy,
  keptWhole = false,
): { keptWhole: string | null; attached: string | null; notAttached: string[]; heading: string | null; failed: string | null } {
  const packages = new Set(split.attached.map((a) => a.fuelBatchId)).size;
  return {
    // The package already held the PDF whole and keeps it: said first, so the
    // summary never reads as if this package received its pages alone.
    keptWhole: keptWhole ? copy.t("split.keptWhole") : null,
    attached: packages === 0 ? null : packages === 1 ? copy.t("split.attachedOne") : copy.t("split.attachedMany", { count: formatNumber(packages, copy.locale) }),
    heading: split.notAttached.length > 0 ? copy.t("split.notAttached") : null,
    notAttached: split.notAttached.map((n) => `${n.invoiceNo} — ${copy.t(`split.reasons.${n.reason}`)}`),
    failed: split.failedTargets.length > 0 ? copy.t("split.failed") : null,
  };
}

/** Whether the panel shows at all: off, nothing (the switch hides it, D8). */
export function panelShown(dto: EvidenceAssistantDTO | null): boolean {
  return dto === null || dto.enabled;
}

/**
 * Keeps only the latest request's answer: one asked for an earlier batch, or
 * before the batch's files changed, arrives late and is dropped (D10).
 */
export function latestOnly() {
  let current = 0;
  return {
    next: () => ++current,
    isLatest: (token: number) => token === current,
    cancel: () => {
      current += 1;
    },
  };
}
