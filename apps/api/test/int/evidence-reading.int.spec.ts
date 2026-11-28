import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FuelBatchEvidenceUploadDTO } from '@tonyai/shared-types';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { EvidenceService } from '../../src/evidence/evidence.service';
import { EvidenceAssistantRuntime } from '../../src/evidence-assistant/evidence-assistant-runtime';
import { READER_VERSION } from '../../src/evidence-assistant/invoice-layout';
import { PdfReaderService, type ReaderSession } from '../../src/evidence-assistant/pdf-reader.service';
import { UploadReadingService } from '../../src/evidence-assistant/upload-reading';
import { FuelBatchFormationService } from '../../src/fuel-batches/fuel-batch-formation.service';
import { FuelBatchesService } from '../../src/fuel-batches/fuel-batches.service';
import { FuelFilesService } from '../../src/fuel-files/fuel-files.service';
import { FuelUploadsService } from '../../src/fuel-files/fuel-uploads.service';
import { StorageIntentsService } from '../../src/storage/storage-intents.service';
import type { StorageService } from '../../src/storage/storage.service';
import { dumanInvoices, invoicesPdf } from '../fixtures/invoices/generate';
import { row as sheetRow, xlsx, OFFICE_RELATIONSHIPS, SPREADSHEETML } from '../xlsx';
import { connect, connectOwner, createTenant, type Tenant } from './db';
import { lifecycleServices, storageStub, type StorageStub } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * inc29-evidence-assistant tasks 7.1 to 7.3: a batch upload reads the PDF before
 * it is stored, stores the reading with the file, splits a PDF of several
 * invoices into one file per invoice and package, and never refuses an upload
 * because of the reader. Against the real schema, the real reader process and a
 * storage stub that records every object written and removed.
 */

const FIXTURES = join(__dirname, '..', 'fixtures', 'invoices');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdf = (buffer: Buffer, name = 'invoice.pdf') =>
  ({ fieldname: 'file', originalname: name, encoding: '7bit', mimetype: 'application/pdf', size: buffer.length, buffer }) as Express.Multer.File;
const asXlsx = (buffer: Buffer) => ({ buffer, size: buffer.length, originalname: 'file.xlsx' }) as Express.Multer.File;

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let reader: PdfReaderService;

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

