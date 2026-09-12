import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  bulkSubmitReportIsComplete,
  type ActivityRecordDTO,
  type CalculationResult,
} from '@tonyai/shared-types';
import { BulkSubmitService } from './bulk-submit.service';
import {
  ActivityRecordsService,
  EVIDENCE_REFUSAL_FRAGMENT,
  RESUBMIT_AUTHOR_REFUSAL,
  SUBMIT_ROLE_REFUSAL,
  VARIANCE_REFUSAL,
} from '../activity-records/activity-records.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

/**
 * The LOOP and its pre-flight are under test, not the gate:
 * `ActivityRecordsService.submit` owns every precondition and has its own
 * suite. What this file holds to account is what the batch does around it —
 * which caller it hands over, which ids it declines to hand over at all, in
 * what order, and what it does with what comes back.
 *
 * Two shapes of assertion are deliberate here, both because their absence was
 * caught by a mutation sweep. **Arguments, not call counts:** forging the role
 * on the call into `submit` passed 921 tests, and that call is where the whole
 * guard chain is handed over. **Values that are not the fixture's defaults:**
 * asserting `periodValue === 'January'` when the fixture's default is
 * `'January'` proves the mapping only by coincidence.
 */
const SNAPSHOT: CalculationResult = {
  category: 'Natural Gas',
  geographyCode: 'UK',
  reportingYear: 2019,
  scope: 1,
  inputValue: 900,
  inputUnit: 'kWh',
  normalizedValue: 900,
  normalizedUnit: 'kWh',
  conversionApplied: false,
  kgCo2e: 165,
  tCo2e: 0.165,
  factorId: 'factor-9',
  factorValue: 0.18,
  factorUnit: 'kgCO2e/kWh',
  methodology: 'location-based',
  source: 'demo',
  version: '2019.1',
};

/** Deliberately nothing like the defaults a lazy assertion would match. */
function record(over: Partial<ActivityRecordDTO> = {}): ActivityRecordDTO {
  return {
    id: 'rec-7',
    subsidiaryId: 'sub-7',
    locationId: 'loc-9',
    reportingYear: 2019,
    reportingPeriod: 'quarterly',
    periodValue: 'Q3',
    category: 'Natural Gas',
    calculation: SNAPSHOT,
    anomalyFlag: true,
    ...over,
  } as ActivityRecordDTO;
}

/** A row as the pre-flight's `select` returns it. */
function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 'a',
    status: 'draft',
    createdBy: 'user-entry',
    reportingYear: 2024,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    ...over,
  };
}

function dataEntry(over: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    fullName: 'Entry User',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1'],
    ...over,
  };
}

function build(rows: Record<string, unknown>[] = [candidate()]) {
  const prisma = {
    activityRecord: { findMany: vi.fn().mockResolvedValue(rows) },
  };
  const records = {
    submit: vi
      .fn()
      .mockImplementation((_user, id: string) => Promise.resolve(record({ id }))),
  };
  const audit = { record: vi.fn() };
  const service = new BulkSubmitService(
    prisma as unknown as PrismaService,
    records as unknown as ActivityRecordsService,
    audit as unknown as AuditService,
  );
  return { prisma, records, audit, service };
}

const ids = (...v: string[]) => ({ recordIds: v });

beforeEach(() => vi.clearAllMocks());

