"use client";

import { useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";
import { DecimalNote } from "@/components/i18n/decimal-note";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { checkDecimal, formatNumber, parseLocaleDecimal, typedValue, type DecimalRule } from "@/lib/i18n/number";
import { useDecimalInput } from "@/lib/i18n/use-decimal-input";
import {
  editedNcv,
  equipmentTotal,
  leakRateOf,
  leakRatePercent,
  offersAlternative,
  referenceValue,
  type EquipmentIssue,
  type EquipmentLineDraft,
  type GasInputs,
  type GasInputsIssue,
} from "@/lib/record-inputs-view";
import {
  ACTIVITY_VALUE_MAX,
  EQUIPMENT_TYPES,
  type EquipmentType,
  type LeakRateChoice,
  type ReleaseParametersDTO,
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
  onChange,
}: {
  id: string;
  label: string;
  stored: number | null;
  rule: DecimalRule;
  max: number;
  disabled?: boolean;
  help?: string;
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
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={input.text}
        disabled={disabled}
        aria-invalid={input.text.trim() !== "" && !check.ok && !input.typing}
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
