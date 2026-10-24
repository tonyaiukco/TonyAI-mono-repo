import { describe, expect, it } from 'vitest';
import { copyFor, describeFor, recordWordsFor } from './testing';
import { preflightFile, rowCount, summarise, tonnesLabel, uploadErrorMessage } from '@/lib/bulk-upload-view';
import { submitBlockReason, submitConfirmation, submitErrorMessage, summariseSubmit } from '@/lib/bulk-submit-view';
import { attachBlockReason, attachConfirmation, attachErrorMessage, attachSuccessMessage, detachSuccessMessage, sharedWithNote } from '@/lib/evidence-view';
import { anomalyStatement } from '@/lib/anomaly-view';
import { reviewBadge, shortfallReasons } from '@/lib/completeness-view';
import { batchSubmitLabel, submitFailureDetail } from '@/lib/import-batches-view';
import { ApiError } from '@/lib/api';
import type { BulkUploadAcceptedRow, BulkUploadReportDTO, Locale } from '@/lib/types';

/**
 * The view modules in Turkish (LP4-04 slice 2): every sentence comes from the
 * Turkish catalogue, counts and figures carry Turkish separators, and the
 * number behind a sentence is the same in both languages.
 */
const up = (locale: Locale) => copyFor('bulkUpload', locale);
const sub = (locale: Locale) => copyFor('bulkSubmit', locale);
const ev = (locale: Locale) => ({ ...copyFor('evidence', locale), words: recordWordsFor(locale) });
const cc = (locale: Locale) => ({ ...copyFor('completeness', locale), words: recordWordsFor(locale) });

const row = (tCo2e: number | null): BulkUploadAcceptedRow =>
  ({ row: 2, tCo2e, recordId: null, category: 'Electricity', activityType: null, activityValue: 1, activityUnit: 'kWh' }) as unknown as BulkUploadAcceptedRow;

describe('the same quantity in both languages', () => {
  it('a bulk total keeps its three decimals and its value; only the separators move', () => {
    const rows = [row(1000), row(234.5)];
    expect(tonnesLabel(rows, up('en'))).toBe('1,234.500 tCO₂e');
    expect(tonnesLabel(rows, up('tr'))).toBe('1.234,500 tCO₂e');
  });

  it('counts are grouped the Turkish way', () => {
    expect(rowCount(1200, up('en'))).toBe('1,200 rows');
    expect(rowCount(1200, up('tr'))).toBe('1.200 satır');
    expect(submitConfirmation(1200, sub('tr'))).toContain('1.200 kaydı');
    expect(batchSubmitLabel(1200, copyFor('imports', 'tr'))).toBe('1.200 taslağı incelemeye gönder');
  });
});

describe('every sentence is Turkish', () => {
  it('names a record by its Turkish period and category', () => {
    const record = { category: 'Natural Gas' as const, periodValue: 'January', reportingYear: 2026, locationName: null };
    const { records } = attachConfirmation('fatura.pdf', [record], ev('tr'));
    expect(records[0]).toBe('Doğal gaz · Ocak 2026');
    const note = sharedWithNote({ linkedRecords: [{ ...record, id: 'a' }, { ...record, id: 'b' }] } as never, 'a', ev('tr'));
    expect(note).toBe('Ayrıca 1 başka kaydı destekliyor: Doğal gaz · Ocak 2026');
  });

  it('a block reason names the status and the period in Turkish', () => {
    const user = { id: 'me', role: 'data_entry' as const };
    const base = { id: 'r', category: 'Electricity' as const, evidenceCount: 1, createdBy: 'me', subsidiaryId: 's', reportingYear: 2026, reportingPeriod: 'monthly' as const, periodValue: 'March', periodLocked: false };
    expect(submitBlockReason({ ...base, status: 'approved' }, user, sub('tr'), recordWordsFor('tr'))).toBe('Zaten onaylanmış.');
    expect(submitBlockReason({ ...base, status: 'draft', periodLocked: true }, user, sub('tr'), recordWordsFor('tr'))).toBe('Mart 2026 kilitli.');
  });

  it('completeness reasons and badges', () => {
    const coverage = { unattributedRecords: 2, outOfScopeRecords: 0, nonMonthlyRecords: 0, missingEvidenceRecords: 1 } as never;
    expect(shortfallReasons(coverage, 2026, cc('tr'))).toEqual([
      '2 kayıt bir tesis yerine tüm şirket için kaydedildi; bu yüzden hiçbir tesisin ayını kapatmaz.',
      '1 kayıtta ekli fatura yok.',
    ]);
    expect(reviewBadge({ awaitingReviewSlots: 3, awaitingReviewRecords: 0 }, cc('tr'))).toBe('3 fatura inceleme bekliyor');
  });

  it('a bulk verdict', () => {
    const report = { dryRun: true, accepted: [row(1)], errors: [], warnings: [], totalRows: 1, fileName: 'f.csv' } as unknown as BulkUploadReportDTO;
    expect(summarise(report, undefined, up('tr')).headline).toBe('1 satır içe aktarılacak.');
  });

  it('an API refusal with a code is the Turkish catalogue’s, never the server’s English', () => {
    const refusal = new ApiError('Too Many Requests', 429);
    expect(describeFor('tr')(refusal).title).not.toBe('Too Many Requests');
  });
});