describe('BulkSubmitService — what it hands to submit', () => {
  it('passes the caller through, untouched, with each id', async () => {
    // The assertion a mutation sweep showed was missing, and the one that
    // matters most: forging `role: 'super_admin'`, widening
    // `accessibleSubsidiaryIds`, or swapping `id` on this call each passed the
    // entire suite. That single call is where the tenant boundary, the author
    // gate and the role gate are all handed over.
    const user = dataEntry();
    const { records, service } = build([
      candidate({ id: 'a' }),
      candidate({ id: 'b', periodValue: 'February' }),
    ]);

    await service.submitMany(user, ids('a', 'b'));

    expect(records.submit.mock.calls).toEqual([
      [user, 'a'],
      [user, 'b'],
    ]);
  });

  it('maps every field of a submitted record from the record itself', async () => {
    // Five of these were hardcodable without a single test failing, because
    // the old fixture's values WERE the asserted values.
    const { service } = build();

    const [accepted] = (await service.submitMany(dataEntry(), ids('a'))).submitted;

    expect(accepted).toEqual({
      recordId: 'a',
      subsidiaryId: 'sub-7',
      locationId: 'loc-9',
      reportingYear: 2019,
      reportingPeriod: 'quarterly',
      periodValue: 'Q3',
      category: 'Natural Gas',
      tCo2e: 0.165,
      anomalous: true,
    });
  });

  it('reports no figure — not a zero — for a category that is not calculated', async () => {
    const { records, service } = build();
    records.submit.mockResolvedValue(
      record({ id: 'a', calculation: { category: 'Water' } as never }),
    );

    const [accepted] = (await service.submitMany(dataEntry(), ids('a'))).submitted;

    expect(accepted.tCo2e).toBeNull();
  });
});

describe('BulkSubmitService — the pre-flight declines what submit would not', () => {
  it('refuses a record someone else created', async () => {
    // `submit` gates only a RESUBMISSION, so a draft is submittable by any
    // colleague who can see the subsidiary. At a thousand ids in one call that
    // is a way to sweep someone's half-finished month into review, where they
    // can no longer edit it and only a reviewer can send it back.
    const { records, service } = build([
      candidate({ id: 'mine' }),
      candidate({ id: 'theirs', createdBy: 'user-colleague' }),
    ]);

    const report = await service.submitMany(dataEntry(), ids('mine', 'theirs'));

    expect(report.submitted.map((r) => r.recordId)).toEqual(['mine']);
    expect(report.failed).toEqual([
      expect.objectContaining({ recordId: 'theirs', code: 'not_author' }),
    ]);
    expect(records.submit).toHaveBeenCalledTimes(1);
  });

  it('lets a super_admin submit anyone’s draft', async () => {
    const { records, service } = build([
      candidate({ id: 'theirs', createdBy: 'user-colleague' }),
    ]);

    const report = await service.submitMany(
      dataEntry({ role: 'super_admin' }),
      ids('theirs'),
    );

    expect(report.submitted).toHaveLength(1);
    expect(records.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['rejected', 'submitted', 'approved', 'locked', 'voided'])(
    'refuses a %s record — bulk takes drafts only',
    async (status) => {
      // `rejected` most of all: resubmitting reverses a reviewer's decision,
      // and a route that flips a thousand of them at once is a mass-reversal
      // endpoint, which is not what "the other half of an import" means.
      const { records, service } = build([candidate({ id: 'a', status })]);

      const report = await service.submitMany(dataEntry(), ids('a'));

      expect(report.failed[0]).toMatchObject({ code: 'not_submittable' });
      expect(report.failed[0].message).toContain(status);
      expect(records.submit).not.toHaveBeenCalled();
    },
  );

  it('scopes the lookup to what the caller can reach', async () => {
    const { prisma, service } = build([]);

    await service.submitMany(
      dataEntry({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] }),
      ids('a'),
    );

    expect(prisma.activityRecord.findMany.mock.calls[0][0].where).toMatchObject({
      subsidiaryId: { in: ['sub-1', 'sub-2'] },
    });
  });

  it('does not disclose whether an unreachable record exists', async () => {
    // Asserted as a PROPERTY, not against a blocklist of four words: an
    // inaccessible id and an absent one must be byte-identical apart from the
    // id itself, or the endpoint is an existence oracle for another tenant.
    const { service } = build([]);

    const report = await service.submitMany(dataEntry(), ids('absent', 'foreign'));

    const [first, second] = report.failed;
    expect({ ...first, recordId: '' }).toEqual({ ...second, recordId: '' });
    expect(first.code).toBe('not_found');
  });

  it('submits in chronological order, whatever order the caller sent', async () => {
    // `submitted` is in COUNTED_STATUSES, so record N's write enters record
    // N+1's anomaly baseline: the verdict is order-dependent WITHIN a batch.
    // December-first would evaluate December against no priors at all and
    // store `anomalyFlag: false` for it. Sorted, the gate is strongest and the
    // outcome is reproducible.
    const { records, service } = build([
      candidate({ id: 'dec', periodValue: 'December' }),
      candidate({ id: 'jan', periodValue: 'January' }),
      candidate({ id: 'prev', periodValue: 'June', reportingYear: 2023 }),
    ]);

    await service.submitMany(dataEntry(), ids('dec', 'jan', 'prev'));

    expect(records.submit.mock.calls.map((c) => c[1])).toEqual([
      'prev',
      'jan',
      'dec',
    ]);
  });

  it('de-duplicates, so an id cannot fail against its own success', async () => {
    const { records, service } = build();

    const report = await service.submitMany(dataEntry(), ids('a', 'a'));

    expect(records.submit).toHaveBeenCalledTimes(1);
    expect(report.requested).toBe(1);
    expect(report.failed).toEqual([]);
  });

  it('accounts for every id it was given', async () => {
    const { service } = build([candidate({ id: 'a' })]);

    const report = await service.submitMany(dataEntry(), ids('a', 'gone'));

    expect(bulkSubmitReportIsComplete(report)).toBe(true);
  });
});

describe('BulkSubmitService — a role refusal is one 403, and it is recorded', () => {
  it.each(['consultant', 'executive_viewer'] as const)(
    'refuses the whole request for %s',
    async (role) => {
      const { prisma, records, service } = build();

      await expect(
        service.submitMany(dataEntry({ role }), ids('a', 'b')),
      ).rejects.toThrow(SUBMIT_ROLE_REFUSAL);
      expect(records.submit).not.toHaveBeenCalled();
      expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    },
  );

  it('writes an audit row for a refused request', async () => {
    // The regression the import already fixed once: its batch row used to be
    // written after the loop, so a seat probing the write surface left no
    // trace at all on an append-only compliance trail.
    const { audit, service } = build();

    await expect(
      service.submitMany(dataEntry({ role: 'consultant' }), ids('a')),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      bulk: true,
      refused: true,
    });
  });

  it('lets both authoring roles through', async () => {
    for (const role of ['data_entry', 'super_admin'] as const) {
      const { records, service } = build();
      await service.submitMany(dataEntry({ role }), ids('a'));
      expect(records.submit).toHaveBeenCalledTimes(1);
    }
  });
});

