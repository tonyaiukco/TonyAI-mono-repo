import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ACTIVITY_UNIT_MAX_LENGTH,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_MESSAGE_MAX_LENGTH,
  CATEGORIES,
  type CalculationResult,
} from '@tonyai/shared-types';
import { BulkUploadService } from './bulk-upload.service';
import { ActivityRecordsService } from '../activity-records/activity-records.service';
import { AuditService } from '../audit/audit.service';
import { blockedUnitReason } from '../calculations/normalization';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { row as sheetRow, xlsx } from '../../test/xlsx';

const HEADER =
  'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';

const row = (over: Partial<Record<string, string>> = {}) => {
  const cells = {
    subsidiaryId: 'sub-1',
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
    accessibleSubsidiaryIds: ['sub-1'],
    ...over,
  };
}

let seq = 0;

function build() {
  const prisma = {
    subsidiary: { findMany: vi.fn().mockResolvedValue([]) },
    location: { findMany: vi.fn().mockResolvedValue([]) },
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
      subsidiaryId: 'sub-1',
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
  const service = new BulkUploadService(
    prisma as unknown as PrismaService,
    records as unknown as ActivityRecordsService,
    audit as unknown as AuditService,
  );
  return { prisma, records, audit, service };
}

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
      action: 'create',
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

    await service.import(dataEntry(), csvFile([row({ locationId: 'loc-9' })]), NOTHING);

    expect(records.create.mock.calls[0][1].locationId).toBe('loc-9');
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
        subsidiaryId: 'sub-1',
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
        subsidiaryId: 'sub-1',
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
    expect(args.where.subsidiaryId).toEqual({ in: ['sub-1'] });
    expect(args.where.reportingYear).toEqual({ in: [2024] });
  });
});

