import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ACTIVITY_UNIT_MAX_LENGTH,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_MAX_SIZE_BYTES,
  BULK_UPLOAD_MESSAGE_MAX_LENGTH,
  CATEGORIES,
  type CalculationResult,
} from '@tonyai/shared-types';
import {
  AUDIT_REASON_MAX_LENGTH,
  BulkUploadService,
} from './bulk-upload.service';
import { QUOTED_FRAGMENTS } from './parse-rows';
import { CALLER_TEXT_QUOTE_MAX_CODE_POINTS } from '../common/caller-text';
import { ActivityRecordsService } from '../activity-records/activity-records.service';
import {
  CreateRoleRefusedError,
  DUPLICATE_RECORD_MESSAGE,
  DuplicateActivityRecordError,
  PeriodLockedError,
} from '../activity-records/errors';
import { NoEmissionFactorError } from '../calculations/errors';
import { InaccessibleEntityError } from './errors';
import { AuditService } from '../audit/audit.service';
import { blockedUnitReason } from '../calculations/normalization';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { RequestUser } from '../auth/auth.types';
import { row as sheetRow, xlsx } from '../../test/xlsx';

// Reporting-entity ids in the one spelling the boundary accepts (hyphenated;
// the DTO lowercases). Hex LETTERS in each, so a case test is never vacuous.
const SUB_1 = 'a1111111-1111-4111-8111-11111111111a';
const SUB_9 = 'a9999999-9999-4999-8999-99999999999a';
const SUB_99 = 'a9999999-9999-4999-8999-9999999999ff';
const LOC_1 = 'b1111111-1111-4111-8111-11111111111b';
const LOC_9 = 'b9999999-9999-4999-8999-99999999999b';
const LOC_A = 'baaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const HEADER =
  'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';

const row = (over: Partial<Record<string, string>> = {}) => {
  const cells = {
    subsidiaryId: SUB_1,
    locationId: '',
    reportingYear: '2024',
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
    activityValue: '1200',
    activityUnit: 'kWh',
    varianceReason: '',
    ...over,
  };
  return [
    cells.subsidiaryId,
    cells.locationId,
    cells.reportingYear,
    cells.reportingPeriod,
    cells.periodValue,
    cells.category,
    cells.activityValue,
    cells.activityUnit,
    cells.varianceReason,
  ].join(',');
};

function csvFile(
  lines: string[],
  over: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  const buffer = Buffer.from([HEADER, ...lines].join('\n'));
  return {
    originalname: 'data.csv',
    mimetype: 'text/csv',
    size: buffer.length,
    buffer,
    ...over,
  } as Express.Multer.File;
}

const SNAPSHOT: CalculationResult = {
  category: 'Electricity',
  geographyCode: 'TR',
  reportingYear: 2024,
  scope: 2,
  inputValue: 1200,
  inputUnit: 'kWh',
  normalizedValue: 1200,
  normalizedUnit: 'kWh',
  conversionApplied: false,
  kgCo2e: 528,
  tCo2e: 0.528,
  factorId: 'factor-1',
  factorValue: 0.44,
  factorUnit: 'kgCO2e/kWh',
  methodology: 'location-based',
  source: 'demo',
  version: '2024.1',
};

function dataEntry(over: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    fullName: 'Entry User',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: [SUB_1],
    ...over,
  };
}

let seq = 0;

function build() {
  const prisma = {
    subsidiary: { findMany: vi.fn().mockResolvedValue([]) },
    // The pre-flight's location query is scoped by the access set; by default
    // every location a file names belongs to the first accessible subsidiary,
    // as a template-shaped file's would. The template's own query (no
    // `where.id`) gets none. A test that needs a foreign location overrides it.
    location: {
      findMany: vi.fn().mockImplementation(({ where }: { where?: any }) =>
        Promise.resolve(
          where?.id?.in
            ? where.id.in.map((id: string) => ({ id, subsidiaryId: where.subsidiaryId.in[0] }))
            : [],
        ),
      ),
    },
    importBatch: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    // `create` is spied even though this service never calls it: asserting
    // "the dry run wrote nothing" against a mock that lacks the method only
    // works by accident (the call throws a TypeError, which becomes an
    // `unexpected` row error, which fails a length assertion with a
    // misleading message). With the spy present the assertion says what it
    // means.
    activityRecord: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
  };
  const records = {
    previewCreate: vi.fn().mockResolvedValue({
      subsidiaryId: SUB_1,
      locationId: null,
      periodValue: 'January',
      calculation: SNAPSHOT,
      scope: 2,
      verdict: { anomalous: false, priorCount: 0, baseline: null },
    }),
    // ECHOES the dto it was handed, because the real service does
    // (`varianceReason: dto.varianceReason ?? null`). A fixed `null` made the
    // apply path's `warnIfUnsubmittable` untestable AND would have agreed
    // with a defect there: it reads `created.varianceReason`, a different
    // source from the dry-run path's `dto.varianceReason`.
    create: vi.fn().mockImplementation((_user, dto) => {
      seq += 1;
      return Promise.resolve({
        id: `rec-${seq}`,
        calculation: SNAPSHOT,
        anomalyFlag: false,
        periodValue: dto.periodValue,
        varianceReason: dto.varianceReason ?? null,
      });
    }),
  };
  const audit = { record: vi.fn() };
  const storage = {
    upload: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const service = new BulkUploadService(
    prisma as unknown as PrismaService,
    records as unknown as ActivityRecordsService,
    audit as unknown as AuditService,
    storage as unknown as StorageService,
  );
  return { prisma, records, audit, storage, service };
}

/**
 * Runs `body` with `Logger.error` captured, and restores the spy even if it
 * throws — `vitest.config.ts` sets `clearMocks`, which clears CALLS but leaves
 * the implementation installed, so a spy leaked by a throwing test would
 * swallow every later test's logging in this file.
 */
async function captureErrors<T>(
  body: () => Promise<T>,
): Promise<{ result: T; logged: { message: string; trace: unknown }[] }> {
  const logged: { message: string; trace: unknown }[] = [];
  const spy = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((message: unknown, trace?: unknown) => {
      logged.push({ message: String(message), trace });
    });
  try {
    return { result: await body(), logged };
  } finally {
    spy.mockRestore();
  }
}

/** How many times a stack header appears in the one attached trace. */
const stackCount = (trace: unknown, header: string) =>
  String(trace).split(header).length - 1;

const NOTHING = { dryRun: false };
const DRY = { dryRun: true };

beforeEach(() => {
  seq = 0;
});

describe('BulkUploadService — the dry run writes nothing', () => {
  it('previews every row and creates none', async () => {
    const { records, service } = build();

    const report = await service.import(dataEntry(), csvFile([row(), row({ periodValue: 'February' })]), DRY);

    expect(records.previewCreate).toHaveBeenCalledTimes(2);
    // The whole point of the feature, and the whole point of PR 1's seam.
    expect(records.create).not.toHaveBeenCalled();
    expect(report.dryRun).toBe(true);
    expect(report.accepted).toHaveLength(2);
    // No id, because there is no record — not a placeholder id.
    expect(report.accepted.every((a) => a.recordId === null)).toBe(true);
    expect(report.accepted[0].tCo2e).toBe(0.528);
  });

  it('still writes ONE audit row, saying it was a dry run', async () => {
    // `audit_log` is append-only and is the only record that a file was ever
    // pointed at this tenant's inventory. A dry run is still an act.
    const { audit, service } = build();

    await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [, entry] = audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'bulk_import',
      entity: 'activity_record',
      entityId: null,
    });
    expect(entry.diff).toMatchObject({
      bulk: true,
      dryRun: true,
      acceptedCount: 1,
      rejectedCount: 0,
    });
  });
});

describe('BulkUploadService — applying', () => {
  it('creates one record per row, through the record service', async () => {
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' })]),
      NOTHING,
    );

    expect(records.create).toHaveBeenCalledTimes(2);
    // Never a bulk write: each row must get its own factor snapshot, gates
    // and audit row.
    expect(report.accepted.map((a) => a.recordId)).toEqual(['rec-1', 'rec-2']);
  });

  it('treats a blank locationId as the whole company, not a missing value', async () => {
    const { records, service } = build();

    await service.import(dataEntry(), csvFile([row({ locationId: '' })]), NOTHING);

    const [, dto] = records.create.mock.calls[0];
    // Absent, not `''` — an empty string would fail `@MinLength(1)` and
    // refuse every company-level row in the file.
    expect(dto.locationId).toBeUndefined();
  });

  it('passes a location through when the row names one', async () => {
    const { records, service } = build();

    await service.import(dataEntry(), csvFile([row({ locationId: LOC_9 })]), NOTHING);

    expect(records.create.mock.calls[0][1].locationId).toBe(LOC_9);
  });
});

