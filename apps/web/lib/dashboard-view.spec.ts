import { describe, it, expect } from 'vitest';
import { buildKpiData, matrixToAlerts, matrixToSubsidiaries } from './dashboard-view';
import type {
  EmissionsSummary,
  TrackingMatrixCell,
  TrackingMatrixDTO,
  TrackingMatrixRow,
} from '@tonyai/shared-types';

/**
 * The first unit tests in `apps/web`.
 *
 * This module decides what every dashboard tile claims — the completion
 * percentage, the stacked bar, whether a cell shows a number or a dot — and it
 * had no automated coverage of any kind: `apps/web`'s `test` script was one
 * assertion about `next.config.mjs`, and the E2E that exercised it does not run
 * in CI. WP17 changed the derivation twice (`tCo2e > 0` → `!== null`, then the
 * matrix rows stopped being mapped at all), both times unverified by `pnpm test`.
 */

function cell(over: Partial<TrackingMatrixCell> = {}): TrackingMatrixCell {
  return {
    category: 'Electricity',
    scope: 2,
    status: 'complete',
    tCo2e: 12.4,
    recordCount: 1,
    uncalculatedRecordCount: 0,
    lastUpdate: '2026-01-01T00:00:00.000Z',
    anomaly: false,
    ...over,
  };
}

function row(over: Partial<TrackingMatrixRow> = {}): TrackingMatrixRow {
  return {
    subsidiaryId: 'sub-1',
    subsidiaryName: 'TonyAI Energy',
    sector: 'Energy',
    designatedPerson: 'Aylin Demir',
    totalTCo2e: 12.4,
    completeCount: 1,
    categoryCount: 11,
    trackingGranularity: 'subsidiary',
    locationCount: 0,
    uncalculatedRecordCount: 0,
    cells: [cell()],
    ...over,
  };
}

const matrix = (rows: TrackingMatrixRow[], totals?: TrackingMatrixDTO['totals']): TrackingMatrixDTO => ({
  reportingYear: 2026,
  rows,
  totals: totals ?? { complete: 1, incomplete: 0, missing: 10 },
});

const summary = {
  totals: { scope1: 100, scope2: 200, scope3: 0, total: 300 },
} as EmissionsSummary;

describe('matrixToSubsidiaries', () => {
  it('shows a figure for a measured zero, and none for an unmeasured cell', () => {
    const [view] = matrixToSubsidiaries(
      matrix([
        row({
          cells: [
            // A genuine zero: something was measured and came to nought.
            cell({ category: 'Electricity', tCo2e: 0 }),
            // Nothing produced a figure — no records, only drafts, or a
            // category with no emission factor.
            cell({ category: 'Water', tCo2e: null }),
          ],
        }),
      ]),
    );

    // The derivation used to be `tCo2e > 0`, which hid a real measured zero and
    // reported it identically to "nothing was measured".
    expect(view.categories[0].calculationComplete).toBe(true);
    expect(view.categories[0].emission).toBe(0);
    expect(view.categories[1].calculationComplete).toBe(false);
    expect(view.categories[1].emission).toBeNull();
  });

  it('rounds the figure and carries the row owner onto every cell', () => {
    const [view] = matrixToSubsidiaries(
      matrix([row({ designatedPerson: 'Aylin Demir', cells: [cell({ tCo2e: 12.6 })] })]),
    );
    expect(view.categories[0].emission).toBe(13);
    expect(view.categories[0].responsible).toBe('Aylin Demir');
  });

  it('falls back to an em dash rather than printing "null" as an owner', () => {
    const [view] = matrixToSubsidiaries(matrix([row({ designatedPerson: null })]));
    expect(view.categories[0].responsible).toBe('—');
  });
});

describe('buildKpiData', () => {
  it('derives the completion percentage from the cell totals', () => {
    const kpi = buildKpiData(
      summary,
      matrix([row()], { complete: 6, incomplete: 2, missing: 2 }),
      8,
    );
    expect(kpi.completedCategories).toBe(6);
    expect(kpi.calculationCompletionRate).toBe(60);
    expect(kpi.totalLocations).toBe(8);
  });

  it('reports 0%, not NaN, for a tenant with no cells at all', () => {
    // Reachable on a fresh organisation with no subsidiaries. The card divided
    // by this total to size its bar and rendered a literal `NaN%`.
    const kpi = buildKpiData(summary, matrix([], { complete: 0, incomplete: 0, missing: 0 }), null);
    expect(kpi.calculationCompletionRate).toBe(0);
    expect(Number.isNaN(kpi.calculationCompletionRate)).toBe(false);
  });

  it('keeps trends null rather than inventing a prior period', () => {
    const kpi = buildKpiData(summary, matrix([row()]), 0);
    expect(kpi.emissions.totalTrend).toBeNull();
    expect(kpi.emissions.scope1Trend).toBeNull();
  });
});

describe('matrixToAlerts', () => {
  it('raises one alert per flagged cell and none for the rest', () => {
    const alerts = matrixToAlerts(
      matrix([
        row({
          cells: [
            cell({ category: 'Electricity', anomaly: true }),
            cell({ category: 'Fuel', anomaly: false }),
          ],
        }),
      ]),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe('Electricity');
    expect(alerts[0].subsidiary).toBe('TonyAI Energy');
  });
});
