import { contextLabels } from './context-labels';
import type { ReportData, ReportFactorRow } from './report-data';
import { CATEGORY_SCOPE_MAP, recordActivityTypesFor, REPORT_COVERAGE_GAP_CODES } from '@tonyai/shared-types';
import {
  esc,
  pdfLedgerHeadRow,
  pdfLedgerRow,
  pdfWithdrawnHeadRow,
  pdfWithdrawnRow,
  pdfWithdrawnTotalRow,
} from './report-columns';
import { coverageGapLabel } from '../report-issuances/issuance-html';
import { reportVocabulary, type ReportVocabulary } from './report-vocabulary';

/**
 * Branded, self-contained HTML for the LIVE PDF (FR §5.1; LP4-03). Pure function
 * of the assembled data — no I/O — so it is unit-testable without Puppeteer.
 * Puppeteer renders this via `page.setContent` (no web route, no auth replay).
 *
 * Live, and it says so on its first line: every figure is as of the snapshot
 * it was read in, and the badge is review status, never a certification (K3).
 * In the report's language (D16, K6): every word goes through the vocabulary,
 * every user string through `esc`.
 */

const STATUS_COLOR: Record<string, string> = {
  approved: '#059669',
  draft: '#2563eb',
  contains_incomplete_data: '#d97706',
};
const STATUS_KEY = {
  approved: 'statusApproved',
  draft: 'statusDraft',
  contains_incomplete_data: 'statusIncomplete',
} as const;

/** The review badge's words (K3): review status, never a certification. */
export function statusLabel(status: ReportData['status'], v: ReportVocabulary): string {
  return v.text(STATUS_KEY[status]);
}

/** "Fuel (Diesel)" for a typed factor, the category alone otherwise. */
function categoryWithActivityLabel(f: ReportFactorRow, v: ReportVocabulary): string {
  const activity = f.activityType ? v.activityType({ category: f.category, activityType: f.activityType }) : '';
  // An implicit category's own type adds nothing ("Electricity (Grid electricity)").
  return activity && recordActivityTypesFor(f.category).length > 0
    ? `${v.category(f.category)} (${activity})`
    : v.category(f.category);
}

/**
 * What the report may say about its factors — asked of every calculated
 * figure's snapshot (`isAuthoritativeSnapshot`, the whole path), never stated
 * as a fixed sentence (LP3-03, obligation 2). Before LP4-02 loads authoritative
 * releases, every figure is a placeholder's and the note says so. Standing is
 * stated now; the figure is not recalculated (historic calculations are
 * immutable) — a correction is a restatement.
 */
function factorNote(data: ReportData, v: ReportVocabulary): string {
  if (data.calculatedRecords === 0) return v.html('factorNoneCalculated');
  // The appendix is optional (`includeMethodologyNotes`): point at it only
  // when it is there.
  const where = data.includeMethodologyNotes ? v.text('factorWhere') : '';
  if (data.nonAuthoritativeRecords === 0) return v.html('factorAllAuthoritative', { where });
  const n = data.nonAuthoritativeRecords;
  // "Factor paths": a figure can rest on an authoritative factor reached
  // through a non-authoritative conversion, or on a release withdrawn since.
  const subject = n === data.calculatedRecords
    ? v.text('factorSubjectAll')
    : v.text('factorSubjectSome', { count: n, calculated: data.calculatedRecords });
  return v.html('factorNotAuthoritative', { subject, standingAsOf: v.text('standingAsOf'), where });
}

