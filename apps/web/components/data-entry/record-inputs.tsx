"use client";

import { useEffect, type ReactNode } from "react";
import { AlertTriangle, Info, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";
import { DecimalNote } from "@/components/i18n/decimal-note";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { checkDecimal, formatComputedAmount, formatNumber, parseLocaleDecimal, typedValue, type DecimalRule } from "@/lib/i18n/number";
import { useDecimalInput } from "@/lib/i18n/use-decimal-input";
import {
  derivedNetQuantity,
  editedNcv,
  equipmentTotal,
  leakRateOf,
  leakRatePercent,
  offersAlternative,
  referenceValue,
  selfGenerationReminder,
  type EquipmentIssue,
  type EquipmentLineDraft,
  type GasInputs,
  type GasInputsIssue,
  type NetSource,
  type SelfGenerationField,
  type SelfGenerationForm,
  type SelfGenerationFormIssue,
} from "@/lib/record-inputs-view";
import {
  ACTIVITY_VALUE_MAX,
  EQUIPMENT_TYPES,
  VOLUME_CORRECTION_FACTOR_MAX,
  VOLUME_CORRECTION_FACTOR_MIN,
  CV_BASES,
  SELF_GENERATION_SOURCES,
  isCvBasis,
  isSelfGenerationSource,
  type CvBasis,
  type EquipmentType,
  type LeakRateChoice,
  type ReleaseParametersDTO,
  type SelfGenerationBalance,
} from "@/lib/types";

/** The release parameters the inputs default to, as the page loaded them. */
export type ReferenceState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; data: ReleaseParametersDTO };

/** The upper bound of a calorific value or correction factor (the shape CHECK's). */
const GAS_INPUT_MAX = 1e300;

/**
 * One calculation input typed in the user's locale (`useDecimalInput`, D15):
 * the value reaching the record is a JSON number, or null when the field is
 * empty, and a refused text is reported so the save can be refused.
 *
 * Mounted per value (the caller keys it), so `stored` is read once, at mount,
 * and reported then as the field's value.
 */
