import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { BULK_UPLOAD_COLUMNS } from '@tonyai/shared-types';
import {
  SLOT_HOLDS_TYPED_MESSAGE,
  SLOT_HOLDS_UNTYPED_MESSAGE,
  recordTriggerCode,
} from '../../src/activity-records/errors';
import { AuditService } from '../../src/audit/audit.service';
import { BulkUploadService } from '../../src/bulk-upload/bulk-upload.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StorageService } from '../../src/storage/storage.service';
import { connect, connectOwner, createRecord, type Tenant, createTenant } from './db';
import { lifecycleServices, storageStub } from './services';

/**
 * LP4-02 PR A (Codex F1): the bulk import's slot-kind pre-check against the
 * real database. A slot holds typed records or one untyped record, never both
 * (`TA002`, a trigger the insert raises); the preview cannot see it, so the
 * importer reads the stored records of the file's own slots first. Here a dry
 * run, an apply and the trigger itself are asked about the same slot, and must
 * agree — the unit specs prove the logic over a mocked store, this proves the
 * query reads the columns the trigger compares (the slot's six, `voided`
 * excluded, a blank site as NULL, the period as stored).
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  runtime = connect(3);
  owner = connectOwner();
});

afterAll(async () => {
  await Promise.all([runtime, owner].map((c) => c.$disconnect()));
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant.cleanup();
});

function importer(): BulkUploadService {
  const store = storageStub();
  const { records, intents } = lifecycleServices(runtime, store);
  return new BulkUploadService(runtime, records, new AuditService(runtime), store as unknown as StorageService, intents);
}

type Cells = Partial<Record<(typeof BULK_UPLOAD_COLUMNS)[number], string>>;

/** A CSV in the current template's columns, one row per entry: January 2026, the whole company. */
function file(...rows: Cells[]): Express.Multer.File {
  const line = (r: Cells) => {
    const cells: Cells = {
      subsidiaryId: tenant.subsidiaryId,
      reportingYear: '2026',
      reportingPeriod: 'monthly',
      periodValue: 'January',
      ...r,
    };
    return BULK_UPLOAD_COLUMNS.map((c) => cells[c] ?? '').join(',');
  };
  const buffer = Buffer.from([BULK_UPLOAD_COLUMNS.join(','), ...rows.map(line)].join('\n'));
  return { originalname: 'slot-kind.csv', mimetype: 'text/csv', size: buffer.length, buffer } as Express.Multer.File;
}

const FUEL = { category: 'Fuel', scope: 1, activityUnit: 'litres' } as const;
const typedFuelRow = { category: 'Fuel', activityType: 'diesel', activityValue: '10', activityUnit: 'litres' };

/** The trigger's own answer for a record inserted into the slot. */
async function insertCode(data: Parameters<typeof createRecord>[2]): Promise<string | null> {
  try {
    await createRecord(runtime, tenant, data);
    return null;
  } catch (e) {
    return recordTriggerCode(e);
  }
}

async function fuelRecordsInJanuary(): Promise<number> {
  return owner.activityRecord.count({
    where: { subsidiaryId: tenant.subsidiaryId, reportingYear: 2026, periodValue: 'January', category: 'Fuel' },
  });
}

describe('the bulk slot-kind pre-check agrees with TA002 (LP4-02, Codex F1)', () => {
  it('refuses a typed row where a stored untyped record holds the slot — on the dry run, the apply and the insert alike', async () => {
    // A legacy (pre-LP3-03) Fuel record names no fuel.
    await createRecord(owner, tenant, { ...FUEL, activityType: null });
    const user = tenant.users.dataEntry;
    const refused = [{ row: 2, column: null, code: 'duplicate_existing', message: SLOT_HOLDS_UNTYPED_MESSAGE }];

    // "january": the file's spelling; the slot is the canonical "January".
    const dry = await importer().import(user, file({ ...typedFuelRow, periodValue: 'january' }), { dryRun: true });
    expect(dry.errors).toEqual(refused);
    expect(dry.accepted).toEqual([]);

    const applied = await importer().import(user, file(typedFuelRow), { dryRun: false });
    expect(applied.errors).toEqual(refused);
    expect(await fuelRecordsInJanuary()).toBe(1);

    expect(await insertCode({ ...FUEL, activityType: 'diesel' })).toBe('TA002');
  });

  it('refuses an untyped row where stored typed records hold the slot — the other direction', async () => {
    // Only a writer outside the API can type an Electricity record; the
    // trigger still guards the slot, and so does the importer.
    await createRecord(owner, tenant, { activityType: 'grid_electricity' });

    const dry = await importer().import(
      tenant.users.dataEntry,
      file({ category: 'Electricity', activityValue: '10', activityUnit: 'kWh' }),
      { dryRun: true },
    );
    expect(dry.errors).toEqual([
      { row: 2, column: null, code: 'duplicate_existing', message: SLOT_HOLDS_TYPED_MESSAGE },
    ]);
    expect(await insertCode({ activityType: null })).toBe('TA002');
  });

  it('lets a voided untyped record go, as the trigger does', async () => {
    await createRecord(owner, tenant, { ...FUEL, activityType: null, status: ActivityRecordStatus.voided });

    const dry = await importer().import(tenant.users.dataEntry, file(typedFuelRow), { dryRun: true });
    expect(dry.errors.filter((e) => e.code === 'duplicate_existing')).toEqual([]);
    expect(await insertCode({ ...FUEL, activityType: 'diesel' })).toBeNull();
  });

  it('reads another month as another slot', async () => {
    await createRecord(owner, tenant, { ...FUEL, activityType: null, periodValue: 'February' });

    const dry = await importer().import(tenant.users.dataEntry, file(typedFuelRow), { dryRun: true });
    expect(dry.errors.filter((e) => e.code === 'duplicate_existing')).toEqual([]);
    expect(await insertCode({ ...FUEL, activityType: 'diesel' })).toBeNull();
  });
});
