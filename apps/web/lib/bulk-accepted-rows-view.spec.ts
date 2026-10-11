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
      category: 'Fuel', activityType: i % 2 ? 'gas_oil' : 'diesel', tCo2e: null, anomalous: false,
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