describe('BulkUploadService — duplicate slots the preview cannot see', () => {
  it('refuses the second row claiming the same slot in one file', async () => {
    // Postgres raises this on the INSERT, so a dry run would otherwise report
    // both rows clean and the apply would return a conflict.
    const { records, service } = build();

    const report = await service.import(dataEntry(), csvFile([row(), row()]), DRY);

    expect(report.accepted).toHaveLength(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ row: 3, code: 'duplicate_in_file' });
    expect(records.previewCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses a row whose slot a stored record already holds', async () => {
    const { prisma, records, service } = build();
    prisma.activityRecord.findMany.mockResolvedValue([
      {
        subsidiaryId: SUB_1,
        locationId: null,
        reportingYear: 2024,
        reportingPeriod: 'monthly',
        periodValue: 'January',
        category: 'Electricity',
      },
    ]);

    const report = await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(report.errors[0]).toMatchObject({ code: 'duplicate_existing' });
    expect(records.previewCreate).not.toHaveBeenCalled();
  });

  it('matches the stored slot on the CANONICAL spelling', async () => {
    // The vocabulary is case-insensitive on the way in and exact on the way
    // out. A file saying "january" claims the same slot as a stored "January",
    // and a check on the raw string would miss it.
    const { prisma, service } = build();
    prisma.activityRecord.findMany.mockResolvedValue([
      {
        subsidiaryId: SUB_1,
        locationId: null,
        reportingYear: 2024,
        reportingPeriod: 'monthly',
        periodValue: 'January',
        category: 'Electricity',
      },
    ]);

    const report = await service.import(
      dataEntry(),
      csvFile([row({ periodValue: '  january ' })]),
      DRY,
    );

    expect(report.errors[0]).toMatchObject({ code: 'duplicate_existing' });
  });

  it('excludes withdrawn records from the slots it considers taken', async () => {
    // The uniqueness index is `WHERE status <> 'voided'` — a withdrawn figure
    // does not hold its slot, and treating it as if it did would refuse the
    // restatement that is meant to replace it.
    const { prisma, service } = build();

    await service.import(dataEntry(), csvFile([row()]), DRY);

    const [args] = prisma.activityRecord.findMany.mock.calls[0];
    expect(args.where.status).toEqual({ not: 'voided' });
  });

  it('asks the database once, not once per row', async () => {
    const { prisma, service } = build();

    await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' }), row({ periodValue: 'March' })]),
      DRY,
    );

    expect(prisma.activityRecord.findMany).toHaveBeenCalledTimes(1);
    const [args] = prisma.activityRecord.findMany.mock.calls[0];
    expect(args.where.subsidiaryId).toEqual({ in: [SUB_1] });
    expect(args.where.reportingYear).toEqual({ in: [2024] });
  });
});

describe('BulkUploadService — the batch pre-flight', () => {
  it('refuses the WHOLE file when a row names an entity the user cannot reach', async () => {
    const { records, prisma, service } = build();

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ subsidiaryId: SUB_99 })]), NOTHING),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing at all happened — not even the row that would have been fine.
    expect(records.create).not.toHaveBeenCalled();
    expect(records.previewCreate).not.toHaveBeenCalled();
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('names the offending rows so the user can find them', async () => {
    const { service } = build();

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ subsidiaryId: SUB_99 })]), NOTHING),
    ).rejects.toThrow(/Row\(s\) 3\b/);
  });

  it.each([
    ['no file', undefined, /No file/],
    ['a renamed executable', csvFile([row()], { originalname: 'x.exe' }), /csv or \.xlsx/],
    ['an oversized file', csvFile([row()], { size: 99_000_000 }), /larger than/],
  ])('refuses %s', async (_label, file, pattern) => {
    const { service } = build();
    await expect(
      service.import(dataEntry(), file as Express.Multer.File | undefined, NOTHING),
    ).rejects.toThrow(pattern);
  });

  it('accepts the MIME type Windows sends for a .csv', async () => {
    // Exact-MIME-matching alone (which is what the evidence module does)
    // rejects an ordinary Excel "Save as CSV" on Windows.
    const { service } = build();
    const file = csvFile([row()], { mimetype: 'application/vnd.ms-excel' });

    const report = await service.import(dataEntry(), file, DRY);

    expect(report.accepted).toHaveLength(1);
  });

  it('refuses a file over the row cap without importing any of it', async () => {
    const { records, service } = build();
    const rows = Array.from({ length: 1001 }, (_, i) =>
      row({ periodValue: 'January', reportingYear: String(2000 + (i % 100)) }),
    );

    await expect(
      service.import(dataEntry(), csvFile(rows), NOTHING),
    ).rejects.toThrow(/limit is 1000/);
    expect(records.create).not.toHaveBeenCalled();
  });
});

describe('BulkUploadService — a bad row does not abort the batch', () => {
  it('keeps going, and the report says exactly which rows were written', async () => {
    // No transaction spans the batch, so a partial import is real. A report
    // that said only "failed" would make that a data-integrity incident.
    const { records, service } = build();
    records.create
      .mockResolvedValueOnce({ id: 'rec-1', calculation: SNAPSHOT, anomalyFlag: false, varianceReason: null })
      .mockRejectedValueOnce(new PeriodLockedError('Reporting period February 2024 is locked'))
      .mockResolvedValueOnce({ id: 'rec-3', calculation: SNAPSHOT, anomalyFlag: false, varianceReason: null });

    const report = await service.import(
      dataEntry(),
      csvFile([
        row(),
        row({ periodValue: 'February' }),
        row({ periodValue: 'March' }),
      ]),
      NOTHING,
    );

    expect(report.accepted.map((a) => a.row)).toEqual([2, 4]);
    expect(report.accepted.map((a) => a.recordId)).toEqual(['rec-1', 'rec-3']);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ row: 3, code: 'period_locked' });
  });

  it.each([
    [new NotFoundException('Subsidiary not found'), 'not_found'],
    [new PeriodLockedError('Reporting period January 2024 is locked'), 'period_locked'],
    [new DuplicateActivityRecordError(), 'duplicate_existing'],
    [new BadRequestException('"Michaelmas" is not a period'), 'invalid'],
  ])('maps %s onto a row code', async (error, code) => {
    // By CLASS: the record service throws typed refusals, and rewording any
    // of their sentences changes nothing here. (The two conflicts used to be
    // told apart by their message, and a duplicate once reported as a locked
    // period for a whole release.)
    const { records, service } = build();
    records.create.mockRejectedValueOnce(error);

    const report = await service.import(dataEntry(), csvFile([row()]), NOTHING);

    expect(report.errors[0].code).toBe(code);
  });

  it('refuses an unexpected failure without echoing it back', async () => {
    // A raw driver error can carry a query, a path or a column name.
    const { records, service } = build();
    records.create.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 while running SELECT "secret"'),
    );

    const report = await service.import(dataEntry(), csvFile([row()]), NOTHING);

    expect(report.errors[0].code).toBe('unexpected');
    expect(report.errors[0].message).not.toMatch(/ECONNREFUSED|SELECT|10\.0\.0\.5/);
  });

  it('logs ONE line for a batch of unexpected failures, not one per row', async () => {
    // Measured: 50 rows carrying a 2,001-character `locationId` wrote 148,542
    // bytes of stderr — fifty Prisma stacks with code frames — which the
    // 1,000-row cap puts near 3 MB for one request, five of which a user may
    // send each minute. The row-level refusal is unchanged; the log is not.
    const { records, service } = build();
    records.create.mockRejectedValue(
      Object.assign(new Error('value too long for the column locationId'), {
        code: 'P2000',
      }),
    );
    // Distinct years, or the in-file duplicate check would refuse rows 2-50
    // before they ever reach `create`.
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ reportingYear: String(2000 + i) }),
    );

    const { result: report, logged } = await captureErrors(() =>
      service.import(dataEntry(), csvFile(rows), NOTHING),
    );

    // Every row still gets its own refusal, with the constant message.
    expect(report.errors).toHaveLength(50);
    expect(report.errors.every((e) => e.code === 'unexpected')).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('bulk import: 50 rows failed unexpectedly');
    expect(logged[0].message).toContain('first: Error P2000: value too long');
    // WHICH rows — spreadsheet numbering, so the header is row 1. Reporting
    // every failure against one row is worse than reporting none.
    expect(logged[0].message).toContain(
      '(2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 40 more)',
    );
    // ONE stack, COUNTED. `toContain` passes just as happily on fifty.
    expect(stackCount(logged[0].trace, 'Error: value too long')).toBe(1);
  });

  it('logs the batch line even when the Forbidden backstop aborts the import', async () => {
    // The backstop fires only while `accepted.length === 0` — which is exactly
    // the state a run of unexpected failures leaves behind. Without the
    // `finally` the 3-row driver incident would vanish with the throw.
    const { records, service } = build();
    records.create
      .mockRejectedValueOnce(new Error('driver said no'))
      .mockRejectedValueOnce(new Error('driver said no'))
      .mockRejectedValueOnce(new Error('driver said no'))
      .mockRejectedValueOnce(new CreateRoleRefusedError());
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ reportingYear: String(2000 + i) }),
    );

    const logged: { message: string; trace: unknown }[] = [];
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown, trace?: unknown) => {
        logged.push({ message: String(message), trace });
      });
    try {
      await expect(
        service.import(dataEntry(), csvFile(rows), NOTHING),
      ).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      spy.mockRestore();
    }

    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('bulk import: 3 rows failed unexpectedly');
  });

  it('keeps one batch per import — the accumulator is not shared between calls', async () => {
    // `BatchFailureLog` is a local because the service is a Nest singleton.
    // Hoisted to a field it would mix two tenants' row numbers into one line.
    const { records, service } = build();
    records.create.mockRejectedValue(new Error('driver said no'));

    const { logged } = await captureErrors(async () => {
      await service.import(dataEntry(), csvFile([row()]), NOTHING);
      await service.import(dataEntry(), csvFile([row()]), NOTHING);
    });

    expect(logged).toHaveLength(2);
    expect(logged[0].message).toContain('bulk import: 1 row failed unexpectedly');
    expect(logged[1].message).toContain('bulk import: 1 row failed unexpectedly');
  });

  it('counts a batch that fails two different ways, and describes the first', async () => {
    // The mixed batch: one accepted row, one refusal it understands, and two
    // unexpected failures of different classes.
    const { records, service } = build();
    records.create
      .mockRejectedValueOnce(new PeriodLockedError('Period 2001 January is locked.'))
      .mockRejectedValueOnce(new Error('driver said no'))
      .mockRejectedValueOnce(new TypeError('records.create is not a function'));
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ reportingYear: String(2000 + i) }),
    );

    const { result: report, logged } = await captureErrors(() =>
      service.import(dataEntry(), csvFile(rows), NOTHING),
    );

    expect(report.accepted).toHaveLength(1);
    expect(report.errors.map((e) => e.code)).toEqual([
      'period_locked',
      'unexpected',
      'unexpected',
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('bulk import: 2 rows failed unexpectedly (3, 4)');
    // Both are counted and named by row; the line describes the FIRST.
    expect(logged[0].message).toContain('first: Error: driver said no');
    // The mapped refusal is reported, never logged.
    expect(logged[0].message).not.toContain('locked');
  });

  it('folds a dry run’s unexpected failures too — the path `create` never sees', async () => {
    const { records, service } = build();
    records.previewCreate.mockRejectedValue(new Error('preview said no'));

    const { result: report, logged } = await captureErrors(() =>
      service.import(dataEntry(), csvFile([row(), row({ reportingYear: '2023' })]), DRY),
    );

    expect(records.create).not.toHaveBeenCalled();
    expect(report.errors).toHaveLength(2);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('bulk import: 2 rows failed unexpectedly (2, 3)');
  });

  it('logs nothing at all when every failure is one it understands', async () => {
    // A closed period or a taken slot is reported, never logged: they are the
    // ordinary answer to an ordinary file, and ERROR level is not for them.
    const { records, service } = build();
    records.create.mockRejectedValue(
      new PeriodLockedError('Period 2024 January is locked.'),
    );

    const { result: report, logged } = await captureErrors(() =>
      service.import(
        dataEntry(),
        csvFile([row(), row({ reportingYear: '2023' })]),
        NOTHING,
      ),
    );

    expect(report.errors.map((e) => e.code)).toEqual([
      'period_locked',
      'period_locked',
    ]);
    expect(logged).toEqual([]);
  });

  it('answers the role before the file — an unreadable one still gets the 403', async () => {
    const { service } = build();

    await expect(
      service.import(
        dataEntry({ role: 'consultant' }),
        csvFile([row()], { originalname: 'x.exe' }),
        DRY,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a role that may not author records before parsing its file — and audits it', async () => {
    // It used to be refused only by the record service inside the loop, so
    // the 403 was thrown past the audited pre-flight and before the batch row:
    // a consultant's import attempt left no trace at all. A READABLE file on
    // purpose: without the gate, every "not called" below would fail.
    const { audit, prisma, records, service } = build();

    await expect(
      service.import(dataEntry({ role: 'consultant' }), csvFile([row()]), DRY),
    ).rejects.toThrow(new ForbiddenException('Your role may not create activity records'));

    expect(records.previewCreate).not.toHaveBeenCalled();
    expect(records.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({ role: 'consultant' });
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      refused: true,
      dryRun: true,
      reason: 'Your role may not create activity records',
    });
  });

  it.each(['consultant', 'executive_viewer'] as const)(
    'refuses a %s even when no row would have reached the record service',
    async (role) => {
      // Every row fails validation, so the loop's own role check never ran and
      // this caller used to get a 200 report instead of a refusal.
      const { service } = build();

      await expect(
        service.import(dataEntry({ role }), csvFile([row({ activityValue: 'abc' })]), DRY),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('still rethrows a role refusal the record service raises mid-file as one 403', async () => {
    // A backstop, not the gate — but a thousand identical "forbidden" row
    // errors would still be a worse answer than one 403.
    const { records, service } = build();
    records.previewCreate.mockRejectedValue(new CreateRoleRefusedError());

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ periodValue: 'February' })]), DRY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not abort on a Forbidden nobody typed — that row is unexpected, the batch goes on', async () => {
    // The backstop fires on the CLASS. A `ForbiddenException` from elsewhere
    // in the graph is not a role refusal, and re-throwing it would discard the
    // report for every row after it.
    const { records, service } = build();
    records.previewCreate
      .mockRejectedValueOnce(new ForbiddenException('not yours'))
      .mockResolvedValueOnce({
        subsidiaryId: SUB_1,
        locationId: null,
        periodValue: 'February',
        calculation: SNAPSHOT,
        scope: 2,
        verdict: { anomalous: false, priorCount: 0, baseline: null },
      });

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' })]),
      DRY,
    );

    expect(report.errors).toEqual([expect.objectContaining({ row: 2, code: 'unexpected' })]);
    expect(report.accepted.map((a) => a.row)).toEqual([3]);
  });
});

