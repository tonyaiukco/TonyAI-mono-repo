import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { EmissionFactor } from '@tonyai/db';
import {
  CATEGORY_SCOPE_MAP,
  CATEGORY_UNITS,
  isRecordableWithoutFactor,
} from '@tonyai/shared-types';
import type {
  ActivityCalculationSnapshot,
  CalculationInput,
  Category,
  EmissionFactorDTO,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import {
  blockedUnitReason,
  canonicalUnit as canonicalInputUnit,
  isKnownUnit,
  normalize,
  type NormalizationResult,
} from './normalization';

@Injectable()
export class CalculationsService {
  constructor(private readonly prisma: PrismaService) {}

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

  /** Expose the pure normalizer for callers/tests. */
  normalize(value: number, unit: string): NormalizationResult {
    return normalize(value, unit);
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
   * Resolve the latest-version factor for (category, geography, year). Among
   * rows sharing that key we take the highest `version` (desc), so a newer
   * factor library supersedes an older one for the same reporting year.
   */
  private async resolveFactor(
    category: string,
    geographyCode: string,
    reportingYear: number,
  ): Promise<EmissionFactor> {
    const factor = await this.findFactor(category, geographyCode, reportingYear);
    if (!factor) {
      throw new NotFoundException(
        `No emission factor found for category "${category}", geography "${geographyCode}", year ${reportingYear}`,
      );
    }
    return factor;
  }

  /** The same lookup without the refusal — for the one caller allowed to
   *  proceed when nothing is found (see `compute`). */
  private async findFactor(
    category: string,
    geographyCode: string,
    reportingYear: number,
  ): Promise<EmissionFactor | null> {
    return this.prisma.emissionFactor.findFirst({
      where: { category, geographyCode, reportingYear },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * Compute emissions for a single activity input.
   * kgCo2e = normalizedValue × factorValue ; tCo2e = kgCo2e / 1000.
   * Returns the factor snapshot for traceability (calculation_logic.md §5).
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
      throw new BadRequestException(`Unsupported unit "${input.unit}"`);
    }
    // Recognised but not calculable (Sm³): refuse by name, with the reason, so
    // the caller learns what is missing rather than "unsupported unit".
    const blocked = blockedUnitReason(input.unit);
    if (blocked) {
      throw new BadRequestException(blocked);
    }
    // Category/unit agreement. The factor guard below only catches a mismatch
    // BETWEEN unit families (litres vs kWh); within the kWh family `therms` on
    // Electricity or `MWh` on Natural Gas produced a plausible number and no
    // error at all.
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
      throw new BadRequestException(
        `Unit "${input.unit}" is not valid for "${input.category}". ` +
          `Accepted: ${allowedUnits.join(', ')}.`,
      );
    }

    // The factor is resolved BEFORE normalization, not after, because when
    // there is no factor there is nothing to normalise TOWARDS — and running
    // normalize() anyway would not be merely pointless, it would be wrong:
    // it is category-blind and converts any `cubic_metres` at the natural-gas
    // calorific multiplier, so a water meter reading would be frozen into the
    // record as kWh. See UncalculatedSnapshot in @tonyai/shared-types.
    const factor = await this.findFactor(
      input.category,
      input.geographyCode,
      input.reportingYear,
    );

    if (!factor) {
      // Only a named category may be stored without a figure — see
      // FACTORLESS_RECORDABLE_CATEGORIES for why this is a list rather than
      // "invoice-tracked and unresolved" (that broader rule would have absorbed
      // a missing Electricity factor). Every other case still refuses, which is
      // what keeps DE-4 (refrigerants) and DE-5 (mobile combustion) honestly
      // unreportable instead of quietly accepting data nobody can calculate.
      if (!isRecordableWithoutFactor(input.category)) {
        throw new NotFoundException(
          `No emission factor found for category "${input.category}", geography "${input.geographyCode}", year ${input.reportingYear}`,
        );
      }
      return {
        category: input.category,
        geographyCode: input.geographyCode,
        reportingYear: input.reportingYear,
        scope: CATEGORY_SCOPE_MAP[input.category as Category],
        inputValue: input.value,
        inputUnit: input.unit,
        reasonCode: 'no_emission_factor',
        reason:
          `No emission factor is available for "${input.category}" (${input.geographyCode}, ${input.reportingYear}), ` +
          `so no tCO₂e figure is produced. The entry is still recorded because this category is tracked ` +
          `by invoice for data-completeness purposes.`,
      };
    }

    const {
      normalizedValue,
      normalizedUnit,
      conversionApplied,
      conversionFactor,
      conversionBasis,
    } = normalize(input.value, input.unit);

    // Guard: the normalized unit must match the unit the factor expects.
    if (normalizedUnit !== factor.normalizedUnit) {
      throw new BadRequestException(
        `Unit "${input.unit}" normalises to "${normalizedUnit}" but the factor for ` +
          `"${input.category}" expects "${factor.normalizedUnit}"`,
      );
    }

    const kgCo2e = normalizedValue * factor.factorValue;
    const tCo2e = kgCo2e / 1000;

    return {
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
      version: factor.version,
    };
  }
}
