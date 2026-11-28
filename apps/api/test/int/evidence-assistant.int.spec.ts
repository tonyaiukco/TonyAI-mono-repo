import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EvidenceAssistantDTO } from '@tonyai/shared-types';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import { errorCodeOf } from '../../src/common/api-error';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { EvidenceService } from '../../src/evidence/evidence.service';
import { EvidenceAssistantRuntime } from '../../src/evidence-assistant/evidence-assistant-runtime';
import { EvidenceAssistantService } from '../../src/evidence-assistant/evidence-assistant.service';
import { READER_VERSION } from '../../src/evidence-assistant/invoice-layout';
import { PdfReaderService } from '../../src/evidence-assistant/pdf-reader.service';
import { UploadReadingService } from '../../src/evidence-assistant/upload-reading';
import { FuelBatchFormationService } from '../../src/fuel-batches/fuel-batch-formation.service';
import { FuelBatchesService } from '../../src/fuel-batches/fuel-batches.service';
import { FuelFilesService } from '../../src/fuel-files/fuel-files.service';
import { FuelUploadsService } from '../../src/fuel-files/fuel-uploads.service';
import { StorageIntentsService } from '../../src/storage/storage-intents.service';
import type { StorageService } from '../../src/storage/storage.service';
import { dumanInvoices, invoicesPdf, singleInvoice } from '../fixtures/invoices/generate';
import { row as sheetRow, xlsx } from '../xlsx';
import { connect, connectOwner, createTenant, type Tenant } from './db';
import { lifecycleServices, storageStub } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * inc29-evidence-assistant task 8.2: `GET /fuel-batches/:id/evidence-assistant`
 * against the real schema, the real reader and the WP9 fuel fixtures — one
 * case per scenario of `specs/evidence-assistant` requirements 3 to 13.
 */

const INVOICES = join(__dirname, '..', 'fixtures', 'invoices');
const FUEL = join(__dirname, '..', 'fixtures', 'fuel');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdf = (buffer: Buffer, name = 'invoice.pdf') =>
  ({ fieldname: 'file', originalname: name, encoding: '7bit', mimetype: 'application/pdf', size: buffer.length, buffer }) as Express.Multer.File;
const xlsxFile = (buffer: Buffer, name = 'file.xlsx') => ({ buffer, size: buffer.length, originalname: name }) as Express.Multer.File;

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let reader: PdfReaderService;
/** The bytes every stored object was written with, by path: what `download` answers. */
const objects = new Map<string, Buffer>();

beforeAll(async () => {
  runtime = connect(4);
  owner = connectOwner();
  await loadTrReleases();
  reader = new PdfReaderService();
  expect(await reader.start()).toBe('available');
}, 60_000);
afterAll(async () => {
  reader.onModuleDestroy();
  await Promise.all([runtime, owner].map((c) => c.$disconnect()));
});
beforeEach(async () => {
  tenant = await createTenant();
  await owner.subsidiary.updateMany({ where: { organisationId: tenant.organisationId }, data: { geographyCode: 'TR' } });
});
afterEach(async () => {
  await tenant.cleanup();
});

function wired(opts: { enabled?: boolean; reader?: PdfReaderService } = {}) {
  const storage = storageStub();
  storage.upload.mockImplementation(async (_b: string, path: string, body: Buffer) => {
    objects.set(path, body);
  });
  const download = async (_b: string, path: string) => objects.get(path) ?? Buffer.from('%PDF-1.4\n');
  const store = { ...storage, download } as unknown as StorageService;
  const audit = new AuditService(runtime);
  const assistant = new EvidenceAssistantRuntime(opts.reader ?? reader, { enabled: opts.enabled ?? true, tolerancePercent: '1' });
  const evidence = new EvidenceService(runtime, store, audit, new StorageIntentsService(runtime, store), new UploadReadingService(assistant));
  return { evidence, compare: new EvidenceAssistantService(runtime, audit, store, assistant) };
}

function fuel() {
  const audit = new AuditService(runtime);
  const uploads = new FuelUploadsService(runtime, audit);
  const { records, evidence } = lifecycleServices(runtime);
  return {
    files: new FuelFilesService(runtime, audit, uploads),
    formation: new FuelBatchFormationService(runtime, audit, records, uploads),
    batches: new FuelBatchesService(runtime, audit, records, evidence),
  };
}

