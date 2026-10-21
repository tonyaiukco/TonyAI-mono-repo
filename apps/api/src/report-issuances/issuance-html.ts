import { IntlMessageFormat } from 'intl-messageformat';
import {
  CATEGORY_SCOPE_MAP,
  isCalculated,
  LOCALE_FORMAT_TAGS,
  type Category,
  type InventoryEntitySnapshot,
  type Locale,
  type ReportCoverageGapCode,
  type ReportDataset,
  type ReportDatasetRecord,
  type ReportIssuanceGap,
  type ReportIssuanceGapCode,
  type ReportTemplate,
} from '@tonyai/shared-types';
import { escapeHtmlText as esc } from '../common/html-escape';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/**
 * The issued PDF's HTML (LP3-04 PR D; README "The issuance"; D16). A pure
 * function of the retained dataset and what the gate derived from it — no
 * live read, no clock — so what it prints is what the dataset holds.
 *
 * Every string a person wrote (a subsidiary, site or source name, an
 * exclusion or withdrawal reason, an evidence file name) goes through `esc`,
 * as does every catalogue message once formatted. Actors are never printed —
 * the dataset holds opaque ids only, and the retained bytes cannot be erased
 * (D20). A figure the dataset does not hold is "Not calculated", never 0.
 */

/** The renderer's own version; the issuance records it with the browser's. */
export const ISSUANCE_RENDERER = 'tonyai-issuance-pdf-v1';

export interface IssuanceDocument {
  issuanceId: string;
  dataset: ReportDataset;
  status: 'final' | 'partial';
  gaps: readonly ReportIssuanceGap[];
  language: Locale;
  template: ReportTemplate;
  options: { includeMethodologyNotes: boolean; includeEvidenceSummary: boolean };
}

export type IssuanceMessageKey = keyof typeof en;
export const ISSUANCE_CATALOGUES: Readonly<Record<Locale, Readonly<Record<IssuanceMessageKey, string>>>> = { en, tr };

const GAP_LABEL: Record<ReportIssuanceGapCode, IssuanceMessageKey> = {
  filtered_extract: 'gapFilteredExtract',
  coverage_gap: 'gapCoverageGap',
  unapproved_record: 'gapUnapprovedRecord',
  unlocked_period: 'gapUnlockedPeriod',
  non_authoritative_calculation: 'gapNonAuthoritativeCalculation',
  gwp_set_mismatch: 'gapGwpSetMismatch',
};

const COVERAGE_LABEL: Record<ReportCoverageGapCode, IssuanceMessageKey> = {
  boundary_unconfirmed: 'covBoundaryUnconfirmed',
  applicability_undetermined: 'covApplicabilityUndetermined',
  unsupported_source: 'covUnsupportedSource',
  missing_record: 'covMissingRecord',
  missing_evidence: 'covMissingEvidence',
  attribution_conflict: 'covAttributionConflict',
  overlapping_periods: 'covOverlappingPeriods',
  unmapped_record: 'covUnmappedRecord',
};

const STANDING_LABEL: Record<string, IssuanceMessageKey> = {
  authoritative: 'standingAuthoritative',
  non_authoritative: 'standingNonAuthoritative',
  uncalculated: 'standingUncalculated',
  legacy: 'standingLegacy',
};

const RECORD_STATUS_LABEL: Record<string, IssuanceMessageKey> = {
  submitted: 'recordSubmitted',
  under_review: 'recordUnderReview',
  approved: 'recordApproved',
  locked: 'recordLocked',
};

const RELEASE_LABEL: Record<string, IssuanceMessageKey> = {
  authoritative: 'releaseAuthoritative',
  placeholder: 'releasePlaceholder',
  fixture: 'releaseFixture',
  withdrawn: 'releaseWithdrawn',
};