describe('BulkUploadService — warnings', () => {
  it('warns that an anomalous row with no reason cannot then be submitted', async () => {
    // The one thing a dry run can say that validation cannot. Without it a
    // user imports a thousand rows and discovers half are stuck later.
    const { records, service } = build();
    records.previewCreate.mockResolvedValue({
      subsidiaryId: SUB_1,
      locationId: null,
      periodValue: 'January',
      calculation: SNAPSHOT,
      scope: 2,
      verdict: { anomalous: true, priorCount: 3, baseline: 0.1 },
    });

    const report = await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(report.accepted).toHaveLength(1);
    // Found by code, not by index: an Electricity row also carries the
    // evidence warning, and indexing would pin the order of two independent
    // rules together.
    expect(
      report.warnings.find((w) => w.code === 'would_block_submit'),
    ).toMatchObject({ row: 2, column: 'varianceReason' });
  });

  it('stays quiet when the anomalous row explains itself', async () => {
    const { records, service } = build();
    records.previewCreate.mockResolvedValue({
      subsidiaryId: SUB_1,
      locationId: null,
      periodValue: 'January',
      calculation: SNAPSHOT,
      scope: 2,
      verdict: { anomalous: true, priorCount: 3, baseline: 0.1 },
    });

    const report = await service.import(
      dataEntry(),
      csvFile([
        row({
          // Not an evidence-required category: this case asserts the ABSENCE
          // of a warning, so it must not also trip the evidence one.
          category: 'Business Travel',
          activityUnit: 'km',
          varianceReason: 'Second meter commissioned',
        }),
      ]),
      DRY,
    );

    expect(report.warnings).toHaveLength(0);
  });

  it('FLAGS a formula-leading reason and imports it unchanged', async () => {
    // Never neutralise on the way in: an apostrophe stored here would be
    // re-neutralised on the next export and corrupt the text permanently.
    // Never refuse either — "-15% after a line shutdown" leads with `-`.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ varianceReason: '-15% after a line shutdown' })]),
      NOTHING,
    );

    expect(report.warnings[0]).toMatchObject({ row: 2, code: 'formula_lead' });
    expect(report.accepted).toHaveLength(1);
    expect(records.create.mock.calls[0][1].varianceReason).toBe(
      '-15% after a line shutdown',
    );
  });

  it('reports warnings only for rows that are, or would be, imported', async () => {
    // A warning says what happens before a row "can be submitted", which is
    // noise on a row that will never exist — and counted into the verdict it
    // told a user importing one row of ten that five needed attention.
    const { service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([
        row(), // row 2: imports, and carries the evidence warning
        row({ periodValue: 'February', activityValue: 'abc', varianceReason: '=SUM(A1)' }), // row 3: invalid
      ]),
      DRY,
    );

    expect(report.accepted.map((a) => a.row)).toEqual([2]);
    expect(report.errors.map((e) => [e.row, e.code])).toEqual([[3, 'invalid']]);
    expect(report.warnings.map((w) => [w.row, w.code])).toEqual([[2, 'evidence_required']]);
  });

  it('drops a row’s warnings when the preview refuses it', async () => {
    // The measured shape: an electricity row the record service refuses (a
    // period its granularity does not have) AFTER the evidence warning had
    // already been pushed.
    const { records, service } = build();
    records.previewCreate.mockRejectedValueOnce(
      new BadRequestException('"Q5" is not a valid period for a quarterly record.'),
    );

    const report = await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(report.errors).toHaveLength(1);
    expect(report.warnings).toEqual([]);
  });

  it('drops a row’s warnings when the write itself refuses it', async () => {
    const { records, service } = build();
    records.create.mockRejectedValueOnce(
      new NoEmissionFactorError(
        'No emission factor found for category "Electricity", geography "TR", year 2019',
      ),
    );

    const report = await service.import(
      dataEntry(),
      csvFile([row({ varianceReason: '=1+1' })]),
      NOTHING,
    );

    expect(report.errors[0]).toMatchObject({ row: 2, code: 'no_factor' });
    expect(report.warnings).toEqual([]);
  });
});

