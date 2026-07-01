import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { EmissionFactor } from '@tonyai/db';
import type {
  CalculationInput,
  CalculationResult,
  EmissionFactorDTO,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { isKnownUnit, normalize, type NormalizationResult } from './normalization';

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
    const factor = await this.prisma.emissionFactor.findFirst({
      where: { category, geographyCode, reportingYear },
      orderBy: { version: 'desc' },
    });
    if (!factor) {
      throw new NotFoundException(
        `No emission factor found for category "${category}", geography "${geographyCode}", year ${reportingYear}`,
      );
    }
    return factor;
  }

  /**
   * Compute emissions for a single activity input.
   * kgCo2e = normalizedValue × factorValue ; tCo2e = kgCo2e / 1000.
   * Returns the factor snapshot for traceability (calculation_logic.md §5).
   */
  async compute(input: CalculationInput): Promise<CalculationResult> {
    if (!Number.isFinite(input.value)) {
      throw new BadRequestException('value must be a finite number');
    }
    if (!isKnownUnit(input.unit)) {
      throw new BadRequestException(`Unsupported unit "${input.unit}"`);
    }

    const { normalizedValue, normalizedUnit, conversionApplied } = normalize(
      input.value,
      input.unit,
    );

    const factor = await this.resolveFactor(
      input.category,
      input.geographyCode,
      input.reportingYear,
    );

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