describe('BulkUploadService — the batch pre-flight', () => {
  it('refuses the WHOLE file when a row names an entity the user cannot reach', async () => {
    const { records, prisma, service } = build();

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ subsidiaryId: 'sub-99' })]), NOTHING),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing at all happened — not even the row that would have been fine.
    expect(records.create).not.toHaveBeenCalled();
    expect(records.previewCreate).not.toHaveBeenCalled();
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('names the offending rows so the user can find them', async () => {
    const { service } = build();

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ subsidiaryId: 'sub-99' })]), NOTHING),
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
      .mockRejectedValueOnce(new ConflictException('Reporting period February 2024 is locked'))
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
    [new ConflictException('Reporting period January 2024 is locked'), 'period_locked'],
    [
      new ConflictException(
        'An activity record already exists for this reporting entity, period and category.',
      ),
      'duplicate_existing',
    ],
    [new BadRequestException('"Michaelmas" is not a period'), 'invalid'],
  ])('maps %s onto a row code', async (error, code) => {
    // The two conflicts are told apart by their MESSAGE. That coupling is
    // real, so it is pinned here: reword either sentence in the record
    // service and a duplicate starts reporting as a locked period.
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

  it('still rethrows a refusal the record service raises mid-file as one 403', async () => {
    // A backstop, not the gate — but a thousand identical "forbidden" row
    // errors would still be a worse answer than one 403.
    const { records, service } = build();
    records.previewCreate.mockRejectedValue(
      new ForbiddenException('Your role may not create activity records'),
    );

    await expect(
      service.import(dataEntry(), csvFile([row(), row({ periodValue: 'February' })]), DRY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('BulkUploadService — warnings', () => {
  it('warns that an anomalous row with no reason cannot then be submitted', async () => {
    // The one thing a dry run can say that validation cannot. Without it a
    // user imports a thousand rows and discovers half are stuck later.
    const { records, service } = build();
    records.previewCreate.mockResolvedValue({
      subsidiaryId: 'sub-1',
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
      subsidiaryId: 'sub-1',
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
      new NotFoundException(
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
          locationId: 'loc-9',
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
      subsidiaryId: 'sub-1',
      locationId: 'loc-9',
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
      subsidiaryId: 'sub-1',
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
      csvFile([row({ locationId: 'loc-a' }), row({ locationId: 'loc-b' })]),
      NOTHING,
    );

    expect(report.errors).toHaveLength(0);
    expect(records.create).toHaveBeenCalledTimes(2);
  });

  it('does not treat a site record as taking the whole company’s slot', async () => {
    const { prisma, records, service } = build();
    prisma.activityRecord.findMany.mockResolvedValue([
      {
        subsidiaryId: 'sub-1',
        locationId: 'loc-a',
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
      service.import(dataEntry(), csvFile([row({ subsidiaryId: 'sub-99' })]), NOTHING),
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
      new NotFoundException(
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
      csvFile([row({ subsidiaryId: ' sub-1 ' })]),
      NOTHING,
    );

    expect(report.errors).toHaveLength(0);
    expect(records.create.mock.calls[0][1].subsidiaryId).toBe('sub-1');
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
  { id: 'sub-1', legalName: 'Mine Ltd.', tradingName: null, geographyCode: 'TR' },
  { id: 'sub-9', legalName: 'Other Tenant Ltd.', tradingName: null, geographyCode: 'UK' },
];
const ALL_LOCATIONS = [
  { id: 'loc-1', subsidiaryId: 'sub-1', name: 'My Site', geographyCode: 'TR' },
  { id: 'loc-9', subsidiaryId: 'sub-9', name: 'Their Site', geographyCode: 'UK' },
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
      await service.template(dataEntry({ accessibleSubsidiaryIds: ['sub-1'] })),
    );

    expect(text).toContain('sub-1');
    expect(text).toContain('Mine Ltd.');
    expect(text).toContain('My Site');
    expect(text).not.toContain('sub-9');
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

    await service.template(dataEntry({ accessibleSubsidiaryIds: ['sub-1'] }));

    expect(prisma.subsidiary.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['sub-1'] },
    });
    expect(prisma.location.findMany.mock.calls[0][0].where).toEqual({
      subsidiaryId: { in: ['sub-1'] },
    });
  });

  it('returns a workbook the importer can read back', async () => {
    const { prisma, service } = build();
    prisma.subsidiary.findMany.mockResolvedValue([
      {
        id: 'sub-1',
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
      service.import(dataEntry(), csvFile([row(), row({ subsidiaryId: 'sub-99' })]), NOTHING),
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
      .mockRejectedValueOnce(new ForbiddenException('Your role may not create activity records'));

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

  it('cleans the refusal reason too — it can echo the file’s own header', async () => {
    // The second caller-controlled string in the diff, and the retry used to
    // leave it in place: a NUL in a header cell failed both writes.
    const { audit, service } = build();
    const file = {
      ...csvFile([]),
      buffer: Buffer.from(`${HEADER},bad\u0000col\n${row()}`),
    } as Express.Multer.File;

    await expect(service.import(dataEntry(), file, DRY)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const { reason } = audit.record.mock.calls[0][1].diff as { reason: string };
    expect(reason).toContain('Unrecognised column(s): badcol.');
    expect(reason).not.toContain('\u0000');
  });

  it('cleans and bounds the reason itself, whatever text the refusal carries', async () => {
    // The header refusal cleans its own fragments now, so the test above would
    // pass with `reason` stored raw. This error carries text nothing upstream
    // has cleaned: a NUL, a U+202E and more than the 500 code points kept.
    const { audit, service } = build();
    const nul = String.fromCharCode(0);
    const rlo = String.fromCharCode(0x202e);
    const file = csvFile([row()]);
    // Defined after `csvFile` builds the object: its spread would call a getter.
    Object.defineProperty(file, 'buffer', {
      get() {
        throw new Error(`boom${nul}${rlo}${'x'.repeat(600)}`);
      },
    });

    await expect(service.import(dataEntry(), file, DRY)).rejects.toThrow(/^boom/);

    const { reason } = audit.record.mock.calls[0][1].diff as { reason: string };
    expect(reason).toBe(`boom${'x'.repeat(496)}`);
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

  it('writes a refused row again without the caller’s text when the database rejects a value', async () => {
    // Belt and braces for the shapes nobody has found yet — and only for a
    // value rejection, which fails before anything commits.
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(
      Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }),
    );

    await expect(
      service.import(dataEntry(), csvFile([row()], { originalname: 'x.exe' }), DRY),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(audit.record).toHaveBeenCalledTimes(2);
    // Everything else the first write carried survives; only the two caller
    // strings go. A retry that kept `{ refused }` alone passed a looser check.
    const first = { ...(audit.record.mock.calls[0][1].diff as Record<string, unknown>) };
    delete first.fileName;
    delete first.reason;
    expect(audit.record.mock.calls[1][1].diff).toEqual({ ...first, callerTextOmitted: true });
  });

  it('retries the post-import summary row too, keeping its counts', async () => {
    // The row that summarises an apply is the one the per-record rows cannot
    // replace; a direct write there lost it to the same filename, silently.
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(
      Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }),
    );

    const report = await service.import(
      dataEntry(),
      csvFile([row(), row({ periodValue: 'February' })]),
      NOTHING,
    );

    expect(report.accepted).toHaveLength(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
    const retried = audit.record.mock.calls[1][1].diff as Record<string, unknown>;
    expect(retried).toMatchObject({
      bulk: true,
      dryRun: false,
      totalRows: 2,
      acceptedCount: 2,
      rejectedCount: 0,
      callerTextOmitted: true,
    });
    expect(retried).not.toHaveProperty('fileName');
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

  it('does not retry a failure that could have committed — that would write the row twice', async () => {
    // A dropped connection or a timeout can fail AFTER the insert committed,
    // and `audit_log` has no delete path for the duplicate.
    const { audit, service } = build();
    audit.record.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    await expect(
      service.import(dataEntry(), csvFile([row()], { originalname: 'x.exe' }), DRY),
    ).rejects.toBeInstanceOf(BadRequestException);

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
  ])('quotes forty code points of a refused %s cell, cleaned', async (column, tail) => {
    // The disguises lead the cell, so a cut taken before the cleaning would
    // spend part of the quote on them.
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
        message: `"${'9'.repeat(20)}${'x'.repeat(20)}…" ${tail}`,
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

    const message = `"${'Y'.repeat(40)}…" is not a whole year.`;
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
      'a missing factor, still classified by its RAW text',
      // The words the classifier looks for sit past the bound: bounded before
      // it read them, this row would be reported as an access problem.
      () => new NotFoundException(`${'z'.repeat(600)} emission factor ${nul}`),
      'no_factor',
      `${'z'.repeat(BULK_UPLOAD_MESSAGE_MAX_LENGTH)}…`,
    ],
    [
      'a closed period, still told apart from a taken slot',
      () => new ConflictException(`${nul}${'p'.repeat(10_000)}`),
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

  it('keeps a KNOWN unit padded past the cap out of every service below', async () => {
    // What the cap actually buys. The vocabulary ACCEPTS this spelling —
    // `canonicalUnit` collapses whitespace — so without the cap the row would
    // be priced and written, with the padding stored verbatim and frozen into
    // an immutable snapshot.
    const { records, service } = build();

    const report = await service.import(
      dataEntry(),
      csvFile([row({ activityUnit: `cubic${' '.repeat(40)}metres` })]),
      DRY,
    );

    expect(report.accepted).toEqual([]);
    expect(records.previewCreate).not.toHaveBeenCalled();
    expect(report.errors[0]).toMatchObject({
      row: 2,
      column: 'activityUnit',
      code: 'invalid',
    });
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