describe('BulkSubmitService — every refusal maps to its own code and sentence', () => {
  it.each([
    [
      new BadRequestException(`Category "Electricity" ${EVIDENCE_REFUSAL_FRAGMENT}.`),
      'evidence_required',
      /evidence file/i,
    ],
    [new BadRequestException(VARIANCE_REFUSAL), 'variance_reason_required', /variance/i],
    [
      new ConflictException(
        'Reporting period January 2024 is locked — a super_admin must unlock it.',
      ),
      'period_locked',
      /locked/i,
    ],
    [new ForbiddenException(RESUBMIT_AUTHOR_REFUSAL), 'not_author', /resubmit/i],
    [new NotFoundException('Activity record not found'), 'not_found', /does not exist/i],
  ])('%s', async (error, code, messagePattern) => {
    // The MESSAGE is asserted as well as the code: the panel renders it
    // verbatim under the label, so junking it is a user-facing regression the
    // code assertion alone cannot see.
    const { records, service } = build();
    records.submit.mockRejectedValue(error);

    const report = await service.submitMany(dataEntry(), ids('a'));

    expect(report.failed[0].code).toBe(code);
    expect(report.failed[0].message).toMatch(messagePattern);
    expect(report.submitted).toEqual([]);
  });

  it('sends an unrecognised Forbidden to `unexpected`, not to `not_author`', async () => {
    // "Anything that is not X is Y" is the shape that goes wrong silently: it
    // would tell a user they do not own a record they wrote.
    const { records, service } = build();
    records.submit.mockRejectedValue(new ForbiddenException('Something else entirely'));

    const report = await service.submitMany(dataEntry(), ids('a'));

    expect(report.failed[0].code).toBe('unexpected');
  });

  it('sends an unrecognised Conflict to `unexpected`, not to `period_locked`', async () => {
    const { records, service } = build();
    records.submit.mockRejectedValue(new ConflictException('Something else entirely'));

    const report = await service.submitMany(dataEntry(), ids('a'));

    expect(report.failed[0].code).toBe('unexpected');
  });

  it('re-throws a role refusal rather than calling it an authorship problem', async () => {
    const { records, service } = build();
    records.submit.mockRejectedValue(new ForbiddenException(SUBMIT_ROLE_REFUSAL));

    await expect(service.submitMany(dataEntry(), ids('a'))).rejects.toThrow(
      SUBMIT_ROLE_REFUSAL,
    );
  });

  it('reads a validation message that arrives as an array', async () => {
    // `BadRequestException` carries `message` as a string[] when it comes from
    // the validation pipe, and `error.message` is then the useless
    // "Bad Request Exception" — which would send an evidence refusal to
    // `not_submittable`.
    const { records, service } = build();
    records.submit.mockRejectedValue(
      new BadRequestException([`Category "Fuel" ${EVIDENCE_REFUSAL_FRAGMENT}.`]),
    );

    const report = await service.submitMany(dataEntry(), ids('a'));

    expect(report.failed[0].code).toBe('evidence_required');
  });

  it('refuses an unexpected failure without echoing it back', async () => {
    const { records, service } = build();
    records.submit.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 while running SELECT "secret"'),
    );

    const report = await service.submitMany(dataEntry(), ids('a'));

    expect(report.failed[0].code).toBe('unexpected');
    expect(report.failed[0].message).not.toMatch(/ECONNREFUSED|SELECT|10\.0\.0\.5/);
    expect(report.failed[0].message).toMatch(/unchanged/i);
  });

  it('keeps going past a failure, and says exactly which records moved', async () => {
    const { records, service } = build([
      candidate({ id: 'a', periodValue: 'January' }),
      candidate({ id: 'b', periodValue: 'February' }),
      candidate({ id: 'c', periodValue: 'March' }),
    ]);
    records.submit
      .mockResolvedValueOnce(record({ id: 'a' }))
      .mockRejectedValueOnce(new NotFoundException('gone'))
      .mockResolvedValueOnce(record({ id: 'c' }));

    const report = await service.submitMany(dataEntry(), ids('a', 'b', 'c'));

    expect(report.submitted.map((r) => r.recordId)).toEqual(['a', 'c']);
    expect(report.failed[0].recordId).toBe('b');
  });
});

