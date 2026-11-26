import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@tonyai/db';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import { errorCodeOf } from '../../src/common/api-error';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { FuelAccountsService } from '../../src/fuel-accounts/fuel-accounts.service';
import { FuelFilesService } from '../../src/fuel-files/fuel-files.service';
import { FuelUploadsService } from '../../src/fuel-files/fuel-uploads.service';
import { row as sheetRow, xlsx } from '../xlsx';
import { addMember, connect, connectOwner, createTenant, type Tenant } from './db';
import { failingAuditClient } from './services';

/**
 * inc28-fuel-bulk tasks 5.1 and 5.3: a fuel file applied against the real
 * schema as the runtime role — stored once, whole or not at all, an
 * associate's rows excluded, a duplicate under another holder said apart —
 * and an account's confirmation and change re-stating its unbatched rows.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  runtime = connect(2);
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

function services(prisma: PrismaService = runtime) {
  const audit = new AuditService(prisma);
  const uploads = new FuelUploadsService(prisma, audit);
  return { files: new FuelFilesService(prisma, audit, uploads), uploads, accounts: new FuelAccountsService(prisma, audit) };
}

const FIXTURES = join(__dirname, '../fixtures/fuel');
const asFile = (buffer: Buffer, name = 'SatisListesi.xlsx') =>
  ({ buffer, size: buffer.length, originalname: name }) as Express.Multer.File;
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

async function associate(): Promise<string> {
  const node = await owner.subsidiary.create({
    data: {
      organisationId: tenant.organisationId,
      legalName: `Int-test associate ${randomUUID().slice(0, 6)}`,
      geographyCode: 'UK',
      nodeType: 'company',
      parentId: tenant.subsidiaryId,
      control: 'associate',
    },
  });
  return node.id;
}

async function confirmedAccount(code: string, subsidiaryId: string): Promise<void> {
  await runtime.fuelAccount.create({
    data: {
      organisationId: tenant.organisationId,
      source: 'petrol_ofisi',
      code,
      name: code,
      subsidiaryId,
      state: 'confirmed',
      confirmedBy: tenant.users.masterkey.id,
      confirmedAt: new Date(),
      createdBy: tenant.users.masterkey.id,
    },
  });
}

/** The masterkey sees every company, the associate made after the tenant included. */
async function masterkey(): Promise<RequestUser> {
  const companies = await owner.subsidiary.findMany({ where: { organisationId: tenant.organisationId }, select: { id: true } });
  return { ...tenant.users.masterkey, accessibleSubsidiaryIds: companies.map((c) => c.id) };
}

async function apply(user: RequestUser, buffer: Buffer, prisma: PrismaService = runtime) {
  return services(prisma).files.apply(user, asFile(buffer), { source: 'petrol_ofisi', usage: 'on_road', fileSha256: sha(buffer) });
}

const rowsOf = () => owner.fuelRow.findMany({ where: { organisationId: tenant.organisationId }, orderBy: { fileRow: 'asc' } });