async function masterkey(): Promise<RequestUser> {
  const companies = await owner.subsidiary.findMany({ where: { organisationId: tenant.organisationId }, select: { id: true } });
  return { ...tenant.users.masterkey, accessibleSubsidiaryIds: companies.map((c) => c.id) };
}

async function account(code: string, subsidiaryId: string, source: 'petrol_ofisi' | 'shell' | 'tanker'): Promise<void> {
  await runtime.fuelAccount.create({
    data: {
      organisationId: tenant.organisationId, source, code, name: code, subsidiaryId, state: 'confirmed',
      confirmedBy: tenant.users.masterkey.id, confirmedAt: new Date(), createdBy: tenant.users.masterkey.id,
    },
  });
}

/** The WP9 Petrol Ofisi fixture: the shared invoice across A, B and an associate (B's account left unmapped on request). */
async function petrolOfisi(mapSecond = true): Promise<void> {
  const assoc = await owner.subsidiary.create({
    data: { organisationId: tenant.organisationId, legalName: 'Int assoc', geographyCode: 'TR', nodeType: 'company', parentId: tenant.subsidiaryId, control: 'associate' },
  });
  await account('PO-0001', tenant.subsidiaryId, 'petrol_ofisi');
  if (mapSecond) await account('000456', tenant.otherSubsidiaryId, 'petrol_ofisi');
  await account('PO-9001', assoc.id, 'petrol_ofisi');
  const user = await masterkey();
  const file = readFileSync(join(FUEL, 'petrol-ofisi-satislistesi.xlsx'));
  const up = await fuel().files.apply(user, xlsxFile(file), { source: 'petrol_ofisi', usage: 'on_road', fileSha256: sha(file) });
  await fuel().formation.formBatches(user, up.id);
}

/** The WP9 Shell fixture: account `0071234` (company A) holds March's 31,86 L pair. */
async function shell(): Promise<void> {
  await account('0071234', tenant.subsidiaryId, 'shell');
  const user = await masterkey();
  const file = readFileSync(join(FUEL, 'shell-items.xlsx'));
  const up = await fuel().files.apply(user, xlsxFile(file), { source: 'shell', usage: 'on_road', fileSha256: sha(file) });
  await fuel().formation.formBatches(user, up.id);
}

async function batchOf(invoiceRef: string, subsidiaryId = tenant.subsidiaryId): Promise<string> {
  return (await owner.fuelBatch.findFirstOrThrow({ where: { organisationId: tenant.organisationId, invoiceRef, subsidiaryId }, orderBy: { sequence: 'asc' } })).id;
}

const invoicePdf = (name: string) => readFileSync(join(INVOICES, name));
const comparison = (dto: EvidenceAssistantDTO) => {
  if (!dto.enabled || 'unread' in dto && dto.unread) throw new Error(JSON.stringify(dto));
  return dto as Extract<EvidenceAssistantDTO, { invoice: unknown }>;
};
/** Every row of records, fuel rows and batches, to prove a comparison changes none. */
const snapshot = async () =>
  JSON.stringify([
    await owner.activityRecord.findMany({ where: { subsidiary: { organisationId: tenant.organisationId } }, orderBy: { id: 'asc' } }),
    await owner.fuelRow.findMany({ where: { organisationId: tenant.organisationId }, orderBy: { id: 'asc' } }),
    await owner.fuelBatch.findMany({ where: { organisationId: tenant.organisationId }, orderBy: { id: 'asc' } }),
  ]);

