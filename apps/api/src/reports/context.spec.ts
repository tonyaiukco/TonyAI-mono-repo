import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../common/coded-validation.pipe';
import { ReportingExportQueryDto } from './dto/report-query.dto';
import { contextLabels } from './context-labels';
import { filename, ReportsController } from './reports.controller';
import type { ReportsService } from './reports.service';
import type { RequestUser } from '../auth/auth.types';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

const query = { template: 'ghg_protocol_detail' as const, year: 2027, scope: 1 as const, category: 'Fuel' as const };
const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
const parse = (value: unknown) => pipe.transform(value, { type: 'query', metatype: ReportingExportQueryDto });

describe('report context boundary', () => {
  it('accepts strict booleans alongside the complete reporting context', async () => {
    expect(await parse({ ...query, year: '2027', scope: '1', includeMethodologyNotes: 'false', includeEvidenceSummary: 'true' }))
      .toMatchObject({ ...query, includeMethodologyNotes: false, includeEvidenceSummary: true });
  });
  it.each([
    { year: undefined }, { template: 'invalid' }, { scope: '2' }, { status: 'approved' },
    { includeMethodologyNotes: 'yes' }, { includeEvidenceSummary: ['true', 'false'] },
  ])('refuses malformed export options %j', async (override) => {
    await expect(parse({ ...query, ...override })).rejects.toMatchObject({ response: { code: 'validation_failed' } });
  });
  it('echoes exact meta context separately from the selected data', async () => {
    const meta = vi.fn().mockResolvedValue({ totalCount: 0 });
    const controller = new ReportsController({ meta } as unknown as ReportsService);
    const context = { year: 2027, subsidiaryId: 'foreign', category: 'Fuel' as const };
    const user = {} as RequestUser;
    expect(await controller.contextMeta(user, context)).toEqual({ context, data: { totalCount: 0 } });
    expect(meta).toHaveBeenCalledWith(user, 2027, 'foreign', context);
  });
  it('discloses filters in sanitized filenames, including empty CSV exports', () => {
    expect(filename(query, 'csv')).toBe('tonyai-ghg_protocol_detail-2027-scope1-fuel.csv');
    expect(filename({ ...query, subsidiaryId: '\r\n"/sub-1' }, 'pdf')).toBe('tonyai-ghg_protocol_detail-2027-sub-1-scope1-fuel.pdf');
  });
  it('keeps EN/TR context catalogue parity and formats ICU values', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(tr[key]).not.toBe(en[key]);
      expect(tr[key].match(/\{\w+\}/g)).toEqual(en[key].match(/\{\w+\}/g));
    }
    expect(contextLabels({ year: 2027 }, null)[0][1]).toBe('All accessible subsidiaries');
    expect(contextLabels({ year: 2027, subsidiaryId: 'foreign', scope: 1 }, null, 'tr'))
      .toContainEqual(['Kapsam filtresi', 'Kapsam 1']);
    expect(contextLabels({ year: 2027, subsidiaryId: 'foreign' }, null)[0][1]).toBe('Selected subsidiary (foreign)');
  });
});