/** A sales list of one account: `n` rows, the first `unrecognised` of them named "Otogaz LPG". */
function salesList(code: string, n: number, unrecognised = 0, invoice = 'OZK-INT-1'): Buffer {
  const rows = [sheetRow(1, ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'])];
  for (let i = 0; i < n; i += 1) {
    rows.push(
      sheetRow(i + 2, [
        `${code}-${i}`,
        code,
        'Int fleet',
        `${String((i % 28) + 1).padStart(2, '0')}.03.2025 08:00`,
        i < unrecognised ? 'Otogaz LPG' : 'Motorin Med',
        10 + i,
        invoice,
      ]),
    );
  }
  return xlsx({ sheetData: rows.join('') });
}

describe('applying a fuel file (task 5.1)', () => {
  it('stores each row once across two uploads, excludes the associate’s rows, and creates no record', async () => {
    const assoc = await associate();
    await confirmedAccount('PO-0001', tenant.subsidiaryId);
    await confirmedAccount('PO-9001', assoc);
    const user = await masterkey();
    const file = readFileSync(join(FIXTURES, 'petrol-ofisi-satislistesi.xlsx'));

    const first = await apply(user, file);
    expect(first).toMatchObject({ rowsRead: 23, rowsRefused: 1, rowsDuplicate: 1 });
    const stored = await rowsOf();
    expect(stored).toHaveLength(21);
    const byState = (state: string) => stored.filter((r) => r.state === state);
    expect(byState('excluded').map((r) => [r.subsidiaryId, r.litres.toString()])).toEqual(
      Array.from({ length: 4 }, () => [assoc, '20']),
    );
    expect(byState('ready')).toHaveLength(16);
    expect(byState('waiting_account').map((r) => r.subsidiaryId)).toEqual([null]);
    // The shared invoice's stored rows add up to 749.38 + 19.63 L (the second account's row waits in the tray).
    const shared = stored.filter((r) => r.invoiceRef === 'OZK0000000000001');
    expect(shared.reduce((sum, r) => sum + Math.round(Number(r.litres) * 100), 0) / 100).toBe(769.01);
    expect(await owner.activityRecord.count({ where: { subsidiary: { organisationId: tenant.organisationId } } })).toBe(0);

    const second = await apply(user, file);
    expect(second.rowsDuplicate).toBe(22);
    expect(await rowsOf()).toHaveLength(21);

    const audit = await owner.auditLog.findFirst({
      where: { entity: 'import_batch', entityId: first.id, action: 'bulk_import' },
    });
    const diff = (audit?.diff as { fuelUpload: { byAccount: unknown[]; usage: string; rowsRead: number } }).fuelUpload;
    expect(diff).toMatchObject({ usage: 'on_road', rowsRead: 23 });
    expect(diff.byAccount).toContainEqual({ code: 'PO-9001', state: 'excluded', rows: 4, litres: '80' });
  });

  it('stores nothing when the transaction fails midway, and a retry stores the file once', async () => {
    const user = await masterkey();
    const file = salesList('INT-A', 12);
    const failing = failingAuditClient(runtime);
    await expect(apply(user, file, failing)).rejects.toThrow();
    expect(await rowsOf()).toHaveLength(0);
    expect(await owner.fuelAccount.count({ where: { organisationId: tenant.organisationId } })).toBe(0);
    expect(await owner.importBatch.count({ where: { organisationId: tenant.organisationId } })).toBe(0);

    await apply(user, file);
    await apply(user, file);
    expect(await rowsOf()).toHaveLength(12);
    expect(await owner.importBatch.count({ where: { organisationId: tenant.organisationId } })).toBe(2);
  });

  it('stores each row once under two concurrent applies of one file', async () => {
    const user = await masterkey();
    const file = salesList('INT-B', 30);
    const results = await Promise.allSettled([apply(user, file), apply(user, file)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await rowsOf()).toHaveLength(30);
  });

  it('reports a duplicate waiting under another holder apart, naming no one', async () => {
    const holder = await addMember(owner, tenant, UserRole.super_admin, { grants: [tenant.subsidiaryId] });
    const file = salesList('INT-C', 3);
    await apply(holder, file);
    const user = await masterkey();
    const preview = await services().files.preview(user, asFile(file), { source: 'petrol_ofisi', usage: 'on_road' });
    expect(preview.duplicates.map((d) => d.code)).toEqual(Array(3).fill('fuel_duplicate_unbatched'));
    expect(JSON.stringify(preview)).not.toContain(holder.id);
    const own = await services().files.preview(holder, asFile(file), { source: 'petrol_ofisi', usage: 'on_road' });
    expect(own.duplicates.map((d) => d.code)).toEqual(Array(3).fill('fuel_duplicate'));
    // A preview stores nothing.
    expect(await rowsOf()).toHaveLength(3);
  });

  it('stores a withdrawn row again as a new row naming the one it replaces', async () => {
    const user = await masterkey();
    const file = salesList('INT-D', 2);
    const upload = await apply(user, file);
    const account = await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code: 'INT-D' } });
    const after = await services().uploads.withdrawRows(user, upload.id, { accountId: account.id, reason: 'Wrong file' });
    expect(after.rows.withdrawn).toMatchObject({ rows: 2 });
    await apply(user, file);
    const rows = await rowsOf();
    const withdrawn = rows.filter((r) => r.state === 'withdrawn');
    const replacing = rows.filter((r) => r.state !== 'withdrawn');
    expect(withdrawn).toHaveLength(2);
    expect(withdrawn.every((r) => r.withdrawnReason === 'Wrong file' && r.withdrawnState === 'waiting_account')).toBe(true);
    expect(replacing.map((r) => r.replacesId).sort()).toEqual(withdrawn.map((r) => r.id).sort());
  });

  it('refuses an auditor and stores nothing', async () => {
    const file = salesList('INT-E', 1);
    const error = await apply(tenant.users.auditor, file).catch((e: unknown) => e);
    expect((error as { getStatus(): number }).getStatus()).toBe(403);
    expect(await rowsOf()).toHaveLength(0);
  });
});