describe('the comparison of a Petrol Ofisi batch (requirements 3, 7, 8, 12)', () => {
  it('compares the shared invoice at invoice level: N = 3, the sum with the associate, siblings by scope', async () => {
    await petrolOfisi();
    const a = await batchOf('OZK0000000000001');
    const b = await batchOf('OZK0000000000001', tenant.otherSubsidiaryId);
    const { evidence, compare } = wired();
    const user = await masterkey();
    await evidence.uploadForFuelBatch(user, a, pdf(invoicePdf('ozk-shared.pdf')));
    const before = await snapshot();
    // A super_admin granted company A: the note and the invoice-level sum, not B's batch.
    const sa = comparison(await compare.forBatch(tenant.users.superAdmin, a));
    expect(sa).toMatchObject({ level: 'invoice', tolerancePercent: 1, invoice: { invoiceNo: 'OZK0000000000001', series: 'OZK', buyerName: 'ÖRNEK TAŞIMACILIK A.Ş.', buyerTaxId: '0000000000', pageFrom: 1, pageTo: 1 } });
    if (sa.level !== 'invoice') throw new Error('level');
    expect(sa.lines).toEqual([
      { fuel: 'diesel', invoiceLitres: '312.80', packageLitres: '312.80', invoiceLevelLitres: '312.80', state: 'consistent', periodShift: false },
      { fuel: 'petrol', invoiceLitres: '456.21', packageLitres: '356.58', invoiceLevelLitres: '456.21', state: 'consistent', periodShift: false },
    ]);
    expect(sa.shared).toEqual({ accounts: 3, siblings: [] });
    // A masterkey sees B's package as a sibling.
    const mk = comparison(await compare.forBatch(user, a));
    if (mk.level !== 'invoice') throw new Error('level');
    expect(mk.shared.siblings).toEqual([{ id: b, accountName: 'Örnek İnşaat Filo', subsidiaryName: expect.any(String), sequence: 1 }]);
    // An auditor reads it, as the rest of the sheet.
    expect(comparison(await compare.forBatch(tenant.users.auditor, a)).level).toBe('invoice');
    // Another company's batch is not found for the super_admin.
    expect(errorCodeOf(await compare.forBatch(tenant.users.superAdmin, b).catch((e: unknown) => e))).toBe('fuel_batch_not_found');
    // Looking changes nothing.
    expect(await snapshot()).toBe(before);
  }, 120_000);

  it('answers no_evidence with no file, no_text for a scanned file, no_matching_invoice for another invoice', async () => {
    await petrolOfisi();
    const single = await batchOf('OZK0000000000002');
    const { evidence, compare } = wired();
    const user = await masterkey();
    expect(await compare.forBatch(user, single)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'no_evidence' } });
    await evidence.uploadForFuelBatch(user, single, pdf(invoicePdf('no-text.pdf')));
    expect(await compare.forBatch(user, single)).toMatchObject({ unread: { reason: 'no_text' } });
    await evidence.uploadForFuelBatch(user, single, pdf(invoicePdf('ozk-mixed.pdf')));
    expect(await compare.forBatch(user, single)).toMatchObject({ unread: { reason: 'no_matching_invoice' } });
    await evidence.uploadForFuelBatch(user, single, pdf(invoicePdf('ozk-single.pdf')));
    expect(comparison(await compare.forBatch(user, single))).toMatchObject({
      level: 'package',
      invoice: { invoiceNo: 'OZK0000000000002', periodText: '2025-03-02', periodFrom: null },
      lines: [{ fuel: 'diesel', invoiceLitres: '1168.00', packageLitres: '1168.00', state: 'consistent', periodShift: false }],
    });
  }, 120_000);

  it('switched off, answers { enabled: false } only after the scope check', async () => {
    await petrolOfisi();
    const a = await batchOf('OZK0000000000001');
    const b = await batchOf('OZK0000000000001', tenant.otherSubsidiaryId);
    const { compare } = wired({ enabled: false });
    expect(await compare.forBatch(await masterkey(), a)).toEqual({ enabled: false });
    expect(errorCodeOf(await compare.forBatch(tenant.users.superAdmin, b).catch((e: unknown) => e))).toBe('fuel_batch_not_found');
  }, 120_000);

  it('follows a resubmitted batch’s new litres', async () => {
    await petrolOfisi();
    const single = await batchOf('OZK0000000000002');
    const { evidence, compare } = wired();
    const user = await masterkey();
    await evidence.uploadForFuelBatch(user, single, pdf(invoicePdf('ozk-single.pdf')));
    expect(comparison(await compare.forBatch(user, single)).lines[0]).toMatchObject({ packageLitres: '1168.00', state: 'consistent' });
    // The batch's rows change (a returned batch rebuilt with more rows): the comparison follows.
    await owner.$executeRaw`UPDATE fuel_rows SET litres = litres + 50 WHERE fuel_batch_id = ${single}::uuid`;
    expect(comparison(await compare.forBatch(user, single)).lines[0]).toMatchObject({ packageLitres: '1218.00', state: 'possible_difference' });
  }, 120_000);
});

