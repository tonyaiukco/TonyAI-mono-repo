import { describe, expect, it } from 'vitest';
import type { ReportLedgerRow } from './report-data';
import { csvHeader, csvLedgerRow, excelLedgerHeader, excelLedgerRow, pdfLedgerRow } from './report-columns';
import { reportVocabulary } from './report-vocabulary';

/**
 * LP4-02 PR5, task 5.3, the live reports' row writers: a record's calculation
 * inputs under its quantity in the PDF and in a trailing column elsewhere, and
 * Scope 2's market-based statement on Scope 2 rows only.
 */
const row = (over: Partial<ReportLedgerRow> = {}): ReportLedgerRow => ({
  subsidiaryName: 'Energy', locationId: null, locationName: null,
  category: 'Refrigerants', periodValue: 'Annual', reportingPeriod: 'annual', activityType: 'R-410A',
  factorStanding: null, activityValue: 10, activityUnit: 'kg',
  calculationInputs: 'split klima: 10 kg × %10 + 0,5 kg dolum = 1,5 kg salım',
  calculationInputsCsv: 'split air conditioner: 10 kg × 10% + 0.5 kg refilled = 1.5 kg released',
  tCo2e: 3.384, status: 'approved', evidenceCount: 0, anomalyFlag: false, anomalyEvaluated: false, anomalyBaselinePriorCount: null, anomalyLegacy: false, anomalyCeiling: false,
  ...over,
} as ReportLedgerRow);

const cells = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));

describe('a record\'s calculation inputs and Scope 2\'s method in the live reports (LP4-02 PR5)', () => {
  const tr = reportVocabulary('tr');

  it('prints the inputs under the quantity in the PDF, escaped', () => {
    const html = pdfLedgerRow(row({ calculationInputs: 'a <b> & c' }), tr);
    expect(html).toContain('<br><span class="note">a &lt;b&gt; &amp; c</span>');
    expect(pdfLedgerRow(row({ calculationInputs: '' }), tr)).not.toContain('class="note"');
  });

  it('writes the CSV in English whatever the language, and the statement on Scope 2 rows only', () => {
    const header = csvHeader().split(',');
    const refrigerant = cells(csvLedgerRow(row()));
    expect(refrigerant[header.indexOf('calculation_inputs')]).toBe('split air conditioner: 10 kg × 10% + 0.5 kg refilled = 1.5 kg released');
    expect(refrigerant[header.indexOf('scope2_market_based')]).toBe('');
    const grid = cells(csvLedgerRow(row({ category: 'Electricity', activityType: null, calculationInputs: '', calculationInputsCsv: '' })));
    expect(grid[header.indexOf('scope2_market_based')]).toBe('No market-based result');
  });

  it('writes the inputs and the statement in the workbook\'s language', () => {
    const header = excelLedgerHeader(tr);
    const at = (label: string) => header.indexOf(label);
    const refrigerant = excelLedgerRow(row(), tr);
    expect(refrigerant[at('Hesaplama girdileri')]).toBe('split klima: 10 kg × %10 + 0,5 kg dolum = 1,5 kg salım');
    expect(refrigerant[at('Kapsam 2 piyasa bazlı')]).toBe('');
    const grid = excelLedgerRow(row({ category: 'Electricity', activityType: null }), tr);
    expect(grid[at('Kapsam 2 piyasa bazlı')]).toBe('Piyasa bazlı sonuç bulunmamaktadır');
  });
});