describe('BulkUploadService — row validation reaches the real DTO rules', () => {
  it.each([
    ['a negative consumption figure', { activityValue: '-5' }, 'activityValue'],
    ['a category that does not exist', { category: 'Vibes' }, 'category'],
    ['a unit the calc engine does not know', { activityUnit: 'furlongs' }, 'activityUnit'],
    ['a year outside the allowed range', { reportingYear: '1066' }, 'reportingYear'],
  ])('refuses %s', async (_label, over, column) => {
    // Routed through `CreateActivityRecordDto` rather than a bespoke row
    // validator, so the importer cannot drift from what the API accepts.
    const { records, service } = build();

    const report = await service.import(dataEntry(), csvFile([row(over)]), NOTHING);

    expect(report.errors[0]).toMatchObject({ code: 'invalid', column });
    expect(records.create).not.toHaveBeenCalled();
  });

  it('refuses a blank consumption cell rather than importing a zero', async () => {
    // The defect this importer exists to avoid: `Number('')` is 0, and a zero
    // is a REPORTED quantity that enters the inventory.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ activityValue: '' })]),
      NOTHING,
    );

    expect(report.errors[0]).toMatchObject({
      code: 'invalid',
      column: 'activityValue',
    });
    expect(records.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Everything below closes a mutation that survived the first review.
// ---------------------------------------------------------------------------

describe('BulkUploadService — the figures that reach the write', () => {
  it('writes the cell values, unchanged', async () => {
    // `activityValue * 2` in the row mapper passed all 68 tests: `2400` still
    // satisfies `@Min(0)`, and `create` is mocked, so every emissions figure
    // in the file could be doubled on its way into the inventory with CI
    // green. In a product whose README calls wrong numbers a liability, this
    // is the assertion that has to exist.
    const { records, service } = build();

    await service.import(
      dataEntry(),
      csvFile([
        row({
          locationId: LOC_9,
          reportingYear: '2023',
          reportingPeriod: 'quarterly',
          periodValue: 'Q3',
          category: 'Natural Gas',
          activityValue: '1234.5',
          activityUnit: 'm3',
          varianceReason: 'Boiler replaced',
        }),
      ]),
      NOTHING,
    );

    expect(records.create.mock.calls[0][1]).toMatchObject({
      subsidiaryId: SUB_1,
      locationId: LOC_9,
      reportingYear: 2023,
      reportingPeriod: 'quarterly',
      periodValue: 'Q3',
      category: 'Natural Gas',
      activityValue: 1234.5,
      activityUnit: 'm3',
      varianceReason: 'Boiler replaced',
    });
  });

  it('reports the whole identity of an accepted row', async () => {
    // A preview that carried only `{row, tCo2e}` would force the browser to
    // re-parse the file to name the entity — a second implementation of row
    // semantics.
    const { service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ periodValue: '  january ' })]),
      DRY,
    );

    expect(report.accepted[0]).toEqual({
      row: 2,
      recordId: null,
      subsidiaryId: SUB_1,
      locationId: null,
      reportingYear: 2024,
      reportingPeriod: 'monthly',
      // The CANONICAL spelling the server will store, not the file's.
      periodValue: 'January',
      category: 'Electricity',
      tCo2e: 0.528,
      anomalous: false,
    });
  });

  it('reports no figure — not a zero — for a category that is not calculated', async () => {
    // Water is tracked by invoice and never calculated. `0` would be a
    // REPORTED quantity entering the inventory.
    const { records, service } = build();
    const uncalculated = {
      category: 'Water',
      reportingYear: 2024,
      inputValue: 100,
      inputUnit: 'm3',
    } as unknown as CalculationResult;
    records.create.mockResolvedValueOnce({
      id: 'rec-water',
      calculation: uncalculated,
      anomalyFlag: false,
      periodValue: 'January',
      varianceReason: null,
    });

    const report = await service.import(
      dataEntry(),
      csvFile([row({ category: 'Water', activityUnit: 'm3' })]),
      NOTHING,
    );

    expect(report.accepted[0].tCo2e).toBeNull();
  });
});

describe('BulkUploadService — the slot key is the whole key', () => {
  it('lets two locations report the same period and category', async () => {
    // Dropping `locationId` from the key survived every duplicate test,
    // because they all used `locationId: null`. The defect it hides: a second
    // site's consumption silently refused as a duplicate and dropped from the
    // inventory.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ locationId: LOC_A }), row({ locationId: LOC_B })]),
      NOTHING,
    );

    expect(report.errors).toHaveLength(0);
    expect(records.create).toHaveBeenCalledTimes(2);
  });

  it('does not treat a site record as taking the whole company’s slot', async () => {
    const { prisma, records, service } = build();
    prisma.activityRecord.findMany.mockResolvedValue([
      {
        subsidiaryId: SUB_1,
        locationId: LOC_A,
        reportingYear: 2024,
        reportingPeriod: 'monthly',
        periodValue: 'January',
        category: 'Electricity',
      },
    ]);

    const report = await service.import(dataEntry(), csvFile([row()]), NOTHING);

    expect(report.errors).toHaveLength(0);
    expect(records.create).toHaveBeenCalledTimes(1);
  });
});

describe('BulkUploadService — an id is accepted in one spelling, in either case', () => {
  // Postgres and Prisma resolve `{…}`, `urn:uuid:…` and the unhyphenated form
  // of a uuid, and the importer once folded all of them onto the stored
  // spelling (#113) — a hand-measured grammar table, a probe to keep it honest
  // and a rewrite of the caller's cells, for spellings nobody types: every id
  // the system shows is hyphenated. The boundary now accepts the hyphenated
  // shape, lowercases it, and refuses the rest on the row.
  const SUB = 'a1111111-1111-4111-8111-1111111111aa';
  /** Hex LETTERS: an all-digit id makes the case tests vacuous. */
  const LOC = '09ed17d3-aef5-4da2-89c1-3b001ac50e94';
  const OTHER_LOC = '09ed17d3-aef5-4da2-89c1-3b001ac50e95';
  const FOREIGN = 'f0000000-0000-4000-8000-00000000000f';
  const MISSPELT = [
    ['braced', `{${LOC}}`],
    ['urn', `urn:uuid:${LOC}`],
    ['unhyphenated', LOC.replace(/-/g, '')],
    ['mis-grouped', '09ed17d3a-ef5-4da2-89c1-3b001ac50e94'],
  ] as const;
  const entry = () => dataEntry({ accessibleSubsidiaryIds: [SUB] });
  const stored = (locationId: string | null) => ({
    subsidiaryId: SUB,
    locationId,
    reportingYear: 2024,
    reportingPeriod: 'monthly',
    periodValue: 'January',
    category: 'Electricity',
  });

  it('claims ONE slot for the two cases of the same location', async () => {
    const { records, service } = build();

    const report = await service.import(
      entry(),
      csvFile([LOC, LOC.toUpperCase()].map((locationId) => row({ subsidiaryId: SUB, locationId }))),
      DRY,
    );

    expect(report.accepted).toHaveLength(1);
    expect(report.errors.map((e) => e.code)).toEqual(['duplicate_in_file']);
    expect(records.previewCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps two DIFFERENT ids in two slots', async () => {
    const { records, service } = build();

    const report = await service.import(
      entry(),
      csvFile([
        row({ subsidiaryId: SUB, locationId: LOC.toUpperCase() }),
        row({ subsidiaryId: SUB, locationId: OTHER_LOC }),
      ]),
      NOTHING,
    );

    expect(report.errors).toHaveLength(0);
    expect(records.create).toHaveBeenCalledTimes(2);
  });

  it.each(MISSPELT)('refuses a %s locationId on its own row, naming the column', async (_label, locationId) => {
    const { records, service } = build();

    const report = await service.import(
      entry(),
      csvFile([row({ subsidiaryId: SUB, locationId }), row({ subsidiaryId: SUB, periodValue: 'February' })]),
      DRY,
    );

    expect(report.errors).toEqual([
      expect.objectContaining({ row: 2, column: 'locationId', code: 'invalid' }),
    ]);
    // The good row is unaffected, and the bad id never reached the service.
    expect(report.accepted.map((a) => a.row)).toEqual([3]);
    expect(records.previewCreate).toHaveBeenCalledTimes(1);
  });

  it.each(MISSPELT)('refuses a %s subsidiaryId on its own row — a typo is not a foreign entity', async (_label, spelt) => {
    // The spelling of the caller's OWN subsidiary. Refusing the whole file
    // with "does not exist or is not yours" would be wrong and unfindable.
    const subsidiaryId = spelt.replace(LOC, SUB).replace(LOC.replace(/-/g, ''), SUB.replace(/-/g, ''));
    const { audit, prisma, records, service } = build();

    const report = await service.import(entry(), csvFile([row({ subsidiaryId })]), DRY);

    expect(report.errors).toEqual([
      expect.objectContaining({ row: 2, column: 'subsidiaryId', code: 'invalid' }),
    ]);
    expect(records.previewCreate).not.toHaveBeenCalled();
    // Never sent to Postgres: a non-uuid in an `IN` list is a P2023, and that
    // query runs outside every catch.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    // A dry run that ran to completion: one batch row, not a refusal.
    expect(audit.record.mock.calls[0][1].diff).not.toHaveProperty('refused');
  });

  it('matches a stored slot the file spells in the other case', async () => {
    const { prisma, records, service } = build();
    prisma.activityRecord.findMany.mockResolvedValue([stored(LOC)]);

    const report = await service.import(
      entry(),
      csvFile([row({ subsidiaryId: SUB.toUpperCase(), locationId: LOC.toUpperCase() })]),
      DRY,
    );

    expect(report.errors.map((e) => e.code)).toEqual(['duplicate_existing']);
    expect(records.previewCreate).not.toHaveBeenCalled();
  });

  it('reports the stored spelling back, asks the database for it, and persists it', async () => {
    const { prisma, records, service } = build();

    const report = await service.import(
      entry(),
      csvFile([row({ subsidiaryId: SUB.toUpperCase(), locationId: LOC.toUpperCase() })]),
      NOTHING,
    );

    expect(report.accepted[0]).toMatchObject({ subsidiaryId: SUB, locationId: LOC });
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where.subsidiaryId).toEqual({
      in: [SUB],
    });
    expect(records.create.mock.calls[0][1]).toMatchObject({ subsidiaryId: SUB, locationId: LOC });
  });

  it('refuses the WHOLE file for a foreign entity id, in either case — and only for an id', async () => {
    for (const foreign of [FOREIGN, FOREIGN.toUpperCase()]) {
      const { records, service } = build();
      await expect(
        service.import(
          entry(),
          csvFile([row({ subsidiaryId: SUB }), row({ subsidiaryId: foreign, periodValue: 'February' })]),
          DRY,
        ),
      ).rejects.toBeInstanceOf(InaccessibleEntityError);
      expect(records.previewCreate).not.toHaveBeenCalled();
    }

    // A foreign id in a spelling the boundary does not accept is never
    // resolved at all: it is a row error like any other typo, and nothing
    // about it is looked up.
    const { prisma, service } = build();
    const report = await service.import(entry(), csvFile([row({ subsidiaryId: `{${FOREIGN}}` })]), DRY);
    expect(report.errors).toEqual([
      expect.objectContaining({ row: 2, column: 'subsidiaryId', code: 'invalid' }),
    ]);
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('takes a padded id cell, and asks the database for one entity once however it is cased', async () => {
    const { prisma, service } = build();

    const report = await service.import(
      entry(),
      csvFile([
        row({ subsidiaryId: ` ${SUB} ` }),
        row({ subsidiaryId: SUB.toUpperCase(), periodValue: 'February' }),
      ]),
      DRY,
    );

    expect(report.errors).toHaveLength(0);
    expect(report.accepted.map((a) => a.subsidiaryId)).toEqual([SUB, SUB]);
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where.subsidiaryId).toEqual({
      in: [SUB],
    });
  });

  it('does not let a blank location collide with a named one, or be refused as misspelt', async () => {
    // A blank `locationId` means the whole company. It is not an id, and the
    // shape rule must not turn every company-level row into an error.
    const { records, service } = build();

    const report = await service.import(
      entry(),
      csvFile([row({ subsidiaryId: SUB }), row({ subsidiaryId: SUB, locationId: LOC })]),
      DRY,
    );

    expect(report.errors).toHaveLength(0);
    expect(records.previewCreate).toHaveBeenCalledTimes(2);
  });
});

describe('BulkUploadService — the audit row tells the truth', () => {
  it('says an apply was an apply, and counts it', async () => {
    // Hardcoding `dryRun: true` in the diff survived every test: only the dry
    // run's audit row was ever asserted. An append-only trail claiming "dry
    // run" for a batch that wrote records is a compliance defect.
    const { audit, service } = build();

    await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' }), row({ activityValue: 'x' })]),
      NOTHING,
    );

    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      bulk: true,
      dryRun: false,
      fileName: 'data.csv',
      totalRows: 3,
      acceptedCount: 2,
      rejectedCount: 1,
    });
  });

  it('records a refusal that never reached the loop', async () => {
    // The event most worth keeping used to leave no trace at all: the batch
    // row was written after a loop the refusal prevented.
    const { audit, records, service } = build();

    await expect(
      service.import(dataEntry(), csvFile([row({ subsidiaryId: SUB_99 })]), NOTHING),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(records.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({ refused: true });
  });

  it('truncates a filename rather than storing it whole', async () => {
    // Caller-controlled, ~16 KB of it allowed by busboy, routinely carrying a
    // person's name, into a table with no delete path.
    const { audit, service } = build();
    const long = `${'n'.repeat(4000)}.csv`;

    await service.import(dataEntry(), csvFile([row()], { originalname: long }), DRY);

    expect(
      (audit.record.mock.calls[0][1].diff as { fileName: string }).fileName.length,
    ).toBe(255);
  });

  it('still returns the report when the batch audit row cannot be written', async () => {
    // By then the records exist. Throwing would hand the caller a 500 with no
    // report — a partial import nobody can enumerate, which is precisely what
    // this module's design exists to prevent.
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(new Error('audit_log unavailable'));

    const report = await service.import(dataEntry(), csvFile([row()]), NOTHING);

    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0].recordId).toBe('rec-1');
  });
});