describe('confirming and changing a mapping (task 5.3)', () => {
  async function waitingAccount(code: string, n: number, unrecognised: number): Promise<string> {
    await apply(await masterkey(), salesList(code, n, unrecognised));
    return (await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code } })).id;
  }
  const states = async () => {
    const rows = await rowsOf();
    return rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.state]: (acc[r.state] ?? 0) + 1 }), {});
  };

  it('re-states 40 waiting rows as 37 ready and 3 waiting for a fuel name', async () => {
    const id = await waitingAccount('INT-F', 40, 3);
    expect(await states()).toEqual({ waiting_account: 40 });
    const account = await services().accounts.confirm(await masterkey(), id, { subsidiaryId: tenant.subsidiaryId });
    expect(account.state).toBe('confirmed');
    expect(await states()).toEqual({ ready: 37, waiting_fuel: 3 });
    expect((await rowsOf()).every((r) => r.subsidiaryId === tenant.subsidiaryId)).toBe(true);
  });

  it('excludes every row, the unrecognised ones included, under an associate; and then refuses a change, stating them', async () => {
    const assoc = await associate();
    const id = await waitingAccount('INT-G', 40, 3);
    const user = await masterkey();
    await services().accounts.confirm(user, id, { subsidiaryId: assoc });
    expect(await states()).toEqual({ excluded: 40 });
    const error = await services().accounts.update(user, id, { subsidiaryId: tenant.subsidiaryId }).catch((e: unknown) => e);
    expect(errorCodeOf(error)).toBe('fuel_account_in_use');
    expect(await states()).toEqual({ excluded: 40 });
  });

  it('moves ready rows to the new company in the same step', async () => {
    const id = await waitingAccount('INT-H', 10, 0);
    const user = await masterkey();
    await services().accounts.confirm(user, id, { subsidiaryId: tenant.subsidiaryId });
    await services().accounts.update(user, id, { subsidiaryId: tenant.otherSubsidiaryId });
    const rows = await rowsOf();
    expect(rows.map((r) => [r.state, r.subsidiaryId])).toEqual(Array(10).fill(['ready', tenant.otherSubsidiaryId]));
    await services().accounts.update(user, id, { subsidiaryId: null });
    expect(await states()).toEqual({ waiting_account: 10 });
  });

  it('lets a super_admin confirm only the proposal of its own company, never an associate or another company', async () => {
    const superAdmin = tenant.users.superAdmin;
    const company = await owner.subsidiary.findUniqueOrThrow({ where: { id: tenant.subsidiaryId } });
    const other = await owner.subsidiary.findUniqueOrThrow({ where: { id: tenant.otherSubsidiaryId } });
    // Accounts named as the companies are, so the tool proposes each.
    await apply(await masterkey(), salesListNamed('INT-OWN', company.legalName));
    await apply(await masterkey(), salesListNamed('INT-OTHER', other.legalName));
    const own = await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code: 'INT-OWN' } });
    const foreign = await owner.fuelAccount.findFirstOrThrow({ where: { organisationId: tenant.organisationId, code: 'INT-OTHER' } });
    expect([own.state, own.subsidiaryId]).toEqual(['proposed', tenant.subsidiaryId]);
    expect([foreign.state, foreign.subsidiaryId]).toEqual(['proposed', tenant.otherSubsidiaryId]);

    const listed = await services().accounts.list(superAdmin);
    expect(listed.map((a) => a.code)).toEqual(['INT-OWN']);
    const notFound = await services().accounts.confirm(superAdmin, foreign.id, { subsidiaryId: tenant.otherSubsidiaryId }).catch((e: unknown) => e);
    expect(errorCodeOf(notFound)).toBe('fuel_account_not_found');
    const confirmed = await services().accounts.confirm(superAdmin, own.id, { subsidiaryId: tenant.subsidiaryId });
    expect(confirmed.state).toBe('confirmed');
    const standard = await services().accounts.list(tenant.users.standardUser).catch((e: unknown) => e);
    expect((standard as { getStatus(): number }).getStatus()).toBe(403);
  });
});

