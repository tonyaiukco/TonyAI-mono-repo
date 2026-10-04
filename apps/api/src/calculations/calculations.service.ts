import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  CalculationInputError,
  FactorLibraryConflictError,
  NoEmissionFactorError,
  type CoverageRefusalCode,
} from './errors';
import type { EmissionFactor, FactorRelease, UnitConversion } from '@tonyai/db';
import {
  CALCULATION_GAS,
  CATEGORY_SCOPE_MAP,
  CATEGORY_UNITS,
  DIMENSION_BASE_UNIT,
  factorActivityTypeFor,
  isInvoiceTracked,
  isRecordActivityTypeAllowed,
  isRecordableWithoutFactor,
  recordActivityTypesFor,
  resolveFactorPath,
  scope2MethodFor,
  unitDimensionOf,
  yearPolicyOf,
} from '@tonyai/shared-types';
import type {
  ActivityCalculationSnapshot,
  CalculationInput,
  CalculationResultV2,
  Category,
  CoverageKey,
  EmissionFactorDTO,
  FactorGasCoverage,
  FactorReleaseSnapshot,
  FactorStatus,
  GwpSet,
  UnitConversionSnapshot,
} from '@tonyai/shared-types';
import { quoteCallerText } from '../common/caller-text';
import { PrismaService } from '../prisma/prisma.service';
import { FACTOR_POLICY, type FactorPolicy } from './factor-policy';
import {
  blockedUnitReason,
  canonicalUnit as canonicalInputUnit,
  isKnownUnit,
  normalize,
} from './normalization';
import { storedUnit } from './storable-unit';

/** Every status a calculation may ever resolve from — never `withdrawn`. */
const LIVE_STATUSES: readonly FactorStatus[] = ['authoritative', 'placeholder', 'fixture'];

/**
 * More candidate rows than one lookup can legitimately have. A lookup is one
 * category, activity type, geography and year; its candidates are that key's
 * factors across releases and units, and its conversions — paths are
 * factors × conversions, so an unbounded library would make one request
 * quadratic. Above the cap the library is defective and the lookup refused.
 */
export const FACTOR_CANDIDATE_CAP = 50;

type FactorRow = EmissionFactor & { release: FactorRelease };
type ConversionRow = UnitConversion & { release: FactorRelease };

/**
 * A row with its release status typed as the contract's. The column is
 * CHECK-constrained to `FACTOR_STATUSES`, and `selectByRelease` ignores any
 * status it does not know in any case.
 */
function ranked<T extends { release: FactorRelease }>(row: T): T & { release: FactorRelease & { status: FactorStatus } } {
  return { ...row, release: { ...row.release, status: row.release.status as FactorStatus } };
}

function releaseSnapshot(release: FactorRelease): FactorReleaseSnapshot {
  return {
    id: release.id,
    publisher: release.publisher,
    title: release.title,
    edition: release.edition,
    ordinal: release.ordinal,
    status: release.status as FactorStatus,
    sourceUrl: release.sourceUrl,
    licence: release.licence,
    publishedAt: release.publishedAt ? release.publishedAt.toISOString().slice(0, 10) : null,
    gwpSet: release.gwpSet as GwpSet | null,
  };
}

function conversionSnapshot(conversion: ConversionRow): UnitConversionSnapshot {
  return {
    id: conversion.id,
    fromUnit: conversion.fromUnit,
    toUnit: conversion.toUnit,
    multiplier: conversion.multiplier,
    calorificBasis: conversion.calorificBasis as UnitConversionSnapshot['calorificBasis'],
    referenceConditions: conversion.referenceConditions,
    basis: conversion.basis,
    dataYear: conversion.dataYear,
    release: releaseSnapshot(conversion.release),
  };
}

