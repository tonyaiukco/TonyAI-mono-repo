import { describe, expect, it } from 'vitest';
import type { ReportDataset } from '@tonyai/shared-types';
import {
  datasetRecord, evidenceReference, namedReleaseIds, periodLock, referencedSubsidiaryIds, releaseStanding,
  reportedNameOf, type RecordRow,
} from './dataset-reader';

/**
 * The capture's mappers (LP3-04 PR C): each field the contract names, spelled
 * as the contract spells it — and nothing a mapper did not name.
 */

const T = new Date('2026-03-01T10:20:30.456Z');

const row = (over: Partial<RecordRow> = {}): RecordRow => ({
  id: 'r-1', subsidiaryId: 'sub-1', locationId: 'loc-1', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'March',
  category: 'Electricity', activityType: null, scope: 2, status: 'approved', activityValue: 12.5, activityUnit: 'kWh',
  calculation: { factorId: 'f', tCo2e: 0.1, nested: { kept: [1, 2] } }, createdBy: 'u-1', createdAt: T, updatedAt: T,
  reviewedBy: 'u-2', reviewedAt: T, submittedAt: null, voidedBy: null, voidedAt: null, voidReason: null,
  subsidiary: { legalName: 'Acme Ltd', tradingName: 'Acme' }, location: { name: 'Plant' },
  ...over,
} as RecordRow);

describe('datasetRecord', () => {
  it('maps every field the contract picks, timestamps as ISO, actors opaque', () => {
    expect(datasetRecord(row())).toEqual({
      id: 'r-1', subsidiaryId: 'sub-1', locationId: 'loc-1', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'March',
      category: 'Electricity', activityType: null, scope: 2, status: 'approved', activityValue: 12.5, activityUnit: 'kWh',
      calculation: { factorId: 'f', tCo2e: 0.1, nested: { kept: [1, 2] } }, createdBy: 'u-1',
      createdAt: '2026-03-01T10:20:30.456Z', updatedAt: '2026-03-01T10:20:30.456Z', reviewedBy: 'u-2',
      reviewedAt: '2026-03-01T10:20:30.456Z', submittedAt: null, voidedBy: null, voidedAt: null, voidReason: null,
      subsidiaryName: 'Acme', locationName: 'Plant',
    });
  });

  it('keeps the calculation as stored, the same object', () => {
    const r = row();
    expect(datasetRecord(r).calculation).toBe(r.calculation);
  });

  it('always emits the nullable keys — a company record has a null site and name', () => {
    const mapped = datasetRecord(row({ locationId: null, location: null, activityType: null }));
    expect(mapped).toHaveProperty('locationId', null);
    expect(mapped).toHaveProperty('locationName', null);
    expect(mapped).toHaveProperty('activityType', null);
  });

  it('refuses a record outside Scope 1/2', () => {
    expect(() => datasetRecord(row({ scope: 3 }))).toThrow(/Scope 1\/2 records only/);
  });

  it('names a subsidiary by its trading name, else its legal name', () => {
    expect(reportedNameOf({ legalName: 'L', tradingName: 'T' })).toBe('T');
    expect(reportedNameOf({ legalName: 'L', tradingName: '' })).toBe('L');
    expect(reportedNameOf({ legalName: 'L', tradingName: null })).toBe('L');
  });
});

