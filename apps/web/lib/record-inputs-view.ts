import {
  ACTIVITY_VALUE_MAX,
  EQUIPMENT_TYPES_WITH_ALTERNATIVE,
  isCvBasis,
  isProvenanceSnapshot,
  usesTrCalculationRules,
  type ActivityCalculationSnapshot,
  type CvBasis,
  type EquipmentType,
  type FactorReleaseSnapshot,
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

/**
 * The inputs a record takes: the TR rules' natural gas chain or capacity
 * method (D11), a TR natural gas bill's calorific basis (ng-kwh-engine), or
 * none.
 */
export type RecordInputMode = "natural_gas" | "natural_gas_energy" | "refrigerant" | null;

/** The units a TR natural gas bill states its energy in (ng-kwh-engine). */
export function isGasEnergyUnit(unit: string): boolean {
  return unit === "kWh" || unit === "MWh";
}

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
  // A bill's energy: the author states its calorific basis (ng-kwh-form).
  if (category === "Natural Gas" && isGasEnergyUnit(unit)) return "natural_gas_energy";
  return null;
}

// --- Natural gas (D5) ---------------------------------------------------------

/** The natural gas fields as typed: null where a field is empty. */
export interface GasInputs {
  ncv: number | null;
  billedGcv: number | null;
  volumeCorrectionFactor: number | null;
  /** A bill's calorific basis, as chosen or stored on the record (ng-kwh-engine, ng-kwh-form). */
  cvBasis: CvBasis | null;
}

export const NO_GAS_INPUTS: GasInputs = Object.freeze({ ncv: null, billedGcv: null, volumeCorrectionFactor: null, cvBasis: null });

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
  // A bill sends exactly its basis; with none stored, nothing, and the API
  // answers `parameters_required` naming it (ng-kwh-engine).
  if (isGasEnergyUnit(unit)) return inputs.cvBasis !== null ? { cvBasis: inputs.cvBasis } : null;
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

/**
 * Why a natural gas bill cannot be sent yet, or null (ng-kwh-form): its basis
 * has no default, so nothing is previewed or saved until the author states it.
 */
export function gasEnergyIssue(inputs: GasInputs, mode: RecordInputMode): "basis_missing" | null {
  return mode === "natural_gas_energy" && inputs.cvBasis === null ? "basis_missing" : null;
}

/**
 * A gross bill's net quantity, in its own unit, and the ratio that derives it
 * (ng-kwh-form): `reference_ncv / reference_gcv` of the release the bill's
 * factor sits in, the rows its calculation reads. Null when the release cannot
 * give a ratio below 1; no default stands in, the calculation's refusal speaks.
 */
export function derivedNetQuantity(
  quantity: number,
  rows: readonly ReleaseParameterDTO[],
): { ratio: number; net: number; ncv: number; gcv: number } | null {
  const ncv = referenceValue(rows, "reference_ncv");
  const gcv = referenceValue(rows, "reference_gcv");
  if (ncv === null || gcv === null || !(ncv > 0) || !(gcv > 0)) return null;
  const ratio = ncv / gcv;
  if (!(ratio < 1)) return null;
  return { ratio, net: quantity * ratio, ncv, gcv };
}

/** The release and parameters a gross bill's net figure is read from. */
export interface NetSource {
  release: FactorReleaseSnapshot;
  parameters: readonly ReleaseParameterDTO[];
}

/**
 * The release and NCV/GCV a successful preview priced a gross bill on, or null
 * (ng-kwh-form review). The form's own reference read and the preview resolve
 * the factor's release in two requests, so a release sealed between them could
 * leave the net figure shown beside the bill on one edition and the price on
 * another. The figure shown is read from the preview's own rows, the ones the
 * price used; the reference read stands in only until a preview holds them. A
 * net or non-bill preview reads no ratio, so it yields null.
 */
export function previewedNetSource(preview: ActivityCalculationSnapshot | null): NetSource | null {
  if (!isProvenanceSnapshot(preview) || preview.snapshotSchema !== 3) return null;
  if (referenceValue(preview.parameterRows, "reference_ncv") === null || referenceValue(preview.parameterRows, "reference_gcv") === null) {
    return null;
  }
  return { release: preview.factorRelease, parameters: preview.parameterRows };
}

/** A stored record's natural gas inputs, for the form. */
export function gasInputsFromRecord(parameters: unknown): GasInputs {
  const stored = (parameters ?? {}) as NaturalGasRecordParameters;
  return {
    ncv: stored.ncvKcalPerSm3 ?? null,
    billedGcv: stored.billedGcvKcalPerSm3 ?? null,
    volumeCorrectionFactor: stored.volumeCorrectionFactor ?? null,
    cvBasis: isCvBasis(stored.cvBasis) ? stored.cvBasis : null,
  };
}

/** The source of a copy of a voided record, as `onOwnType` reads it (ng-kwh-engine). */
export interface CopySource {
  category: string;
  activityType: string | null;
  /** The geography the source was priced under; null when its snapshot says none. */
  geography: string | null;
}

/**
 * Whether a copy still keeps its source's own unit and type listed (ng-kwh-engine):
 * on the source's category and type, under the geography it was priced in. A
 * copy moved across the TR rules is narrowed like a new record, as before,
 * rather than carrying a unit or type the new geography does not price.
 */
export function copyKeepsOwnUnit(
  source: CopySource | null,
  category: string,
  activityType: string,
  geography: string | null,
): boolean {
  return (
    source !== null &&
    source.category === category &&
    (source.activityType ?? "") === activityType &&
    source.geography !== null &&
    source.geography === geography
  );
}

