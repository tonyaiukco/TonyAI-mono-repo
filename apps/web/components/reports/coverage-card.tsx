'use client';

import { useId } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { formatNumber } from '@/lib/i18n/number';
import { coverageLines, COVERAGE_GAP_KEY, type Line } from '@/lib/report-coverage-view';
import type { Locale, ReportLiveCoverage } from '@/lib/types';

/**
 * The coverage card when its read failed (a capacity refusal after its retry,
 * a selection too broad for the preview): unknown, said so — never left out,
 * which would read as "no gaps" (`security-rls` P3-1 on LP4-03 PR B).
 */
export function CoverageUnavailable({ className = '' }: { className?: string }) {
  const t = useTranslations('reports');
  const headingId = useId();
  return (
    <section
      className={`space-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm ${className}`}
      data-testid="coverage-card"
      data-coverage="unavailable"
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="flex items-center gap-2 font-semibold">
        <ShieldQuestion className="h-4 w-4 shrink-0" aria-hidden />
        {t('coverage.heading')}
      </h3>
      <p>{t('coverage.unavailable')}</p>
    </section>
  );
}

/**
 * What the year's inventory boundary says about a selection (LP4-03 K3, K9):
 * the Reports preview, the dashboard and Data Entry draw the same card from
 * `ReportMetaDTO.coverage`. Green only for the one complete reading — and even
 * then it says it certifies nothing.
 */
export function CoverageCard({
  coverage,
  year,
  className = '',
}: {
  coverage: ReportLiveCoverage;
  year: number;
  className?: string;
}) {
  const t = useTranslations('reports');
  const locale = useLocale() as Locale;
  const view = coverageLines(coverage, year);
  const headingId = useId();
  // The catalogue keys are built by the view module; reports.coverage.spec proves each exists.
  const say = (line: Line) => {
    const values = Object.fromEntries(
      Object.entries(line.values ?? {}).map(([k, v]) => [
        k,
        k === 'decision' && typeof v === 'string'
          ? t(v as never)
          // A count is grouped in the locale; a year or a version number never is.
          : typeof v === 'number' && k !== 'year' && k !== 'version' ? formatNumber(v, locale) : v,
      ]),
    );
    return t(line.key as never, values as never);
  };
  const tone = {
    complete: { icon: ShieldCheck, frame: 'border-emerald-300 bg-emerald-50 text-emerald-900' },
    gaps: { icon: ShieldAlert, frame: 'border-amber-300 bg-amber-50 text-amber-900' },
    unknown: { icon: ShieldQuestion, frame: 'border-border bg-muted/40 text-foreground' },
  }[view.tone];
  const Icon = tone.icon;
  return (
    <section
      className={`space-y-2 rounded-lg border px-4 py-3 text-sm ${tone.frame} ${className}`}
      data-testid="coverage-card"
      data-coverage={coverage.state === 'assessed' ? coverage.reading : coverage.state}
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="flex items-center gap-2 font-semibold">
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {t('coverage.heading')}
      </h3>
      {view.lines.map((line) => (
        <p key={line.key}>{say(line)}</p>
      ))}
      {view.gaps.length > 0 && (
        <ul className="list-inside list-disc text-xs" data-testid="coverage-gaps">
          {view.gaps.map((g) => (
            <li key={g.code}>
              {t('coverage.gapCount', { label: t(COVERAGE_GAP_KEY[g.code] as never), count: formatNumber(g.count, locale) })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
