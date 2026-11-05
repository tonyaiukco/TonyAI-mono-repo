import {
  ACTIVITY_VALUE_MAX,
  EQUIPMENT_TYPES_WITH_ALTERNATIVE,
  usesTrCalculationRules,
  type EquipmentType,
  type LeakRateChoice,
  type Locale,
  type NaturalGasRecordParameters,
  type RefrigerantRecordParameters,
  type ReleaseParameterDTO,
} from "@/lib/types";
import { formatNumber } from "@/lib/i18n/number";

/**
 * Data Entry's per-record calculation inputs (LP4-02 PR4, D3): which a record
 * takes, what the form sends, and what keeps it from saving. Pure, so the
 * field rules are specified here and the page only renders them.
 */

/** The inputs a record takes: the TR rules' natural gas chain or capacity method (D11), or none. */
export type RecordInputMode = "natural_gas" | "refrigerant" | null;

/**
 * Which inputs the form shows. Keyed on geography as the engine is: a TR
 * natural gas record in Sm³ or metered m³ takes the chain (D5), a TR
 * refrigerant record the capacity method (D7); every other record none, since
 * the API refuses parameters there (`parameters_not_applicable`).
 */
export function recordInputMode(category: string, geographyCode: string | null, unit: string): RecordInputMode {
  if (geographyCode === null || !usesTrCalculationRules(geographyCode)) return null;
  if (category === "Refrigerants") return "refrigerant";
  if (category === "Natural Gas" && (unit === "standard_cubic_metres" || unit === "cubic_metres")) return "natural_gas";
  return null;
}

// --- Natural gas (D5) ---------------------------------------------------------

/** The natural gas fields as typed: null where a field is empty. */
export interface GasInputs {
  ncv: number | null;
  billedGcv: number | null;
  volumeCorrectionFactor: number | null;
}

export const NO_GAS_INPUTS: GasInputs = Object.freeze({ ncv: null, billedGcv: null, volumeCorrectionFactor: null });

/** A release's reference value (`reference_ncv`, `reference_gcv`), or null when it holds none. */
export function referenceValue(rows: readonly ReleaseParameterDTO[], key: "reference_ncv" | "reference_gcv"): number | null {
  return rows.find((r) => r.key === key && r.equipmentType === null && r.isDefault)?.value ?? null;
}

/**
 * The NCV the user changed, or null. The field opens on the release's default,
 * and a value equal to it is the default, sent as null so the snapshot records
 * its origin as `default` (D5).
 */
export function editedNcv(inputs: GasInputs, referenceNcv: number | null): number | null {
  return inputs.ncv !== null && inputs.ncv !== referenceNcv ? inputs.ncv : null;
}

/** What a natural gas record sends (D3): only what was entered, null when nothing was. */
export function gasParameters(inputs: GasInputs, unit: string, referenceNcv: number | null): NaturalGasRecordParameters | null {
  const parameters: NaturalGasRecordParameters = {};
  const ncv = editedNcv(inputs, referenceNcv);
  if (ncv !== null) parameters.ncvKcalPerSm3 = ncv;
  if (inputs.billedGcv !== null) parameters.billedGcvKcalPerSm3 = inputs.billedGcv;
  // Sm³ takes none: the engine refuses one there (`parameters_not_applicable`).
  if (unit === "cubic_metres" && inputs.volumeCorrectionFactor !== null) {
    parameters.volumeCorrectionFactor = inputs.volumeCorrectionFactor;
  }
  return Object.keys(parameters).length > 0 ? parameters : null;
}

export type GasInputsIssue = "volume_correction_required" | "ncv_and_gcv";

/** Why a natural gas record cannot be sent yet, or null. */
export function gasInputsIssue(inputs: GasInputs, unit: string, referenceNcv: number | null): GasInputsIssue | null {
  if (editedNcv(inputs, referenceNcv) !== null && inputs.billedGcv !== null) return "ncv_and_gcv";
  if (unit === "cubic_metres" && inputs.volumeCorrectionFactor === null) return "volume_correction_required";
  return null;
}