function salesListNamed(code: string, name: string): Buffer {
  return xlsx({
    sheetData: [
      sheetRow(1, ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası']),
      sheetRow(2, [`${code}-1`, code, name, '03.03.2025 08:00', 'Motorin Med', 10, 'OZK-INT-9']),
    ].join(''),
  });
}

describe('reading uploads, the tray, a takeover (task 5.4)', () => {
  it('scopes the list, the summary and the tray to the reader, and answers others as not found', async () => {
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [tenant.subsidiaryId] });
    const upload = await apply(reporter, salesList('INT-TRAY', 4, 1));
    const files = services();

    // The uploader reads its own upload, and its rows waiting for an account.
    expect((await files.uploads.list(reporter)).map((u) => u.id)).toEqual([upload.id]);
    expect((await files.uploads.detail(reporter, upload.id)).rows.waiting_account).toEqual({ rows: 4, litres: '46' });
    const tray = await files.uploads.tray(reporter);
    expect(tray.accounts).toMatchObject([{ code: 'INT-TRAY', rows: 4, canConfirm: false }]);

    // A super_admin of the company neither lists the upload nor reads rows with no company.
    const superAdmin = tenant.users.superAdmin;
    expect(await files.uploads.list(superAdmin)).toEqual([]);
    expect(errorCodeOf(await files.uploads.detail(superAdmin, upload.id).catch((e: unknown) => e))).toBe('fuel_file_not_found');
    expect((await files.uploads.tray(superAdmin)).accounts).toEqual([]);

    // The organisation's readers read all; another organisation's masterkey reads nothing.
    expect((await files.uploads.tray(tenant.users.auditor)).accounts).toHaveLength(1);
    const stranger = await createTenant();
    try {
      const outsider = stranger.users.masterkey;
      expect(errorCodeOf(await files.uploads.detail(outsider, upload.id).catch((e: unknown) => e))).toBe('fuel_file_not_found');
      expect((await files.uploads.tray(outsider)).accounts).toEqual([]);
    } finally {
      await stranger.cleanup();
    }
  });

  it('makes a masterkey the holder of an upload’s unbatched rows, ready again, with an audit row naming the uploader', async () => {
    const reporter = await addMember(owner, tenant, UserRole.standard_user, { grants: [tenant.subsidiaryId] });
    await confirmedAccount('INT-TAKE', tenant.otherSubsidiaryId);
    const upload = await apply(reporter, salesList('INT-TAKE', 3));
    // A formation step would hold them as outside the reporter's scope.
    await owner.fuelRow.updateMany({ where: { importBatchId: upload.id }, data: { state: 'held', holdReason: 'fuel_out_of_scope' } });
    const user = await masterkey();
    const after = await services().uploads.takeOver(user, upload.id, {});
    expect(after).toMatchObject({ readerIsHolder: true, processableRows: 3 });
    const rows = await rowsOf();
    expect(rows.map((r) => [r.holderId, r.state, r.holdReason])).toEqual(Array(3).fill([user.id, 'ready', null]));
    const audit = await owner.auditLog.findFirstOrThrow({ where: { entityId: upload.id, action: 'take_over' } });
    expect(audit.diff).toMatchObject({ fuelRowsTakenOver: { uploadedBy: reporter.id, fromHolders: [{ holder: reporter.id, rows: 3, litres: '33' }] } });
    // Only a masterkey takes over.
    const refusal = await services().uploads.takeOver(tenant.users.superAdmin, upload.id, {}).catch((e: unknown) => e);
    expect((refusal as { getStatus(): number }).getStatus()).toBe(403);
  });
});

