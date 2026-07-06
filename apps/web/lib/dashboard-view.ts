// Maps live API DTOs onto the dashboard's existing view models so the
// polished components (TrackingMatrix, KPICards, EmissionsCharts,
// AlertsPanel, SubsidiaryDetail) render live data unchanged.
import type {
  Alert,
  CategoryData,
  EmissionsSummary,
  KPIData,
  Subsidiary,
  TrackingMatrixDTO,
  TrackingMatrixRow,
} from "@/lib/types";

function rowToViewModel(row: TrackingMatrixRow): Subsidiary {
  const categories: CategoryData[] = row.cells.map((cell) => ({
    category: cell.category,
    status: cell.status,
    lastUpdate: cell.lastUpdate,
    responsible: row.designatedPerson ?? "—",
    // Show the committed tCO₂e figure inside the cell when there is one
    // (rounded — StatusCell prints sub-1000 values verbatim).
    calculationComplete: cell.tCo2e > 0,
    emission: cell.tCo2e > 0 ? Math.round(cell.tCo2e) : null,
  }));

  return {
    id: row.subsidiaryId,
    name: row.subsidiaryName,
    shortName: row.subsidiaryName,
    sector: row.sector ?? "—",
    totalEmissions: row.totalTCo2e,
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
    totalEmissions: summary.totals.total,
    calculationCompletionRate:
      cellCount > 0 ? Math.round((complete / cellCount) * 100) : 0,
    emissions: {
      scope1: summary.totals.scope1,
      scope2: summary.totals.scope2,
      scope3: summary.totals.scope3,
      total: summary.totals.total,
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