@Injectable()
export class CalculationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FACTOR_POLICY) private readonly policy: FactorPolicy,
  ) {}

  private toFactorDTO(f: EmissionFactor): EmissionFactorDTO {
    return {
      id: f.id,
      category: f.category,
      geographyCode: f.geographyCode,
      reportingYear: f.reportingYear,
      scope: f.scope,
      factorValue: f.factorValue,
      factorUnit: f.factorUnit,
      normalizedUnit: f.normalizedUnit,
      methodology: f.methodology,
      source: f.source,
      version: f.version,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    };
  }

  /** List factors, optionally filtered. Reference data — not tenant-scoped. */
  async listFactors(filter: {
    category?: string;
    geographyCode?: string;
    year?: number;
  }): Promise<EmissionFactorDTO[]> {
    const factors = await this.prisma.emissionFactor.findMany({
      where: {
        category: filter.category,
        geographyCode: filter.geographyCode,
        reportingYear: filter.year,
      },
      orderBy: [
        { category: 'asc' },
        { geographyCode: 'asc' },
        { reportingYear: 'desc' },
        { version: 'desc' },
      ],
    });
    return factors.map((f) => this.toFactorDTO(f));
  }

  /**
   * The candidate factors and conversions of one lookup, matched EXACTLY on
   * category, activity type, geography and reporting year — a loose match
   * would apply another country's calorific value or another year's grid —
   * factors also on the CO2e row of the category's own Scope 2 method, and
   * conversions from the base unit of the record's family. Releases are
   * filtered by status here, in SQL, as well as by `resolveFactorPath`.
   */
  private async candidates(
    lookup: { category: string; activityType: string; geographyCode: string; reportingYear: number },
    baseUnit: string,
    statuses: readonly FactorStatus[],
  ): Promise<{ factors: FactorRow[]; conversions: ConversionRow[] }> {
    const where = { ...lookup, release: { status: { in: [...statuses] } } };
    const [factors, conversions] = await Promise.all([
      this.prisma.emissionFactor.findMany({
        where: { ...where, gas: CALCULATION_GAS, scope2Method: scope2MethodFor(lookup.category) },
        include: { release: true },
        orderBy: { id: 'asc' },
        take: FACTOR_CANDIDATE_CAP + 1,
      }),
      this.prisma.unitConversion.findMany({
        where: { ...where, fromUnit: baseUnit },
        include: { release: true },
        orderBy: { id: 'asc' },
        take: FACTOR_CANDIDATE_CAP + 1,
      }),
    ]);
    if (factors.length > FACTOR_CANDIDATE_CAP || conversions.length > FACTOR_CANDIDATE_CAP) {
      throw new FactorLibraryConflictError(
        'ambiguous_factor',
        `The factor library holds more than ${FACTOR_CANDIDATE_CAP} candidate rows for category ` +
          `"${lookup.category}" (${lookup.activityType}, ${lookup.geographyCode}, ${lookup.reportingYear}) — a library defect, refused rather than searched.`,
      );
    }
    return { factors, conversions };
  }

  /**
   * Which factor — and which sourced conversion — prices this lookup, by
   * `resolveFactorPath`: the one rule the engine, the seed and the coverage
   * report share.
   *
   * Where placeholders are refused, the pricing query reads authoritative
   * releases only, so no non-authoritative row ever reaches the arithmetic
   * here even if the resolver were wrong. A refusal is then re-derived over
   * every live release — never to price, only so the code names the real gap
   * (`placeholder_refused` — "load the source" — rather than `no_factor`).
   */
  private async resolve(
    lookup: { category: string; activityType: string; geographyCode: string; reportingYear: number },
    inputUnit: string,
  ) {
    const dimension = unitDimensionOf(inputUnit);
    if (dimension === undefined) return { ok: false as const, code: 'unit_unknown' as const };
    const baseUnit = DIMENSION_BASE_UNIT[dimension];
    const allowPlaceholders = this.policy.allowPlaceholders;
    const run = async (statuses: readonly FactorStatus[]) => {
      const { factors, conversions } = await this.candidates(lookup, baseUnit, statuses);
      return resolveFactorPath({
        category: lookup.category,
        inputUnit,
        factors: factors.map(ranked),
        conversions: conversions.map(ranked),
        allowPlaceholders,
      });
    };
    const result = await run(allowPlaceholders ? LIVE_STATUSES : ['authoritative']);
    if (result.ok || allowPlaceholders) return result;
    const why = await run(LIVE_STATUSES);
    return why.ok ? result : why;
  }

  /** The lookup, in words. The activity is named only when the record named one. */
  private lookupText(key: CoverageKey, typed: boolean): string {
    return (
      `category "${quoteCallerText(key.category)}"` +
      (typed ? `, activity "${quoteCallerText(key.activityType)}"` : '') +
      `, geography "${quoteCallerText(key.geographyCode)}", year ${key.reportingYear}`
    );
  }

  /** The refusal sentence for a coverage code — what is missing, in words. */
  private coverageMessage(code: CoverageRefusalCode, key: CoverageKey, typed: boolean): string {
    const what = this.lookupText(key, typed);
    switch (code) {
      case 'placeholder_refused':
        return `Only placeholder (non-authoritative) emission factors cover ${what}, and this environment calculates from authoritative factors only.`;
      case 'no_conversion':
        return `The emission factor for ${what} is quoted in another unit, and no sourced conversion from "${quoteCallerText(key.unit)}" to it is loaded.`;
      case 'calorific_basis_mismatch':
        return `The emission factors for ${what} are stated on a different calorific basis than "${quoteCallerText(key.unit)}" (a fuel's kWh is billed on gross calorific value).`;
      default:
        return `No emission factor found for ${what}`;
    }
  }

  /**
   * Compute emissions for a single activity input.
   * kgCo2e = normalizedValue × factorValue ; tCo2e = kgCo2e / 1000.
   * Returns the v2 snapshot — the figure and where every number came from
   * (calculation_logic.md §5; `CalculationResultV2`).
   *
   * Validates the activity type against the category (`activity_type_*`), but
   * does not require one: whether a record must name a type depends on
   * whether it is new (`ActivityRecordsService`), which a preview cannot know.
   */
  async compute(
    input: CalculationInput,
    /** `false` when the unit was INHERITED from a stored record rather than
     *  chosen now. The category map is new, so a record saved before it (gas in
     *  MWh, say) would otherwise 400 on any edit — including one that never
     *  touched the unit — and tell the user to change a historical figure. */
    options: { enforceCategoryUnit?: boolean } = {},
  ): Promise<ActivityCalculationSnapshot> {
    if (!Number.isFinite(input.value)) {
      throw new BadRequestException('value must be a finite number');
    }
    if (!isKnownUnit(input.unit)) {
      throw new CalculationInputError('unit_unknown', `Unsupported unit "${quoteCallerText(input.unit)}"`);
    }
    // Recognised but not calculable (Sm³): refuse by name, with the reason, so
    // the caller learns what is missing rather than "unsupported unit".
    const blocked = blockedUnitReason(input.unit);
    if (blocked) {
      throw new CalculationInputError('unit_blocked', blocked);
    }
    // Category/unit agreement. Path resolution only refuses a unit whose
    // family no factor reaches; within the kWh family `therms` on Electricity
    // or `MWh` on Natural Gas would otherwise produce a plausible number.
    const allowedUnits =
      options.enforceCategoryUnit === false
        ? undefined
        : CATEGORY_UNITS[input.category as Category];
    // Compare canonical to canonical: the shared list carries display tokens
    // (`kWh`, `MWh`) while the engine keys on resolved aliases (`kwh`, `mwh`),
    // so a raw `includes` rejected the very units it was meant to allow.
    if (
      allowedUnits &&
      !allowedUnits
        .map((u) => canonicalInputUnit(u))
        .includes(canonicalInputUnit(input.unit))
    ) {
      // The unit is quoted, never repeated whole. A KNOWN unit can arrive
      // padded — `canonicalUnit` collapses whitespace, so `cubic`, 30,000
      // spaces and `metres` passes `isKnownUnit` — and a bulk import repeats
      // this sentence in its report.
      throw new CalculationInputError(
        'unit_not_for_category',
        `Unit "${quoteCallerText(input.unit)}" is not valid for "${input.category}". ` +
          `Accepted: ${allowedUnits.join(', ')}.`,
      );
    }
    const recordType = input.activityType ?? null;
    if (!isRecordActivityTypeAllowed(input.category, recordType)) {
      const types = recordActivityTypesFor(input.category).map((t) => t.value);
      throw new CalculationInputError(
        'activity_type_not_for_category',
        `Activity type "${quoteCallerText(recordType ?? '')}" is not one "${input.category}" has. ` +
          (types.length > 0 ? `Accepted: ${types.join(', ')}.` : 'This category takes no activity type.'),
      );
    }

    // The vocabulary spelling (`kWh`, not `kwh`): path resolution classifies a
    // unit by exact match.
    const unit = storedUnit(input.unit);
    const coverage: CoverageKey = {
      category: input.category,
      activityType: factorActivityTypeFor(input.category, recordType),
      geographyCode: input.geographyCode,
      reportingYear: input.reportingYear,
      unit,
    };
    // Resolved BEFORE normalization: when there is no factor there is nothing
    // to normalise TOWARDS, and the factorless Water branch below must freeze
    // the reading exactly as entered.
    const resolution = await this.resolve(
      {
        category: coverage.category,
        activityType: coverage.activityType,
        geographyCode: coverage.geographyCode,
        reportingYear: coverage.reportingYear,
      },
      unit,
    );

    if (!resolution.ok) {
      if (resolution.code === 'unit_unknown') {
        throw new CalculationInputError('unit_unknown', `Unsupported unit "${quoteCallerText(input.unit)}"`);
      }
      if (resolution.code === 'ambiguous_factor') {
        throw new FactorLibraryConflictError(
          'ambiguous_factor',
          `Two factor releases claim the factor for ${this.lookupText(coverage, recordType !== null)} at the same rank — the factor library needs a person to settle which applies.`,
        );
      }
      // Only a named category may be stored without a figure — see
      // FACTORLESS_RECORDABLE_CATEGORIES for why this is a list rather than
      // "invoice-tracked and unresolved" (that broader rule would have absorbed
      // a missing Electricity factor). And only when NO factor exists: a
      // placeholder refused or a conversion missing is a gap to fix, not a
      // category without a methodology. Every other case still refuses, which
      // is what keeps DE-4 (refrigerants) and DE-5 (mobile combustion)
      // honestly unreportable instead of quietly accepting data nobody can
      // calculate.
      //
      // BOTH conditions, because the `reason` below is frozen into an immutable
      // column and says the entry is kept for invoice-level completeness. Gated
      // on the allow-list alone, adding a factor-less category that is NOT
      // invoice-tracked would write that sentence — permanently — into rows
      // where it is false.
      if (
        resolution.code === 'no_factor' &&
        isRecordableWithoutFactor(input.category) &&
        isInvoiceTracked(input.category)
      ) {
        return {
          snapshotSchema: 1,
          category: input.category,
          geographyCode: input.geographyCode,
          reportingYear: input.reportingYear,
          scope: CATEGORY_SCOPE_MAP[input.category as Category],
          inputValue: input.value,
          inputUnit: input.unit,
          reasonCode: 'no_emission_factor',
          // Raw here, deliberately, unlike the refusal below. This is a STORED
          // value, not a sentence shown once: the identical raw `geographyCode`
          // is frozen into the field a few lines up, so quoting only the prose
          // would be theatre — and would leave an immutable record whose
          // sentence disagrees with its own machine-readable fields. A second
          // layer, if one is ever wanted, belongs on the column.
          reason:
            `No emission factor is available for "${input.category}" (${input.geographyCode}, ${input.reportingYear}), ` +
            `so no tCO₂e figure is produced. The entry is still recorded because this category is tracked ` +
            `by invoice for data-completeness purposes.`,
        };
      }
      throw new NoEmissionFactorError(this.coverageMessage(resolution.code, coverage, recordType !== null), {
        code: resolution.code,
        coverage,
      });
    }

    const { factor, conversion } = resolution;
    // The record's scope comes from its category; a factor loaded under
    // another scope is a library defect, never a reason to move the record.
    const scope = CATEGORY_SCOPE_MAP[input.category as Category];
    if (factor.scope !== scope) {
      throw new FactorLibraryConflictError(
        'factor_scope_mismatch',
        `The factor resolved for "${input.category}" is a Scope ${factor.scope} factor, but "${input.category}" is Scope ${scope} — a factor-library defect.`,
      );
    }

    const { normalizedValue, normalizedUnit, conversionApplied, conversionFactor, conversionBasis } = normalize(
      input.value,
      input.unit,
      input.category,
      conversion,
    );
    // The resolver chose this path for this unit; arriving anywhere else is a
    // defect in the engine, not something to price through.
    if (normalizedUnit !== factor.normalizedUnit) {
      throw new Error(
        `Engine defect: ${input.unit} normalised to ${normalizedUnit}, but the resolved factor is per ${factor.normalizedUnit}`,
      );
    }
    if (factor.gasCoverage === null) {
      throw new Error(`Factor ${factor.id} is a CO2e row with no gas coverage — the library CHECK should refuse it`);
    }

    const kgCo2e = normalizedValue * factor.factorValue;
    const tCo2e = kgCo2e / 1000;

    const snapshot: CalculationResultV2 = {
      snapshotSchema: 2,
      category: input.category,
      geographyCode: input.geographyCode,
      reportingYear: input.reportingYear,
      scope: factor.scope,
      inputValue: input.value,
      inputUnit: input.unit,
      normalizedValue,
      normalizedUnit,
      conversionApplied,
      ...(conversionFactor !== undefined ? { conversionFactor } : {}),
      ...(conversionBasis !== undefined ? { conversionBasis } : {}),
      kgCo2e,
      tCo2e,
      factorId: factor.id,
      factorValue: factor.factorValue,
      factorUnit: factor.factorUnit,
      methodology: factor.methodology,
      source: factor.source,
      // The release's edition — the label the contract gives `version`.
      version: factor.release.edition,
      activityType: factor.activityType,
      gas: CALCULATION_GAS,
      gasCoverage: factor.gasCoverage as FactorGasCoverage,
      calorificBasis: factor.calorificBasis as CalculationResultV2['calorificBasis'],
      scope2Method: factor.scope2Method as CalculationResultV2['scope2Method'],
      dataYear: factor.dataYear,
      yearPolicy: yearPolicyOf(input.reportingYear, factor.dataYear),
      factorRelease: releaseSnapshot(factor.release),
      conversion: conversion ? conversionSnapshot(conversion) : null,
    };
    return snapshot;
  }
}