describe('BulkUploadService — the remaining refusals', () => {
  it('reports a missing emission factor as its own thing, not as an access problem', async () => {
    // The archetypal use of this feature: importing 2019 history for a
    // category whose factors start in 2021. Reported as `not_found` it told
    // the user they had a permissions problem.
    const { records, service } = build();
    records.create.mockRejectedValueOnce(
      new NoEmissionFactorError(
        'No emission factor found for category "Electricity", geography "TR", year 2019',
      ),
    );

    const report = await service.import(dataEntry(), csvFile([row()]), NOTHING);

    expect(report.errors[0]).toMatchObject({ code: 'no_factor' });
    expect(report.errors[0].message).toMatch(/emission factor/i);
  });

  it('warns that an evidence-required category cannot be submitted after import', async () => {
    const { service } = build();

    const report = await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(report.warnings.find((w) => w.code === 'evidence_required')).toMatchObject({
      row: 2,
      column: 'category',
    });
  });

  it('reports a BLANK reporting entity on its own row, not as a foreign one', async () => {
    // One empty cell in row 400 used to refuse all 1,000 rows, saying the
    // entity "does not exist or is not yours" — wrong, and unfindable.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ subsidiaryId: '' })]),
      NOTHING,
    );

    expect(report.accepted).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ row: 3, code: 'invalid' });
    expect(records.create).toHaveBeenCalledTimes(1);
  });

  it('keeps an out-of-range year away from the database', async () => {
    // `strictNumber` accepts any digit string and this query runs OUTSIDE the
    // per-row try/catch, so `99999999999` used to reach Prisma as an INT4
    // conversion error — a 500 with no report and no audit row, from one cell.
    const { prisma, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ reportingYear: '99999999999' })]),
      NOTHING,
    );

    // Out of range, so it never enters the `in` list — and with no usable
    // year the pre-check skips the query entirely rather than sending one it
    // knows matches nothing.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    expect(report.errors[0]).toMatchObject({ code: 'invalid', column: 'reportingYear' });
  });

  it('refuses a file that is only a header', async () => {
    const { service } = build();
    await expect(
      service.import(dataEntry(), csvFile([]), NOTHING),
    ).rejects.toThrow(/no data rows/);
  });

  it('accepts a spreadsheet whatever type the browser claims it is', async () => {
    // The extension is the gate; the declared MIME type is advisory, because
    // it is client-controlled and browsers disagree about spreadsheets.
    const { service } = build();

    for (const mimetype of ['application/octet-stream', 'text/x-csv', '']) {
      const report = await service.import(
        dataEntry(),
        csvFile([row()], { mimetype }),
        DRY,
      );
      expect(report.accepted).toHaveLength(1);
    }
  });

  it('refuses anything that is not a spreadsheet, whatever type it claims', async () => {
    const { service } = build();
    await expect(
      service.import(
        dataEntry(),
        csvFile([row()], { originalname: 'payload.exe', mimetype: 'text/csv' }),
        DRY,
      ),
    ).rejects.toThrow(/csv or \.xlsx/);
  });

  it('tolerates a space after a comma in a hand-edited file', async () => {
    // `sub-1 ,,2024,…` refused the WHOLE file with "does not exist or is not
    // yours" if any one of the three `.trim()` calls was dropped — and
    // dropping only one of them makes `storedKeys` silently stop matching.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ subsidiaryId: ` ${SUB_1} ` })]),
      NOTHING,
    );

    expect(report.errors).toHaveLength(0);
    expect(records.create.mock.calls[0][1].subsidiaryId).toBe(SUB_1);
  });
});

describe('BulkUploadService — a dry run touches no write API at all', () => {
  it('calls neither the record service nor Prisma to write', async () => {
    const { prisma, records, service } = build();

    await service.import(dataEntry(), csvFile([row(), row({ periodValue: 'March' })]), DRY);

    expect(records.create).not.toHaveBeenCalled();
    // Explicit, rather than relying on the mock lacking the method: without a
    // spy a stray write throws a TypeError that the row catch turns into an
    // `unexpected` error, and the suite fails for the wrong reason.
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });
});

/** Two tenants in one database, so an unscoped query has something to leak. */
const ALL_SUBSIDIARIES = [
  { id: SUB_1, legalName: 'Mine Ltd.', tradingName: null, geographyCode: 'TR' },
  { id: SUB_9, legalName: 'Other Tenant Ltd.', tradingName: null, geographyCode: 'UK' },
];
const ALL_LOCATIONS = [
  { id: LOC_1, subsidiaryId: SUB_1, name: 'My Site', geographyCode: 'TR' },
  { id: LOC_9, subsidiaryId: SUB_9, name: 'Their Site', geographyCode: 'UK' },
];

/** Everything the reference sheet of a generated template says. */
async function referenceTextOf(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[1];
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) =>
      cells.push(String(cell.value ?? '')),
    );
    lines.push(cells.join(' | '));
  });
  return lines.join('\n');
}