/**
 * Whether the form holds a net figure where nothing prices it as net
 * (ng-kwh-engine): a natural gas bill in kWh or MWh carrying the NET basis
 * while the record is not under the TR rules' energy path. Outside them an
 * energy bill is priced as gross and no basis is sent, so the figure would be
 * priced as if it were gross. A state, not a move: it holds however the form
 * got there, by a move, an opened draft whose site's geography changed since,
 * or a copy into another subsidiary (review of the change). A gross figure is
 * what the target prices, so it stays.
 */
export function clearsNetEnergyQuantity(
  category: string,
  mode: RecordInputMode,
  unit: string,
  cvBasis: CvBasis | null,
): boolean {
  return category === "Natural Gas" && mode !== "natural_gas_energy" && isGasEnergyUnit(unit) && cvBasis === "net";
}

/** The natural gas units of a volume reading. */
function isGasVolumeUnit(unit: string): boolean {
  return unit === "standard_cubic_metres" || unit === "cubic_metres";
}

/**
 * Whether a unit the user picks must clear the quantity (ng-kwh-engine
 * reviews): any change, in any category. A figure entered for one unit is not
 * the same number in another, kWh against MWh (×1,000) as much as kWh against
 * Sm³, so the form asks for it again rather than carry it over.
 */
export function unitChangeClearsQuantity(previous: string, next: string): boolean {
  return previous !== next;
}

/**
 * The calorific basis a unit change leaves on the form (ng-kwh-engine
 * reviews): the record's own stored basis when the user picks its own energy
 * unit again after a detour that cleared it (a volume unit), so undoing that
 * move works; none after a move between energy and volume; otherwise the
 * current one. Between kWh and MWh the basis the user holds stays, even back
 * onto the record's own unit: it was never cleared, and a stored net must not
 * overwrite a gross the user chose (ng-kwh-form review). The figure is asked
 * for again either way (`unitChangeClearsQuantity`).
 */
export function basisAfterUnitChange(
  previous: string,
  next: string,
  current: CvBasis | null,
  own: { unit: string | null; cvBasis: CvBasis | null },
): CvBasis | null {
  if (next === own.unit && isGasEnergyUnit(next) && !isGasEnergyUnit(previous) && own.cvBasis !== null) return own.cvBasis;
  return unitChangeClearsBasis(previous, next) ? null : current;
}

/** Why the form is reset: a record was submitted, or anything else (a subsidiary change, a copy, a failed cancel). */
export type FormResetReason = "submitted" | "other";

/**
 * The category a unit counts as chosen for once the form is reset
 * (ng-kwh-form review). After a SUBMIT, a TR gas bill's kWh or MWh is not the
 * next record's choice: it is let go (empty), so the unit counts as carried
 * over and the next TR gas record starts on its first unit, m³, as a new one
 * does. It asks the form's input mode, never the unit alone (Electricity's MWh
 * is a real choice and stays), and never any other reason: a subsidiary or site
 * change keeps a unit the target offers, as the design says, so TR MWh moved to
 * a UK subsidiary stays MWh.
 */
export function unitCategoryAfterReset(mode: RecordInputMode, unitCategory: string, reason: FormResetReason): string {
  return reason === "submitted" && mode === "natural_gas_energy" ? "" : unitCategory;
}

/**
 * Whether a saved record was calculated on other releases than the preview the
 * form shows (ng-kwh-form review). The API prices a save with the release in
 * force at that moment, so one sealed after the preview leaves the form's net
 * figure and total on the edition it read while the saved record cites another.
 * True only when both are factor-backed snapshots and the factor's or the
 * conversion's release differs; the saved snapshot is then what the form shows.
 */
export function calculationRevised(shown: ActivityCalculationSnapshot | null, saved: ActivityCalculationSnapshot | null | undefined): boolean {
  if (!isProvenanceSnapshot(shown) || !isProvenanceSnapshot(saved)) return false;
  return (
    shown.factorRelease.id !== saved.factorRelease.id ||
    (shown.conversion?.release.id ?? null) !== (saved.conversion?.release.id ?? null)
  );
}

/** What a successful save does to the preview on screen. */
export type SavedCalculationEffect = "keep" | "refresh" | "revised";

/**
 * What the preview on screen needs once a save answers (ng-kwh-form review).
 * The save is priced by the API with the release in force at that moment, and
 * its answer may come after the form moved on: the preview still pending or
 * refused (nothing shown), or already redone for a figure typed since. So the
 * answer never overwrites the screen: it only asks whether the screen is right.
 * - `revised`: the preview on screen cites other releases than the saved
 *   record; a fresh preview is asked for, and the user told.
 * - `refresh`: no preview is shown (pending, or refused earlier); a fresh one is
 *   asked for, which also clears an old refusal the new release no longer gives.
 * - `keep`: the preview on screen already cites the saved record's releases.
 * A fresh preview prices the inputs on the form NOW, never the saved ones, and
 * the page's own guard drops any older answer, so a late save cannot put one
 * figure's total beside another figure's quantity.
 */
export function savedCalculationEffect(
  shown: ActivityCalculationSnapshot | null,
  saved: ActivityCalculationSnapshot | null | undefined,
): SavedCalculationEffect {
  if (calculationRevised(shown, saved)) return "revised";
  return shown === null ? "refresh" : "keep";
}

/**
 * Whether a unit change must clear a bill's calorific basis (ng-kwh-engine):
 * a move between an energy unit (kWh, MWh) and a volume (Sm³, m³), where the
 * basis means nothing. kWh to MWh keeps it: the same bill, another scale.
 */
export function unitChangeClearsBasis(previous: string, next: string): boolean {
  return (isGasEnergyUnit(previous) && isGasVolumeUnit(next)) || (isGasVolumeUnit(previous) && isGasEnergyUnit(next));
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