function ParameterNumberField({
  id,
  label,
  stored,
  rule,
  max,
  disabled,
  help,
  info,
  invalid = false,
  onChange,
}: {
  id: string;
  label: string;
  stored: number | null;
  rule: DecimalRule;
  max: number;
  disabled?: boolean;
  help?: string;
  /** An explanation behind an ⓘ beside the label, opened by click or Enter
   *  (UAT round 2, BUG-R2-06): what the field is, beyond its one help line. */
  info?: { label: string; content: ReactNode };
  /** A rule across fields this one breaks (exports above the generation): marked as its own refusal is. */
  invalid?: boolean;
  onChange: (value: number | null, refused: boolean) => void;
}) {
  const locale = useLocale();
  const input = useDecimalInput(stored === null ? undefined : typedValue(stored, locale));
  const check = checkDecimal(input.parsed, rule, max);
  // A field (re)mounts showing `stored`, a valid number or nothing: say so,
  // so a refusal of the text it replaced (a billed GCV taking over, a default
  // arriving) cannot keep the save refused with nothing on screen to explain it.
  useEffect(() => {
    onChange(stored, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-1.5">
      {info ? (
        <div className="flex items-center gap-1">
          <Label htmlFor={id}>{label}</Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label={info.label}>
                <Info className="h-4 w-4" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 text-xs">
              {info.content}
            </PopoverContent>
          </Popover>
        </div>
      ) : (
        <Label htmlFor={id}>{label}</Label>
      )}
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={input.text}
        disabled={disabled}
        aria-invalid={invalid || (input.text.trim() !== "" && !check.ok && !input.typing)}
        aria-describedby={`${id}-note`}
        onBlur={input.blur}
        onChange={(e) => {
          input.setText(e.target.value);
          const next = checkDecimal(parseLocaleDecimal(e.target.value, locale), rule, max);
          onChange(next.ok ? next.value : null, !next.ok && next.reason !== "empty");
        }}
      />
      <DecimalNote id={`${id}-note`} check={check} otherReading={input.otherReading} locale={input.locale} typing={input.typing} />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

/**
 * What the volume correction factor is (UAT round 2, BUG-R2-06), behind the
 * field's ⓘ. The range comes from the contract's bounds; the calorific value
 * is named, never quoted, because its number is release data the form above
 * already shows. The reference conditions are worded per language — the
 * contract's `STANDARD_REFERENCE_CONDITIONS` is English and in kPa, and a spec
 * pins it so a change leads back here.
 */
export function VolumeCorrectionInfo() {
  const t = useTranslations("dataEntry.inputs.volumeCorrectionInfo");
  const locale = useLocale();
  return (
    <ul className="list-disc space-y-1.5 pl-4">
      <li>{t("standard")}</li>
      <li>{t("arithmetic")}</li>
      <li>
        {t("range", {
          min: formatNumber(VOLUME_CORRECTION_FACTOR_MIN, locale),
          max: formatNumber(VOLUME_CORRECTION_FACTOR_MAX, locale),
        })}
      </li>
      <li>{t("standardUnit")}</li>
    </ul>
  );
}

/** Where a default came from, or why there is none. */
function ReferenceNote({ reference, value }: { reference: ReferenceState; value: number | null }) {
  const t = useTranslations("dataEntry.inputs");
  const locale = useLocale();
  if (reference.status === "loading") return <p className="text-xs text-muted-foreground">{t("referenceLoading")}</p>;
  if (reference.status === "failed") return <p className="text-xs text-destructive">{t("referenceFailed")}</p>;
  const release = reference.data.release;
  if (!release || value === null) return <p className="text-xs text-muted-foreground">{t("referenceMissing")}</p>;
  return (
    <p className="text-xs text-muted-foreground">
      {t("ncvDefault", {
        value: formatNumber(value, locale),
        publisher: release.publisher,
        edition: release.edition,
        // A placeholder or fixture value is never shown as if it were sourced.
        status: release.status === "authoritative" ? "" : t("notAuthoritative"),
      })}
    </p>
  );
}

/**
 * A TR natural gas bill's calorific basis, chosen by the author (ng-kwh-form):
 * no default, so nothing is priced until it is stated; an opened or copied
 * record's stored basis comes selected. A gross bill shows the net quantity it
 * is priced on, by its factor release's own ratio, before save.
 */
export function CalorificBasisChoice({
  basis,
  quantity,
  unit,
  reference,
  previewed = null,
  priceRefused = false,
  issue,
  onChange,
}: {
  basis: CvBasis | null;
  /** The quantity as entered, or null while it is not a number. */
  quantity: number | null;
  unit: string;
  reference: ReferenceState;
  /**
   * The release and NCV/GCV the last successful preview priced the bill on
   * (`previewedNetSource`). The net figure is read from them, so it names the
   * edition the price used; the reference read stands in until a preview holds
   * them (ng-kwh-form review).
   */
  previewed?: NetSource | null;
  /**
   * The calculation refused the bill (a release without its GCV, no factor): no
   * derived figure is shown then, and the reference read, which may still hold
   * the ratio of an edition that no longer applies, does not stand in. It holds
   * until a later preview succeeds. A first preview still pending, with no
   * refusal before it, is not a refusal and keeps the figure shown (ng-kwh-form review).
   */
  priceRefused?: boolean;
  issue: "basis_missing" | null;
  onChange: (basis: CvBasis) => void;
}) {
  const t = useTranslations("dataEntry.inputs");
  const tUnits = useTranslations("units");
  const locale = useLocale();
  const source: NetSource | null =
    previewed ??
    (reference.status === "ready" && reference.data.release
      ? { release: reference.data.release, parameters: reference.data.parameters }
      : null);
  const derived =
    basis === "gross" && quantity !== null && source && !priceRefused ? derivedNetQuantity(quantity, source.parameters) : null;
  const release = source?.release ?? null;
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="gas-energy-basis">
      <div>
        <p className="text-sm font-medium" id="gas-energy-basis-title">{t("cvBasis.title")}</p>
        <p className="text-xs text-muted-foreground">{t("cvBasis.help")}</p>
      </div>
      <RadioGroup
        // "" selects neither: the basis has no default.
        value={basis ?? ""}
        onValueChange={(value) => {
          if (isCvBasis(value)) onChange(value);
        }}
        aria-labelledby="gas-energy-basis-title"
        // Not Radix's `required`: its hidden native input would join a form's own validation.
        aria-required
        aria-invalid={issue !== null}
        className="flex flex-wrap gap-6"
        data-testid="gas-energy-basis-choice"
      >
        {CV_BASES.map((value) => (
          <div key={value} className="flex items-center gap-2">
            {/* The group carries aria-invalid; the items stay calm, as the amber line beside them does. */}
            <RadioGroupItem value={value} id={`gas-energy-basis-${value}`} />
            <Label htmlFor={`gas-energy-basis-${value}`} className="font-normal">{t(`cvBasis.${value}`)}</Label>
          </div>
        ))}
      </RadioGroup>
      {issue && <p className="text-xs text-amber-700" role="status" data-testid="gas-energy-basis-missing">{t("cvBasis.missing")}</p>}
      {derived && release && (
        <p className="text-xs text-muted-foreground" data-testid="gas-energy-derived-net">
          {t("cvBasis.derivedNet", {
            net: formatNumber(derived.net, locale, { maximumFractionDigits: unit === "MWh" ? 4 : 2 }),
            unit: tUnits(`label.${unit}` as "label.kWh"),
            ratio: formatNumber(derived.ratio, locale, { maximumFractionDigits: 6 }),
            ncv: formatNumber(derived.ncv, locale),
            gcv: formatNumber(derived.gcv, locale),
            publisher: release.publisher,
            edition: release.edition,
            // A placeholder or fixture value is never shown as if it were sourced.
            status: release.status === "authoritative" ? "" : t("notAuthoritative"),
          })}
        </p>
      )}
    </div>
  );
}

/**
 * A TR natural gas record's inputs (D5): the NCV, opened on the release's
 * default; a billed GCV instead of it; and, for a metered m³ reading, the
 * volume correction factor. NCV and GCV exclude each other on screen as the
 * API does: whichever is in use disables the other.
 */
export function NaturalGasInputs({
  unit,
  inputs,
  reference,
  issue,
  epoch,
  onChange,
}: {
  unit: string;
  inputs: GasInputs;
  reference: ReferenceState;
  issue: GasInputsIssue | null;
  epoch: number;
  onChange: (next: Partial<GasInputs>, field: keyof GasInputs, refused: boolean) => void;
}) {
  const t = useTranslations("dataEntry.inputs");
  const rows = reference.status === "ready" ? reference.data.parameters : [];
  const defaultNcv = referenceValue(rows, "reference_ncv");
  const billed = inputs.billedGcv !== null;
  const ncvEdited = editedNcv(inputs, defaultNcv) !== null;
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="gas-inputs">
      <p className="text-sm font-medium">{t("title")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <ParameterNumberField
            // Re-read when the default arrives or a billed value takes over;
            // never while the user types into it.
            key={`${epoch}:ncv:${defaultNcv}:${billed}`}
            id="input-ncv"
            label={t("ncv")}
            stored={billed ? defaultNcv : (inputs.ncv ?? defaultNcv)}
            rule="positive"
            max={GAS_INPUT_MAX}
            disabled={billed}
            // The default itself is held as "not edited", so a later default
            // (another year's release) is never mistaken for the user's value.
            onChange={(value, refused) => onChange({ ncv: value === defaultNcv ? null : value }, "ncv", refused)}
          />
          {billed ? <p className="text-xs text-muted-foreground">{t("ncvDerived")}</p> : <ReferenceNote reference={reference} value={defaultNcv} />}
        </div>
        <ParameterNumberField
          key={`${epoch}:gcv`}
          id="input-gcv"
          label={t("gcv")}
          stored={inputs.billedGcv}
          rule="positive"
          max={GAS_INPUT_MAX}
          disabled={ncvEdited && !billed}
          help={ncvEdited && !billed ? t("gcvBlocked") : t("gcvHelp")}
          onChange={(value, refused) => onChange({ billedGcv: value }, "billedGcv", refused)}
        />
      </div>
      {unit === "cubic_metres" && (
        <ParameterNumberField
          key={`${epoch}:vcf`}
          id="input-volume-correction"
          label={t("volumeCorrectionFactor")}
          stored={inputs.volumeCorrectionFactor}
          rule="positive"
          max={GAS_INPUT_MAX}
          help={t("volumeCorrectionHelp")}
          info={{ label: t("volumeCorrectionInfo.aria"), content: <VolumeCorrectionInfo /> }}
          onChange={(value, refused) => onChange({ volumeCorrectionFactor: value }, "volumeCorrectionFactor", refused)}
        />
      )}
      {issue && <p className="text-xs text-amber-700" role="status">{t(`gasIssues.${issue}`)}</p>}
    </div>
  );
}

/**
 * A TR refrigerant record's equipment lines (D7): type, installed capacity and
 * refill per line, the type's default rate shown, the alternative offered only
 * where the release states one. Their total capacity is the record's quantity,
 * shown read-only by the page.
 */
export function EquipmentLines({
  lines,
  reference,
  issue,
  epoch,
  onChange,
  onAdd,
  onRemove,
}: {
  lines: readonly EquipmentLineDraft[];
  reference: ReferenceState;
  issue: EquipmentIssue | null;
  epoch: number;
  onChange: (id: string, next: Partial<EquipmentLineDraft>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations("dataEntry.inputs");
  const tTypes = useTranslations("dataEntry.equipmentTypes");
  const locale = useLocale();
  const rows = reference.status === "ready" ? reference.data.parameters : [];
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="equipment-lines">
      <div>
        <p className="text-sm font-medium">{t("equipmentTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("equipmentHelp")}</p>
      </div>
      {lines.map((line, index) => {
        const taken = new Set(lines.filter((l) => l.id !== line.id).map((l) => l.equipmentType));
        const defaultRate = line.equipmentType ? leakRateOf(rows, line.equipmentType, "default") : null;
        const alternativeRate = line.equipmentType ? leakRateOf(rows, line.equipmentType, "alternative") : null;
        // A stored choice stays visible even where the release no longer offers it.
        const showChoice = line.equipmentType !== "" && (offersAlternative(rows, line.equipmentType) || line.leakRateChoice === "alternative");
        return (
          <div key={line.id} className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]" data-testid="equipment-line">
            <div className="space-y-1.5">
              <Label htmlFor={`equipment-${line.id}-type`}>{t("equipmentType")}</Label>
              <Select
                value={line.equipmentType}
                onValueChange={(v) => {
                  const type = v as EquipmentType;
                  onChange(line.id, {
                    equipmentType: type,
                    ...(offersAlternative(rows, type) ? {} : { leakRateChoice: "default" as LeakRateChoice }),
                  });
                }}
              >
                <SelectTrigger id={`equipment-${line.id}-type`} aria-label={`${t("equipmentType")} ${index + 1}`}>
                  <SelectValue placeholder={t("chooseEquipment")} />
                </SelectTrigger>
                <SelectContent>
                  {EQUIPMENT_TYPES.filter((type) => !taken.has(type)).map((type) => (
                    <SelectItem key={type} value={type}>
                      {tTypes(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {line.equipmentType !== "" && (
                showChoice ? (
                  <Select
                    value={line.leakRateChoice}
                    onValueChange={(v) => onChange(line.id, { leakRateChoice: v as LeakRateChoice })}
                  >
                    <SelectTrigger aria-label={`${t("leakRate")} ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {defaultRate === null ? t("rateUnknown") : t("defaultRate", { rate: leakRatePercent(defaultRate, locale) })}
                      </SelectItem>
                      <SelectItem value="alternative">
                        {alternativeRate === null ? t("rateUnknown") : t("alternativeRate", { rate: leakRatePercent(alternativeRate, locale) })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid="equipment-rate">
                    {t("leakRate")}: {defaultRate === null ? t("rateUnknown") : t("defaultRate", { rate: leakRatePercent(defaultRate, locale) })}
                  </p>
                )
              )}
            </div>
            <ParameterNumberField
              key={`${epoch}:${line.id}:capacity`}
              id={`equipment-${line.id}-capacity`}
              label={t("capacity")}
              stored={line.capacityKg}
              rule="non_negative"
              max={ACTIVITY_VALUE_MAX}
              onChange={(value) => onChange(line.id, { capacityKg: value })}
            />
            <ParameterNumberField
              key={`${epoch}:${line.id}:refill`}
              id={`equipment-${line.id}-refill`}
              label={t("refill")}
              stored={line.refillKg}
              rule="non_negative"
              max={ACTIVITY_VALUE_MAX}
              onChange={(value) => onChange(line.id, { refillKg: value })}
            />
            <div className="flex items-start pt-6">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={lines.length === 1}
                aria-label={t("removeLine")}
                onClick={() => onRemove(line.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={onAdd} disabled={lines.length >= EQUIPMENT_TYPES.length}>
          <Plus className="h-4 w-4" />
          {t("addLine")}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t("total")}: <span className="font-mono">{formatNumber(equipmentTotal(lines), locale)}</span>
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{t("annualOnly")}</p>
      {issue && <p className="text-xs text-amber-700" role="status">{t(`equipmentIssues.${issue}`)}</p>}
    </div>
  );
}

/** The upper bound of a self-generation kWh field (the shape CHECK's and the DTO's). */
const SELF_GENERATION_KWH_MAX = 1e300;

/** The field each of the section's issues concerns, marked invalid on screen; none for an unread field, which marks itself. */
const ISSUE_FIELD: Record<SelfGenerationFormIssue, SelfGenerationField | null> = {
  unreadable: null,
  generated_missing: "generatedKwh",
  generated_negative: "generatedKwh",
  exported_negative: "exportedKwh",
  exported_above_generated: "exportedKwh",
  facility_not_positive: "facilityKwh",
};

/**
 * An Electricity record's own generation behind the meter (self-gen-form; D5,
 * D6, D8), in any geography. Opens by source: with none, nothing more is asked
 * and the record is a plain grid record; with one, the generated kWh
 * (required), the exported and the facility consumption kWh (optional), the
 * Case A statement, the import statement, the fuel reminder for a fuel source,
 * and the energy balance warning when the consumption is given. Neither the
 * reminder nor the warning holds anything back; the issue does.
 */
export function SelfGenerationInputs({
  form,
  issue,
  balance,
  epoch,
  onChange,
}: {
  form: SelfGenerationForm;
  issue: SelfGenerationFormIssue | null;
  balance: SelfGenerationBalance | null;
  epoch: number;
  onChange: (next: Partial<SelfGenerationForm>, field: SelfGenerationField | null, refused: boolean) => void;
}) {
  const t = useTranslations("dataEntry.inputs.selfGeneration");
  const locale = useLocale();
  const reminder = selfGenerationReminder(form.source);
  const invalidField = issue ? ISSUE_FIELD[issue] : null;
  const kwh = (value: number) => formatComputedAmount(value, locale);
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="self-generation">
      <div>
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-xs text-muted-foreground">{t("help")}</p>
      </div>
      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor="self-generation-source">{t("source")}</Label>
        <Select
          value={form.source ?? "none"}
          onValueChange={(value) => onChange({ source: isSelfGenerationSource(value) ? value : null }, null, false)}
        >
          <SelectTrigger id="self-generation-source" data-testid="self-generation-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("sources.none")}</SelectItem>
            {SELF_GENERATION_SOURCES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`sources.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {form.source !== null && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="self-generation-case-a">{t("caseA")}</p>
          <p className="text-xs text-muted-foreground" data-testid="self-generation-import">{t("importStatement")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ParameterNumberField
              key={`${epoch}:self-generated`}
              id="input-self-generated"
              label={t("generated")}
              stored={form.generatedKwh}
              rule="non_negative"
              max={SELF_GENERATION_KWH_MAX}
              invalid={invalidField === "generatedKwh"}
              onChange={(value, refused) => onChange({ generatedKwh: value }, "generatedKwh", refused)}
            />
            <ParameterNumberField
              key={`${epoch}:self-exported`}
              id="input-self-exported"
              label={t("exported")}
              stored={form.exportedKwh}
              rule="non_negative"
              max={SELF_GENERATION_KWH_MAX}
              help={t("exportedHelp")}
              invalid={invalidField === "exportedKwh"}
              onChange={(value, refused) => onChange({ exportedKwh: value }, "exportedKwh", refused)}
            />
            <ParameterNumberField
              key={`${epoch}:self-facility`}
              id="input-self-facility"
              label={t("facility")}
              stored={form.facilityKwh}
              // Zero is read, so the section can say the consumption must be
              // above zero or left empty (its own sentence), rather than that
              // the figure could not be read (qa-auditor review).
              rule="non_negative"
              max={SELF_GENERATION_KWH_MAX}
              help={t("facilityHelp")}
              invalid={invalidField === "facilityKwh"}
              onChange={(value, refused) => onChange({ facilityKwh: value }, "facilityKwh", refused)}
            />
          </div>
          {issue && (
            <p className="text-xs text-amber-700" role="status" data-testid="self-generation-issue">
              {t(`issues.${issue}`)}
            </p>
          )}
          {reminder && (
            <p
              className="flex items-start gap-1.5 rounded-lg bg-secondary/60 p-2.5 text-xs"
              role="note"
              data-testid="self-generation-reminder"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t(`reminder.${reminder}`)}
            </p>
          )}
          {balance?.warns && (
            <p
              className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-900"
              role="status"
              data-testid="self-generation-balance"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t("balance", { imported: kwh(balance.importKwh), expected: kwh(balance.expectedImportKwh) })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
