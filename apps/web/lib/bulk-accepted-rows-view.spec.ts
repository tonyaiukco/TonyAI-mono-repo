import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { AcceptedRows } from '@/components/data-entry/bulk-accepted-rows';
import { MESSAGES } from '@/messages';
import type { BulkUploadAcceptedRow } from '@/lib/types';

describe('accepted-row table', () => {
  it.each(['en', 'tr'] as const)('%s renders every row without folding away its activity identity', (locale) => {
    const rows: BulkUploadAcceptedRow[] = Array.from({ length: 1000 }, (_, i) => ({
      row: i + 2, recordId: null, subsidiaryId: 'entity', locationId: null,
      reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
      category: 'Fuel', activityType: i % 2 ? 'gas_oil' : 'diesel', activityValue: 1200, activityUnit: 'litres', tCo2e: null, anomalous: false,
    }));
    const html = renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale], children: createElement(AcceptedRows, { rows }),
    }));
    expect(html.match(/<tr[ >]/g)).toHaveLength(1001);
    expect(html).toContain(MESSAGES[locale].dataEntry.bulkColumns.activityType);
    expect(html).toContain(MESSAGES[locale].dataEntry.activityTypes.diesel);
    expect(html).toContain(MESSAGES[locale].dataEntry.activityTypes.gas_oil);
    expect(html).toContain(MESSAGES[locale].periods.values.January);
    expect(html).toContain('1001');
  });
});

describe('the amount read (LP4-04, D15)', () => {
  const rows: BulkUploadAcceptedRow[] = [
    { row: 2, recordId: null, subsidiaryId: 'entity', locationId: null, reportingYear: 2026, reportingPeriod: 'monthly',
      periodValue: 'January', category: 'Electricity', activityType: null, activityValue: 1.234, activityUnit: 'kWh', tCo2e: 0.0005, anomalous: false },
    { row: 3, recordId: null, subsidiaryId: 'entity', locationId: null, reportingYear: 2026, reportingPeriod: 'monthly',
      periodValue: 'February', category: 'Fuel', activityType: 'diesel', activityValue: 1234.5, activityUnit: 'litres', tCo2e: 2.3, anomalous: false },
  ];
  const render = (locale: 'en' | 'tr') => renderToStaticMarkup(createElement(IntlProvider, {
    locale, timeZone: 'UTC', messages: MESSAGES[locale], children: createElement(AcceptedRows, { rows }),
  }));
  const amounts = (html: string) => [...html.matchAll(/data-testid="bulk-read-amount">([^<]*)</g)].map((m) => m[1]);

  it('shows a file\'s 1.234 as 1,234 in Turkish — the decimal the server read, not a thousand', () => {
    const html = render('tr');
    expect(amounts(html)).toEqual(['1,234 kWh', '1.234,5 L']);
    expect(html).toContain(MESSAGES.tr.dataEntry.bulkPreview.amount);
    expect(html).toContain(MESSAGES.tr.dataEntry.bulkPreview.readNote);
  });

  it('shows the same numbers in English, written the English way', () => {
    const html = render('en');
    expect(amounts(html)).toEqual(['1.234 kWh', '1,234.5 L']);
    expect(html).toContain(MESSAGES.en.dataEntry.bulkPreview.readNote);
  });

  it.each([
    // The numbers the API reads from these CSV / XLSX-text cells (Number(cell),
    // pinned in bulk-upload.service.spec.ts): a fraction-digit cap rounded
    // them (Codex's B9 review of #208).
    ['0.000000000000000000015', '0,000000000000000000015 kWh', '0.000000000000000000015 kWh'],
    ['0.0000012345678901234567', '0,0000012345678901234567 kWh', '0.0000012345678901234567 kWh'],
  ])('shows a file\'s %s with every digit, in Turkish and English', (cell, tr, en) => {
    const small: BulkUploadAcceptedRow[] = [{ ...rows[0], activityValue: Number(cell), activityUnit: 'kWh' }];
    const renderSmall = (locale: 'en' | 'tr') => renderToStaticMarkup(createElement(IntlProvider, {
      locale, timeZone: 'UTC', messages: MESSAGES[locale], children: createElement(AcceptedRows, { rows: small }),
    }));
    expect(amounts(renderSmall('tr'))).toEqual([tr]);
    expect(amounts(renderSmall('en'))).toEqual([en]);
  });

  it('a language change changes how an amount is written, never the amount', () => {
    const read = (text: string, locale: 'en' | 'tr') =>
      Number(text.split(' ')[0].replaceAll(locale === 'tr' ? '.' : ',', '').replace(',', '.'));
    const tr = amounts(render('tr'));
    const en = amounts(render('en'));
    expect(tr.map((a) => read(a, 'tr'))).toEqual(rows.map((r) => r.activityValue));
    expect(en.map((a) => read(a, 'en'))).toEqual(rows.map((r) => r.activityValue));
  });
});
