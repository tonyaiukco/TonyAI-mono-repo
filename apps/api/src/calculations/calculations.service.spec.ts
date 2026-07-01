import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EmissionFactor } from '@tonyai/db';
import { CalculationsService } from './calculations.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalize } from './normalization';

// Local Prisma mock: only the emissionFactor surface the service touches. No DB.
function createFactorPrismaMock() {
  return {
    emissionFactor: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  };
}
type FactorPrismaMock = ReturnType<typeof createFactorPrismaMock>;

let seq = 0;
function makeFactor(overrides: Partial<EmissionFactor> = {}): EmissionFactor {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `factor-${seq}`,
    category: 'Electricity',
    geographyCode: 'TR',
    reportingYear: 2024,
    scope: 2,
    factorValue: 0.44,
    factorUnit: 'kgCO2e/kWh',
    normalizedUnit: 'kWh',
    methodology: 'location-based',
    source: 'calculation_logic.md §3',
    version: '2024.1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as EmissionFactor;
}

describe('normalize (calculation_logic.md §2)', () => {
  it('passes through the electricity base unit (kWh) with no conversion', () => {
    expect(normalize(1000, 'kWh')).toEqual({
      normalizedValue: 1000,
      normalizedUnit: 'kWh',
      conversionApplied: false,
    });
  });

  it('converts electricity MWh -> kWh (×1000)', () => {
    const r = normalize(5, 'mwh');
    expect(r.normalizedValue).toBe(5000);
    expect(r.normalizedUnit).toBe('kWh');
    expect(r.conversionApplied).toBe(true);
  });

  it('converts natural gas cubic_metres -> kWh (×11.36)', () => {
    const r = normalize(100, 'cubic_metres');
    expect(r.normalizedValue).toBeCloseTo(1136, 6);
    expect(r.normalizedUnit).toBe('kWh');
    expect(r.conversionApplied).toBe(true);
  });

  it('accepts the m³ alias for cubic_metres', () => {
    expect(normalize(100, 'm³').normalizedValue).toBeCloseTo(1136, 6);
  });

  it('converts liquid fuel uk_gallons -> litres (×4.546)', () => {
    const r = normalize(10, 'uk_gallons');
    expect(r.normalizedValue).toBeCloseTo(45.46, 6);
    expect(r.normalizedUnit).toBe('litres');
    expect(r.conversionApplied).toBe(true);
  });

  it('throws for an unsupported unit', () => {
    expect(() => normalize(1, 'bananas')).toThrow(/Unsupported unit/);
  });
});

