import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_ERROR_STATUS,
  BULK_SUBMIT_ISSUE_CODES,
  BULK_UPLOAD_ERROR_CODES,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_ACTIVITY_RECORD_SORT,
  ACTIVITY_RECORD_SEARCH_MAX_LENGTH,
  TARGET_PROGRESS_MAX_IDS,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_LIMIT,
  isCursorPage,
  type ActivityRecordPageFilters,
  type ActivityRecordPageItemDTO,
  type ActivityRecordPageParams,
  type ActivityRecordDTO,
  type BulkSubmitReportDTO,
  type BulkUploadReportDTO,
  type BulkImportAuditDiff,
  type BulkSubmitAuditDiff,
  type ReportMetaDTO,
  type CursorPage,
  type ListActivityRecordsParams,
  type Paginated,
} from './index';

describe('bounded page envelopes at the client/API boundary', () => {
  it('pins the published limits and default order independently of their implementation', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(MAX_CURSOR_LENGTH).toBe(2048);
    expect(ACTIVITY_RECORD_SEARCH_MAX_LENGTH).toBe(200);
    expect(DEFAULT_ACTIVITY_RECORD_SORT).toBe('newest');
    expect(TARGET_PROGRESS_MAX_IDS).toBe(100);
  });
  it('accepts the empty last page without inventing a total or an offset', () => {
    const empty: CursorPage<never> = { items: [], limit: DEFAULT_PAGE_LIMIT, nextCursor: null };
    expect(isCursorPage(JSON.parse(JSON.stringify(empty)))).toBe(true);
    expectTypeOf<CursorPage<unknown>>().not.toMatchTypeOf<Paginated<unknown>>();
  });

  it('accepts full and short pages, including an opaque continuation', () => {
    expect(isCursorPage({ items: [1, 2], limit: 2, nextCursor: 'v1.opaque+/%=' })).toBe(true);
    expect(isCursorPage({ items: [1], limit: MAX_PAGE_LIMIT, nextCursor: null })).toBe(true);
    expect(isCursorPage({ items: [1], limit: 1, nextCursor: 'x'.repeat(MAX_CURSOR_LENGTH) })).toBe(true);
  });

  it.each([
    null, undefined, [], [1], {},
    { items: [], limit: 50 },
    { items: [], nextCursor: null },
    { items: {}, limit: 50, nextCursor: null },
    { items: [], limit: '50', nextCursor: null },
    ...[0, -1, 1.5, MAX_PAGE_LIMIT + 1, NaN, Infinity].map((limit) => ({ items: [], limit, nextCursor: null })),
    { items: [1, 2], limit: 1, nextCursor: null },
    { items: [1], limit: 1, nextCursor: '' },
    { items: [1], limit: 1, nextCursor: 1 },
    { items: [1], limit: 1, nextCursor: 'x'.repeat(MAX_CURSOR_LENGTH + 1) },
    { items: [], limit: 50, nextCursor: 'would-loop-without-progress' },
  ])('refuses incompatible, unbounded or non-progressing envelopes: %j', (value) => {
    expect(isCursorPage(value)).toBe(false);
  });
});

describe('the additive contract preserves current producers', () => {
  it('carries deadline completion and unstarted counts in both non-refused audit variants', () => {
    type Import = Extract<BulkImportAuditDiff, { totalRows: number }>;
    type Submit = Extract<BulkSubmitAuditDiff, { submittedCount: number }>;
    expectTypeOf<Import['completion']>().toEqualTypeOf<BulkUploadReportDTO['completion']>();
    expectTypeOf<Submit['completion']>().toEqualTypeOf<BulkSubmitReportDTO['completion']>();
    expectTypeOf<Import['notProcessedCount']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Submit['notProcessedCount']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ReportMetaDTO['recordLimit']>().toEqualTypeOf<number | undefined>();
  });
  it('keeps legacy filters unchanged while pages can describe whole-company and site records', () => {
    expectTypeOf<keyof ListActivityRecordsParams>().toEqualTypeOf<
      'subsidiaryId' | 'year' | 'period' | 'category' | 'status'
    >();
    expectTypeOf<ActivityRecordPageParams>().toMatchTypeOf<ListActivityRecordsParams>();
    expectTypeOf<ActivityRecordPageFilters['locationId']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ActivityRecordPageItemDTO>().toMatchTypeOf<ActivityRecordDTO>();
    expectTypeOf<ActivityRecordPageItemDTO['periodLocked']>().toEqualTypeOf<boolean>();
  });

  it('adds a deadline outcome to each row vocabulary without changing old completion producers', () => {
    expect(BULK_UPLOAD_ERROR_CODES).toContain('not_processed_deadline');
    expect(BULK_SUBMIT_ISSUE_CODES).toContain('not_processed_deadline');
    expectTypeOf<BulkUploadReportDTO['completion']>().toEqualTypeOf<
      'completed' | 'deadline_exceeded' | undefined
    >();
    expectTypeOf<BulkSubmitReportDTO['completion']>().toEqualTypeOf<BulkUploadReportDTO['completion']>();
  });

  it('distinguishes query budget refusals from validation, upload size and rate limits', () => {
    expect(API_ERROR_STATUS.query_too_broad).toBe(422);
    expect(API_ERROR_STATUS.validation_failed).toBe(400);
    expect(API_ERROR_STATUS.payload_too_large).toBe(413);
    expect(API_ERROR_STATUS.rate_limited).toBe(429);
  });
});
