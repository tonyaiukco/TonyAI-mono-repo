import { describe, expect, it } from 'vitest';
import type { ActivityCalculationSnapshot, SealedFactorReleaseDTO } from '@/lib/types';
import { factorReleaseId, formatSealDate, sealDateFor, sealDateIndex } from './release-seal-view';

const release = (id: string, sealedAt: string): SealedFactorReleaseDTO => ({
  id,
  publisher: 'ETKB',
  title: 'Türkiye grid factors',
  edition: 'TONYAI-EF-TR-2026.11',
  ordinal: 1,
  status: 'authoritative',
  sourceUrl: null,
  licence: null,
  publishedAt: '2026-11-04',
  gwpSet: 'AR6',
  sealedAt,
});

describe('release seal dates (UAT round 2, S2)', () => {
  const dates = sealDateIndex([release('rel-a', '2026-11-05T09:30:00.000Z'), release('rel-b', '2026-11-10T12:00:00.000Z')]);

  it('finds the seal timestamp of a known release', () => {
    expect(sealDateFor(dates, 'rel-a')).toBe('2026-11-05T09:30:00.000Z');
  });

  it('yields nothing for an unknown or missing release, or before the list loads', () => {
    expect(sealDateFor(dates, 'rel-unknown')).toBeNull();
    expect(sealDateFor(dates, null)).toBeNull();
    expect(sealDateFor(dates, undefined)).toBeNull();
    expect(sealDateFor(null, 'rel-a')).toBeNull();
  });

  it('reads the factor release id only from a snapshot that names one', () => {
    const v3 = { factorId: 'f-1', tCo2e: 1, snapshotSchema: 3, factorRelease: { id: 'rel-a' } } as unknown as ActivityCalculationSnapshot;
    const legacy = { factorId: 'f-1', tCo2e: 1 } as unknown as ActivityCalculationSnapshot;
    expect(factorReleaseId(v3)).toBe('rel-a');
    expect(factorReleaseId(legacy)).toBeNull();
    expect(factorReleaseId(null)).toBeNull();
  });

  it('formats the date in the user locale, date only', () => {
    const iso = '2026-11-05T09:30:00.000Z';
    expect(formatSealDate(iso, 'en')).toMatch(/2026/);
    expect(formatSealDate(iso, 'en')).not.toMatch(/09:30|9:30/);
    expect(formatSealDate(iso, 'tr')).toMatch(/Kas/);
  });

  it('reads the date in one fixed time zone, so a late-evening UTC seal is one date everywhere', () => {
    // 22:30 UTC on 4 November is 01:30 on 5 November in Istanbul.
    expect(formatSealDate('2026-11-04T22:30:00.000Z', 'en')).toMatch(/05/);
  });
});