describe('BulkUploadService — the template', () => {
  /** Filters like a real database would, so an unscoped query returns BOTH. */
  function twoTenants(prisma: ReturnType<typeof build>['prisma']): void {
    prisma.subsidiary.findMany.mockImplementation(
      ({ where }: { where?: { id?: { in?: string[] } } }) =>
        Promise.resolve(
          ALL_SUBSIDIARIES.filter((s) => where?.id?.in?.includes(s.id) ?? true),
        ),
    );
    prisma.location.findMany.mockImplementation(
      ({ where }: { where?: { subsidiaryId?: { in?: string[] } } }) =>
        Promise.resolve(
          ALL_LOCATIONS.filter(
            (l) => where?.subsidiaryId?.in?.includes(l.subsidiaryId) ?? true,
          ),
        ),
    );
  }

  it('names only what this caller can reach — asserted on the FILE', async () => {
    // Asserting the `where` of `calls[0]` proved only the shape of one query.
    // A mutant that kept that query untouched and merged a SECOND, unscoped
    // one passed all 53 service tests, handing every user an XLSX naming
    // every subsidiary and location in the database — the quietest possible
    // tenant leak, in a file people email around. The bytes are the only
    // assertion that survives that.
    const { prisma, service } = build();
    twoTenants(prisma);

    const text = await referenceTextOf(
      await service.template(dataEntry({ accessibleSubsidiaryIds: [SUB_1] })),
    );

    expect(text).toContain(SUB_1);
    expect(text).toContain('Mine Ltd.');
    expect(text).toContain('My Site');
    expect(text).not.toContain(SUB_9);
    expect(text).not.toContain('Other Tenant Ltd.');
    expect(text).not.toContain('Their Site');
  });

  it('drops a location whose parent this caller cannot reach', async () => {
    // Defence in depth inside the builder: even handed a foreign location it
    // renders none, because it walks subsidiaries and looks locations up
    // under them.
    const { prisma, service } = build();
    prisma.subsidiary.findMany.mockResolvedValue([ALL_SUBSIDIARIES[0]]);
    prisma.location.findMany.mockResolvedValue(ALL_LOCATIONS);

    const text = await referenceTextOf(await service.template(dataEntry()));

    expect(text).toContain('My Site');
    expect(text).not.toContain('Their Site');
  });

  it('scopes both queries to the accessible set', async () => {
    const { prisma, service } = build();

    await service.template(dataEntry({ accessibleSubsidiaryIds: [SUB_1] }));

    expect(prisma.subsidiary.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [SUB_1] },
    });
    expect(prisma.location.findMany.mock.calls[0][0].where).toEqual({
      subsidiaryId: { in: [SUB_1] },
    });
  });

  it('returns a workbook the importer can read back', async () => {
    const { prisma, service } = build();
    prisma.subsidiary.findMany.mockResolvedValue([
      {
        id: SUB_1,
        legalName: 'Sub One',
        tradingName: null,
        geographyCode: 'TR',
      },
    ]);

    const buffer = await service.template(dataEntry());

    // Magic bytes: a real .xlsx is a zip, and a caller that got JSON here
    // would find out only when Excel refused the download.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('writes nothing', async () => {
    const { prisma, records, audit, service } = build();

    await service.template(dataEntry());

    expect(records.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    // No audit row either: a download is not a mutation, and audit_log has no
    // correction path for rows written on a read.
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('BulkUploadService — what the UAT-prep review passes found', () => {
  it.each(['data_entry', 'super_admin'] as const)('lets a %s through the role gate', async (role) => {
    // The gate is the record service's own rule. Narrowing it to one role
    // passed every test until this one.
    const { audit, service } = build();

    const report = await service.import(dataEntry({ role }), csvFile([row()]), DRY);

    expect(report.accepted).toHaveLength(1);
    expect(audit.record.mock.calls[0][1].diff).not.toHaveProperty('refused');
  });

  it('states the entity refusal as its reason alone', async () => {
    // The panel prints "Nothing was imported." under every whole-file refusal;
    // the sentence saying it as well put it on screen twice.
    const { service } = build();

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ subsidiaryId: SUB_99 })]), NOTHING),
    ).rejects.toThrow(
      new BadRequestException(
        'Row(s) 3 name a reporting entity that does not exist or is not yours.',
      ),
    );
  });

  it('neither leaks a refused row’s warning into the next row nor repeats one', async () => {
    const { service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([
        row(),
        row({ periodValue: 'February', activityValue: 'abc', varianceReason: '=SUM(A1)' }),
        row({ periodValue: 'March' }),
      ]),
      DRY,
    );

    expect(report.accepted.map((a) => a.row)).toEqual([2, 4]);
    expect(report.warnings.map((w) => [w.row, w.code])).toEqual([
      [2, 'evidence_required'],
      [4, 'evidence_required'],
    ]);
  });

  it.each([[''], [null], [undefined], [0]])(
    'refuses a non-boolean dryRun (%s) instead of importing',
    async (value) => {
      // The DTO makes it a boolean over HTTP. Every other caller used to reach a
      // branch that writes records whenever the flag is not truthy.
      const { audit, records, service } = build();

      const error = await service
        .import(dataEntry(), csvFile([row()]), { dryRun: value as unknown as boolean })
        .catch((e: unknown) => e);
      // The class as well as the words: `toThrow(instance)` compares messages
      // only, and a plain Error here would reach the caller as a 500.
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe('dryRun must be true or false.');
      expect(records.create).not.toHaveBeenCalled();
      expect(records.previewCreate).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('reports a refusal raised after a row was written on its row, not as a bare 403', async () => {
    // No transaction spans the batch: rethrowing here would hand the caller a
    // 403 for a file that was partly imported, with no report and no batch row.
    const { audit, records, service } = build();
    records.create
      .mockImplementationOnce((_user, dto) =>
        Promise.resolve({
          id: 'rec-1',
          calculation: SNAPSHOT,
          anomalyFlag: false,
          periodValue: dto.periodValue,
          varianceReason: null,
        }),
      )
      .mockRejectedValueOnce(new CreateRoleRefusedError());

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' })]),
      NOTHING,
    );

    expect(report.accepted.map((a) => a.recordId)).toEqual(['rec-1']);
    expect(report.errors.map((e) => e.row)).toEqual([3]);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({ acceptedCount: 1, rejectedCount: 1 });
  });

  it('stores a filename Postgres will accept — no NUL, no half of a character', async () => {
    // Either shape made the audit write fail, and a failed write is swallowed
    // by design — so the refusal the row exists to keep left no trace at all.
    const { audit, service } = build();

    await expect(
      service.import(
        dataEntry({ role: 'consultant' }),
        csvFile([row()], { originalname: 'probe\u0000.csv' }),
        DRY,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({ fileName: 'probe.csv' });

    // 254 characters and an emoji: a UTF-16 slice to 255 kept half of it.
    const long = `${'a'.repeat(254)}😀.csv`;
    await service.import(dataEntry(), csvFile([row()], { originalname: long }), DRY);
    expect(audit.record.mock.calls[1][1].diff).toMatchObject({
      fileName: `${'a'.repeat(254)}😀`,
    });
  });

  it('does not audit a header refusal — a malformed file is a 400, not an event about the caller', async () => {
    // These used to be audited, and the reason then carried the file's own
    // header text into an append-only table at five rows a minute per user.
    const { audit, service } = build();
    const file = {
      ...csvFile([]),
      buffer: Buffer.from(`${HEADER},bad\u0000col\n${row()}`),
    } as Express.Multer.File;

    await expect(service.import(dataEntry(), file, DRY)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected pre-flight failure without auditing it', async () => {
    // Only the two refusals that are ABOUT the caller are recorded. A failure
    // nobody typed — here the multer buffer itself throwing — is not one.
    const { audit, service } = build();
    const file = csvFile([row()]);
    // Defined after `csvFile` builds the object: its spread would call a getter.
    Object.defineProperty(file, 'buffer', {
      get() {
        throw new Error('boom');
      },
    });

    await expect(service.import(dataEntry(), file, DRY)).rejects.toThrow(/^boom/);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('drops the characters that disguise a name in the audit drawer', async () => {
    // Rendered, `invoice_<U+202E>fdp.xlsx` read as a PDF, and a zero-width
    // space made two different names look identical.
    const { audit, service } = build();

    await service.import(
      dataEntry(),
      csvFile([row()], { originalname: 'invoice_\u202Efdp\u200B.csv' }),
      DRY,
    );

    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      fileName: 'invoice_fdp.csv',
    });
  });

  it('refuses a header of disguised cells with a sentence that keeps every marker whole — and writes no audit row', async () => {
    // A marker is one unit but many code points; a sentence cut in units can
    // end `a<U+20`, a label that reads as a space. Header refusals used to be
    // audited and this pinned the STORED sentence; they are not audited any
    // more (a malformed file says nothing about the caller), so what is
    // pinned is the sentence the caller gets back.
    const { audit, service } = build();
    const cell = `a${String.fromCodePoint(0x2063).repeat(40)}`.repeat(20);
    const header = `${HEADER},${[cell, cell, cell, cell, cell, 'x'].join(',')}`;
    const file = {
      ...csvFile([]),
      buffer: Buffer.from([header, row()].join('\n')),
    } as Express.Multer.File;

    const error = await service.import(dataEntry(), file, DRY).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('Unrecognised column(s)');
    expect((error as Error).message).not.toMatch(/<U\+[0-9A-F]*$/);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('cannot build a header refusal longer than the audit reason bound', async () => {
    // Derived from the sentence `mapHeader` really throws, not from a copy of
    // its template: every quoted cell at its code-point bound, and then the
    // largest "(+N more)" a header row can carry — an unknown cell costs at
    // least two bytes, so a file cannot name more cells than half its size.
    // Header refusals are no longer audited, so the bound is now a ceiling on
    // the sentence the caller gets back; it is kept so that widening a quote
    // bound or adding a column is a deliberate act.
    const { service } = build();
    const cell = `aaa${String.fromCodePoint(0x200b)}`.repeat(6);
    const header = `${HEADER},${[
      ...Array.from({ length: QUOTED_FRAGMENTS }, () => cell),
      'x',
    ].join(',')}`;
    const file = {
      ...csvFile([]),
      buffer: Buffer.from([header, row()].join('\n')),
    } as Express.Multer.File;

    const error = await service.import(dataEntry(), file, DRY).catch((e: unknown) => e);

    const message = (error as Error).message;
    const fragment = `${'aaa<U+200B>'.repeat(5)}aaa…`;
    // A worst case only if every quote is as long as its bound allows.
    expect([...fragment].length).toBe(CALLER_TEXT_QUOTE_MAX_CODE_POINTS + 1);
    expect(message).toContain(`"${fragment}", "${fragment}"`);
    const digits = String(Math.floor(BULK_UPLOAD_MAX_SIZE_BYTES / 2)).length;
    const longest = message.replace(' (+1 more)', ` (+${'9'.repeat(digits)} more)`);

    expect([...longest].length).toBeLessThanOrEqual(AUDIT_REASON_MAX_LENGTH);
    // And with room to spare, deliberately. The ceiling is 490 at a 58
    // code-point quote, 495 at 59 and exactly 500 at 60 — so a bound raised to
    // 60 would pass the line above while leaving nothing for a reworded
    // sentence or a tenth column.
    expect(AUDIT_REASON_MAX_LENGTH - [...longest].length).toBeGreaterThanOrEqual(10);
  });

  it('drops every format character from the file name, and names none of them', async () => {
    // A name is stored, not quoted: markers belong to a refusal's sentence.
    // An invisible operator, a tag character and U+2028 all passed the old
    // rule.
    const { audit, service } = build();
    const hidden = [0x2063, 0xe0041, 0x2028]
      .map((code) => String.fromCodePoint(code))
      .join('');

    await service.import(
      dataEntry(),
      csvFile([row()], { originalname: `invoice${hidden}.csv` }),
      DRY,
    );

    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      fileName: 'invoice.csv',
    });
  });

  it('does not retry an audit write the database refused a value in — it logs it and still answers', async () => {
    // A retry that re-wrote the row without the caller's text once lived here.
    // The filename is sanitised before it reaches the row and the audited
    // reasons carry no caller text, so a refusal that still happens is a bug
    // to see in the log, not to write around.
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(
      Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }),
    );

    const { result: report, logged } = await captureErrors(() =>
      service.import(dataEntry(), csvFile([row(), row({ periodValue: 'February' })]), NOTHING),
    );

    expect(report.accepted).toHaveLength(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toContain('batch audit row failed to write');
  });

  it.each([0x01, 0x0a, 0x1f, 0x7f, 0x80, 0x9f, 0xd800])(
    'drops code unit %d from a stored name',
    async (code) => {
      // Every control character and an unpaired surrogate, not just U+0000:
      // the docblock promises all of them.
      const { audit, service } = build();

      await service.import(
        dataEntry(),
        csvFile([row()], { originalname: `x${String.fromCharCode(code)}.csv` }),
        DRY,
      );

      expect(audit.record.mock.calls[0][1].diff).toMatchObject({ fileName: 'x.csv' });
    },
  );

  it('does not retry a refusal’s audit write either — a failure that could have committed would write the row twice', async () => {
    // A dropped connection or a timeout can fail AFTER the insert committed,
    // and `audit_log` has no delete path for the duplicate.
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    await expect(
      service.import(dataEntry({ role: 'consultant' }), csvFile([row()]), DRY),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it.each([[''], ['   ']])(
    'keeps a blank reporting entity (%j) out of the stored-slot query',
    async (blank) => {
      // Postgres refuses '' as a uuid (P2023). This query runs outside every
      // catch, so one blank cell was a 500 with no report and no audit row. The
      // mock says no the way the database does — a mock that cannot say no is
      // not a test. Whitespace too: a filter placed before the trim would let
      // '   ' through, to reach Postgres as ''.
      const { prisma, service } = build();
      prisma.activityRecord.findMany.mockImplementation(
        (args: { where: { subsidiaryId: { in: string[] } } }) =>
          args.where.subsidiaryId.in.includes('')
            ? Promise.reject(new Error('P2023: Error creating UUID, invalid length'))
            : Promise.resolve([]),
      );

      const report = await service.import(
        dataEntry(),
        csvFile([row(), row({ subsidiaryId: blank })]),
        DRY,
      );

      expect(report.accepted).toHaveLength(1);
      expect(report.errors[0]).toMatchObject({ row: 3, code: 'invalid' });
    },
  );
});

describe('BulkUploadService — what the report repeats back', () => {
  // Built from code points, never typed: escape sequences typed into this repo
  // have arrived in files as the literal, invisible character.
  const nul = String.fromCharCode(0);
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);

  it.each([
    ['reportingYear', 'is not a whole year.'],
    ['activityValue', 'is not a number. Use a plain figure with no thousands separator.'],
  ])('quotes a refused %s cell, naming what it cannot show', async (column, tail) => {
    // The disguises lead the cell. Named, they cost the quote one marker and
    // the value still shows; dropped in silence, the sentence refused a value
    // it then printed as though nothing were wrong with it.
    const { service } = build();
    const cell = `${rlo}${nul}${zwsp}${'9'.repeat(20)}${'x'.repeat(40_000)}`;

    const report = await service.import(
      dataEntry(),
      csvFile([row({ [column]: cell })]),
      DRY,
    );

    expect(report.errors).toEqual([
      {
        row: 2,
        column,
        code: 'invalid',
        message: `"<U+202E U+0000 U+200B>${'9'.repeat(20)}${'x'.repeat(16)}…" ${tail}`,
      },
    ]);
  });

  it('stays small when one shared string backs a refused cell on every row', async () => {
    // The measured shape: one 32,000-character string in the year cell of a
    // thousand rows, with no entity id (a blank one passes the pre-flight).
    // A 12,416-byte workbook came back as a 32,092,008-byte report.
    const { service } = build();
    const dataRows = Array.from(
      { length: BULK_UPLOAD_MAX_ROWS },
      (_, i) => `<row r="${i + 2}"><c r="C${i + 2}" t="s"><v>0</v></c></row>`,
    );
    const buffer = xlsx({
      // `_x202E_` is how a workbook writes U+202E; the reader decodes it.
      sharedStrings: [`<t>_x202E_${'Y'.repeat(32_000)}</t>`],
      sheetData: [sheetRow(1, HEADER.split(',')), ...dataRows].join(''),
    });
    const file = {
      originalname: 'history.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: buffer.length,
      buffer,
    } as Express.Multer.File;

    const report = await service.import(dataEntry(), file, DRY);

    const message = `"<U+202E>${'Y'.repeat(39)}…" is not a whole year.`;
    expect(report.errors).toHaveLength(BULK_UPLOAD_MAX_ROWS);
    expect(report.errors.filter((e) => e.message !== message)).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(200_000);
  });

  it.each([
    [
      'a refusal passed through from the record service',
      () => new BadRequestException(`${rlo}${'x'.repeat(10_000)}`),
      'invalid',
      `${'x'.repeat(BULK_UPLOAD_MESSAGE_MAX_LENGTH)}…`,
    ],
    [
      'a missing factor, classified by its class whatever its text',
      () => new NoEmissionFactorError(`${'z'.repeat(600)}${nul}`),
      'no_factor',
      `${'z'.repeat(BULK_UPLOAD_MESSAGE_MAX_LENGTH)}…`,
    ],
    [
      'a closed period, told apart from a taken slot by its class',
      () => new PeriodLockedError(`${nul}${'p'.repeat(10_000)}`),
      'period_locked',
      `${'p'.repeat(BULK_UPLOAD_MESSAGE_MAX_LENGTH)}…`,
    ],
  ])('bounds and cleans %s', async (_label, error, code, message) => {
    const { records, service } = build();
    records.previewCreate.mockRejectedValueOnce(error());

    const report = await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(report.errors).toEqual([{ row: 2, column: null, code, message }]);
  });

  it('answers a huge unit cell with the cap’s own sentence, which quotes nothing', async () => {
    // `@MaxLength` is the bottom decorator, so class-validator registers it
    // first and the report publishes ITS sentence. The vocabulary's quoted one
    // — which used to come back 100,053 characters long — is built either way,
    // because every constraint on a property is evaluated. Pinned as the whole
    // issue: swapping the two decorators, or taking the last constraint
    // instead of the first, changes what a user reads and nothing else caught
    // it.
    const { service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ activityUnit: `${rlo}${'k'.repeat(100_000)}` })]),
      DRY,
    );

    expect(report.errors).toEqual([
      {
        row: 2,
        column: 'activityUnit',
        code: 'invalid',
        message: `activityUnit must be shorter than or equal to ${ACTIVITY_UNIT_MAX_LENGTH} characters`,
      },
    ]);
  });

  it('strips a KNOWN unit’s padding rather than refusing the row', async () => {
    // What the cap was reaching for, done by the transform instead. This case
    // was written to stop the row being "priced and written, with the padding
    // stored verbatim and frozen into an immutable snapshot" — and the cap
    // bought that only above 32 characters, while a single interior carriage
    // return sailed through at ten. `storableUnit` collapses the run at the
    // boundary, so the padding reaches no service at ANY length, and a
    // spreadsheet cell with a sloppy unit imports as the unit it plainly means
    // instead of costing the user a row.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ activityUnit: `cubic${' '.repeat(40)}metres` })]),
      DRY,
    );

    expect(report.errors).toEqual([]);
    expect(report.accepted).toHaveLength(1);
    expect(records.previewCreate).toHaveBeenCalledTimes(1);
    expect(records.previewCreate.mock.calls[0][1].activityUnit).toBe('cubic metres');
  });

  it('returns the file name by the audit row’s own rule', async () => {
    // Only the audit copy was cleaned: the report returned a 417-character name
    // carrying U+202E and U+0000 as it arrived.
    const { audit, service } = build();
    // A non-ASCII letter the rule keeps, in an English word: the cut counts
    // code points, and a cedilla must survive both the cleaning and the cut.
    const name = `Façade_${rlo}${nul}${zwsp}${'n'.repeat(300)}.csv`;

    const report = await service.import(
      dataEntry(),
      csvFile([row()], { originalname: name }),
      DRY,
    );

    expect(report.fileName).toBe(`Façade_${'n'.repeat(248)}`);
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({
      fileName: report.fileName,
    });
  });

  it('gives every data row one outcome, so the row cap bounds the error count', async () => {
    // What BULK_UPLOAD_MESSAGE_MAX_LENGTH's arithmetic rests on: a row is
    // accepted, or refused once, however many things are wrong with it.
    const { records, service } = build();
    records.previewCreate.mockRejectedValueOnce(
      new BadRequestException('"Q5" is not a valid period for a quarterly record.'),
    );

    const report = await service.import(
      dataEntry(),
      csvFile([
        row({ periodValue: 'February' }),
        row({ reportingYear: 'soon', activityValue: '1,2', category: 'Vibes' }),
        row({ category: 'Vibes', activityUnit: 'furlongs' }),
        row({ periodValue: 'March' }),
        row({ periodValue: 'March' }),
        row({ periodValue: 'April', varianceReason: '=1+1' }),
      ]),
      DRY,
    );

    const refused = report.errors.map((e) => e.row);
    expect(refused).toEqual([2, 3, 4, 6]);
    expect(report.accepted.map((a) => a.row)).toEqual([5, 7]);
    expect(report.accepted.length + refused.length).toBe(report.totalRows);
  });

  it('keeps whole the longest sentences a row can be refused with', async () => {
    // Pinned as a literal, because a bound derived from the constant under test
    // passes however far it is widened; and checked against the sentences a
    // tighter bound would cut.
    expect(BULK_UPLOAD_MESSAGE_MAX_LENGTH).toBe(500);
    const { service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ category: 'Vibes' })]),
      DRY,
    );

    // The category refusal ends with the whole vocabulary.
    expect(report.errors[0].message).toContain(CATEGORIES.join(', '));
    for (const unit of ['standard_cubic_metres', 'normal_cubic_metres']) {
      const reason = blockedUnitReason(unit) ?? '';
      expect(reason).not.toBe('');
      expect(Array.from(reason).length).toBeLessThanOrEqual(
        BULK_UPLOAD_MESSAGE_MAX_LENGTH,
      );
    }
  });
});