describe('BulkSubmitService — the audit row', () => {
  it('is written as the CALLER, and counts what happened', async () => {
    // The actor was unasserted, and forging it to `undefined` passed every
    // test — while in production `AuditService` would throw on `user.id`, the
    // catch below would swallow it, and bulk submits would write no batch row
    // at all, silently.
    const user = dataEntry();
    const { records, audit, service } = build([
      candidate({ id: 'a' }),
      candidate({ id: 'b', periodValue: 'February' }),
    ]);
    records.submit
      .mockResolvedValueOnce(record({ id: 'a' }))
      .mockRejectedValueOnce(new NotFoundException('gone'));

    await service.submitMany(user, ids('a', 'b'));

    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        action: 'submit',
        entity: 'activity_record',
        entityId: null,
      }),
    );
  });

  it('names the records it moved, so the per-record rows can be tied to it', async () => {
    const { audit, service } = build([candidate({ id: 'a' })]);

    await service.submitMany(dataEntry(), ids('a', 'gone'));

    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      bulk: true,
      requested: 2,
      submittedCount: 1,
      failedCount: 1,
      recordIds: ['a'],
    });
  });

  it('is written even when every record failed', async () => {
    const { records, audit, service } = build();
    records.submit.mockRejectedValue(new NotFoundException('gone'));

    await service.submitMany(dataEntry(), ids('a'));

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({ submittedCount: 0 });
  });

  it('does not take the report down with it', async () => {
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(new Error('audit_log unavailable'));

    const report = await service.submitMany(dataEntry(), ids('a'));

    expect(report.submitted).toHaveLength(1);
  });
});
