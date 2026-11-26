import { describe, it, expect } from 'vitest';
import { reportingCompanies, axisThousands, buildKpiData, cellsByColumn, compactTonnes, completionRate, emptyInvoiceGridKey, matrixCellLinks, matrixColumns, matrixToAlerts, matrixToSubsidiaries, scope12Total } from './dashboard-view';
import { CATEGORIES } from '@/lib/types';
import { initialEmissionsTab } from './emissions-view';
import { copyFor } from '@/lib/i18n/testing';
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
    notEvaluatedRecordCount: 0,
    tCo2e: 12.4,
    recordCount: 1,
    uncalculatedRecordCount: 0,
    voidedRecordCount: 0,
    awaitingReviewRecords: 0,
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

  it('totals a subsidiary on Scope 1 + 2, as the headline does — never its Scope 3 cells', () => {
    const r = row({
      totalTCo2e: 1_012.4,
      cells: [
        cell({ category: 'Electricity', scope: 2, tCo2e: 12.4 }),
        cell({ category: 'Natural Gas', scope: 1, tCo2e: null }),
        cell({ category: 'Business Travel', scope: 3, tCo2e: 1_000 }),
      ],
    });
    expect(scope12Total(r)).toBeCloseTo(12.4);
    expect(matrixToSubsidiaries(matrix([r]))[0].totalEmissions).toBeCloseTo(12.4);
  });

  it('calls a row with no Scope 1 or 2 cell not covered (null), never a measured 0', () => {
    // A Scope 3 selection: the matrix keeps only its categories.
    const r = row({ cells: [cell({ category: 'Business Travel', scope: 3, tCo2e: 40 })] });
    expect(scope12Total(r)).toBeNull();
    // A covered row whose cells have no figure yet is still a Scope 1 + 2 row.
    expect(scope12Total(row({ cells: [cell({ tCo2e: null })] }))).toBe(0);
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

  it('counts a cell awaiting review as incomplete, not complete', () => {
    // WP19 moved a submitted-only cell from `complete` to `incomplete` on the
    // server, and this card is where a user meets the consequence: the
    // percentage now answers "how much has been ACCEPTED", not "how much has
    // been keyed in". Read from the server's totals and never recomputed here —
    // the cells this function receives are one row's worth, while the totals
    // span the whole tenant.
    const kpi = buildKpiData(
      summary,
      matrix(
        [
          row({
            cells: [cell({ status: 'incomplete', awaitingReviewRecords: 3 })],
            completeCount: 0,
          }),
        ],
        { complete: 0, incomplete: 1, missing: 10 },
      ),
      1,
    );
    expect(kpi.completedCategories).toBe(0);
    expect(kpi.calculationCompletionRate).toBe(0);
  });

  it('reports not applicable (null), never 0% or NaN, with no cell to complete', () => {
    // A fresh organisation with no subsidiaries, or a standard user granted a
    // company with no category ticked and no record of its own (owner's
    // review): there is nothing to complete. The card once rendered `NaN%`.
    const kpi = buildKpiData(summary, matrix([], { complete: 0, incomplete: 0, missing: 0 }), null);
    expect(kpi.calculationCompletionRate).toBeNull();
  });

  it('totals Scope 1 + 2 as every report does — Scope 3 on its own card, outside the total (LP4-03 K4)', () => {
    const withScope3 = { ...summary, totals: { scope1: 10, scope2: 20, scope3: 999, total: 1029 } };
    const kpi = buildKpiData(withScope3, matrix([row()]), 0);
    expect(kpi.emissions.total).toBe(30);
    expect(kpi.totalEmissions).toBe(30);
    expect(kpi.emissions.scope3).toBe(999);
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
      (category) => copyFor('dashboard').t('alerts.anomaly', { category }),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].category).toBe('Electricity');
    expect(alerts[0].subsidiary).toBe('TonyAI Energy');
    expect(alerts[0].message).toBe('Anomaly flag on Electricity records — review the variance reason');
  });
});

describe('compactTonnes', () => {
  const en = copyFor('dashboard', 'en');
  const tr = copyFor('dashboard', 'tr');

  it('reads as the cards always did in English', () => {
    expect(compactTonnes(818, en)).toBe('818');
    expect(compactTonnes(12_345, en)).toBe('12.3k');
    expect(compactTonnes(1_250_000, en)).toBe('1.3M');
    expect(compactTonnes(1000, en)).toBe('1.0k');
    expect(axisThousands(12_000, en)).toBe('12k');
    expect(axisThousands(0, en)).toBe('0k');
    // The KPI cards pass raw float totals: a whole number below 1,000.
    expect(compactTonnes(818.456, en)).toBe('818');
    expect(compactTonnes(1_000_000, en)).toBe('1.0M');
    expect(axisThousands(12_345, en)).toBe('12k');
    // Never "-0" for a value that rounds to zero.
    expect(compactTonnes(-0.3, en)).toBe('0');
  });

  it('writes the same quantity the Turkish way', () => {
    expect(compactTonnes(818, tr)).toBe('818');
    expect(compactTonnes(12_345, tr)).toBe('12,3 bin');
    expect(compactTonnes(1_250_000, tr)).toBe('1,3 mn');
    expect(axisThousands(12_000, tr)).toBe('12 bin');
  });
});