describe('evidenceReference, periodLock, releaseStanding', () => {
  it("names a file's content by its sha256, or null when unknown — never an empty-file hash", () => {
    const file = { id: 'ev-1', subsidiaryId: 'sub-1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 9, createdAt: T };
    expect(evidenceReference({ ...file, sha256: 'a'.repeat(64) }, ['r-2', 'r-1', 'r-2'])).toEqual({
      ...file, createdAt: '2026-03-01T10:20:30.456Z', contentFingerprint: { algorithm: 'sha256', hex: 'a'.repeat(64) }, recordIds: ['r-1', 'r-2'],
    });
    expect(evidenceReference({ ...file, sha256: null }, []).contentFingerprint).toBeNull();
  });

  it('maps a lock exactly', () => {
    expect(periodLock({ id: 'l', subsidiaryId: 's', reportingYear: 2026, reportingPeriod: 'annual', periodValue: 'Annual', lockedBy: 'u', createdAt: T }))
      .toEqual({ id: 'l', subsidiaryId: 's', reportingYear: 2026, reportingPeriod: 'annual', periodValue: 'Annual', lockedBy: 'u', createdAt: '2026-03-01T10:20:30.456Z' });
  });

  it("spells a release's publication as the engine's snapshot does — a date-only publication", () => {
    const standing = releaseStanding({
      id: 'rel', publisher: 'DESNZ', title: 'T', edition: '2026', ordinal: 3, status: 'withdrawn', sourceUrl: null, licence: 'OGL',
      publishedAt: new Date('2026-06-01T00:00:00Z'), gwpSet: 'AR5', withdrawnAt: T, withdrawnBy: 'TonyAI', withdrawalReason: 'Erratum',
    } as Parameters<typeof releaseStanding>[0]);
    expect(standing).toEqual({
      id: 'rel', status: 'withdrawn', withdrawnAt: '2026-03-01T10:20:30.456Z', withdrawnBy: 'TonyAI', withdrawalReason: 'Erratum',
      publication: { publisher: 'DESNZ', title: 'T', edition: '2026', ordinal: 3, sourceUrl: null, licence: 'OGL', publishedAt: '2026-06-01', gwpSet: 'AR5' },
    });
  });
});

describe('namedReleaseIds', () => {
  const v2 = (factor: string, conversion: string | null) => ({
    snapshotSchema: 2, factorId: 'f', tCo2e: 1, factorRelease: { id: factor },
    conversion: conversion === null ? null : { release: { id: conversion } },
  });
  it("names each live record's factor and conversion releases, once, sorted — never a voided record's", () => {
    const records = [
      { status: 'approved', calculation: v2('b', 'c') },
      { status: 'draft', calculation: v2('a', null) },
      { status: 'voided', calculation: v2('z', 'y') },
      { status: 'approved', calculation: { factorId: 'legacy', tCo2e: 1 } },
      { status: 'approved', calculation: v2('b', null) },
    ] as unknown as Parameters<typeof namedReleaseIds>[0];
    expect(namedReleaseIds(records)).toEqual(['a', 'b', 'c']);
  });
});

describe('referencedSubsidiaryIds — the read rule\'s set', () => {
  const base = () => ({
    context: { year: 2026 },
    resolvedSubsidiaryIds: ['s-resolved'],
    boundary: { subsidiaryIds: ['s-declared'], entities: [], applicability: [], attribution: [], sources: [] },
    records: [], evidence: [], periodLocks: [], coverage: { obligations: [], excludedSourceIds: [], gaps: [] },
  });
  const plant: Array<[string, (d: Record<string, any>) => void]> = [
    ['the context', (d) => { d.context.subsidiaryId = 'x'; }],
    ['an entity', (d) => { d.boundary.entities.push({ subsidiaryId: 'x' }); }],
    ['a cell', (d) => { d.boundary.applicability.push({ subsidiaryId: 'x' }); }],
    ['a policy', (d) => { d.boundary.attribution.push({ subsidiaryId: 'x' }); }],
    ["a source's entity", (d) => { d.boundary.sources.push({ entity: { subsidiaryId: 'x' } }); }],
    ['a record', (d) => { d.records.push({ subsidiaryId: 'x' }); }],
    ['a file', (d) => { d.evidence.push({ subsidiaryId: 'x' }); }],
    ['a lock', (d) => { d.periodLocks.push({ subsidiaryId: 'x' }); }],
    ["a gap's entity", (d) => { d.coverage.gaps.push({ entity: { subsidiaryId: 'x' } }); }],
    ['a collection added later', (d) => { d.someday = [{ deep: { subsidiaryId: 'x' } }]; }],
  ];
  it.each(plant)('names a subsidiary held only in %s', (_where, put) => {
    const d = base();
    put(d);
    expect(referencedSubsidiaryIds(d as unknown as ReportDataset)).toEqual(['s-declared', 's-resolved', 'x']);
  });

  it('holds the declared and resolved subsidiaries with nothing else referenced', () => {
    expect(referencedSubsidiaryIds(base() as unknown as ReportDataset)).toEqual(['s-declared', 's-resolved']);
  });

  it('skips a key spelled subsidiaryId whose value is not a string, as the guard does', () => {
    const d = base() as Record<string, any>;
    d.records.push({ subsidiaryId: null });
    expect(referencedSubsidiaryIds(d as unknown as ReportDataset)).toEqual(['s-declared', 's-resolved']);
  });
});