describe('a tanker file, read first and declared per delivery (task 5.1, C3)', () => {
  const file = () => readFileSync(join(FIXTURES, 'tanker-alimlari.xlsx'));
  const declare = (documentNo: string) => ({ documentNo, fuel: 'diesel', usage: 'stationary', year: 2025, month: 3 });
  const all = ['000101', '000102', '000103', '000104', '000105'];
  const applyTanker = async (declarations: unknown[]) =>
    services().files.apply(await masterkey(), asFile(file(), 'tanker.xlsx'), {
      source: 'tanker',
      fileSha256: sha(file()),
      declarations: JSON.stringify(declarations),
    });

  it('refuses a delivery left undeclared, naming its row, and a choice for a refused or unknown delivery; stores nothing', async () => {
    expect(errorCodeOf(await applyTanker(all.slice(1).map(declare)).catch((e: unknown) => e))).toBe('fuel_file_declarations_incomplete');
    expect(errorCodeOf(await applyTanker([...all.map(declare), declare('TOPLAM')]).catch((e: unknown) => e))).toBe(
      'fuel_file_declaration_unknown',
    );
    expect(errorCodeOf(await applyTanker([...all.map(declare), declare('999999')]).catch((e: unknown) => e))).toBe(
      'fuel_file_declaration_unknown',
    );
    expect(await rowsOf()).toHaveLength(0);
  });

  it('stores each delivery with its declared fuel, usage and month, and refuses a choice for a delivery already stored', async () => {
    const upload = await applyTanker(all.map(declare));
    expect(upload).toMatchObject({ rowsRead: 6, rowsRefused: 1 });
    const rows = await rowsOf();
    expect(rows.map((r) => [r.invoiceRef, r.fuel, r.usage, r.year, r.month, r.rawFuel, r.transactionAt])).toEqual(
      all.map((doc) => [doc, 'diesel', 'stationary', 2025, 3, null, null]),
    );
    const again = await applyTanker([declare('000101')]).catch((e: unknown) => e);
    expect(errorCodeOf(again)).toBe('fuel_file_declaration_unknown');
    const preview = await services().files.preview(await masterkey(), asFile(file(), 'tanker.xlsx'), { source: 'tanker' });
    expect(preview.deliveries.map((d) => d.needs)).toEqual(Array(5).fill('stored'));
  });
});

describe('mapping targets and accounts by hand (task 5.3)', () => {
  it('maps an account by hand before any upload, so its rows never enter the tray; refuses it twice', async () => {
    const user = await masterkey();
    const created = await services().accounts.create(user, { source: 'petrol_ofisi', code: 'INT-HAND', name: 'Hand', subsidiaryId: tenant.subsidiaryId });
    expect(created).toMatchObject({ state: 'confirmed', subsidiaryId: tenant.subsidiaryId, confirmedBy: user.id });
    const again = await services()
      .accounts.create(user, { source: 'petrol_ofisi', code: 'INT-HAND', name: 'Hand', subsidiaryId: tenant.subsidiaryId })
      .catch((e: unknown) => e);
    expect(errorCodeOf(again)).toBe('fuel_account_exists');
    await apply(user, salesList('INT-HAND', 5));
    expect((await rowsOf()).map((r) => r.state)).toEqual(Array(5).fill('ready'));
  });

  it('never maps to a sector group, and keeps an associate’s proposal for a masterkey', async () => {
    const sector = await owner.subsidiary.create({
      data: { organisationId: tenant.organisationId, legalName: 'Int sector group', geographyCode: 'UK', nodeType: 'sector_group', parentId: tenant.subsidiaryId },
    });
    const user = await masterkey();
    const invalid = await services()
      .accounts.create(user, { source: 'shell', code: 'INT-SG', name: 'SG', subsidiaryId: sector.id })
      .catch((e: unknown) => e);
    expect(errorCodeOf(invalid)).toBe('fuel_account_target_invalid');

    const assoc = await associate();
    const id = (await runtime.fuelAccount.create({
      data: { organisationId: tenant.organisationId, source: 'shell', code: 'INT-AP', name: 'AP', subsidiaryId: assoc, state: 'proposed', createdBy: user.id },
    })).id;
    // No grant ever names an associate (TA020), so a super_admin neither reads nor confirms its proposal (B6).
    const superAdmin = tenant.users.superAdmin;
    const refused = await services().accounts.confirm(superAdmin, id, { subsidiaryId: assoc }).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('fuel_account_not_found');
    expect((await services().accounts.list(superAdmin)).find((a) => a.id === id)).toBeUndefined();
    expect((await services().accounts.list(user)).find((a) => a.id === id)).toMatchObject({ canConfirm: true, subsidiaryIsAssociate: true });
    expect((await services().accounts.confirm(user, id, { subsidiaryId: assoc })).state).toBe('confirmed');
  });
});