const PERIOD_ORDER = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November',
  'December', 'Q1', 'Q2', 'Q3', 'Q4', 'Annual',
];

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The catalogue's message for `key`, formatted and escaped. */
function translator(locale: Locale) {
  const messages = ISSUANCE_CATALOGUES[locale];
  const tag = LOCALE_FORMAT_TAGS[locale];
  return (key: IssuanceMessageKey, values?: Record<string, string | number>): string =>
    esc(String(new IntlMessageFormat(messages[key], tag).format(values)));
}

export function buildIssuanceHtml(doc: IssuanceDocument): string {
  const { dataset, language } = doc;
  const t = translator(language);
  const tag = LOCALE_FORMAT_TAGS[language];
  const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 3 });
  const date = new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
  const isDetail = doc.template === 'ghg_protocol_detail';
  const final = doc.status === 'final';

  const label = (prefix: 'category' | 'period', value: string): string => {
    const key = `${prefix} ${value}` as IssuanceMessageKey;
    return key in ISSUANCE_CATALOGUES[language] ? t(key) : esc(value);
  };
  const entityName = new Map<string, InventoryEntitySnapshot>(
    dataset.boundary.entities.map((e) => [JSON.stringify([e.subsidiaryId, e.locationId]), e]),
  );
  const entityLabel = (subsidiaryId: string, locationId: string | null, fallback?: { subsidiaryName: string; locationName: string | null }): string => {
    const e = entityName.get(JSON.stringify([subsidiaryId, locationId]));
    const subsidiary = e?.subsidiaryName ?? fallback?.subsidiaryName ?? subsidiaryId;
    const location = locationId === null ? null : (e?.locationName ?? fallback?.locationName ?? locationId);
    return esc(location === null ? subsidiary : `${subsidiary} · ${location}`);
  };
  const companyName = (subsidiaryId: string): string =>
    esc(entityName.get(JSON.stringify([subsidiaryId, null]))?.subsidiaryName ?? subsidiaryId);
  const tonnes = (value: number | null): string => (value === null ? t('notCalculated') : number.format(value));

  // --- Header and status
  const title = doc.template === 'executive_summary' ? t('titleExecutiveSummary') : t('titleGhgProtocolDetail');
  const filters = [
    dataset.context.subsidiaryId === undefined ? null : t('filterSubsidiary', { name: companyNameText(dataset, dataset.context.subsidiaryId) }),
    dataset.context.scope === undefined ? null : t('filterScope', { scope: dataset.context.scope }),
    dataset.context.category === undefined ? null : label('category', dataset.context.category),
  ].filter((f): f is string => f !== null);
  const selection = dataset.selection === 'inventory'
    ? t('selectionInventory')
    : `${t('selectionExtract')}${filters.length > 0 ? ` — ${filters.join(', ')}` : ''}`;

  // A coverage gap names its own code, entity and category (as the dataset's).
  const gapLabel = (g: ReportIssuanceGap): string => (g.code === 'coverage_gap' && g.coverageCode !== undefined
    ? `${t('gapCoverageGap')}: ${t(COVERAGE_LABEL[g.coverageCode])}`
    : t(GAP_LABEL[g.code]));
  const gapRows = doc.gaps.map((g) => `<tr><td>${gapLabel(g)}</td>
    <td>${g.entity === undefined ? '' : entityLabel(g.entity.subsidiaryId, g.entity.locationId)}</td>
    <td>${g.category === undefined ? '' : label('category', g.category)}</td>
    <td class="num">${g.sourceIds.length}</td><td class="num">${g.obligationIds.length}</td><td class="num">${g.recordIds.length}</td></tr>`).join('');

  // --- Emissions: the dataset's scope disclosures, as retained. A scope an
  // extract's scope or category filter leaves out reads so (its sources may be
  // included in the boundary); a selected scope with no included obligation
  // has nothing to calculate and reads so, never "Not calculated" (`qa-auditor`
  // P2-1 and its re-review's P2).
  const [scope1, scope2] = dataset.scopes;
  const { scope: onlyScope, category: onlyCategory } = dataset.context;
  const selectedScope = (scope: 1 | 2): boolean =>
    (onlyScope === undefined || onlyScope === scope) && (onlyCategory === undefined || CATEGORY_SCOPE_MAP[onlyCategory] === scope);
  const sourceScope = new Map(dataset.boundary.sources.flatMap((s) => (s.applicability === 'included' ? s.obligations.map((o) => [o.id, s.scope] as const) : [])));
  const scopesWithSources = new Set(dataset.coverage.obligations.map((o) => sourceScope.get(o.obligationId)));
  const tile = (s: typeof scope1 | typeof scope2): string => `<div class="tile">
    <div class="l">${t('scope', { scope: s.scope })}</div>
    <div class="v">${!selectedScope(s.scope) ? t('scopeNotInExtract')
      : s.tCo2e === null && !scopesWithSources.has(s.scope) ? t('scopeNoSource') : tonnes(s.tCo2e)}${s.tCo2e === null ? '' : ' <span class="u">tCO2e</span>'}</div>
    <div class="n">${s.coverage === 'covered' ? t('coverageCovered') : t('coveragePartial')} · ${t('countedRecords', { count: s.countedRecordIds.length })}</div>
  </div>`;

  // --- Detail: coverage gaps, the counted ledger, exclusions, withdrawals.
  const coverageRows = dataset.coverage.gaps.map((g) => `<tr><td>${t(COVERAGE_LABEL[g.code])}</td>
    <td>${g.entity === undefined ? '' : entityLabel(g.entity.subsidiaryId, g.entity.locationId)}</td>
    <td>${g.category === undefined ? '' : label('category', g.category)}</td>
    <td class="num">${g.sourceIds.length}</td><td class="num">${g.obligationIds.length}</td><td class="num">${g.recordIds.length}</td></tr>`).join('');

  const standing = new Map(dataset.provenance.records.map((p) => [p.recordId, p.standing]));
  const counted = new Set(dataset.scopes.flatMap((s) => (s.scope === 3 ? [] : s.countedRecordIds)));
  const ledger = sortRecords(dataset.records.filter((r) => counted.has(r.id)));
  const ledgerRows = ledger.map((r) => `<tr><td>${entityLabel(r.subsidiaryId, r.locationId, r)}</td>
    <td>${label('category', r.category)}</td><td>${label('period', r.periodValue)}</td>
    <td>${RECORD_STATUS_LABEL[r.status] === undefined ? esc(r.status) : t(RECORD_STATUS_LABEL[r.status])}</td>
    <td class="num">${number.format(r.activityValue)} ${esc(r.activityUnit)}</td>
    <td class="num">${isCalculated(r.calculation) ? number.format(r.calculation.tCo2e) : t('notCalculated')}</td>
    <td>${t(STANDING_LABEL[standing.get(r.id) ?? 'uncalculated'])}</td></tr>`).join('');

  const excludedSources = new Set(dataset.coverage.excludedSourceIds);
  const resolved = new Set(dataset.resolvedSubsidiaryIds);
  const exclusionRows = [
    ...dataset.boundary.sources
      .filter((s) => excludedSources.has(s.id) && s.applicability === 'excluded')
      .map((s) => ({
        entity: entityLabel(s.entity.subsidiaryId, s.entity.locationId),
        what: `${esc(s.name)}${s.mapping.kind === 'mapped' ? ` (${label('category', s.mapping.category)})` : ''}`,
        reason: s.applicability === 'excluded' ? esc(s.reason) : '',
      })),
    ...dataset.boundary.applicability
      .filter((c) => c.applicability === 'excluded' && resolved.has(c.subsidiaryId)
        && (dataset.context.category === undefined || c.category === dataset.context.category))
      .map((c) => ({
        entity: entityLabel(c.subsidiaryId, c.locationId),
        what: label('category', c.category),
        reason: c.applicability === 'excluded' ? esc(c.reason) : '',
      })),
  ].map((x) => `<tr><td>${x.entity}</td><td>${x.what}</td><td>${x.reason}</td></tr>`).join('');

  const withdrawn = sortRecords(dataset.records.filter((r) => r.status === 'voided'));
  const withdrawnRows = withdrawn.map((r) => `<tr><td>${entityLabel(r.subsidiaryId, r.locationId, r)}</td>
    <td>${label('category', r.category)}</td><td>${label('period', r.periodValue)}</td>
    <td class="num">${isCalculated(r.calculation) ? number.format(r.calculation.tCo2e) : t('notCalculated')}</td>
    <td class="wrap">${esc(r.voidReason ?? '')}</td></tr>`).join('');

  // --- Options: the releases as they stood at capture; the evidence by name.
  const releaseRows = dataset.provenance.releases.map((r) => `<tr><td>${esc(r.publication.publisher)} — ${esc(r.publication.title)}</td>
    <td>${esc(r.publication.edition)}</td><td>${RELEASE_LABEL[r.status] === undefined ? esc(r.status) : t(RELEASE_LABEL[r.status])}</td></tr>`).join('');
  const evidenceRows = [...dataset.evidence]
    .sort((a, b) => byText(a.fileName, b.fileName) || byText(a.id, b.id))
    .map((e) => `<tr><td class="wrap">${esc(e.fileName)}</td><td>${companyName(e.subsidiaryId)}</td><td class="num">${e.recordIds.length}</td></tr>`)
    .join('');

  const table = (head: string[], rows: string, numeric: number[] = []): string => rows === ''
    ? `<p class="note">${t('none')}</p>`
    : `<table><thead><tr>${head.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

  return `<!DOCTYPE html><html lang="${language}"><head><meta charset="utf-8"><title>${title}</title><style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #1d1d1f; padding: 40px 48px; font-size: 12px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #059669; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; color: #059669; } h2 { font-size: 14px; margin: 24px 0 8px; color: #1d1d1f; }
  .meta { text-align: right; color: #6e6e73; font-size: 11px; line-height: 1.6; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; color: #fff; font-weight: 600; font-size: 11px; }
  .badge.final { background: #059669; } .badge.partial { background: #b45309; }
  .tiles { display: flex; gap: 12px; margin: 16px 0; }
  .tile { flex: 1; border: 1px solid #e5e5ea; border-radius: 10px; padding: 12px 16px; }
  .tile .v { font-size: 20px; font-weight: 700; } .tile .u { font-size: 11px; font-weight: 400; color: #6e6e73; }
  .tile .l, .tile .n { color: #6e6e73; font-size: 10px; } .tile .l { text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6e6e73; border-bottom: 1.5px solid #d2d2d7; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f2; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .wrap { overflow-wrap: anywhere; }
  .note { color: #6e6e73; font-size: 11px; line-height: 1.5; }
  .status { border: 1px solid #e5e5ea; border-radius: 10px; padding: 12px 16px; line-height: 1.5; }
  .identity td:first-child { color: #6e6e73; width: 28%; } .identity td { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; overflow-wrap: anywhere; }
</style></head><body>
<header>
  <div><h1>${title}</h1><p class="note">${esc(dataset.organisationName)}</p></div>
  <div class="meta">${t('reportingYear')}: ${dataset.boundary.reportingYear}<br>
    <span class="badge ${final ? 'final' : 'partial'}">${final ? t('statusFinal') : t('statusPartial')}</span></div>
</header>
<section class="status"><p>${final ? t('statusFinalNote') : t('statusPartialNote', { count: doc.gaps.length })}${
  final && dataset.coverage.obligations.length === 0 ? ` ${t('finalNoSourcesNote')}` : ''}</p></section>
${final ? '' : `<h2>${t('gapsHeading')}</h2>${table([t('colGap'), t('colEntity'), t('colCategory'), t('colSources'), t('colObligations'), t('colRecords')], gapRows, [3, 4, 5])}`}
<h2>${t('emissionsHeading')}</h2>
<div class="tiles">${tile(scope1)}${tile(scope2)}</div>
<p class="note">${t('scope3NotCovered')}</p>
<h2>${t('boundaryHeading')}</h2>
<p>${selection}</p>
<p class="note">${t('boundaryVersion', { version: dataset.boundary.version })} · ${dataset.boundary.decision === 'confirmed' ? t('decisionConfirmed') : t('decisionUnconfirmed')}</p>
<p class="note">${t('subsidiaries')}: ${[...dataset.boundary.subsidiaryIds].map(companyName).sort(byText).join(', ')}</p>
<h2>${t('exclusionsHeading')}</h2>${table([t('colEntity'), t('colSource'), t('colReason')], exclusionRows)}
${isDetail ? `<h2>${t('coverageHeading')}</h2>${table([t('colGap'), t('colEntity'), t('colCategory'), t('colSources'), t('colObligations'), t('colRecords')], coverageRows, [3, 4, 5])}
<h2>${t('ledgerHeading')}</h2>${table([t('colEntity'), t('colCategory'), t('colPeriod'), t('colStatus'), t('colActivity'), t('colEmissions'), t('colStanding')], ledgerRows, [4, 5])}
<h2>${t('withdrawnHeading')}</h2>${table([t('colEntity'), t('colCategory'), t('colPeriod'), t('colEmissions'), t('colReason')], withdrawnRows, [3])}` : ''}
${doc.options.includeMethodologyNotes ? `<h2>${t('methodologyHeading')}</h2><p class="note">${t('methodologyText')}</p>${table([t('colRelease'), t('colEdition'), t('colStanding')], releaseRows)}` : ''}
${doc.options.includeEvidenceSummary ? `<h2>${t('evidenceHeading')}</h2>${table([t('colFile'), t('colEntity'), t('colLinkedRecords')], evidenceRows, [2])}` : ''}
<h2>${t('identityHeading')}</h2>
<table class="identity"><tbody>
  <tr><td>${t('identityIssuance')}</td><td>${esc(doc.issuanceId)}</td></tr>
  <tr><td>${t('identityDataset')}</td><td>${esc(dataset.datasetId)}</td></tr>
  <tr><td>${t('identityFingerprint')}</td><td>${esc(dataset.fingerprint.algorithm)}:${esc(dataset.fingerprint.hex)} (${esc(dataset.fingerprint.canonicalization)})</td></tr>
  <tr><td>${t('identityCaptured')}</td><td>${esc(date.format(new Date(dataset.capturedAt)))} UTC</td></tr>
  <tr><td>${t('identityRenderer')}</td><td>${ISSUANCE_RENDERER}</td></tr>
</tbody></table>
<p class="note">${t('identityNote')}</p>
</body></html>`;
}

/** The plain (unescaped) name of a company entity, for a message argument. */
function companyNameText(dataset: ReportDataset, subsidiaryId: string): string {
  return dataset.boundary.entities.find((e) => e.subsidiaryId === subsidiaryId && e.locationId === null)?.subsidiaryName ?? subsidiaryId;
}

/** By entity, category and period — the order a reader scans a ledger in. */
function sortRecords(records: readonly ReportDatasetRecord[]): ReportDatasetRecord[] {
  const rank = (v: string) => { const i = PERIOD_ORDER.indexOf(v); return i < 0 ? PERIOD_ORDER.length : i; };
  return [...records].sort((a, b) =>
    byText(a.subsidiaryName, b.subsidiaryName)
    || byText(a.locationName ?? '', b.locationName ?? '')
    || byText(a.category as Category, b.category as Category)
    || rank(a.periodValue) - rank(b.periodValue)
    || byText(a.id, b.id));
}