describe('matrixCellLinks (BUG-R2-06)', () => {
  const id = '3f2b6c1e-0d4a-4e8b-9c7d-1a2b3c4d5e6f';
  const links = matrixCellLinks(id, 'Natural Gas', 2026);
  const query = (href: string) => new URL(href, 'http://x').searchParams;

  it('opens Data Entry on the pair in the grid\'s year', () => {
    expect(links.dataEntry.startsWith('/data-entry?')).toBe(true);
    const q = query(links.dataEntry);
    expect([q.get('subsidiaryId'), q.get('category'), q.get('year')]).toEqual([id, 'Natural Gas', '2026']);
    expect(q.has('tab')).toBe(false);
  });

  it('opens Emissions on its History tab, filtered by the same reporting-context keys', () => {
    expect(links.history.startsWith('/emissions?')).toBe(true);
    const q = query(links.history);
    expect([q.get('subsidiaryId'), q.get('category'), q.get('year'), q.get('tab')]).toEqual([id, 'Natural Gas', '2026', 'history']);
    expect(initialEmissionsTab(q)).toBe('history');
  });

  it('Emissions honours only tab=history', () => {
    expect(initialEmissionsTab(new URLSearchParams(''))).toBe('summary');
    expect(initialEmissionsTab(new URLSearchParams('tab=trends'))).toBe('summary');
    expect(initialEmissionsTab(new URLSearchParams('tab=HISTORY'))).toBe('summary');
  });
});

describe("matrixColumns and cellsByColumn (inc26: a standard user's rows hold only the categories it may see)", () => {
  const cell = (category: string) => ({ category }) as unknown as TrackingMatrixRow["cells"][number];
  const row = (id: string, categories: string[]) =>
    ({ subsidiaryId: id, cells: categories.map(cell) }) as unknown as TrackingMatrixRow;

  it("lists the categories any row holds, in the product's order", () => {
    expect(matrixColumns([row("a", ["Fuel", "Electricity"]), row("b", ["Water"])])).toEqual(["Electricity", "Fuel", "Water"]);
  });

  it("keeps the full list for a matrix with no row", () => {
    expect(matrixColumns([])).toEqual([...CATEGORIES]);
  });

  it("places each cell under its column and leaves a hidden category blank", () => {
    const columns = matrixColumns([row("a", ["Electricity"]), row("b", ["Fuel"])]);
    expect(cellsByColumn(row("a", ["Electricity"]), columns).map((c) => c?.category ?? null)).toEqual(["Electricity", null]);
    expect(cellsByColumn(row("b", ["Fuel"]), columns).map((c) => c?.category ?? null)).toEqual([null, "Fuel"]);
  });
});

describe("completionRate (owner's review: no NaN % for a company with no visible category)", () => {
  it("is a whole percentage of the categories the row holds", () => {
    expect(completionRate({ completeCount: 1, categoryCount: 3 })).toBe(33);
    expect(completionRate({ completeCount: 0, categoryCount: 2 })).toBe(0);
  });
  it("is null — not applicable — when the row holds no category", () => {
    expect(completionRate({ completeCount: 0, categoryCount: 0 })).toBeNull();
  });
});

describe("emptyInvoiceGridKey (owner's review: a reader's access is not the company's measurement)", () => {
  it("explains a subsidiary measured as a whole", () => {
    expect(emptyInvoiceGridKey("subsidiary")).toBe("grid.wholeCompany");
  });
  it("explains a location-measured subsidiary whose invoice categories the reader is not granted", () => {
    expect(emptyInvoiceGridKey("location")).toBe("grid.noVisibleCategory");
  });
});

describe("matrixToSubsidiaries — a row with nothing the reader may see is not a measured 0 (owner's review)", () => {
  it("marks a row with no Scope 1 or 2 cell as not covered, and a row with one as covered", () => {
    const empty = { subsidiaryId: "a", subsidiaryName: "A", sector: null, designatedPerson: null, totalTCo2e: 0, completeCount: 0, categoryCount: 0, trackingGranularity: "subsidiary", locationCount: 0, uncalculatedRecordCount: 0, cells: [] };
    const covered = { ...empty, subsidiaryId: "b", categoryCount: 1, cells: [{ category: "Electricity", scope: 2, status: "complete", tCo2e: 5, lastUpdate: null }] };
    const [a, b] = matrixToSubsidiaries({ reportingYear: 2026, rows: [empty, covered], totals: { complete: 1, incomplete: 0, missing: 0 } } as never);
    expect(a.emissionsNotCovered).toBe(true);
    expect(b.emissionsNotCovered).toBe(false);
    expect(b.totalEmissions).toBe(5);
  });
});


describe("reportingCompanies — the dashboard's reporting set (inc26-group-tree)", () => {
  it('keeps the holding and the companies, never a sector group or an associate', () => {
    const list = [
      { id: 'h', nodeType: 'holding' as const, control: 'controlled' as const },
      { id: 'g', nodeType: 'sector_group' as const, control: 'controlled' as const },
      { id: 'a', nodeType: 'company' as const, control: 'controlled' as const },
      { id: 'x', nodeType: 'company' as const, control: 'associate' as const },
    ];
    expect(reportingCompanies(list).map((s) => s.id)).toEqual(['h', 'a']);
  });
});
