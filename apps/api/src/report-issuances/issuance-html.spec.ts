import { describe, expect, it } from 'vitest';
import type { ReportDataset } from '@tonyai/shared-types';
import { complete, SUB } from '../../test/boundary-fixtures';
import { allExcludedBoundary, datasetOf, frozenBoundary, fullYear, priced, record, release, standing, UNCALCULATED } from '../../test/issuance-fixtures';
import { deriveIssuance } from './issuance-gate';
import { buildIssuanceHtml, ISSUANCE_CATALOGUES, ISSUANCE_RENDERER, type IssuanceDocument } from './issuance-html';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/**
 * The issued PDF's HTML (LP3-04 PR D; D16, D20): a pure function of the
 * retained dataset and the gate's result — escaped, actor-free, never a 0
 * for a figure the dataset does not hold, in the issuance's language.
 */

const ISSUANCE_ID = '1550a000-0000-4000-8000-000000000001';

function html(dataset: ReportDataset, over: Partial<IssuanceDocument> = {}): string {
  const derived = deriveIssuance(dataset);
  return buildIssuanceHtml({
    issuanceId: ISSUANCE_ID, dataset, status: derived.status, gaps: derived.gaps, language: 'en',
    template: 'ghg_protocol_detail', options: { includeMethodologyNotes: true, includeEvidenceSummary: true },
    ...over,
  });
}

/** Text a person wrote, in every place the PDF prints one. */
function hostile(): ReportDataset {
  const rows = complete();
  const evil = '<script>alert(1)</script>';
  const boundary = frozenBoundary({
    ...rows,
    subsidiaries: rows.subsidiaries.map((s) => (s.subsidiaryId === SUB ? { ...s, liveName: `Acme ${evil}` } : s)),
    sources: rows.sources.map((s) => (s.id === 'g-2' ? { ...s, name: `Meter ${evil}`, reason: `Billed ${evil}` } : s)),
  });
  const records = fullYear().map((r) => (r.id === 'r-05' ? { ...r, status: 'voided' as const, voidReason: `Dup ${evil}`, voidedBy: 'actor-voided' } : r));
  const evidence = [{
    id: 'ev-1', subsidiaryId: SUB, fileName: `invoice ${evil}.pdf`, mimeType: 'application/pdf', sizeBytes: 10,
    createdAt: '2026-10-15T00:00:00.000Z', contentFingerprint: null, recordIds: ['r-01'],
  }];
  return datasetOf({ boundary, records, evidence });
}

