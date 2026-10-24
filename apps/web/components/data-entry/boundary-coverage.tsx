'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CoverageCard, CoverageUnavailable } from '@/components/reports/coverage-card';
import { withPreviewRetry } from '@/lib/report-preview';
import type { ReportLiveCoverage } from '@/lib/types';

/**
 * Data Entry's view of the year's inventory boundary for the selected
 * subsidiary (LP4-03 K9): the same card the Reports preview and the dashboard
 * draw, from the same snapshot read. Beside — never instead of — the invoice
 * panel above it: that one counts what is keyed in; this one says what the
 * boundary still expects. For a user granted part of an organisation whose
 * boundary declares other subsidiaries too, the answer is `not_readable` and
 * the card says so (follow-up (1), Decisions 2026-10-24: option A).
 *
 * A failed read says the coverage is unavailable — never leaves the card out.
 */
export function BoundaryCoverage({
  subsidiaryId,
  reportingYear,
  refreshKey,
}: {
  subsidiaryId: string;
  reportingYear: number;
  refreshKey: number;
}) {
  // Kept with the subsidiary it describes: a switch bumps `refreshKey` only once
  // the new records load, so until then (or for good, if they fail) the old
  // subsidiary's card must not stand under the new one's header (`qa-auditor` P2-2).
  const [read, setRead] = useState<{ subsidiaryId: string; coverage: ReportLiveCoverage | 'unavailable' } | null>(null);
  const coverage = read?.subsidiaryId === subsidiaryId ? read.coverage : null;

  useEffect(() => {
    if (!subsidiaryId) return;
    let cancelled = false;
    setRead(null);
    // A save refreshes the panel while the previous read may still hold this
    // user's one preview permit: retried once, then said to be unavailable.
    withPreviewRetry(() => api.reportingMeta({ year: reportingYear, subsidiaryId }), () => !cancelled)
      .then((m) => !cancelled && setRead({ subsidiaryId, coverage: m.data.coverage }))
      .catch(() => !cancelled && setRead({ subsidiaryId, coverage: 'unavailable' }));
    return () => {
      cancelled = true;
    };
    // `refreshKey` alone drives the refetch, as the invoice panel's (a
    // subsidiary switch bumps it too).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportingYear, refreshKey]);

  if (!subsidiaryId || coverage === null) return null;
  if (coverage === 'unavailable') return <CoverageUnavailable />;
  return <CoverageCard coverage={coverage} year={reportingYear} />;
}