/** The live coverage in plain sentences (K3): what the year's boundary says, as of the snapshot. */
export function coverageSentences(data: Pick<ReportData, 'coverage' | 'year'>, v: ReportVocabulary): string[] {
  const c = data.coverage;
  if (c.state === 'no_boundary') return [v.text('coverageNoBoundary', { year: data.year })];
  if (c.state === 'not_readable') return [v.text('coverageNotReadable', { year: data.year })];
  if (c.state === 'not_covered') return [v.text('coverageNotCovered')];
  if (c.state === 'too_broad') return [v.text('coverageTooBroad')];
  const decision = c.boundary.decision === 'confirmed'
    ? v.text('decisionConfirmed')
    : c.boundary.frozen ? v.text('decisionUnconfirmed') : v.text('decisionOpen');
  const head = v.text('coverageAssessed', {
    version: c.boundary.version,
    decision,
    extract: c.selection === 'extract' ? 'true' : 'false',
    satisfied: c.satisfiedObligationCount,
    total: c.obligationCount,
    excluded: c.excludedSourceCount,
  });
  const gaps = REPORT_COVERAGE_GAP_CODES.filter((code) => (c.gapCounts[code] ?? 0) > 0)
    .map((code) => v.text('coverageGap', { label: coverageGapLabel(code, v.locale), count: c.gapCounts[code] ?? 0 }));
  if (c.reading === 'complete') return [head, v.text('coverageComplete')];
  if (c.reading === 'nothing_included') return [head, v.text('coverageNothingIncluded')];
  const gapSentence = gaps.length > 0 ? [v.text('coverageGaps', { gaps: gaps.join('; ') })] : [];
  // Outside the boundary, and still every gap counted (`architect` re-review P3-1).
  if (c.reading === 'outside_boundary') return [head, v.text('coverageOutsideBoundary', { year: data.year }), ...gapSentence];
  return [head, ...gapSentence];
}

function coverageHtml(data: ReportData, v: ReportVocabulary): string {
  const [head, ...rest] = coverageSentences(data, v);
  return `<p>${esc(head ?? '')}</p>${rest.map((s) => `<p class="note">${esc(s)}</p>`).join('')}`;
}

/** Does a selection read Scope 3 alone — `scope=3`, or a Scope 3 category with no scope? */
export function selectsScope3Only(context: ReportData['context']): boolean {
  return context.scope === 3 || (context.category !== undefined && CATEGORY_SCOPE_MAP[context.category] === 3);
}