describe('buildIssuanceHtml', () => {
  it('escapes every string a person wrote — names, reasons, file names', () => {
    const page = html(hostile());
    expect(page).not.toContain('<script>');
    expect(page).toContain('Acme &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('Billed &lt;script&gt;');
    expect(page).toContain('Dup &lt;script&gt;');
    expect(page).toContain('invoice &lt;script&gt;');
  });

  it('escapes the rest too — organisation, a cell\'s reason, a unit, a release, an unknown period (`security-rls` F2)', () => {
    const evil = '<img src=x onerror=1>';
    const rows = complete();
    const boundary = frozenBoundary({
      ...rows,
      cells: rows.cells.map((c) => (c.subsidiaryId === SUB && c.category === 'Fuel' ? { ...c, reason: `Cell ${evil}` } : c)),
    });
    const hostileRelease = { ...release('rel-a'), publisher: `Pub ${evil}`, title: `Title ${evil}` };
    const records = fullYear().map((r) => (r.id === 'r-01' ? { ...r, activityUnit: `kWh ${evil}` } : r))
      .map((r) => (r.id === 'r-02' ? { ...r, status: 'voided' as const, periodValue: `Feb ${evil}`, voidReason: 'x' } : r));
    const dataset = { ...datasetOf({ boundary, records, releases: [standing(hostileRelease)] }), organisationName: `Org ${evil}` };
    const page = html(dataset);
    expect(page).not.toContain('<img');
    for (const text of ['Org', 'Cell', 'kWh', 'Pub', 'Title', 'Feb']) expect(page).toContain(`${text} &lt;img src=x onerror=1&gt;`);
  });

  it('prints no actor: the opaque ids of who created, reviewed, voided, locked or decided never appear', () => {
    const page = html(hostile());
    for (const actor of ['actor-created', 'actor-reviewed', 'actor-voided', 'actor-locked', 'actor-decided']) {
      expect(page).not.toContain(actor);
    }
  });

  it('prints a figure the dataset does not hold as "Not calculated", never 0 — and a calculated zero as 0', () => {
    const none = datasetOf({ records: fullYear().map((r) => (r.scope === 1 ? { ...r, calculation: UNCALCULATED } : r)) });
    expect(none.scopes[0].tCo2e).toBeNull();
    const scope1 = (page: string) => page.slice(page.indexOf('Scope 1</div>'), page.indexOf('Scope 2</div>'));
    expect(scope1(html(none))).toContain('<div class="v">Not calculated</div>');
    const zero = datasetOf({ records: fullYear().map((r) => (r.scope === 1 ? { ...r, calculation: priced(0) } : r)) });
    expect(scope1(html(zero))).toContain('<div class="v">0 <span class="u">tCO2e</span></div>');
  });

  it('a final with no included source says so — never "Not calculated" under a final badge (`qa-auditor` P2-1)', () => {
    const dataset = datasetOf({ boundary: allExcludedBoundary(), records: [], locks: [] });
    expect(deriveIssuance(dataset).status).toBe('final');
    for (const template of ['executive_summary', 'ghg_protocol_detail'] as const) {
      const page = html(dataset, { template });
      expect(page).toContain('<div class="v">No included source</div>');
      expect(page).not.toContain('Not calculated');
      expect(page).toContain('This boundary includes no emission source');
      // The exclusions it rests on are in both templates.
      expect(page).toContain('<h2>Named exclusions</h2>');
      expect(page).toContain('<td>No operations</td>');
    }
    // Not on a partial with no obligation either (`qa-auditor` re-review M7).
    const unconfirmed = datasetOf({ boundary: allExcludedBoundary('unconfirmed'), records: [], locks: [] });
    expect(deriveIssuance(unconfirmed).status).toBe('partial');
    expect(html(unconfirmed)).not.toContain('This boundary includes no emission source');
    // A scope with sources but no figure still reads "Not calculated".
    const none = datasetOf({ records: fullYear().map((r) => (r.scope === 1 ? { ...r, calculation: UNCALCULATED } : r)) });
    expect(html(none)).not.toContain('This boundary includes no emission source');
  });

  it('a scope an extract filters out reads "Not in this extract" — never "No included source" (`qa-auditor` re-review P2)', () => {
    const tiles = (page: string) => [...page.matchAll(/<div class="l">Scope (\d)<\/div>\s*<div class="v">([^<]*)/g)].map((m) => [m[1], m[2].trim()]);
    expect(tiles(html(datasetOf({ selection: { scope: 1 } })))).toEqual([['1', '4'], ['2', 'Not in this extract']]);
    expect(tiles(html(datasetOf({ selection: { category: 'Electricity' } })))).toEqual([['1', 'Not in this extract'], ['2', '24']]);
    // A subsidiary extract selects both scopes: each reads its own figure.
    expect(tiles(html(datasetOf({ selection: { subsidiaryId: SUB } })))).toEqual([['1', '4'], ['2', '24']]);
  });

  it('names the issuance, its dataset and the dataset fingerprint', () => {
    const dataset = datasetOf();
    const page = html(dataset);
    expect(page).toContain(ISSUANCE_ID);
    expect(page).toContain(dataset.datasetId);
    expect(page).toContain(`sha256:${dataset.fingerprint.hex}`);
    expect(page).toContain(ISSUANCE_RENDERER);
  });

  it('a final shows its badge and no gap table; a partial its gaps', () => {
    const final = html(datasetOf());
    expect(final).toContain('<span class="badge final">Final</span>');
    expect(final).not.toContain('<h2>What blocks a final report</h2>');
    const partial = html(datasetOf({ locks: [] }));
    expect(partial).toContain('<span class="badge partial">Partial</span>');
    expect(partial).toContain('<h2>What blocks a final report</h2>');
    expect(partial).toContain('<td>Periods not locked</td>');
    // A coverage gap names its own code, entity and category.
    const missing = html(datasetOf({ records: fullYear().filter((r) => r.id !== 'r-02') }));
    expect(missing).toMatch(/<td>Coverage gap: Missing record<\/td>\s*<td>Company sub-a · Site site-1<\/td>\s*<td>Electricity<\/td>/);
  });

  it('the detail template adds the coverage gaps, the counted ledger and the withdrawals', () => {
    const detail = html(hostile());
    const summary = html(hostile(), { template: 'executive_summary' });
    for (const heading of ['Coverage gaps, as captured', 'Counted records', 'Withdrawn records, excluded from every figure']) {
      expect(detail).toContain(`<h2>${heading}</h2>`);
      expect(summary).not.toContain(`<h2>${heading}</h2>`);
    }
    // The excluded meter, with its reason.
    expect(detail).toContain('<td>Meter &lt;script&gt;alert(1)&lt;/script&gt; (Natural Gas)</td>');
  });

  it('prints the methodology and the evidence only when asked', () => {
    const none = html(hostile(), { options: { includeMethodologyNotes: false, includeEvidenceSummary: false } });
    expect(none).not.toContain('<h2>Methodology</h2>');
    expect(none).not.toContain('<h2>Evidence</h2>');
    const both = html(hostile());
    expect(both).toContain('<h2>Methodology</h2>');
    expect(both).toContain('<h2>Evidence</h2>');
  });

  it('a counted figure on a non-authoritative release reads so in the ledger', () => {
    const records = fullYear().map((r) => (r.id === 'r-01' ? record('r-01', { calculation: UNCALCULATED }) : r));
    expect(html(datasetOf({ records }))).toContain('<td>Not calculated</td>');
  });

  it('prints in Turkish, with Turkish number formatting, when issued in Turkish (D16)', () => {
    const records = fullYear().map((r) => (r.id === 'g-Q1' ? { ...r, calculation: priced(1.5) } : r));
    const page = html(datasetOf({ records }), { language: 'tr' });
    expect(page).toContain('<html lang="tr">');
    expect(page).toContain('<span class="badge final">Nihai</span>');
    expect(page).toContain('Kapsam 1');
    expect(page).toContain('4,5');
    expect(page).toContain('Doğal gaz');
    expect(page).toContain('Ocak');
  });
});

describe('the issuance catalogues', () => {
  it('hold the same keys and the same ICU arguments in both languages, translated', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    // A unit symbol reads the same in either language.
    const same = new Set(['colEmissions']);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(tr[key].match(/\{\w+\}/g), key).toEqual(en[key].match(/\{\w+\}/g));
      expect(tr[key].trim(), key).not.toBe('');
      if (!same.has(key)) expect(tr[key], key).not.toBe(en[key]);
    }
    expect(ISSUANCE_CATALOGUES.en).toBe(en);
    expect(ISSUANCE_CATALOGUES.tr).toBe(tr);
  });

  it('carry no invisible or bidirectional characters', () => {
    const invisible = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00a0, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e]
      .map((c) => String.fromCharCode(c)).join('')}]`);
    for (const value of [...Object.values(en), ...Object.values(tr)]) expect(value).not.toMatch(invisible);
  });
});
