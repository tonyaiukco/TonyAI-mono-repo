import { HttpException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import type { ApiErrorBody } from '@tonyai/shared-types';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '../common/api-error';
import {
  SingleEntryConflictError,
  accessTriggerRefusal,
  recordCentralReportingRefusal,
} from './central-reporting-errors';

/** A trigger's RAISE on a model query, framed as Prisma 6's engine reports it. */
const modelQuery = (sqlstate: string, message: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlstate}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: 'test' },
  );
/** The same RAISE on a raw query: P2010 with both in `meta`. */
const rawQuery = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 'test', meta: { code, message } });

const bodyOf = (e: HttpException | null) => (e === null ? null : (e.getResponse() as ApiErrorBody));
const period = { category: 'Electricity' as const, reportingYear: 2026, periodValue: 'March' };

describe('SingleEntryConflictError (design D4)', () => {
  it('carries its side as the sentence selector and the conflicts as identifiers, never an account', () => {
    const body = bodyOf(new SingleEntryConflictError('company_users', [
      { subsidiaryId: 'a', categories: ['Mobile Combustion'] },
      { subsidiaryId: 'b', categories: ['Mobile Combustion', 'Electricity'] },
    ]));
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'single_entry_conflict',
      params: { side: 'company_users' },
      conflicts: [
        { subsidiaryId: 'a', categories: ['Mobile Combustion'] },
        { subsidiaryId: 'b', categories: ['Mobile Combustion', 'Electricity'] },
      ],
    });
    expect(Object.keys(body!.conflicts![0]!).sort()).toEqual(['categories', 'subsidiaryId']);
  });
});

describe('accessTriggerRefusal (TA024)', () => {
  it.each(['company_users', 'central_reporter'] as const)('maps a raced %s refusal to single_entry_conflict with an empty list, on both framings', (side) => {
    const message = `single_entry_conflict: side=${side}; at subsidiary x the categories {Electricity} are already open`;
    for (const e of [modelQuery('TA024', message), rawQuery('TA024', message)]) {
      const body = bodyOf(accessTriggerRefusal(e));
      expect(body).toMatchObject({ code: 'single_entry_conflict', params: { side }, conflicts: [] });
    }
  });

  it('trusts no other SQLSTATE, message or side', () => {
    for (const e of [
      modelQuery('TA020', 'single_entry_conflict: side=company_users'),
      modelQuery('TA024', 'write company access under READ COMMITTED'),
      modelQuery('TA024', 'single_entry_conflict: side=owner'),
      new Error('single_entry_conflict: side=company_users'),
    ]) {
      expect(accessTriggerRefusal(e)).toBeNull();
    }
  });
});

describe('recordCentralReportingRefusal (TA025, TA026)', () => {
  it('maps TA026 to single_entry_period_conflict with the period of the record being written', () => {
    const message = 'single_entry_period_conflict: side=company_users; subsidiary x already holds record y';
    for (const e of [modelQuery('TA026', message), rawQuery('TA026', message)]) {
      const mapped = recordCentralReportingRefusal(e, period);
      expect(errorCodeOf(mapped!)).toBe('single_entry_period_conflict');
      expect(bodyOf(mapped)?.params).toEqual({ side: 'company_users', category: 'Electricity', year: 2026, period: 'March' });
    }
  });

  it("maps TA025's missing main company to central_reporter_needs_main_entity", () => {
    const mapped = recordCentralReportingRefusal(modelQuery('TA025', 'central_reporter_needs_main_entity: the author x'), period);
    expect(errorCodeOf(mapped!)).toBe('central_reporter_needs_main_entity');
  });

  it('leaves every other refusal to its own mapping', () => {
    for (const e of [
      modelQuery('TA025', 'reporting_entity_fixed: record x'),
      modelQuery('TA026', 'write activity records under READ COMMITTED'),
      modelQuery('TA001', 'single_entry_period_conflict: side=company_users'),
      modelQuery('TA024', 'single_entry_conflict: side=company_users'),
    ]) {
      expect(recordCentralReportingRefusal(e, period)).toBeNull();
    }
  });
});
