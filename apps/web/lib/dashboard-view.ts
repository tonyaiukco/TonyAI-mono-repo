// Maps live API DTOs onto the dashboard's mock-era view models.
//
// The list of consumers has shrunk: `TrackingMatrix`, `StatusCell` and
// `SubsidiaryDetail` now read the contract directly, because WP17's per-cell
// `coverage` and per-row `trackingGranularity` died at this boundary. What is
// still mapped here is what `EmissionsCharts` (matrixToSubsidiaries),
// `KPICards` (buildKpiData) and `AlertsPanel` (matrixToAlerts) consume.
// Retiring the remaining three view models is a separate change.
import type {
  Alert,
  CategoryData,
  EmissionsSummary,
  KPIData,
  Subsidiary,
  TrackingMatrixDTO,
  TrackingMatrixRow,
} from "@/lib/types";

/**
 * A subsidiary's Scope 1 + 2 total, as the headline and every report count it
 * (LP4-03 K4). The row's own `totalTCo2e` also sums its Scope 3 cells, so the
 * table, the bar chart and the detail drawer would otherwise add up to more
 * than the dashboard's Total (`architect` P1 on LP4-03 PR B).
 *
 * `null` when the row holds no Scope 1 or 2 cell — the matrix keeps only the
 * selection's categories, so a Scope 3 selection excluded them: not covered,
 * never a measured 0 (Codex B9 P2-2 on PR B).
 */
export function scope12Total(row: TrackingMatrixRow): number | null {
  const covered = row.cells.filter((cell) => cell.scope !== 3);
  if (covered.length === 0) return null;
  return covered.reduce((sum, cell) => sum + (cell.tCo2e ?? 0), 0);
}

function rowToViewModel(row: TrackingMatrixRow): Subsidiary {
  const categories: CategoryData[] = row.cells.map((cell) => ({
    category: cell.category,
    status: cell.status,
    lastUpdate: cell.lastUpdate,
    responsible: row.designatedPerson ?? "—",
    // Show the committed tCO₂e figure inside the cell when there is one
    // (rounded — StatusCell prints sub-1000 values verbatim).
    //
    // Keyed on `!== null`, not `> 0`. The old test conflated three different
    // states — no records, a factor-less record, and a genuine zero — and the
    // last of those is a real measurement that was being hidden. `null` now
    // means "nothing produced a figure" and the API says so explicitly.
    calculationComplete: cell.tCo2e !== null,
    emission: cell.tCo2e !== null ? Math.round(cell.tCo2e) : null,
  }));

  return {
    id: row.subsidiaryId,
    name: row.subsidiaryName,
    shortName: row.subsidiaryName,
    sector: row.sector ?? "—",
    // 0 for a row the selection leaves uncovered: the chart is told so on its
    // own (`notCovered`) and draws no bar at all.
    totalEmissions: scope12Total(row) ?? 0,
    completionRate: Math.round((row.completeCount / row.categoryCount) * 100),
    categories,
  };
}

/** Tracking-matrix rows → the mock-era Subsidiary view model. */
export function matrixToSubsidiaries(matrix: TrackingMatrixDTO): Subsidiary[] {
  return matrix.rows.map(rowToViewModel);
}

/**
 * Live KPIData for the Emissions Overview cards.
 * Trends are null (no prior-year data yet) — the cards render "—" for them.
 * `totalLocations` comes from GET /kpi (null while it hasn't loaded).
 */
export function buildKpiData(
  summary: EmissionsSummary,
  matrix: TrackingMatrixDTO,
  totalLocations: number | null,
): KPIData {
  const { complete, incomplete, missing } = matrix.totals;
  const cellCount = complete + incomplete + missing;
  return {
    totalSubsidiaries: matrix.rows.length,
    totalLocations,
    completedCategories: complete,
    incompleteCategories: incomplete,
    missingCategories: missing,
    // Scope 1 + 2, as every report prints it (LP4-03 K4): Scope 3 is recorded,
    // shown on its own card, and not covered by the inventory.
    totalEmissions: summary.totals.scope1 + summary.totals.scope2,
    calculationCompletionRate:
      cellCount > 0 ? Math.round((complete / cellCount) * 100) : 0,
    emissions: {
      scope1: summary.totals.scope1,
      scope2: summary.totals.scope2,
      scope3: summary.totals.scope3,
      total: summary.totals.scope1 + summary.totals.scope2,
      scope1Trend: null,
      scope2Trend: null,
      scope3Trend: null,
      totalTrend: null,
    },
  };
}

/** Real action items: one warning per anomaly-flagged matrix cell. */
export function matrixToAlerts(matrix: TrackingMatrixDTO): Alert[] {
  const alerts: Alert[] = [];
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      if (!cell.anomaly) continue;
      alerts.push({
        id: `${row.subsidiaryId}-${cell.category}`,
        type: "warning",
        message: `Anomaly flag on ${cell.category} records — review the variance reason`,
        subsidiary: row.subsidiaryName,
        category: cell.category,
        timestamp: cell.lastUpdate ?? new Date().toISOString(),
      });
    }
  }
  return alerts;
}