/** A stored record's natural gas inputs, for the form. */
export function gasInputsFromRecord(parameters: unknown): GasInputs {
  const stored = (parameters ?? {}) as NaturalGasRecordParameters;
  return {
    ncv: stored.ncvKcalPerSm3 ?? null,
    billedGcv: stored.billedGcvKcalPerSm3 ?? null,
    volumeCorrectionFactor: stored.volumeCorrectionFactor ?? null,
  };
}

// --- Refrigerants (D7) --------------------------------------------------------

/** One equipment line as typed: a mass is null while its field is empty or refused. */
export interface EquipmentLineDraft {
  id: string;
  equipmentType: EquipmentType | "";
  capacityKg: number | null;
  refillKg: number | null;
  leakRateChoice: LeakRateChoice;
}

/** A new line: no type yet, and an explicit zero in both masses. */
export function newEquipmentLine(id: string): EquipmentLineDraft {
  return { id, equipmentType: "", capacityKg: 0, refillKg: 0, leakRateChoice: "default" };
}

/** The record's quantity: its total installed capacity, summed in the engine's order (D7). */
export function equipmentTotal(lines: readonly EquipmentLineDraft[]): number {
  return lines.reduce((sum, line) => sum + (line.capacityKg ?? 0), 0);
}

export type EquipmentIssue = "no_lines" | "type_missing" | "type_repeated" | "value_missing" | "empty_line" | "too_large";

/** Why the lines cannot be sent yet, or null. A refill-only line is a line (D7). */
export function equipmentIssue(lines: readonly EquipmentLineDraft[]): EquipmentIssue | null {
  if (lines.length === 0) return "no_lines";
  if (lines.some((l) => l.equipmentType === "")) return "type_missing";
  if (new Set(lines.map((l) => l.equipmentType)).size !== lines.length) return "type_repeated";
  if (lines.some((l) => l.capacityKg === null || l.refillKg === null)) return "value_missing";
  if (lines.some((l) => l.capacityKg === 0 && l.refillKg === 0)) return "empty_line";
  if (equipmentTotal(lines) > ACTIVITY_VALUE_MAX) return "too_large";
  return null;
}

/** What a refrigerant record sends, once `equipmentIssue` is null. */
export function equipmentParameters(lines: readonly EquipmentLineDraft[]): RefrigerantRecordParameters {
  return {
    equipment: lines.map((l) => ({
      equipmentType: l.equipmentType as EquipmentType,
      capacityKg: l.capacityKg as number,
      refillKg: l.refillKg as number,
      leakRateChoice: l.leakRateChoice,
    })),
  };
}

/** A stored record's lines, for the form; one blank line when it has none. */
export function linesFromRecord(parameters: unknown, newId: () => string): EquipmentLineDraft[] {
  const equipment = (parameters as Partial<RefrigerantRecordParameters> | null)?.equipment;
  if (!Array.isArray(equipment) || equipment.length === 0) return [newEquipmentLine(newId())];
  return equipment.map((line) => ({
    id: newId(),
    equipmentType: line.equipmentType,
    capacityKg: line.capacityKg,
    refillKg: line.refillKg,
    leakRateChoice: line.leakRateChoice,
  }));
}

/** An equipment type's leak rate in the release: its default, or its alternative. */
export function leakRateOf(rows: readonly ReleaseParameterDTO[], type: string, choice: LeakRateChoice): number | null {
  return rows.find((r) => r.key === "leak_rate" && r.equipmentType === type && r.isDefault === (choice === "default"))?.value ?? null;
}

/**
 * Whether the form offers the alternative rate: only for the types that have
 * one (split air conditioners and chillers, D7), and only once the release
 * states it, so a choice is never offered without its number.
 */
export function offersAlternative(rows: readonly ReleaseParameterDTO[], type: string): boolean {
  return (EQUIPMENT_TYPES_WITH_ALTERNATIVE as readonly string[]).includes(type) && leakRateOf(rows, type, "alternative") !== null;
}

/** A rate (a fraction, 0.02) as people read it: 2%. */
export function leakRatePercent(rate: number, locale: Locale): string {
  return `${formatNumber(rate * 100, locale, { maximumFractionDigits: 4 })}%`;
}