describe('BulkUploadService — what is audited, and under which verb', () => {
  // Measured 2026-09-17 before this rule: five live imports left 37 audit
  // rows for 5 records, every refusal written as `action: 'create'` with a
  // null id — indistinguishable from a record that was created, and carrying
  // the file's own header text into an append-only table.

  it.each([
    ['an empty file', () => csvFile([])],
    ['a wrong extension', () => csvFile([row()], { originalname: 'x.exe' })],
    [
      'an unrecognised header',
      () =>
        ({
          ...csvFile([]),
          buffer: Buffer.from(`${HEADER},extra\n${row()}`),
        }) as Express.Multer.File,
    ],
    [
      'too many rows',
      () => csvFile(Array.from({ length: BULK_UPLOAD_MAX_ROWS + 1 }, () => row())),
    ],
  ])('does not audit %s — it says something about the file, not the caller', async (_label, file) => {
    const { audit, records, service } = build();

    await expect(service.import(dataEntry(), file(), DRY)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(records.previewCreate).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a role that may not author',
      () => dataEntry({ role: 'consultant' }),
      () => csvFile([row()]),
      CreateRoleRefusedError,
      'Your role may not create activity records',
    ],
    [
      'a file naming an entity outside the tenant',
      () => dataEntry(),
      () => csvFile([row({ subsidiaryId: SUB_99 })]),
      InaccessibleEntityError,
      // Row numbers only: no caller text reaches the row.
      'Row(s) 2 name a reporting entity that does not exist or is not yours.',
    ],
  ] as const)('audits %s under bulk_import, with a reason that carries no caller text', async (_label, user, file, cls, reason) => {
    const { audit, service } = build();

    await expect(service.import(user(), file(), DRY)).rejects.toBeInstanceOf(cls);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'bulk_import',
      entity: 'activity_record',
      entityId: null,
      diff: { bulk: true, dryRun: true, refused: true, reason },
    });
  });

  it('classifies a row failure by class, not by sentence', async () => {
    // A `ConflictException` carrying the duplicate SENTENCE but not the class
    // is an unexpected failure; a `PeriodLockedError` is a lock whatever it
    // says; a `NotFoundException` that merely mentions a factor is an access
    // problem. Reverting the mapper to message matching fails all three.
    const { records, service } = build();
    records.create
      .mockRejectedValueOnce(new ConflictException(DUPLICATE_RECORD_MESSAGE))
      .mockRejectedValueOnce(new PeriodLockedError('closed'))
      .mockRejectedValueOnce(
        new NotFoundException('No emission factor found for anything at all'),
      );

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' }), row({ periodValue: 'March' })]),
      NOTHING,
    );

    expect(report.errors.map((e) => e.code)).toEqual([
      'unexpected',
      'period_locked',
      'not_found',
    ]);
  });
});