export function buildReportHtml(data: ReportData): string {
  const v = reportVocabulary(data.language);
  const color = STATUS_COLOR[data.status];
  const isDetail = data.template === 'ghg_protocol_detail';
  const scope3Only = selectsScope3Only(data.context);
  const tonnes = (n: number) => `${v.number.format(n)} tCO₂e`;

  const categoryRows = data.summary.byCategory
    .map(
      (c) => `<tr><td>${esc(v.category(c.category))}</td><td>${esc(v.text('tileScope', { scope: c.scope }))}</td>
        <td class="num">${v.number.format(c.tCo2e)}</td><td class="num">${v.number.format(c.percentOfTotal)}%</td>
        <td class="num">${c.recordCount}</td></tr>`,
    )
    .join('');

  const subsidiaryRows = data.summary.bySubsidiary
    .map(
      (r) => `<tr><td>${esc(r.subsidiaryName)}</td>
        <td class="num">${v.number.format(r.tCo2e)}</td><td class="num">${v.number.format(r.percentOfTotal)}%</td>
        <td class="num">${r.recordCount}</td></tr>`,
    )
    .join('');

  const ledgerRows = isDetail ? data.records.map((r) => pdfLedgerRow(r, v)).join('') : '';

  const factorRows = data.factors
    .map(
      (f) => `<tr><td>${esc(categoryWithActivityLabel(f, v))}</td><td>${esc(f.geographyCode)}</td>
      <td class="num">${f.factorValue} ${esc(f.factorUnit)}</td><td>${esc(f.methodology)}</td>
      <td>${esc(f.source)}</td><td>${esc(f.release)} (${esc(f.version)})</td><td>${esc(f.standing)}</td></tr>${
        f.conversionBasis
          ? `<tr><td colspan="7" class="note">${v.html('unitConversion', { basis: f.conversionBasis })}</td></tr>`
          : ''
      }`,
    )
    .join('');

  // Every cell here is user-authored — a site name and a free-text reason of up
  // to 2,000 characters — so all of it goes through `esc`.
  const withdrawnRows = data.withdrawn.map((r) => pdfWithdrawnRow(r, v)).join('');

  const evidenceRows = data.evidenceSummary
    .map(
      (e) => `<tr><td>${esc(e.subsidiaryName)}</td><td>${esc(v.category(e.category))} · ${esc(v.period(e.periodValue))}</td>
      <td class="num">${e.fileCount}</td><td>${e.fileNames
        .map((name, i) => {
          const others = e.alsoBacks[i] ?? 0;
          const here = e.alsoBacksHere[i] ?? 0;
          return others > 0
            ? `${esc(name)} <span class="note">${v.html('alsoBacks', {
                others,
                here: here === others ? v.text('alsoBacksAll') : here,
              })}</span>`
            : esc(name);
        })
        .join(', ')}</td></tr>`,
    )
    .join('');

  const th = (label: string, num = false) => `<th${num ? ' class="num"' : ''}>${esc(v.label(label))}</th>`;
  const scopeTile = (scope: 1 | 2, value: number) => `<div class="tile"><div class="l">${v.html('tileScope', { scope })}</div><div class="v">${
    scope3Only ? v.html('notCovered') : esc(tonnes(value))}</div></div>`;
  const s3 = data.scope3;

  return `<!DOCTYPE html><html lang="${data.language}"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #1d1d1f; padding: 40px 48px; font-size: 12px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #059669; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 22px; color: #059669; } h2 { font-size: 14px; margin: 24px 0 8px; color: #1d1d1f; }
  .meta { text-align: right; color: #6e6e73; font-size: 11px; line-height: 1.6; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; color: #fff; font-weight: 600; font-size: 11px; background: ${color}; }
  .live { border: 1.5px dashed #b45309; color: #92400e; background: #fffbeb; border-radius: 8px; padding: 8px 12px; margin: 0 0 16px; font-weight: 600; }
  .tiles { display: flex; gap: 12px; margin: 16px 0; }
  .tile { flex: 1; border: 1px solid #e5e5ea; border-radius: 10px; padding: 12px 16px; }
  .tile .v { font-size: 20px; font-weight: 700; } .tile .l { color: #6e6e73; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6e6e73; border-bottom: 1.5px solid #d2d2d7; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f2; }
  /* Opt-in per column, via PdfSlot.brk -- never on every td. A 36-char UUID is
     one unbreakable token (~227px) with nowhere to wrap, so without this the
     withdrawn table's eighth column widens off the A4 page; but applied
     globally, overflow-wrap also feeds the table layout algorithm a smaller
     min-content width and silently narrows other columns (measured: the
     ledger's Status column went 67px to 57px, where approved stops fitting on
     one line). All three declarations were measured on a real render: bare
     overflow-wrap collapses this column to its 1-char min-content -- 47px, the
     id in nine short lines -- so min-width holds it open, and 10px, the size
     the report already uses for its notes and headers, is the reading this
     column deserves: a machine identifier a verifier copies, not prose. The
     width it gives back goes to Reason, which is free text. (No backticks in
     this block: it lives inside a template literal, and one would close it.) */
  .brk { font-size: 10px; min-width: 76px; }
  /* The break itself is on the CELL only. On the <th> it split the heading
     mid-word (WITHDRAW / N BY) -- the label is prose and wraps at its space
     like every other heading; it is the value below it that has no space. */
  td.brk { overflow-wrap: anywhere; } .num { text-align: right; font-variant-numeric: tabular-nums; }
  .warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; border-radius: 8px; padding: 10px 14px; margin: 12px 0; }
  .note { color: #6e6e73; font-size: 10px; margin-top: 4px; }
  footer { margin-top: 28px; border-top: 1px solid #e5e5ea; padding-top: 10px; color: #6e6e73; font-size: 10px; }
  </style></head><body>
  <div class="live">${v.html('liveBanner', { readAt: data.generatedAt })}</div>
  <header>
    <div>
      <h1>${esc(data.organisationName)}</h1>
      <div>${esc(data.templateName)} · ${v.html('reportingYear', { year: data.year })}${data.subsidiaryName ? ` · ${esc(data.subsidiaryName)}` : ''}</div>
      ${contextLabels(data.context, data.subsidiaryName, data.language).map(([label, value]) => `<div>${esc(label)}: ${esc(value)}</div>`).join('')}
    </div>
    <div class="meta">
      <span class="badge">${esc(statusLabel(data.status, v))}</span><br/>
      ${v.html('generatedAt', { at: data.generatedAt })}<br/>${v.html('generatedBy', { email: data.generatedBy })}
    </div>
  </header>

  ${
    data.incompleteRatio > 0.15
      ? `<div class="warn"><strong>${v.html('dataWarningLabel')}</strong> ${v.html('dataWarning', { percent: v.number.format(data.incompleteRatio * 100) })}</div>`
      : ''
  }

  <div class="tiles">
    ${scopeTile(1, data.summary.totals.scope1)}
    ${scopeTile(2, data.summary.totals.scope2)}
    <div class="tile"><div class="l">${v.html('tileTotal')}</div><div class="v">${scope3Only ? v.html('notCovered') : esc(tonnes(data.summary.totals.total))}</div></div>
    <div class="tile"><div class="l">${v.html('tileCommitted')}</div><div class="v">${data.summary.recordCount}</div></div>
  </div>
  ${
    data.summary.uncalculatedRecordCount > 0
      ? `<p class="note">${v.html(
          'uncalculatedNote',
          { total: data.summary.recordCount, notCalculated: v.notCalculated },
          { uncalculated: `<strong>${data.summary.uncalculatedRecordCount}</strong>` },
        )}</p>`
      : ''
  }
  ${
    data.withdrawn.length > 0
      ? `<div class="warn"><strong>${v.html('restatementLabel')}</strong> ${v.html(
          'restatementWithdrawn',
          { count: data.withdrawnTotals.count },
          { tonnes: `<strong>${esc(tonnes(data.withdrawnTotals.tCo2e))}</strong>` },
        )}${
          data.withdrawnTotals.uncalculatedCount > 0
            ? ` ${v.html('restatementUncalculated', { count: data.withdrawnTotals.uncalculatedCount })}`
            : ''
        } ${v.html('restatementListed', { count: data.withdrawnTotals.count })}</div>`
      : ''
  }
  <p class="note">${v.html('scope3NotCovered')}${
    s3.recordCount > 0 ? ` ${v.html('scope3Recorded', { count: s3.recordCount, tonnes: v.number.format(s3.calculatedTCo2e) })}` : ''
  } ${factorNote(data, v)}</p>

  <h2>${v.html('coverageHeading')}</h2>
  ${coverageHtml(data, v)}

  <h2>${v.html('categoryHeading')}</h2>
  <table><thead><tr>${th('Category')}${th('Scope')}${th('tCO₂e', true)}${th('% of total', true)}${th('Records', true)}</tr></thead>
  <tbody>${categoryRows || `<tr><td colspan="5">${v.html('noCommittedData')}</td></tr>`}</tbody></table>

  <h2>${v.html('subsidiaryHeading')}</h2>
  <table><thead><tr>${th('Subsidiary')}${th('tCO₂e', true)}${th('% of total', true)}${th('Records', true)}</tr></thead>
  <tbody>${subsidiaryRows || `<tr><td colspan="4">${v.html('noCommittedData')}</td></tr>`}</tbody></table>

  ${
    isDetail
      ? `<h2>${v.html('ledgerHeading')}</h2>
  <table><thead>${pdfLedgerHeadRow(v)}</thead>
  <tbody>${ledgerRows}</tbody></table>`
      : ''
  }

  ${
    // Deliberately NOT gated on `isDetail`, unlike the ledger above it: a
    // restatement is a disclosure, not a detail appendix, and the template a
    // board actually reads is the Executive Summary. Hiding it there would
    // recreate the omission this section exists to end.
    data.withdrawn.length > 0
      ? `<h2>${v.html('withdrawnHeading')}</h2>
  <p class="note">${v.html('withdrawnNote')}</p>
  <table><thead>${pdfWithdrawnHeadRow(v)}</thead>
  <tbody>${withdrawnRows}${pdfWithdrawnTotalRow(data.withdrawnTotals, v)}</tbody></table>`
      : ''
  }

  ${
    data.includeMethodologyNotes
      ? `<h2>${v.html('methodologyHeading')}</h2>
  <p class="note">${v.html('methodologyNote', { standingAsOf: v.text('standingAsOf') })}</p>
  <table><thead><tr>${th('Category')}${th('Geography')}${th('Factor', true)}${th('Methodology')}${th('Source')}${th('Release')}${th('Standing')}</tr></thead>
  <tbody>${factorRows}</tbody></table>`
      : ''
  }

  ${
    data.includeEvidenceSummary && evidenceRows
      ? `<h2>${v.html('evidenceHeading')}</h2>
  <p class="note">${v.html('evidenceNote', { count: data.evidenceFileTotal })}</p>
  <table><thead><tr>${th('Subsidiary')}${th('Record')}${th('Files', true)}${th('File names')}</tr></thead>
  <tbody>${evidenceRows}</tbody></table>`
      : ''
  }

  <footer>${v.html('footer', {
    template: data.templateName,
    year: data.year,
    statuses: data.summary.statusesIncluded.join(', '),
  })}</footer>
  </body></html>`;
}