describe('CalculationsService.compute', () => {
  let prisma: FactorPrismaMock;
  let service: CalculationsService;

  beforeEach(() => {
    prisma = createFactorPrismaMock();
    service = new CalculationsService(prisma as unknown as PrismaService);
  });

  it('known input -> known output: 45000 kWh electricity TR 2024 = 19.8 tCO2e', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ geographyCode: 'TR', factorValue: 0.44, reportingYear: 2024 }),
    );

    const result = await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 45000,
      unit: 'kWh',
    });

    expect(result.kgCo2e).toBeCloseTo(19800, 6);
    expect(result.tCo2e).toBeCloseTo(19.8, 6);
    expect(result.normalizedValue).toBe(45000);
    expect(result.conversionApplied).toBe(false);
  });

  it('doc worked example: 5 MWh electricity TR = 2.20 tCO2e (normalizes MWh->kWh)', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ geographyCode: 'TR', factorValue: 0.44 }),
    );

    const result = await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 5,
      unit: 'mwh',
    });

    expect(result.normalizedValue).toBe(5000);
    expect(result.kgCo2e).toBeCloseTo(2200, 6);
    expect(result.tCo2e).toBeCloseTo(2.2, 6);
    expect(result.conversionApplied).toBe(true);
  });

  it('returns the factor snapshot for traceability', async () => {
    const factor = makeFactor({
      id: 'factor-snap',
      factorValue: 0.44,
      factorUnit: 'kgCO2e/kWh',
      methodology: 'location-based',
      source: 'DEFRA demo',
      version: '2024.1',
    });
    prisma.emissionFactor.findFirst.mockResolvedValue(factor);

    const result = await service.compute({
      category: 'Electricity',
      geographyCode: 'TR',
      reportingYear: 2024,
      value: 100,
      unit: 'kWh',
    });

    expect(result.factorId).toBe('factor-snap');
    expect(result.factorValue).toBe(0.44);
    expect(result.factorUnit).toBe('kgCO2e/kWh');
    expect(result.methodology).toBe('location-based');
    expect(result.version).toBe('2024.1');
    expect(result.geographyCode).toBe('TR');
    expect(result.scope).toBe(2);
  });

  it('factor versioning: resolves the requested year (2023 factor differs from 2024)', async () => {
    // Query for 2023 must return the 2023 factor, ordered by version desc.
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ reportingYear: 2023, factorValue: 0.2123, geographyCode: 'UK', version: '2023.1' }),
    );

    const result = await service.compute({
      category: 'Electricity',
      geographyCode: 'UK',
      reportingYear: 2023,
      value: 1000,
      unit: 'kWh',
    });

    // Confirms the year filter is passed to the DB and the returned factor is used.
    expect(prisma.emissionFactor.findFirst).toHaveBeenCalledWith({
      where: { category: 'Electricity', geographyCode: 'UK', reportingYear: 2023 },
      orderBy: { version: 'desc' },
    });
    expect(result.factorValue).toBe(0.2123);
    expect(result.version).toBe('2023.1');
    expect(result.kgCo2e).toBeCloseTo(212.3, 6);
  });

  it('natural gas m³ -> kWh then applies the Scope 1 factor', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({
        category: 'Natural Gas',
        scope: 1,
        factorValue: 0.1829,
        geographyCode: 'UK',
      }),
    );

    const result = await service.compute({
      category: 'Natural Gas',
      geographyCode: 'UK',
      reportingYear: 2024,
      value: 100,
      unit: 'cubic_metres',
    });

    // 100 m³ × 11.36 = 1136 kWh ; × 0.1829 = 207.7744 kgCO2e
    expect(result.normalizedValue).toBeCloseTo(1136, 6);
    expect(result.kgCo2e).toBeCloseTo(207.7744, 4);
    expect(result.scope).toBe(1);
  });

  it('throws NotFound when no factor exists for the key', async () => {
    prisma.emissionFactor.findFirst.mockResolvedValue(null);

    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'ZZ',
        reportingYear: 2024,
        value: 1,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequest for an unsupported unit before any DB lookup', async () => {
    await expect(
      service.compute({
        category: 'Electricity',
        geographyCode: 'TR',
        reportingYear: 2024,
        value: 1,
        unit: 'bananas',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.emissionFactor.findFirst).not.toHaveBeenCalled();
  });

  it('throws BadRequest when the normalized unit mismatches the factor unit', async () => {
    // Factor expects litres, but input normalises to kWh.
    prisma.emissionFactor.findFirst.mockResolvedValue(
      makeFactor({ category: 'Fuel', normalizedUnit: 'litres', factorValue: 2.6841, scope: 1 }),
    );

    await expect(
      service.compute({
        category: 'Fuel',
        geographyCode: 'UK',
        reportingYear: 2024,
        value: 100,
        unit: 'kWh',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CalculationsService.listFactors', () => {
  let prisma: FactorPrismaMock;
  let service: CalculationsService;

  beforeEach(() => {
    prisma = createFactorPrismaMock();
    service = new CalculationsService(prisma as unknown as PrismaService);
  });

  it('passes optional filters through to Prisma and maps to DTOs', async () => {
    prisma.emissionFactor.findMany.mockResolvedValue([makeFactor({ id: 'f1' })]);

    const result = await service.listFactors({ category: 'Electricity', geographyCode: 'TR', year: 2024 });

    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { category: 'Electricity', geographyCode: 'TR', reportingYear: 2024 },
      orderBy: [
        { category: 'asc' },
        { geographyCode: 'asc' },
        { reportingYear: 'desc' },
        { version: 'desc' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f1');
    expect(typeof result[0].createdAt).toBe('string');
  });

  it('omits undefined filters (lists all)', async () => {
    prisma.emissionFactor.findMany.mockResolvedValue([]);

    await service.listFactors({});

    expect(prisma.emissionFactor.findMany).toHaveBeenCalledWith({
      where: { category: undefined, geographyCode: undefined, reportingYear: undefined },
      orderBy: expect.any(Array),
    });
  });
});