/** The evidence service with the assistant wired as the module wires it. */
function evidenceWith(opts: { enabled?: boolean; reader?: PdfReaderService; storage?: StorageStub } = {}) {
  const storage = opts.storage ?? storageStub();
  const audit = new AuditService(runtime);
  const intents = new StorageIntentsService(runtime, storage as unknown as StorageService);
  const assistant = new EvidenceAssistantRuntime(opts.reader ?? reader, { enabled: opts.enabled ?? true, tolerancePercent: '1' });
  const evidence = new EvidenceService(runtime, storage as unknown as StorageService, audit, intents, new UploadReadingService(assistant));
  return { evidence, storage };
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

async function account(code: string, subsidiaryId: string, source: 'petrol_ofisi' | 'shell'): Promise<void> {
  await runtime.fuelAccount.create({
    data: {
      organisationId: tenant.organisationId, source, code, name: code, subsidiaryId, state: 'confirmed',
      confirmedBy: tenant.users.masterkey.id, confirmedAt: new Date(), createdBy: tenant.users.masterkey.id,
    },
  });
}

/** Petrol Ofisi batches, formed by `user`: one sale per [account, invoice]. */
async function poBatches(user: RequestUser, sales: Array<[string, string]>): Promise<Map<string, string[]>> {
  const header = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
  const buffer = xlsx({
    sheetData: [sheetRow(1, header), ...sales.map(([code, invoice], i) => sheetRow(i + 2, [`S-${i}-${invoice}-${code}`, code, 'Fleet', `0${2 + (i % 7)}.03.2025 08:00`, 'Motorin', 10, invoice]))].join(''),
  });
  const s = fuel();
  const up = await s.files.apply(user, asXlsx(buffer), { source: 'petrol_ofisi', usage: 'on_road', fileSha256: sha(buffer) });
  await s.formation.formBatches(user, up.id);
  return batchesByInvoice();
}

/** One Shell batch for the first half of February 2025, formed by `user`. */
async function shellFebruaryBatch(user: RequestUser): Promise<string> {
  const header = ['Müşteri Kodu', 'Müşteri Adı', 'Kart No', 'İşlem Tarihi', 'İstasyon Kodu', 'Ürün', 'Miktar (LT)'];
  const buffer = xlsx({
    sheetData: [sheetRow(1, header), sheetRow(2, ['0071234', 'Fleet', 'CARD-1', '03.02.2025 08:00', 'ST-1', 'Motorin Med', 7502.66])].join(''),
    workbookXml: `<workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}"><sheets><sheet name="items" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  });
  const s = fuel();
  const up = await s.files.apply(user, asXlsx(buffer), { source: 'shell', usage: 'on_road', fileSha256: sha(buffer) });
  await s.formation.formBatches(user, up.id);
  return (await owner.fuelBatch.findFirstOrThrow({ where: { organisationId: tenant.organisationId, invoiceRef: '2025-02-1' } })).id;
}

async function batchOf(invoiceRef: string, subsidiaryId: string): Promise<string> {
  return (await owner.fuelBatch.findFirstOrThrow({ where: { organisationId: tenant.organisationId, invoiceRef, subsidiaryId } })).id;
}

async function batchesByInvoice(): Promise<Map<string, string[]>> {
  const all = await owner.fuelBatch.findMany({ where: { organisationId: tenant.organisationId }, orderBy: [{ invoiceRef: 'asc' }, { id: 'asc' }] });
  const out = new Map<string, string[]>();
  for (const b of all) out.set(b.invoiceRef, [...(out.get(b.invoiceRef) ?? []), b.id]);
  return out;
}

/** The files a batch's records hold, with their readings. */
async function filesOf(batchId: string) {
  return owner.evidence.findMany({
    where: { links: { some: { activityRecord: { fuelBatchId: batchId } } } },
    include: { readings: true },
    orderBy: { createdAt: 'asc' },
  });
}

const createAudits = async (evidenceId: string) =>
  owner.auditLog.findMany({ where: { entity: 'evidence', entityId: evidenceId, action: 'create' } });

describe('reading a PDF at a batch upload (task 7.1)', () => {
  it('stores a read invoice and its reading together; the audit row holds the outcome only', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const [batchId] = (await poBatches(user, [['PO-A', 'OZK0000000000002']])).get('OZK0000000000002')!;
    const dto = await evidenceWith().evidence.uploadForFuelBatch(user, batchId!, pdf(fixture('ozk-single.pdf')));
    expect(dto.split).toBeUndefined();
    const [file] = await filesOf(batchId!);
    expect(file!.id).toBe(dto.id);
    expect(file!.readings).toHaveLength(1);
    expect(file!.readings[0]).toMatchObject({ readerVersion: READER_VERSION, status: 'read', pageCount: 1, subsidiaryId: tenant.subsidiaryId });
    expect((file!.readings[0]!.invoices as Array<{ invoiceNo: string }>)[0]!.invoiceNo).toBe('OZK0000000000002');
    const [audit] = await createAudits(dto.id);
    const after = (audit!.diff as { after: Record<string, unknown> }).after;
    expect(after.reading).toEqual({ status: 'read', pages: 1, readerVersion: READER_VERSION });
    const trail = JSON.stringify(audit!.diff);
    for (const extracted of ['OZK0000000000002', '1168', 'ÖRNEK', '0000000000', 'Motorin']) expect(trail).not.toContain(extracted);
  }, 60_000);

  it('stores a scanned PDF with no_text, and a JPEG without trying', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const [batchId] = (await poBatches(user, [['PO-A', 'OZK0000000000002']])).get('OZK0000000000002')!;
    const { evidence } = evidenceWith();
    await evidence.uploadForFuelBatch(user, batchId!, pdf(fixture('no-text.pdf')));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    await evidence.uploadForFuelBatch(user, batchId!, { ...pdf(jpeg, 'photo.jpg'), mimetype: 'image/jpeg' });
    // The same photo again under another name is a file of its own, as before WP10: only PDFs are deduplicated (fourth round).
    await evidence.uploadForFuelBatch(user, batchId!, { ...pdf(jpeg, 'photo-again.jpg'), mimetype: 'image/jpeg' });
    const files = await filesOf(batchId!);
    expect(files.map((f) => [f.mimeType, f.readings.map((r) => r.status)])).toEqual([
      ['application/pdf', ['no_text']],
      ['image/jpeg', []],
      ['image/jpeg', []],
    ]);
  }, 60_000);

  it('a failing, busy or switched-off reader leaves the upload successful and unread; the batch then submits', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const [batchId] = (await poBatches(user, [['PO-A', 'OZK0000000000002']])).get('OZK0000000000002')!;
    const failing = new PdfReaderService();
    await failing.start();
    (failing as unknown as { withSession: unknown }).withSession = async (_ms: number, fn: (s: ReaderSession) => Promise<unknown>) =>
      fn({ remainingMs: () => 1000, text: async () => { throw new Error('reader crashed'); }, cut: async () => ({ kind: 'failed', reason: 'failed' }) });
    await evidenceWith({ reader: failing }).evidence.uploadForFuelBatch(user, batchId!, pdf(fixture('ozk-single.pdf'), 'failing.pdf'));
    // Busy: another request holds the one reader for the whole upload.
    let release!: () => void;
    const held = reader.withSession(30_000, () => new Promise<void>((r) => { release = r; }));
    await evidenceWith().evidence.uploadForFuelBatch(user, batchId!, pdf(fixture('ozk-adblue.pdf'), 'busy.pdf'));
    release();
    await held;
    await evidenceWith({ enabled: false }).evidence.uploadForFuelBatch(user, batchId!, pdf(fixture('ozk-mixed.pdf'), 'off.pdf'));
    // Three different PDFs: identical bytes would be one file (review of PR B, second round).
    const files = await filesOf(batchId!);
    expect(files.map((f) => [f.fileName, f.readings.length])).toEqual([['failing.pdf', 0], ['busy.pdf', 0], ['off.pdf', 0]]);
    expect(await owner.evidenceReading.count({ where: { evidence: { subsidiaryId: tenant.subsidiaryId } } })).toBe(0);
    expect(await fuel().batches.submit(user, batchId!)).toMatchObject({ status: 'submitted' });
  }, 60_000);

  it('switched off, a PDF of several invoices is attached whole, as before', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const [batchId] = (await poBatches(user, [['PO-A', 'OZK0000000000002']])).get('OZK0000000000002')!;
    const bytes = fixture('ozk-three.pdf');
    const dto = await evidenceWith({ enabled: false }).evidence.uploadForFuelBatch(user, batchId!, pdf(bytes));
    expect(dto.split).toBeUndefined();
    const [file] = await filesOf(batchId!);
    expect([file!.sha256, file!.sizeBytes, file!.sourceSha256, file!.readings.length]).toEqual([sha(bytes), bytes.length, null, 0]);
  }, 60_000);
});

describe('a reading that cannot be stored as it was printed (qa-auditor review of PR B, P1)', () => {
  it('stores a NUL or a lone surrogate the reader met as U+FFFD, and the upload succeeds', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const [batchId] = (await poBatches(user, [['PO-A', 'OZK0000000000002']])).get('OZK0000000000002')!;
    // The real reader's text of the invoice, with characters pdf.js gives for unmapped glyphs.
    const real = await reader.withSession(20_000, (s) => s.text(fixture('ozk-single.pdf')));
    if ('refused' in real || real.kind !== 'text') throw new Error(JSON.stringify(real));
    const pages = real.pages.map((p) => ({ ...p, items: p.items.map((i) => (i.s === 'Motorin Med' ? { ...i, s: 'Motorin\u0000Med' } : i.s.startsWith('ÖRNEK') ? { ...i, s: `${i.s}\ud800` } : i)) }));
    const stub = Object.create(reader) as PdfReaderService;
    stub.withSession = ((_ms: number, fn: (s: ReaderSession) => Promise<unknown>) =>
      fn({ remainingMs: () => 10_000, text: async () => ({ kind: 'text', pageCount: pages.length, pages }), cut: async () => ({ kind: 'failed', reason: 'failed' }) })) as PdfReaderService['withSession'];
    const dto = await evidenceWith({ reader: stub }).evidence.uploadForFuelBatch(user, batchId!, pdf(fixture('ozk-single.pdf')));
    const [file] = await filesOf(batchId!);
    expect(file!.id).toBe(dto.id);
    const invoices = file!.readings[0]!.invoices as Array<{ buyerName: string; lines: Array<{ product: string }> }>;
    expect(invoices[0]!.lines[0]!.product).toBe('Motorin\ufffdMed');
    expect(invoices[0]!.buyerName).toBe('ÖRNEK TAŞIMACILIK A.Ş.\ufffd');
    expect(await fuel().batches.submit(user, batchId!)).toMatchObject({ status: 'submitted' });
  }, 60_000);
});

describe('splitting a PDF of several invoices (task 7.2)', () => {
  it('a 23-invoice Duman PDF on a Shell batch stores only that half-month’s pages and reports 22; K3 then passes', async () => {
    await account('0071234', tenant.subsidiaryId, 'shell');
    const user = await masterkey();
    const batchId = await shellFebruaryBatch(user);
    const source = fixture('duman-23.pdf');
    const { evidence, storage } = evidenceWith();
    const dto: FuelBatchEvidenceUploadDTO = await evidence.uploadForFuelBatch(user, batchId, pdf(source, 'duman_petrol.pdf'));
    // February's first half is the third invoice, on page 3.
    expect(dto.source).toEqual({ sha256: sha(source), pageFrom: 3, pageTo: 3 });
    expect(dto.split).toMatchObject({ invoices: 23, attached: [{ invoiceNo: 'DAU0000000000003', fuelBatchId: batchId }], failedTargets: [] });
    expect(dto.split!.notAttached).toHaveLength(22);
    expect(new Set(dto.split!.notAttached.map((n) => n.reason))).toEqual(new Set(['manual_attachment_required']));
    const [file] = await filesOf(batchId);
    // The stored file is the part: its own bytes, length and digest.
    const uploaded = storage.upload.mock.calls.map((c) => c[2] as Buffer);
    expect(uploaded).toHaveLength(1);
    expect([file!.sizeBytes, file!.sha256, file!.fileName]).toEqual([uploaded[0]!.length, sha(uploaded[0]!), 'duman_petrol.pdf']);
    expect(uploaded[0]!.length).toBeLessThan(source.length);
    expect(file!.readings[0]).toMatchObject({ status: 'read', pageCount: 1 });
    const [audit] = await createAudits(file!.id);
    expect((audit!.diff as { after: { source: unknown } }).after.source).toEqual({ sha256: sha(source), pageFrom: 3, pageTo: 3 });
    expect(await fuel().batches.submit(user, batchId)).toMatchObject({ status: 'submitted' });
  }, 60_000);

  it('a PDF of other invoices stays whole on the selected batch only (C11)', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000009'], ['PO-A', 'OZK0000000000002']]);
    const [selected] = batches.get('OZK0000000000009')!;
    const bytes = fixture('ozk-three.pdf');
    const dto = await evidenceWith().evidence.uploadForFuelBatch(user, selected!, pdf(bytes));
    expect(dto.split).toBeUndefined();
    expect(dto.source).toBeUndefined();
    const [file] = await filesOf(selected!);
    expect([file!.sha256, file!.readings[0]!.status, (file!.readings[0]!.invoices as unknown[]).length]).toEqual([sha(bytes), 'read', 3]);
    // OZK…0002's batch, though the PDF holds its invoice, receives nothing.
    expect(await filesOf(batches.get('OZK0000000000002')![0]!)).toEqual([]);
  }, 60_000);

  it('two Duman invoices of the selected half-month: the original stays for a manual check, nothing is routed (C9)', async () => {
    await account('0071234', tenant.subsidiaryId, 'shell');
    const user = await masterkey();
    const batchId = await shellFebruaryBatch(user);
    const [, , february] = dumanInvoices();
    const twice = await invoicesPdf([dumanInvoices()[0]!, february!, { ...february!, invoiceNo: 'DAU0000000000099' }]);
    const dto = await evidenceWith().evidence.uploadForFuelBatch(user, batchId, pdf(twice));
    expect(dto.split).toBeUndefined();
    const files = await filesOf(batchId);
    expect(files.map((f) => [f.sha256, f.sourceSha256])).toEqual([[sha(twice), null]]);
  }, 60_000);
});

describe('sending the other invoices to their own packages (task 7.3)', () => {
  it('three invoices, one batch missing: each batch gets its own pages, a shared invoice each company its own file', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    await account('PO-B', tenant.otherSubsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-B', 'OZK0000000000001'], ['PO-A', 'OZK0000000000002']]);
    const [first, second] = batches.get('OZK0000000000001')!;
    const [third] = batches.get('OZK0000000000002')!;
    const source = fixture('ozk-three.pdf');
    const dto = await evidenceWith().evidence.uploadForFuelBatch(user, first!, pdf(source));
    expect(dto.split!.attached.map((a) => [a.invoiceNo, a.fuelBatchId]).sort()).toEqual(
      [['OZK0000000000001', first], ['OZK0000000000001', second], ['OZK0000000000002', third]].sort(),
    );
    expect(dto.split!.notAttached).toEqual([{ invoiceNo: 'OZK0000000000006', reason: 'no_eligible_batch' }]);
    const owners = await owner.fuelBatch.findMany({ where: { id: { in: [first!, second!, third!] } }, select: { id: true, subsidiaryId: true } });
    for (const b of owners) {
      const files = await filesOf(b.id);
      expect(files, b.id).toHaveLength(1);
      expect(files[0]!.subsidiaryId).toBe(b.subsidiaryId);
      expect(files[0]!.sourceSha256).toBe(sha(source));
      expect(files[0]!.readings[0]!.status).toBe('read');
    }
    expect((await filesOf(third!))[0]).toMatchObject({ sourcePageFrom: 2, sourcePageTo: 2 });
  }, 90_000);

  it("leaves another author's batch, a submitted batch and a batch outside the uploader's scope untouched, reporting by number only", async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    await account('PO-B', tenant.otherSubsidiaryId, 'petrol_ofisi');
    // A super_admin granted only the first company is the uploader.
    const superAdmin = tenant.users.superAdmin;
    expect(superAdmin.accessibleSubsidiaryIds).toEqual([tenant.subsidiaryId]);
    await poBatches(superAdmin, [['PO-A', 'OZK0000000000001'], ['PO-A', 'OZK0000000000006']]);
    await poBatches(tenant.users.standardUser, [['PO-A', 'OZK0000000000002']]);
    await poBatches(await masterkey(), [['PO-B', 'OZK0000000000002']]);
    const selected = await batchOf('OZK0000000000001', tenant.subsidiaryId);
    const submitted = await batchOf('OZK0000000000006', tenant.subsidiaryId);
    const anotherAuthor = await batchOf('OZK0000000000002', tenant.subsidiaryId);
    const outOfScope = await batchOf('OZK0000000000002', tenant.otherSubsidiaryId);
    const { evidence } = evidenceWith();
    await evidence.uploadForFuelBatch(superAdmin, submitted, pdf(fixture('ozk-single.pdf'), 'k3.pdf'));
    await fuel().batches.submit(superAdmin, submitted);
    const dto = await evidence.uploadForFuelBatch(superAdmin, selected, pdf(fixture('ozk-three.pdf')));
    expect(dto.split!.attached).toEqual([{ invoiceNo: 'OZK0000000000001', fuelBatchId: selected }]);
    expect(dto.split!.notAttached).toEqual([
      { invoiceNo: 'OZK0000000000002', reason: 'no_eligible_batch' },
      { invoiceNo: 'OZK0000000000006', reason: 'no_eligible_batch' },
    ]);
    expect(dto.split!.failedTargets).toEqual([]);
    for (const hidden of [anotherAuthor, outOfScope, submitted]) expect(JSON.stringify(dto)).not.toContain(hidden);
    expect(await filesOf(anotherAuthor)).toEqual([]);
    expect(await filesOf(outOfScope)).toEqual([]);
    expect((await filesOf(submitted)).map((f) => f.fileName)).toEqual(['k3.pdf']);
  }, 90_000);

  it('a second attach after a planted failure completes the rest without a duplicate', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-A', 'OZK0000000000002'], ['PO-A', 'OZK0000000000006']]);
    const [first] = batches.get('OZK0000000000001')!;
    const [second] = batches.get('OZK0000000000002')!;
    const [third] = batches.get('OZK0000000000006')!;
    const storage = storageStub();
    // The second part's upload fails once.
    storage.upload.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => {
      throw new Error('planted storage failure');
    });
    const source = fixture('ozk-three.pdf');
    const firstTry = await evidenceWith({ storage }).evidence.uploadForFuelBatch(user, first!, pdf(source));
    expect(firstTry.split!.failedTargets).toEqual([{ invoiceNo: 'OZK0000000000002', fuelBatchId: second, reason: 'attachment_failed' }]);
    expect(firstTry.split!.notAttached).toEqual([{ invoiceNo: 'OZK0000000000002', reason: 'attachment_failed' }]);
    const retry = await evidenceWith({ storage }).evidence.uploadForFuelBatch(user, first!, pdf(source));
    expect(retry.id).toBe(firstTry.id);
    expect(retry.split!.attached.map((a) => a.fuelBatchId).sort()).toEqual([first, second, third].sort());
    for (const id of [first!, second!, third!]) expect(await filesOf(id), id).toHaveLength(1);
    expect(await owner.auditLog.count({ where: { entity: 'evidence', action: 'create', entityId: firstTry.id } })).toBe(1);
  }, 90_000);

  it('one target failing does not report an invoice another target received', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    await account('PO-B', tenant.otherSubsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-B', 'OZK0000000000001']]);
    const selected = await batchOf('OZK0000000000001', tenant.subsidiaryId);
    const other = await batchOf('OZK0000000000001', tenant.otherSubsidiaryId);
    const storage = storageStub();
    // The selected batch's part stores; the other company's copy fails.
    storage.upload.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => {
      throw new Error('planted storage failure');
    });
    const dto = await evidenceWith({ storage }).evidence.uploadForFuelBatch(user, selected, pdf(fixture('ozk-three.pdf')));
    expect(dto.split!.attached).toEqual([{ invoiceNo: 'OZK0000000000001', fuelBatchId: selected }]);
    expect(dto.split!.failedTargets).toEqual([{ invoiceNo: 'OZK0000000000001', fuelBatchId: other, reason: 'attachment_failed' }]);
    expect(dto.split!.notAttached.map((n) => n.invoiceNo)).not.toContain('OZK0000000000001');
  }, 90_000);

  it('concurrent identical uploads leave one file and one audit set per batch, and no object behind', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-A', 'OZK0000000000002']]);
    const [first] = batches.get('OZK0000000000001')!;
    const [second] = batches.get('OZK0000000000002')!;
    const storage = storageStub();
    // A reader that queues instead of answering busy, so both uploads split and
    // their stores race under the batch locks: each plan is read in turn.
    let chain: Promise<unknown> = Promise.resolve();
    const queued = Object.create(reader) as PdfReaderService;
    queued.withSession = ((ms: number, fn: (s: ReaderSession) => Promise<unknown>) => {
      const run = chain.then(() => reader.withSession(ms, fn));
      chain = run.catch(() => undefined);
      return run;
    }) as PdfReaderService['withSession'];
    expect(storage.remove).not.toHaveBeenCalled();
    // Both uploads pass the check before the upload, then meet: neither has
    // committed, so the batch lock decides (the in-transaction check).
    let arrived = 0;
    let meet!: () => void;
    const met = new Promise<void>((r) => { meet = r; });
    storage.upload.mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) meet();
      if (arrived <= 2) await met;
    });
    const source = fixture('ozk-three.pdf');
    const [a, b] = await Promise.all([1, 2].map(() => evidenceWith({ storage, reader: queued }).evidence.uploadForFuelBatch(user, first!, pdf(source))));
    expect(a!.split).toBeDefined();
    expect(b!.split).toBeDefined();
    expect(a!.id).toBe(b!.id);
    for (const id of [first!, second!]) {
      const files = await filesOf(id);
      expect(files, id).toHaveLength(1);
      expect(await owner.auditLog.count({ where: { entity: 'evidence', action: 'create', entityId: files[0]!.id } })).toBe(1);
      expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', action: 'attach', entityId: id } })).toBe(1);
    }
    // Every object written is a kept file's or was removed; no upload intent is left.
    const kept = new Set((await owner.evidence.findMany({ where: { subsidiaryId: tenant.subsidiaryId } })).map((e) => e.storagePath));
    const removed = new Set(storage.remove.mock.calls.flatMap((c) => c[1] as string[]));
    const written = storage.upload.mock.calls.map((c) => c[1] as string);
    for (const path of written) expect(kept.has(path) || removed.has(path), path).toBe(true);
    expect(await owner.storageIntent.count({ where: { kind: 'upload', objectPath: { in: written } } })).toBe(0);
  }, 120_000);

  it('an identical upload that finds the reader busy adds no whole copy beside the split one (review of PR B, P2)', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-A', 'OZK0000000000002']]);
    const [first] = batches.get('OZK0000000000001')!;
    const [second] = batches.get('OZK0000000000002')!;
    const storage = storageStub();
    // The production reader, held by the first upload until the second has
    // been refused by it: the second is stored whole, unread.
    let entered!: () => void;
    const holding = new Promise<void>((r) => { entered = r; });
    let refused!: () => void;
    const afterRefusal = new Promise<void>((r) => { refused = r; });
    let calls = 0;
    const held = Object.create(reader) as PdfReaderService;
    held.withSession = (async (ms: number, fn: (s: ReaderSession) => Promise<unknown>) => {
      calls += 1;
      if (calls === 1) return reader.withSession(ms, async (s) => { entered(); await afterRefusal; return fn(s); });
      await holding;
      const outcome = await reader.withSession(ms, fn);
      refused();
      return outcome;
    }) as PdfReaderService['withSession'];
    // Both pass the check before the upload, then meet under the batch lock.
    let arrived = 0;
    let meet!: () => void;
    const met = new Promise<void>((r) => { meet = r; });
    storage.upload.mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) meet();
      if (arrived <= 2) await met;
    });
    const source = fixture('ozk-three.pdf');
    const sha = createHash('sha256').update(source).digest('hex');
    const [a, b] = await Promise.all([1, 2].map(() => evidenceWith({ storage, reader: held }).evidence.uploadForFuelBatch(user, first!, pdf(source))));
    expect([a!.split, b!.split].filter(Boolean)).toHaveLength(1);
    expect(a!.id).toBe(b!.id);
    const files = await filesOf(first!);
    expect(files).toHaveLength(1);
    expect(files[0]!.sha256 === sha || files[0]!.sourceSha256 === sha).toBe(true);
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', action: 'attach', entityId: first! } })).toBe(1);
    // The other invoice's batch still gets its own part.
    expect(await filesOf(second!)).toHaveLength(1);
    const kept = new Set((await owner.evidence.findMany({ where: { subsidiaryId: tenant.subsidiaryId } })).map((e) => e.storagePath));
    const removed = new Set(storage.remove.mock.calls.flatMap((c) => c[1] as string[]));
    for (const path of storage.upload.mock.calls.map((c) => c[1] as string)) expect(kept.has(path) || removed.has(path), path).toBe(true);
  }, 120_000);

  it('two identical uploads both stored whole leave one file on the batch (review of PR B, second round)', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-A', 'OZK0000000000002']]);
    const [first] = batches.get('OZK0000000000001')!;
    const storage = storageStub();
    let arrived = 0;
    let meet!: () => void;
    const met = new Promise<void>((r) => { meet = r; });
    storage.upload.mockImplementation(async () => {
      arrived += 1;
      if (arrived === 2) meet();
      if (arrived <= 2) await met;
    });
    // Both find the reader busy with a third job: each is stored whole.
    const busy = Object.create(reader) as PdfReaderService;
    busy.withSession = (async () => ({ refused: 'reader_busy' })) as unknown as PdfReaderService['withSession'];
    const source = fixture('ozk-three.pdf');
    const [a, b] = await Promise.all([1, 2].map(() => evidenceWith({ storage, reader: busy }).evidence.uploadForFuelBatch(user, first!, pdf(source))));
    expect(a!.id).toBe(b!.id);
    expect(await filesOf(first!)).toHaveLength(1);
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', action: 'attach', entityId: first! } })).toBe(1);
    const kept = new Set((await owner.evidence.findMany({ where: { subsidiaryId: tenant.subsidiaryId } })).map((e) => e.storagePath));
    const removed = new Set(storage.remove.mock.calls.flatMap((c) => c[1] as string[]));
    for (const path of storage.upload.mock.calls.map((c) => c[1] as string)) expect(kept.has(path) || removed.has(path), path).toBe(true);
  }, 120_000);

  it('a part is not added to a batch already holding the uploaded PDF whole, nor the PDF whole beside its part', async () => {
    await account('PO-A', tenant.subsidiaryId, 'petrol_ofisi');
    const user = await masterkey();
    const batches = await poBatches(user, [['PO-A', 'OZK0000000000001'], ['PO-A', 'OZK0000000000002']]);
    const [first] = batches.get('OZK0000000000001')!;
    const [second] = batches.get('OZK0000000000002')!;
    const source = fixture('ozk-three.pdf');
    const whole = await evidenceWith({ enabled: false }).evidence.uploadForFuelBatch(user, first!, pdf(source));
    const split = await evidenceWith().evidence.uploadForFuelBatch(user, first!, pdf(source));
    expect(split.id).toBe(whole.id);
    // The answer names the whole file it kept, and does not report this batch as receiving a part.
    expect(split.source).toBeUndefined();
    expect(split.split!.attached.map((a) => a.fuelBatchId)).not.toContain(first);
    expect(split.split!.attached.map((a) => a.fuelBatchId)).toContain(second);
    expect(await filesOf(first!)).toHaveLength(1);
    expect(await filesOf(second!)).toHaveLength(1);
    const again = await evidenceWith({ enabled: false }).evidence.uploadForFuelBatch(user, second!, pdf(source));
    expect((await filesOf(second!)).map((f) => f.id)).toEqual([again.id]);
    // A third batch holding the PDF whole, reached by routing: it keeps the whole file and is not reported as receiving a part.
    const [third] = (await poBatches(user, [['PO-A', 'OZK0000000000006']])).get('OZK0000000000006')!;
    const kept = await evidenceWith({ enabled: false }).evidence.uploadForFuelBatch(user, third!, pdf(source));
    const routed = await evidenceWith().evidence.uploadForFuelBatch(user, first!, pdf(source));
    expect(routed.split!.attached.map((a) => a.fuelBatchId)).not.toContain(third);
    expect(routed.split!.notAttached.map((n) => n.invoiceNo)).not.toContain('OZK0000000000006');
    expect((await filesOf(third!)).map((f) => f.id)).toEqual([kept.id]);
  }, 120_000);
});
