import {
  FUEL_CARD_DEFAULT_USAGE,
  FUEL_PREVIEW_OUTCOMES,
  isFuelCardSource,
  type FileFuel,
  type FormFuelBatchesResultDTO,
  type FuelFilePreviewDTO,
  type FuelPreviewOutcome,
  type FuelRowCountDTO,
  type FuelSource,
  type FuelTankerDeclaration,
  type FuelTankerDeliveryDTO,
  type FuelUploadDTO,
  type FuelUsage,
} from "@/lib/types";

/**
 * The Fuel files page's Upload tab, as pure logic (inc28-fuel-bulk D3, D8,
 * D16): what is preselected, when a file may be applied, and how long the
 * page keeps forming batches.
 */

/** A card file's usage starts on-road (INC-2.8 §5); a tanker file has none, each delivery is declared. */
export function initialUsage(source: FuelSource): FuelUsage | null {
  return isFuelCardSource(source) ? FUEL_CARD_DEFAULT_USAGE : null;
}

/** One delivery's choices while the user fills them: nothing preselected (C3). */
export interface DeliveryChoice {
  fuel?: FileFuel;
  usage?: FuelUsage;
  year?: number;
  /** 1–12. */
  month?: number;
}

/** The deliveries the user must declare: those neither refused nor already stored. */
export function deliveriesToDeclare(preview: FuelFilePreviewDTO): FuelTankerDeliveryDTO[] {
  return preview.deliveries.filter((d) => d.needs === "declaration");
}

function complete(choice: DeliveryChoice | undefined): choice is Required<DeliveryChoice> {
  return !!choice && !!choice.fuel && !!choice.usage && Number.isInteger(choice.year) && Number.isInteger(choice.month) &&
    choice.month! >= 1 && choice.month! <= 12;
}

/** Every delivery to declare, declared; null while one is not — the apply stays held. */
export function declarationsOf(
  preview: FuelFilePreviewDTO,
  choices: Readonly<Record<string, DeliveryChoice>>,
): FuelTankerDeclaration[] | null {
  const out: FuelTankerDeclaration[] = [];
  for (const delivery of deliveriesToDeclare(preview)) {
    const choice = choices[delivery.documentNo];
    if (!complete(choice)) return null;
    out.push({ documentNo: delivery.documentNo, fuel: choice.fuel, usage: choice.usage, year: choice.year, month: choice.month });
  }
  return out;
}

/** "Copy to all": one delivery's filled fields onto every delivery to declare, keeping what the others set that it leaves blank. */
export function copyToAll(
  preview: FuelFilePreviewDTO,
  choices: Readonly<Record<string, DeliveryChoice>>,
  from: DeliveryChoice,
): Record<string, DeliveryChoice> {
  const filled = Object.fromEntries(Object.entries(from).filter(([, v]) => v !== undefined)) as DeliveryChoice;
  const out: Record<string, DeliveryChoice> = { ...choices };
  for (const d of deliveriesToDeclare(preview)) out[d.documentNo] = { ...choices[d.documentNo], ...filled };
  return out;
}

/** Whether the previewed file may be applied with these choices. */
export function canApply(
  preview: FuelFilePreviewDTO | null,
  usage: FuelUsage | null,
  choices: Readonly<Record<string, DeliveryChoice>>,
): boolean {
  if (!preview) return false;
  if (isFuelCardSource(preview.source)) return usage !== null;
  return declarationsOf(preview, choices) !== null;
}

/** The page asks for another formation step only while rows can still be processed (D8). */
export function continueForming(result: Pick<FormFuelBatchesResultDTO, "processableRows">): boolean {
  return result.processableRows > 0;
}

/**
 * Forming batches as the page does it: one step, then another only while
 * rows are processable. `maxSteps` guards a server that never makes progress.
 * Answers the last step's result and the batches formed or joined in all.
 */
export async function formUntilDone(
  step: () => Promise<FormFuelBatchesResultDTO>,
  onStep: (result: FormFuelBatchesResultDTO) => void = () => {},
  maxSteps = 100,
): Promise<{ last: FormFuelBatchesResultDTO; formed: number; joined: number; steps: number }> {
  let formed = 0;
  let joined = 0;
  let previous: number | null = null;
  for (let steps = 1; ; steps += 1) {
    const last = await step();
    formed += last.formedBatches;
    joined += last.joinedBatches;
    onStep(last);
    // Stop with nothing processable, at the cap, or when a step changed nothing.
    const stalled = previous !== null && last.processableRows >= previous && last.formedBatches + last.joinedBatches === 0;
    if (!continueForming(last) || steps >= maxSteps || stalled) return { last, formed, joined, steps };
    previous = last.processableRows;
  }
}

/** A previewed file's rows and litres per outcome, every outcome listed (zero when none). */
export function previewTotals(preview: FuelFilePreviewDTO): Record<FuelPreviewOutcome, FuelRowCountDTO> {
  const totals = Object.fromEntries(FUEL_PREVIEW_OUTCOMES.map((o) => [o, { rows: 0, litres: "0" }])) as Record<FuelPreviewOutcome, FuelRowCountDTO>;
  for (const account of preview.accounts) {
    for (const o of account.outcomes) {
      const t = totals[o.outcome];
      totals[o.outcome] = { rows: t.rows + o.rows, litres: addDecimal(t.litres, o.litres) };
    }
  }
  return totals;
}

/**
 * Two non-negative decimal strings added without a float (the server sums
 * litres as decimals; a screen total must not round them differently).
 */
export function addDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const sum = BigInt(ai + af.padEnd(scale, "0")) + BigInt(bi + bf.padEnd(scale, "0"));
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, "0");
  const frac = digits.slice(-scale).replace(/0+$/, "");
  return frac ? `${digits.slice(0, -scale)}.${frac}` : digits.slice(0, -scale);
}

/**
 * A company as the page names it: by its name, or as outside the reader's
 * companies when the server named none (D14 — it never sends a name the
 * reader cannot read, and the page invents none).
 */
export function companyLabel(name: string | null, outsideScope: string): string {
  return name ?? outsideScope;
}

/**
 * Whether an applied upload is formed at once: only when its uploader holds
 * rows a step can process. A file every row of which was already stored, or
 * whose rows all wait or are excluded, forms nothing — and the API refuses a
 * step from a caller who holds no unbatched row.
 */
export function formsAfterApply(upload: Pick<FuelUploadDTO, "readerIsHolder" | "processableRows">): boolean {
  return upload.readerIsHolder && upload.processableRows > 0;
}

/**
 * How many fraction digits a litres figure is shown with: those its decimal
 * text holds (trailing zeros dropped), at least none and at most 20 (Intl's
 * limit). A stored 0.0004 L is shown as such, never rounded to 0 L.
 */
export function litresFractionDigits(litres: string): number {
  const fraction = /\.(\d+)$/.exec(litres.trim())?.[1]?.replace(/0+$/, "") ?? "";
  return Math.min(fraction.length, 20);
}
