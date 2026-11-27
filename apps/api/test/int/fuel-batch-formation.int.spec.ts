import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@tonyai/db';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { FuelBatchFormationService } from '../../src/fuel-batches/fuel-batch-formation.service';
import { FuelBatchesService } from '../../src/fuel-batches/fuel-batches.service';
import { FuelFilesService } from '../../src/fuel-files/fuel-files.service';
import { FuelUploadsService } from '../../src/fuel-files/fuel-uploads.service';
import { FuelAccountsService } from '../../src/fuel-accounts/fuel-accounts.service';
import { errorCodeOf } from '../../src/common/api-error';
import { row as sheetRow, xlsx, OFFICE_RELATIONSHIPS, SPREADSHEETML } from '../xlsx';
import { addMember, attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { failingAuditClient, lifecycleServices } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * inc28-fuel-bulk task 6.3: batches formed by their rows' holder against the
 * real schema and the real TR factor releases — one transaction per group,
 * joining an open batch or forming the next, every record through the record
 * service's create core, refusals held with their reason.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;

beforeAll(async () => {
  runtime = connect(3);
  owner = connectOwner();
  await loadTrReleases();
});
afterAll(async () => {
  await Promise.all([runtime, owner].map((c) => c.$disconnect()));
});
beforeEach(async () => {
  tenant = await createTenant();
  await owner.subsidiary.updateMany({ where: { organisationId: tenant.organisationId }, data: { geographyCode: 'TR' } });
});
afterEach(async () => {
  await tenant.cleanup();
});

function services(prisma: PrismaService = runtime) {
  const audit = new AuditService(prisma);
  const uploads = new FuelUploadsService(prisma, audit);
  const { records, periodLocks } = lifecycleServices(prisma);
  return {
    files: new FuelFilesService(prisma, audit, uploads),
    uploads,
    formation: new FuelBatchFormationService(prisma, audit, records, uploads),
    records,
    periodLocks,
  };
}

const asFile = (buffer: Buffer) => ({ buffer, size: buffer.length, originalname: 'file.xlsx' }) as Express.Multer.File;
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function masterkey(): Promise<RequestUser> {
  const companies = await owner.subsidiary.findMany({ where: { organisationId: tenant.organisationId }, select: { id: true } });
  return { ...tenant.users.masterkey, accessibleSubsidiaryIds: companies.map((c) => c.id) };
}

async function confirmed(code: string, subsidiaryId: string, source = 'petrol_ofisi'): Promise<void> {
  await runtime.fuelAccount.create({
    data: {
      organisationId: tenant.organisationId, source, code, name: code, subsidiaryId, state: 'confirmed',
      confirmedBy: tenant.users.masterkey.id, confirmedAt: new Date(), createdBy: tenant.users.masterkey.id,
    },
  });
}

const PO_HEADER = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
/** A sales list: each row [saleId, account, date dd.MM.yyyy, product, litres, invoice]. */
function sales(rows: Array<[string, string, string, string, number, string]>): Buffer {
  return xlsx({
    sheetData: [sheetRow(1, PO_HEADER), ...rows.map(([id, acc, date, tip, l, inv], i) => sheetRow(i + 2, [id, acc, 'Fleet', `${date} 08:00`, tip, l, inv]))].join(''),
  });
}

async function upload(user: RequestUser, buffer: Buffer, usage = 'on_road') {
  return services().files.apply(user, asFile(buffer), { source: 'petrol_ofisi', usage, fileSha256: sha(buffer) });
}

const batchesOf = () =>
  owner.fuelBatch.findMany({ where: { organisationId: tenant.organisationId }, orderBy: [{ invoiceRef: 'asc' }, { sequence: 'asc' }] });
const recordsOf = (batchId: string) => owner.activityRecord.findMany({ where: { fuelBatchId: batchId }, orderBy: { periodValue: 'asc' } });

describe('forming batches (task 6.3)', () => {
  it('prices the golden vector: 15,973.75 L of on-road petrol, Türkiye 2025, is 36.8646 tCO₂e within 0.5%', async () => {
    await confirmed('GOLD', tenant.subsidiaryId);
    const user = await masterkey();
    const up = await upload(user, sales([['G-1', 'GOLD', '10.03.2025', 'Kurşunsuz 95', 15973.75, 'OZK-G']]));
    const step = await services().formation.formBatches(user, up.id);
    expect(step).toMatchObject({ formedBatches: 1, processableRows: 0 });
    const [batch] = await batchesOf();
    const [record] = await recordsOf(batch!.id);
    expect(record).toMatchObject({
      category: 'Mobile Combustion', activityType: 'on_road_petrol', activityUnit: 'litres', activityValue: 15973.75,
      reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'March', status: 'draft', createdBy: user.id,
    });
    const tco2e = (record!.calculation as { tCo2e?: number }).tCo2e ?? null;
    expect(tco2e).not.toBeNull();
    expect(Math.abs(tco2e! - 36.8646) / 36.8646).toBeLessThan(0.005);
    expect(record!.input).toMatchObject({ invoice_no: 'OZK-G' });
  });

  it('splits a shared invoice per account, one record per fuel and month, and forms nothing for an associate', async () => {
    const assoc = await owner.subsidiary.create({
      data: { organisationId: tenant.organisationId, legalName: 'Int assoc', geographyCode: 'TR', nodeType: 'company', parentId: tenant.subsidiaryId, control: 'associate' },
    });
    await confirmed('PO-0001', tenant.subsidiaryId);
    await confirmed('000456', tenant.otherSubsidiaryId);
    await confirmed('PO-9001', assoc.id);
    const user = await masterkey();
    const file = readFileSync(join(__dirname, '../fixtures/fuel/petrol-ofisi-satislistesi.xlsx'));
    const up = await upload(user, file);
    await services().formation.formBatches(user, up.id);
    const batches = await batchesOf();
    const shared = batches.filter((b) => b.invoiceRef === 'OZK0000000000001');
    expect(shared.map((b) => [b.subsidiaryId, b.sequence])).toEqual(
      expect.arrayContaining([[tenant.subsidiaryId, 1], [tenant.otherSubsidiaryId, 1]]),
    );
    expect(shared).toHaveLength(2);
    const controlled = shared.find((b) => b.subsidiaryId === tenant.subsidiaryId)!;
    const records = await recordsOf(controlled.id);
    // Diesel and petrol of March: two records whose litres are the rows' sums.
    const sum = records.reduce((s, r) => s + r.activityValue, 0);
    expect(records.map((r) => r.activityType).sort()).toEqual(['on_road_diesel', 'on_road_petrol']);
    expect(Math.round(sum * 100) / 100).toBe(669.38);
    expect(await owner.activityRecord.count({ where: { subsidiaryId: assoc.id } })).toBe(0);
    expect(await owner.fuelRow.count({ where: { subsidiaryId: assoc.id, state: 'excluded' } })).toBe(4);
  });

  it('joins rows of one invoice from a second file to the open batch, keeping its record and id', async () => {
    await confirmed('JOIN', tenant.subsidiaryId);
    const user = await masterkey();
    const first = await upload(user, sales([['J-1', 'JOIN', '02.03.2025', 'Motorin', 10, 'OZK-J'], ['J-2', 'JOIN', '03.03.2025', 'Motorin', 20, 'OZK-J']]));
    await services().formation.formBatches(user, first.id);
    const [batch] = await batchesOf();
    const [before] = await recordsOf(batch!.id);
    const second = await upload(user, sales([['J-3', 'JOIN', '04.03.2025', 'Motorin', 5.5, 'OZK-J']]));
    expect(await services().formation.formBatches(user, second.id)).toMatchObject({ formedBatches: 0, joinedBatches: 1 });
    expect(await batchesOf()).toHaveLength(1);
    const [after] = await recordsOf(batch!.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.activityValue).toBe(35.5);
    // The figure is recomputed for the new quantity, never carried over (QA review of PR B).
    const tOf = (r: typeof before) => (r!.calculation as { tCo2e?: number }).tCo2e ?? null;
    expect(tOf(before)).not.toBeNull();
    expect(Math.abs(tOf(after)! / tOf(before)! - 35.5 / 30)).toBeLessThan(1e-6);
    expect(await owner.fuelRow.count({ where: { fuelBatchId: batch!.id, state: 'assigned' } })).toBe(3);
  });

  it('forms a further batch of the invoice for rows of another usage', async () => {
    await confirmed('USE', tenant.subsidiaryId);
    const user = await masterkey();
    const a = await upload(user, sales([['U-1', 'USE', '02.03.2025', 'Motorin', 10, 'OZK-U']]), 'on_road');
    await services().formation.formBatches(user, a.id);
    const b = await upload(user, sales([['U-2', 'USE', '03.03.2025', 'Motorin', 7, 'OZK-U']]), 'off_road');
    await services().formation.formBatches(user, b.id);
    expect((await batchesOf()).map((x) => [x.sequence, x.usage])).toEqual([[1, 'on_road'], [2, 'off_road']]);
  });

  it('forms a Shell account’s month as two half-month batches', async () => {
    await confirmed('SH-1', tenant.subsidiaryId, 'shell');
    const user = await masterkey();
    const header = ['Müşteri Kodu', 'Müşteri Adı', 'Kart No', 'İşlem Tarihi', 'İstasyon Kodu', 'Ürün', 'Miktar (LT)'];
    const fills = ['03.03.2025 08:00', '14.03.2025 08:00', '16.03.2025 08:00', '31.03.2025 23:50'].map((at, i) =>
      sheetRow(i + 2, ['SH-1', 'Fleet', `CARD-${i}`, at, 'ST-1', 'Motorin Med', 10]),
    );
    const buffer = xlsx({
      sheetData: [sheetRow(1, header), ...fills].join(''),
      workbookXml: `<workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="items" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    });
    const up = await services().files.apply(user, asFile(buffer), { source: 'shell', usage: 'on_road', fileSha256: sha(buffer) });
    await services().formation.formBatches(user, up.id);
    const batches = await batchesOf();
    expect(batches.map((b) => b.invoiceRef)).toEqual(['2025-03-1', '2025-03-2']);
    for (const b of batches) expect(await owner.fuelRow.count({ where: { fuelBatchId: b.id } })).toBe(2);
  });

  it('stores nothing of a group whose step fails, holds its rows, and forms it on a retry', async () => {
    await confirmed('FAIL', tenant.subsidiaryId);
    const user = await masterkey();
    const up = await upload(user, sales([['F-1', 'FAIL', '02.03.2025', 'Motorin', 10, 'OZK-F']]));
    const failing = services(failingAuditClient(runtime));
    const step = await failing.formation.formBatches(user, up.id);
    expect(step).toMatchObject({ formedBatches: 0, processableRows: 0, held: [{ reason: 'unexpected', rows: 1 }] });
    expect(await batchesOf()).toHaveLength(0);
    expect(await owner.activityRecord.count({ where: { subsidiary: { organisationId: tenant.organisationId } } })).toBe(0);
    // A further step does not try held rows again; the holder's request does.
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({ formedBatches: 0 });
    expect(await services().formation.formBatches(user, up.id, { retryHeld: true })).toMatchObject({ formedBatches: 1 });
  });

  it('holds rows of a locked period with that reason, and forms them once unlocked and asked again', async () => {
    await confirmed('LOCK', tenant.subsidiaryId);
    const user = await masterkey();
    await services().periodLocks.lock(user, { subsidiaryId: tenant.subsidiaryId, reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'March' } as never);
    const up = await upload(user, sales([['L-1', 'LOCK', '02.03.2025', 'Motorin', 10, 'OZK-L']]));
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({ held: [{ reason: 'period_locked', rows: 1 }], processableRows: 0 });
    await owner.periodLock.deleteMany({ where: { subsidiaryId: tenant.subsidiaryId } });
    expect(await services().formation.formBatches(user, up.id, { retryHeld: true })).toMatchObject({ formedBatches: 1 });
  });

  it('holds a central reporter’s rows outside its grant; a masterkey takes them over and forms them as author', async () => {
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [tenant.subsidiaryId] });
    await confirmed('OUT', tenant.otherSubsidiaryId);
    const up = await upload(reporter, sales([['O-1', 'OUT', '02.03.2025', 'Motorin', 10, 'OZK-O']]));
    expect(await services().formation.formBatches(reporter, up.id)).toMatchObject({ held: [{ reason: 'fuel_out_of_scope' }] });
    const user = await masterkey();
    // Not the holder: refused, nothing changes.
    expect(await services().formation.formBatches(user, up.id).catch((e: unknown) => (e as { getStatus(): number }).getStatus())).toBe(403);
    await services().uploads.takeOver(user, up.id, {});
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({ formedBatches: 1 });
    const [batch] = await batchesOf();
    expect(batch).toMatchObject({ subsidiaryId: tenant.otherSubsidiaryId, createdBy: user.id });
    const row = await owner.fuelRow.findFirstOrThrow({ where: { fuelBatchId: batch!.id }, include: { importBatch: true } });
    expect(row.importBatch.uploadedBy).toBe(reporter.id);
  });

  it('forms one batch when two steps of one holder process one invoice at once', async () => {
    await confirmed('RACE', tenant.subsidiaryId);
    const user = await masterkey();
    const a = await upload(user, sales([['R-1', 'RACE', '02.03.2025', 'Motorin', 10, 'OZK-R']]));
    const b = await upload(user, sales([['R-2', 'RACE', '03.03.2025', 'Motorin', 20, 'OZK-R']]));
    await Promise.all([services().formation.formBatches(user, a.id), services().formation.formBatches(user, b.id)]);
    const batches = await batchesOf();
    expect(batches).toHaveLength(1);
    expect((await recordsOf(batches[0]!.id)).map((r) => r.activityValue)).toEqual([30]);
  });
});

describe('a mapping change racing a step (task 5.3) and an invoice’s two sums (task 5.5)', () => {
  it('ends a change racing a formation step in one of the two allowed outcomes', async () => {
    await confirmed('RC', tenant.subsidiaryId);
    const user = await masterkey();
    const up = await upload(user, sales([['RC-1', 'RC', '02.03.2025', 'Motorin', 10, 'OZK-RC']]));
    const account = await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code: 'RC' } });
    const accounts = new FuelAccountsService(runtime, new AuditService(runtime));
    const [, change] = await Promise.allSettled([
      services().formation.formBatches(user, up.id),
      accounts.update(user, account.id, { subsidiaryId: tenant.otherSubsidiaryId }),
    ]);
    const batches = await batchesOf();
    const mapping = await owner.fuelAccount.findUniqueOrThrow({ where: { id: account.id } });
    if (change.status === 'rejected') {
      // The batch formed first, under the old company; the change was refused.
      expect(errorCodeOf(change.reason)).toBe('fuel_account_in_use');
      expect(batches.map((b) => b.subsidiaryId)).toEqual([tenant.subsidiaryId]);
      expect(mapping.subsidiaryId).toBe(tenant.subsidiaryId);
    } else {
      // The change came first: no batch under the old company.
      expect(mapping.subsidiaryId).toBe(tenant.otherSubsidiaryId);
      expect(batches.filter((b) => b.subsidiaryId === tenant.subsidiaryId)).toEqual([]);
    }
  });

  it('counts the Scope 1 figure from controlled rows and the invoice’s litres from all its live rows, through a withdrawal and a re-upload', async () => {
    const assoc = await owner.subsidiary.create({
      data: { organisationId: tenant.organisationId, legalName: 'Int assoc 2', geographyCode: 'TR', nodeType: 'company', parentId: tenant.subsidiaryId, control: 'associate' },
    });
    await confirmed('PO-0001', tenant.subsidiaryId);
    await confirmed('000456', tenant.subsidiaryId);
    await confirmed('PO-9001', assoc.id);
    const user = await masterkey();
    const file = readFileSync(join(__dirname, '../fixtures/fuel/petrol-ofisi-satislistesi.xlsx'));
    const up = await upload(user, file);
    await services().formation.formBatches(user, up.id);
    const INVOICE = 'OZK0000000000001';
    const scope1 = async () => {
      const records = await owner.activityRecord.findMany({ where: { fuelBatch: { invoiceRef: INVOICE }, status: { not: 'voided' } } });
      return Math.round(records.reduce((s, r) => s + r.activityValue, 0) * 100) / 100;
    };
    const invoiceLitres = async () => {
      const rows = await owner.fuelRow.findMany({ where: { invoiceRef: INVOICE, organisationId: tenant.organisationId, state: { in: ['assigned', 'excluded'] } } });
      return Math.round(rows.reduce((s, r) => s + Number(r.litres), 0) * 100) / 100;
    };
    // Expected before: 669.38 + 19.63 L counted; 769.01 L stored on the invoice (80.00 L of them excluded).
    expect([await scope1(), await invoiceLitres()]).toEqual([689.01, 769.01]);
    const associateAccount = await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code: 'PO-9001' } });
    await services().uploads.withdrawRows(user, up.id, { accountId: associateAccount.id, reason: 'Re-read the invoice' });
    // After the withdrawal: the figure is unchanged; the invoice's stored litres lose the 80.00 L.
    expect([await scope1(), await invoiceLitres()]).toEqual([689.01, 689.01]);
    await upload(user, file);
    // After the re-upload: the 4 rows stored again, excluded, naming the withdrawn ones.
    expect([await scope1(), await invoiceLitres()]).toEqual([689.01, 769.01]);
    expect(await owner.fuelRow.count({ where: { organisationId: tenant.organisationId, state: 'excluded', replacesId: { not: null } } })).toBe(4);
  });
});

describe('the slot key and the slot kind beside manual records (task 6.2)', () => {
  const march = { reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'March', category: 'Mobile Combustion', activityUnit: 'litres', scope: 1 };

  it('lets a batch record stand beside a manual record of the same type and month', async () => {
    await createRecord(owner, tenant, { ...march, activityType: 'on_road_diesel', activityValue: 50, createdBy: tenant.users.masterkey.id });
    await confirmed('SLOT', tenant.subsidiaryId);
    const user = await masterkey();
    const up = await upload(user, sales([['S-1', 'SLOT', '02.03.2025', 'Motorin', 10, 'OZK-S']]));
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({ formedBatches: 1 });
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId, periodValue: 'March', activityType: 'on_road_diesel' } })).toBe(2);
    // A second manual record of that type and month is still a duplicate.
    const dto = { subsidiaryId: tenant.subsidiaryId, ...march, activityType: 'on_road_diesel', activityValue: 5 };
    const refused = await services().records.previewCreate(user, dto as never).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('record_duplicate');
  });

  it('answers the slot-kind conflict alike from a manual preview and a batch’s formation when an untyped record holds the slot', async () => {
    await createRecord(owner, tenant, { ...march, activityType: null, activityValue: 50, createdBy: tenant.users.masterkey.id });
    await confirmed('KIND', tenant.subsidiaryId);
    const user = await masterkey();
    const dto = { subsidiaryId: tenant.subsidiaryId, ...march, activityType: 'on_road_diesel', activityValue: 5 };
    expect(errorCodeOf(await services().records.previewCreate(user, dto as never).catch((e: unknown) => e))).toBe('slot_holds_untyped');
    const up = await upload(user, sales([['K-1', 'KIND', '02.03.2025', 'Motorin', 10, 'OZK-K']]));
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({ held: [{ reason: 'slot_holds_untyped' }] });
  });
});

describe('later rows, the tray, the reporting company and the holder (task 6.3)', () => {
  const S = () => tenant.subsidiaryId;
  const T = () => tenant.otherSubsidiaryId;
  function batchService() {
    const { records, evidence } = lifecycleServices(runtime);
    return new FuelBatchesService(runtime, new AuditService(runtime), records, evidence);
  }
  /** A standard user whose main company is T, a central reporter of S for Mobile Combustion; S's own user keeps Water. */
  async function centralReporter(): Promise<RequestUser> {
    await owner.userSubsidiaryAccess.update({
      where: { userId_subsidiaryId: { userId: tenant.users.standardUser.id, subsidiaryId: S() } },
      data: { categories: ['Water'] },
    });
    const member = await addMember(owner, tenant, UserRole.standard_user, { grants: [T()], categories: ['Water'] });
    await owner.userSubsidiaryAccess.create({
      data: { userId: member.id, subsidiaryId: S(), organisationId: tenant.organisationId, kind: 'central_reporter', categories: ['Mobile Combustion'] },
    });
    // As the guard builds it: both companies, each with its categories.
    return { ...member, accessibleSubsidiaryIds: [T(), S()], categoryGrants: { [T()]: ['Water'], [S()]: ['Mobile Combustion'] } };
  }

  it('forms a further batch for a late row of an approved invoice; the approved batch, its rows and records stay byte-equal', async () => {
    await confirmed('LATE', S());
    const user = await masterkey();
    const first = await upload(user, sales([['LT-1', 'LATE', '03.03.2025', 'Motorin', 100, 'OZK-LT']]));
    await services().formation.formBatches(user, first.id);
    const [approved] = await batchesOf();
    await attachEvidence(owner, tenant, (await recordsOf(approved!.id)).map((r) => r.id));
    const batches = batchService();
    const submitted = await batches.submit(user, approved!.id);
    await batches.approve(user, approved!.id, submitted.submittedAt);
    const snapshot = async () => ({
      batch: await owner.fuelBatch.findUniqueOrThrow({ where: { id: approved!.id } }),
      records: await recordsOf(approved!.id),
      rows: await owner.fuelRow.findMany({ where: { fuelBatchId: approved!.id }, orderBy: { id: 'asc' } }),
    });
    const before = await snapshot();

    const late = await upload(user, sales([['LT-2', 'LATE', '12.03.2025', 'Motorin', 40, 'OZK-LT']]));
    expect(await services().formation.formBatches(user, late.id)).toMatchObject({ formedBatches: 1, joinedBatches: 0 });
    expect(await snapshot()).toEqual(before);
    const all = await batchesOf();
    expect(all.map((b) => [b.sequence, b.status])).toEqual([[1, 'approved'], [2, 'draft']]);
    expect((await recordsOf(all[1]!.id)).map((r) => [r.periodValue, r.activityType, r.activityValue])).toEqual([['March', 'on_road_diesel', 40]]);
    // Both of the invoice's batches say it has another.
    expect((await batches.list(user, {})).map((b) => b.hasSiblings)).toEqual([true, true]);
  });

  it('forms one batch per invoice once an unknown account’s tray rows are released by its confirmation', async () => {
    const user = await masterkey();
    const up = await upload(user, sales([
      ['TR-1', 'TRAY', '03.03.2025', 'Motorin', 10, 'OZK-T1'],
      ['TR-2', 'TRAY', '04.03.2025', 'Motorin', 20, 'OZK-T2'],
      ['TR-3', 'TRAY', '05.04.2025', 'Motorin', 30, 'OZK-T3'],
    ]));
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({
      formedBatches: 0, processableRows: 0, waiting: [{ reason: 'fuel_account_unmatched', rows: 3 }],
    });
    const account = await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code: 'TRAY' } });
    await new FuelAccountsService(runtime, new AuditService(runtime)).confirm(user, account.id, { subsidiaryId: S() });
    expect(await services().formation.formBatches(user, up.id)).toMatchObject({ formedBatches: 3, processableRows: 0, held: [], waiting: [] });
    expect((await batchesOf()).map((b) => [b.invoiceRef, b.sequence, b.subsidiaryId])).toEqual([
      ['OZK-T1', 1, S()], ['OZK-T2', 1, S()], ['OZK-T3', 1, S()],
    ]);
  });

  it('names a central reporter’s main company as its batch’s reporting company, and none on a masterkey’s', async () => {
    const reporter = await centralReporter();
    await confirmed('CR', S());
    const up = await upload(reporter, sales([['CR-1', 'CR', '03.03.2025', 'Motorin', 10, 'OZK-CR']]));
    expect(await services().formation.formBatches(reporter, up.id)).toMatchObject({ formedBatches: 1 });
    const mk = await masterkey();
    const own = await upload(mk, sales([['CR-2', 'CR', '04.04.2025', 'Motorin', 10, 'OZK-MK']]));
    expect(await services().formation.formBatches(mk, own.id)).toMatchObject({ formedBatches: 1 });

    const [byReporter, byMasterkey] = await batchesOf();
    expect(byReporter).toMatchObject({ invoiceRef: 'OZK-CR', subsidiaryId: S(), createdBy: reporter.id });
    expect((await recordsOf(byReporter!.id)).map((r) => [r.subsidiaryId, r.reportedBySubsidiaryId, r.createdBy])).toEqual([[S(), T(), reporter.id]]);
    expect(byMasterkey).toMatchObject({ invoiceRef: 'OZK-MK', subsidiaryId: S(), createdBy: mk.id });
    expect((await recordsOf(byMasterkey!.id)).map((r) => r.reportedBySubsidiaryId)).toEqual([null]);
    const dtos = await batchService().list(mk, {});
    const reporterDto = dtos.find((d) => d.id === byReporter!.id)!;
    expect(reporterDto).toMatchObject({ reportingSubsidiaryId: T(), createdBy: reporter.id });
    expect(reporterDto.uploaders.map((u) => u.id)).toEqual([reporter.id]);
    expect(dtos.find((d) => d.id === byMasterkey!.id)!.reportingSubsidiaryId).toBeNull();

    // Withdrawn — its records removed — the batch still names the company it reported for (fourth review, P2).
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id: byReporter!.id } })).reportedBySubsidiaryId).toBe(T());
    await batchService().withdraw(reporter, byReporter!.id, 'entered twice');
    expect(await recordsOf(byReporter!.id)).toEqual([]);
    expect((await batchService().list(mk, {})).find((d) => d.id === byReporter!.id)).toMatchObject({ status: 'withdrawn', reportingSubsidiaryId: T() });
  });

  it('moves the batch’s reporting company with its records when a rebuild writes them under a moved main company (fifth review, P2)', async () => {
    const reporter = await centralReporter();
    await confirmed('MV', S());
    const up = await upload(reporter, sales([['MV-1', 'MV', '03.03.2025', 'Motorin', 10, 'OZK-MV']]));
    await services().formation.formBatches(reporter, up.id);
    const [batch] = await batchesOf();
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id: batch!.id } })).reportedBySubsidiaryId).toBe(T());
    // The reporter's main company moves from T to a new company U.
    const u = await owner.subsidiary.create({
      data: { organisationId: tenant.organisationId, legalName: `Int-test U ${randomUUID().slice(0, 6)}`, geographyCode: 'TR', nodeType: 'company', parentId: S(), control: 'controlled' },
    });
    await owner.userSubsidiaryAccess.delete({ where: { userId_subsidiaryId: { userId: reporter.id, subsidiaryId: T() } } });
    await owner.userSubsidiaryAccess.create({ data: { userId: reporter.id, subsidiaryId: u.id, organisationId: tenant.organisationId, kind: 'assigned', categories: ['Water'] } });
    const moved: RequestUser = {
      ...reporter,
      accessibleSubsidiaryIds: [u.id, S()],
      categoryGrants: { [u.id]: ['Water'], [S()]: ['Mobile Combustion'] },
      grantKinds: { [u.id]: 'assigned', [S()]: 'central_reporter' },
    };
    // A declaration change rebuilds the records (on-road to off-road): they are written for U now, and so is the header.
    await batchService().changeDeclarations(moved, batch!.id, { usage: 'off_road' });
    expect((await recordsOf(batch!.id)).map((r) => r.reportedBySubsidiaryId)).toEqual([u.id]);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id: batch!.id } })).reportedBySubsidiaryId).toBe(u.id);
    expect((await batchService().list(moved, {})).find((d) => d.id === batch!.id)).toMatchObject({ reportingSubsidiaryId: u.id });
  });

  it('holds a central reporter’s rows for a month the company’s own user entered, with the single-entry conflict', async () => {
    await createRecord(runtime, tenant, {
      category: 'Mobile Combustion', activityType: 'on_road_diesel', activityUnit: 'litres', periodValue: 'March', reportingYear: 2025,
      createdBy: tenant.users.standardUser.id,
    });
    const reporter = await centralReporter();
    await confirmed('SE', S());
    const up = await upload(reporter, sales([['SE-1', 'SE', '03.03.2025', 'Motorin', 10, 'OZK-SE']]));
    expect(await services().formation.formBatches(reporter, up.id)).toMatchObject({
      formedBatches: 0, processableRows: 0, held: [{ reason: 'single_entry_period_conflict', rows: 1 }],
    });
    expect(await batchesOf()).toEqual([]);
  });

  it('holds the rows of an uploader whose grant was withdrawn, as outside its scope', async () => {
    await confirmed('WG', S());
    const superAdmin = tenant.users.superAdmin;
    const up = await upload(superAdmin, sales([['WG-1', 'WG', '03.03.2025', 'Motorin', 10, 'OZK-WG']]));
    await owner.userSubsidiaryAccess.deleteMany({ where: { userId: superAdmin.id } });
    const narrowed: RequestUser = { ...superAdmin, accessibleSubsidiaryIds: [] };
    expect(await services().formation.formBatches(narrowed, up.id)).toMatchObject({
      formedBatches: 0, held: [{ reason: 'fuel_out_of_scope', rows: 1 }],
    });
    expect(await batchesOf()).toEqual([]);
  });

  it('holds an invoice of any size in one statement: 50,000 judged rows pass no parameter limit (fifth review, P2)', async () => {
    await confirmed('BIG', S());
    const up = await upload(tenant.users.superAdmin, sales([['BIG-1', 'BIG', '03.03.2025', 'Motorin', 10, 'OZK-BIG']]));
    const row = await owner.fuelRow.findFirstOrThrow({ where: { importBatchId: up.id } });
    const ids = [row.id, ...Array.from({ length: 49_999 }, () => randomUUID())];
    const formation = services().formation as unknown as {
      holdGroup: (importId: string, holderId: string, reason: string, judged: { rowIds: string[]; subsidiaryId: string | null }) => Promise<void>;
    };
    await formation.holdGroup(up.id, tenant.users.superAdmin.id, 'fuel_out_of_scope', { rowIds: ids, subsidiaryId: S() });
    expect((await owner.fuelRow.findUniqueOrThrow({ where: { id: row.id } })).holdReason).toBe('fuel_out_of_scope');
  });

  it('holds only the rows its refusal judged: a mapping changed meanwhile keeps its rows ready (fourth review of the branch, P2)', async () => {
    await confirmed('RM', S());
    const superAdmin = tenant.users.superAdmin;
    const up = await upload(superAdmin, sales([['RM-1', 'RM', '03.03.2025', 'Motorin', 10, 'OZK-RM']]));
    await owner.userSubsidiaryAccess.deleteMany({ where: { userId: superAdmin.id } });
    const narrowed: RequestUser = { ...superAdmin, accessibleSubsidiaryIds: [] };
    const formation = services().formation;
    const internals = formation as unknown as { formGroup: (...args: unknown[]) => Promise<unknown> };
    const original = internals.formGroup.bind(formation);
    // The refusal is decided; before it is written as a hold, a masterkey re-maps the account and the row is ready under the new company.
    internals.formGroup = async (...args: unknown[]) => {
      try {
        return await original(...args);
      } finally {
        await owner.fuelRow.updateMany({ where: { importBatchId: up.id }, data: { subsidiaryId: T(), state: 'ready', holdReason: null } });
      }
    };
    await formation.formBatches(narrowed, up.id);
    const row = await owner.fuelRow.findFirstOrThrow({ where: { importBatchId: up.id } });
    expect([row.state, row.holdReason, row.subsidiaryId]).toEqual(['ready', null, T()]);
  });

  it('forms nothing of a disabled uploader’s ready rows until a masterkey takes them over; the uploader stays named', async () => {
    await confirmed('DIS', S());
    const uploader = tenant.users.superAdmin;
    const up = await upload(uploader, sales([['D-1', 'DIS', '03.03.2025', 'Motorin', 10, 'OZK-D']]));
    await owner.profile.update({ where: { id: uploader.id }, data: { disabledAt: new Date() } });
    const mk = await masterkey();
    expect(await services().formation.formBatches(mk, up.id).catch((e: unknown) => (e as { getStatus(): number }).getStatus())).toBe(403);
    expect(await batchesOf()).toEqual([]);
    await services().uploads.takeOver(mk, up.id, {});
    expect(await services().formation.formBatches(mk, up.id)).toMatchObject({ formedBatches: 1 });
    const [batch] = await batchesOf();
    expect(batch).toMatchObject({ createdBy: mk.id, subsidiaryId: S() });
    const [dto] = await batchService().list(mk, {});
    expect(dto!.uploaders.map((u) => u.id)).toEqual([uploader.id]);
  });
});