describe('the invoice level (B10; qa-auditor review of PR B)', () => {
  it('compares two packages of one account on their sum, with N = 1', async () => {
    await account('PO-77', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const header = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
    for (const [usage, id, litres] of [['on_road', 'S-77-1', 10], ['off_road', 'S-77-2', 20]] as const) {
      const buffer = xlsx({ sheetData: [sheetRow(1, header), sheetRow(2, [id, 'PO-77', 'Fleet', '03.03.2025 08:00', 'Motorin', litres, 'OZK0000000000077'])].join('') });
      const up = await fuel().files.apply(user, xlsxFile(buffer), { source: 'petrol_ofisi', usage, fileSha256: sha(buffer) });
      await fuel().formation.formBatches(user, up.id);
    }
    const both = await owner.fuelBatch.findMany({ where: { organisationId: tenant.organisationId, invoiceRef: 'OZK0000000000077' }, orderBy: { sequence: 'asc' } });
    expect(both.map((b) => b.usage)).toEqual(['on_road', 'off_road']);
    const { evidence, compare } = wired();
    const invoice = await invoicesPdf([{ ...singleInvoice(), invoiceNo: 'OZK0000000000077', lines: [{ product: 'Motorin Med', litres: '30.00' }] }]);
    await evidence.uploadForFuelBatch(user, both[0]!.id, pdf(invoice));
    const dto = comparison(await compare.forBatch(user, both[0]!.id));
    if (dto.level !== 'invoice') throw new Error(dto.level);
    expect(dto.lines).toEqual([{ fuel: 'diesel', invoiceLitres: '30.00', packageLitres: '10', invoiceLevelLitres: '30', state: 'consistent', periodShift: false }]);
    expect(dto.shared).toEqual({ accounts: 1, siblings: [expect.objectContaining({ id: both[1]!.id, sequence: 2 })] });
  }, 120_000);

  it('leaves rows still waiting in the tray out of the sum', async () => {
    await petrolOfisi(false);
    const a = await batchOf('OZK0000000000001');
    const { evidence, compare } = wired();
    const user = await masterkey();
    await evidence.uploadForFuelBatch(user, a, pdf(invoicePdf('ozk-shared.pdf')));
    const dto = comparison(await compare.forBatch(user, a));
    if (dto.level !== 'invoice') throw new Error(dto.level);
    // 356.58 L of A's package and the associate's 80.00 L: the 19.63 L of the unmapped account waits in the tray.
    expect(dto.lines[1]).toMatchObject({ fuel: 'petrol', invoiceLevelLitres: '436.58', state: 'possible_difference' });
    expect(dto.shared.accounts).toBe(2);
  }, 120_000);
});

describe('the comparison of a Shell batch (requirements 6, 11)', () => {
  it('recognises the March period-shift pair from both sides', async () => {
    await shell();
    const first = await batchOf('2025-03-1');
    const second = await batchOf('2025-03-2');
    const { evidence, compare } = wired();
    const user = await masterkey();
    const duman = invoicePdf('duman-23.pdf');
    await evidence.uploadForFuelBatch(user, first, pdf(duman));
    // The second half has no read invoice yet: the tolerance alone decides the first.
    expect(comparison(await compare.forBatch(user, first)).lines[0]).toMatchObject({ invoiceLitres: '80.00', packageLitres: '111.86', state: 'possible_difference', periodShift: false });
    await evidence.uploadForFuelBatch(user, second, pdf(duman));
    for (const [id, invoice, pkg] of [[first, '80.00', '111.86'], [second, '119.22', '87.36']] as const) {
      expect(comparison(await compare.forBatch(user, id)).lines).toEqual([
        { fuel: 'diesel', invoiceLitres: invoice, packageLitres: pkg, state: 'consistent', periodShift: true },
      ]);
    }
  }, 120_000);

  it('leaves two invoices of one half-month unread, and a tanker batch', async () => {
    await shell();
    const first = await batchOf('2025-03-1');
    const { evidence, compare } = wired();
    const user = await masterkey();
    const march = dumanInvoices()[4]!;
    const twice = await invoicesPdf([march, { ...march, invoiceNo: 'DAU0000000000098' }]);
    await evidence.uploadForFuelBatch(user, first, pdf(twice));
    expect(await compare.forBatch(user, first)).toMatchObject({ unread: { reason: 'several_matching_invoices' } });
    // A tanker delivery: its PDF is never read and its period stays as declared.
    await account('ÖRNEK DEPO A.Ş.', tenant.subsidiaryId, 'tanker');
    const tankerFile = readFileSync(join(FUEL, 'tanker-alimlari.xlsx'));
    const declare = (documentNo: string) => ({ documentNo, fuel: 'diesel', usage: 'stationary', year: 2025, month: 3 });
    const up = await fuel().files.apply(user, xlsxFile(tankerFile, 'tanker.xlsx'), {
      source: 'tanker', fileSha256: sha(tankerFile), declarations: JSON.stringify(['000101', '000102', '000103', '000104', '000105'].map(declare)),
    });
    await fuel().formation.formBatches(user, up.id);
    const tanker = await batchOf('000101');
    const file = await evidence.uploadForFuelBatch(user, tanker, pdf(invoicePdf('ozk-single.pdf')));
    expect(await compare.forBatch(user, tanker)).toEqual({ enabled: true, tolerancePercent: 1, unread: { reason: 'tanker' } });
    // Nothing of it is read or kept: no reading row, no reading in its audit row (architect review, P2).
    expect(await owner.evidenceReading.count({ where: { evidenceId: file.id } })).toBe(0);
    const [created] = await owner.auditLog.findMany({ where: { entity: 'evidence', entityId: file.id, action: 'create' } });
    expect((created!.diff as { after: Record<string, unknown> }).after.reading).toBeUndefined();
  }, 120_000);
});

describe('a file read at its comparison (fuel-invoice-reading, D4)', () => {
  it('reads a file attached before the assistant once, stored and audited; concurrent first views commit one of each', async () => {
    await petrolOfisi();
    const single = await batchOf('OZK0000000000002');
    const user = await masterkey();
    // Attached while the assistant was off: stored unread.
    const off = wired({ enabled: false });
    const file = await off.evidence.uploadForFuelBatch(user, single, pdf(invoicePdf('ozk-single.pdf')));
    expect(await owner.evidenceReading.count({ where: { evidenceId: file.id } })).toBe(0);
    // A reader that queues instead of answering busy, so both first views read.
    let chain: Promise<unknown> = Promise.resolve();
    const queued = Object.create(reader) as PdfReaderService;
    queued.withSession = ((ms: number, fn: Parameters<PdfReaderService['withSession']>[1]) => {
      const run = chain.then(() => reader.withSession(ms, fn));
      chain = run.catch(() => undefined);
      return run;
    }) as PdfReaderService['withSession'];
    const { compare } = wired({ reader: queued });
    const [a, b] = await Promise.all([compare.forBatch(user, single), compare.forBatch(user, single)]);
    expect(comparison(a).invoice.invoiceNo).toBe('OZK0000000000002');
    expect(comparison(b).invoice.invoiceNo).toBe('OZK0000000000002');
    expect(await owner.evidenceReading.findMany({ where: { evidenceId: file.id } })).toEqual([
      expect.objectContaining({ readerVersion: READER_VERSION, status: 'read' }),
    ]);
    const reads = await owner.auditLog.findMany({ where: { entity: 'evidence', entityId: file.id, action: 'read' } });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.diff).toEqual({ reading: { status: 'read', pages: 1, readerVersion: READER_VERSION }, fuelBatchId: single });
    // Viewed again: nothing more is read or written.
    await compare.forBatch(user, single);
    expect(await owner.auditLog.count({ where: { entity: 'evidence', entityId: file.id, action: 'read' } })).toBe(1);
  }, 120_000);

  it('answers busy while another request reads, and stores nothing', async () => {
    await petrolOfisi();
    const single = await batchOf('OZK0000000000002');
    const user = await masterkey();
    const file = await wired({ enabled: false }).evidence.uploadForFuelBatch(user, single, pdf(invoicePdf('ozk-single.pdf')));
    let release!: () => void;
    const held = reader.withSession(30_000, () => new Promise<void>((r) => { release = r; }));
    expect(await wired().compare.forBatch(user, single)).toMatchObject({ unread: { reason: 'reader_busy' } });
    release();
    await held;
    expect(await owner.evidenceReading.count({ where: { evidenceId: file.id } })).toBe(0);
    expect(comparison(await wired().compare.forBatch(user, single)).invoice.invoiceNo).toBe('OZK0000000000002');
  }, 120_000);
});