describe('one and many are worded apart (each pair, both languages)', () => {
  const file = (n: number) => ({ fileName: 'f.pdf', linkedRecords: Array.from({ length: n }, (_, i) => ({ id: String(i) })) }) as never;
  it('evidence', () => {
    expect(attachSuccessMessage(file(1), ev('en'))).toBe('f.pdf now backs 1 record.');
    expect(attachSuccessMessage(file(2), ev('en'))).toBe('f.pdf now backs 2 records.');
    expect(detachSuccessMessage({ fileDeleted: false }, file(2), ev('en'))).toBe('Removed from this record — f.pdf still backs 1 other record.');
    expect(detachSuccessMessage({ fileDeleted: false }, file(3), ev('en'))).toBe('Removed from this record — f.pdf still backs 2 other records.');
  });
  it('bulk submit', () => {
    const report = (moved: number) => ({ requested: moved, submitted: Array.from({ length: moved }, (_, i) => ({ recordId: String(i) })), failed: [] }) as never;
    expect(summariseSubmit(report(1), undefined, sub('en')).headline).toBe('1 record is now in the review queue.');
    expect(summariseSubmit(report(2), undefined, sub('en')).headline).toBe('2 records are now in the review queue.');
  });
  it('anomaly', () => {
    const { t } = copyFor('anomaly', 'en');
    const one = anomalyStatement({ anomalyFlag: false, anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: null }, t, 'en');
    const two = anomalyStatement({ anomalyFlag: false, anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: null }, t, 'en');
    expect(one.detail).toMatch(/^Only 1 earlier committed period exists/);
    expect(two.detail).toMatch(/^Only 2 earlier committed periods exist/);
  });
  it('bulk upload rows', () => {
    expect(rowCount(1, up('en'))).toBe('1 row');
    expect(rowCount(2, up('en'))).toBe('2 rows');
  });
});

describe('Turkish-only paths (English reads the same either way, so these pin the Turkish words)', () => {
  const user = { id: 'me', role: 'data_entry' as const };
  const draft = { id: 'r', category: 'Electricity' as const, evidenceCount: 0, createdBy: 'me', subsidiaryId: 's', reportingYear: 2026, reportingPeriod: 'monthly' as const, periodValue: 'March', periodLocked: true, status: 'draft' as const };

  it('an attach refusal names the locked month in Turkish', () => {
    expect(attachBlockReason(draft, user, ev('tr'))).toBe('Mart 2026 kilitli.');
  });

  it('a many-row verdict says "satır" once', () => {
    const report = { dryRun: true, accepted: [row(1), row(2)], errors: [], warnings: [], totalRows: 2, fileName: 'f.csv' } as unknown as BulkUploadReportDTO;
    const headline = summarise(report, undefined, up('tr')).headline;
    expect(headline).toBe('Satırların tümü (2 satır) içe aktarılacak.');
    expect(headline.match(/satır/gi)?.length).toBe(2);
    expect(tonnesLabel([row(1), row(null)], up('tr'))).toBe('1,000 tCO₂e; 2 satır içinden 1 satır için. 1 satırın hesaplanmış değeri yok');
  });

  it('a file of the wrong kind lists the accepted kinds with the Turkish "or"', () => {
    expect(preflightFile({ name: 'a.pdf', size: 10 }, up('tr'))).toContain(' veya ');
  });

  it('a batch submit failure groups its counts the Turkish way', () => {
    const failed = Array.from({ length: 1200 }, (_, i) => ({ recordId: String(i), code: 'evidence_required', message: 'x' }));
    const t = copyFor('errors', 'tr').t;
    const detail = submitFailureDetail({ requested: 1200, submitted: [], failed } as never, 'x', t as never, t as never, 'tr');
    expect(detail).toContain('1.200');
  });
});

describe('error words', () => {
  it('a throttled submit gets its own sentence, not the generic 429', () => {
    expect(submitErrorMessage(new ApiError('Too Many Requests', 429), sub('en'), describeFor('en')).title).toBe(
      'Too many submissions in a short time. Wait a minute and try again.',
    );
  });

  it('a plain Error is described, never shown raw; anything else is the module’s own sentence', () => {
    expect(attachErrorMessage(new Error('boom'), ev('en'), describeFor('en')).title).toBe('Something went wrong.');
    expect(attachErrorMessage('boom', ev('en'), describeFor('en')).title).toBe('The file could not be attached.');
  });

  it('in Turkish a generic refusal keeps the server’s English beneath it (K5)', () => {
    const refusal = new ApiError('Records Q1 2026 are locked.', 400);
    const words = attachErrorMessage(refusal, ev('tr'), describeFor('tr'));
    expect(words.title).not.toBe('Records Q1 2026 are locked.');
    expect(words.description).toBe('Records Q1 2026 are locked.');
    expect(uploadErrorMessage(refusal, () => 'x', up('tr'), describeFor('tr')).description).toBe('Records Q1 2026 are locked.');
    expect(submitErrorMessage(refusal, sub('tr'), describeFor('tr')).description).toBe('Records Q1 2026 are locked.');
  });
});

describe('recordWordsOf (useRecordWords and the specs share it)', () => {
  it('a status is the inline word in a sentence, and unknown values pass through as stored', () => {
    const words = recordWordsFor('tr');
    expect(words.status('under_review')).toBe('incelemede');
    expect(words.status('not_a_status')).toBe('not a status');
    expect(words.period('Q9')).toBe('Q9');
    expect(words.category('Lava')).toBe('Lava');
  });

  it('prototype names are not catalogue keys', () => {
    const words = recordWordsFor('en');
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(words.category(name)).toBe(name);
      expect(words.period(name)).toBe(name);
    }
  });
});