describe('BulkUploadService — import batches', () => {
  it('a dry run creates no batch, stores no file and passes no provenance', async () => {
    const { prisma, storage, records, audit, service } = build();

    const report = await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(report.batchId).toBeNull();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.importBatch.update).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(records.create).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      entity: 'activity_record',
      entityId: null,
    });
  });

  it('an apply stores the file, opens the batch, links every record to it, then closes it', async () => {
    const { prisma, storage, records, audit, service } = build();
    const order: string[] = [];
    storage.upload.mockImplementation(async () => void order.push('upload'));
    prisma.importBatch.create.mockImplementation(async () => void order.push('batch'));
    records.create.mockImplementation(async (_u: unknown, dto: any, provenance: any) => {
      order.push(`create:${provenance?.importBatchId ? 'linked' : 'unlinked'}`);
      return { id: `rec-${order.length}`, calculation: SNAPSHOT, anomalyFlag: false, periodValue: dto.periodValue, varianceReason: null };
    });
    prisma.importBatch.update.mockImplementation(async () => void order.push('close'));

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' }), row({ activityValue: 'x' })]),
      NOTHING,
    );

    expect(order).toEqual(['upload', 'batch', 'create:linked', 'create:linked', 'close']);
    const created = prisma.importBatch.create.mock.calls[0][0].data;
    expect(report.batchId).toBe(created.id);
    expect(created).toMatchObject({
      organisationId: 'org-1',
      uploadedBy: 'user-entry',
      subsidiaryIds: [SUB_1],
      fileName: 'data.csv',
      fileFormat: 'csv',
      totalRows: 3,
    });
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The key holds no part of the caller's file name.
    expect(created.storagePath).toBe(`org-1/${created.id}/source.csv`);
    expect(storage.upload.mock.calls[0][0]).toBe('import-sources');
    expect(prisma.importBatch.update.mock.calls[0][0]).toMatchObject({
      where: { id: created.id },
      data: { status: 'completed', acceptedCount: 2, rejectedCount: 1 },
    });
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'bulk_import',
      entity: 'import_batch',
      entityId: created.id,
      diff: { batchId: created.id, acceptedCount: 2 },
    });
  });

  it('removes the stored file and writes no record when the batch row cannot be written', async () => {
    const { prisma, storage, records, service } = build();
    prisma.importBatch.create.mockRejectedValue(new Error('db down'));

    await expect(service.import(dataEntry(), csvFile([row()]), NOTHING)).rejects.toThrow('db down');

    expect(storage.remove).toHaveBeenCalledWith('import-sources', [
      storage.upload.mock.calls[0][1],
    ]);
    expect(records.create).not.toHaveBeenCalled();
  });

  it('marks the batch failed when the loop aborts on the role backstop', async () => {
    const { prisma, records, service } = build();
    records.create.mockRejectedValue(new CreateRoleRefusedError());

    await expect(service.import(dataEntry(), csvFile([row()]), NOTHING)).rejects.toBeInstanceOf(
      CreateRoleRefusedError,
    );

    expect(prisma.importBatch.update.mock.calls[0][0].data).toMatchObject({ status: 'failed' });
  });

  it('records every subsidiary the file names, a location counted by its owner', async () => {
    const { prisma, service } = build();
    const user = dataEntry({ accessibleSubsidiaryIds: [SUB_1, SUB_9] });
    prisma.location.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where?.id?.in ? [{ id: LOC_1, subsidiaryId: SUB_9 }] : []),
    );

    await service.import(
      user,
      csvFile([row({ subsidiaryId: SUB_1 }), row({ subsidiaryId: SUB_9, locationId: LOC_1 })]),
      NOTHING,
    );

    expect(prisma.importBatch.create.mock.calls[0][0].data.subsidiaryIds).toEqual(
      [SUB_1, SUB_9].sort(),
    );
  });

  it('refuses a caller with no organisation before reading the file, and audits it', async () => {
    const { audit, storage, service } = build();

    await expect(
      service.import(dataEntry({ organisationId: null }), csvFile([row()]), NOTHING),
    ).rejects.toBeInstanceOf(CreateRoleRefusedError);

    expect(storage.upload).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][1].diff).toMatchObject({ refused: true });
  });
});

describe('BulkUploadService — a location outside the tenant refuses the whole file', () => {
  it.each([
    ["another tenant's location", 'absent from the access-scoped query'],
    ['a location that does not exist', 'absent all the same'],
  ])('%s — %s, with one sentence and an audit row', async () => {
    // Both are simply absent from a query scoped by the access set, so the two
    // cannot be told apart: no existence oracle.
    const { prisma, records, audit, storage, service } = build();
    prisma.location.findMany.mockResolvedValue([]);

    await expect(
      service.import(
        dataEntry(),
        csvFile([row(), row({ periodValue: 'February', locationId: LOC_9 })]),
        NOTHING,
      ),
    ).rejects.toThrow(
      'Row(s) 3 name a reporting entity that does not exist or is not yours.',
    );

    expect(prisma.location.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [LOC_9] },
      subsidiaryId: { in: [SUB_1] },
    });
    expect(records.previewCreate).not.toHaveBeenCalled();
    expect(records.create).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'bulk_import',
      entityId: null,
      diff: { refused: true },
    });
  });

  it('asks nothing when no row names a location', async () => {
    const { prisma, service } = build();

    await service.import(dataEntry(), csvFile([row()]), DRY);

    expect(prisma.location.findMany).not.toHaveBeenCalled();
  });
});
