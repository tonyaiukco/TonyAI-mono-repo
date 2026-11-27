import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '../auth/auth.types';
import { errorCodeOf } from '../common/api-error';
import { FuelFilesService } from './fuel-files.service';
import type { FuelUploadsService } from './fuel-uploads.service';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * DB-free: the fuel upload's refusals before anything is stored, and what a
 * preview names (inc28-fuel-bulk D3, D14; task 5.1). The integration spec
 * `test/int/fuel-files.int.spec.ts` holds the stored side.
 */

const FIXTURES = join(__dirname, '../../test/fixtures/fuel');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const asFile = (buffer: Buffer, name = 'file.xlsx') => ({ buffer, size: buffer.length, originalname: name }) as Express.Multer.File;

const ORG = '00000000-0000-4000-8000-0000000000aa';
const LOGISTICS = '00000000-0000-4000-8000-000000000001';
const ASSOCIATE = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

const user = (role: RequestUser['role'], accessible: string[]): RequestUser => ({
  id: '00000000-0000-4000-8000-0000000000ff',
  email: 'x@tonyai.test',
  fullName: 'X',
  role,
  organisationId: ORG,
  accessibleSubsidiaryIds: accessible,
  categoryGrants: {},
});

function harness() {
  const prisma = {
    subsidiary: {
      findMany: vi.fn(async () => [
        { id: LOGISTICS, legalName: 'Örnek Taşımacılık', tradingName: null, control: 'controlled', nodeType: 'company' },
        { id: ASSOCIATE, legalName: 'Örnek İştirak', tradingName: null, control: 'associate', nodeType: 'company' },
        { id: OTHER, legalName: 'Örnek İnşaat', tradingName: null, control: 'controlled', nodeType: 'company' },
      ]),
    },
    fuelAccount: {
      findMany: vi.fn(async () => [
        { id: 'acc-1', code: 'PO-0001', state: 'confirmed', subsidiaryId: LOGISTICS },
        { id: 'acc-9', code: 'PO-9001', state: 'confirmed', subsidiaryId: ASSOCIATE },
        { id: 'acc-4', code: '000456', state: 'confirmed', subsidiaryId: OTHER },
      ]),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
    importBatch: { create: vi.fn() },
    fuelDedupeKey: {
      findUnique: vi.fn(async () => ({ secret: Buffer.alloc(32, 7) })),
      createMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const uploads = { detail: vi.fn() };
  const service = new FuelFilesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    uploads as unknown as FuelUploadsService,
  );
  return { prisma, audit, service };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: unknown; status: number }> {
  const error = await promise.catch((e: unknown) => e);
  return { code: errorCodeOf(error), status: (error as { getStatus(): number }).getStatus() };
}

describe('FuelFilesService — refusals before anything is stored', () => {
  const file = fixture('petrol-ofisi-satislistesi.xlsx');

  it('refuses an auditor with 403', async () => {
    const { service, prisma } = harness();
    const result = await refusal(service.preview(user('auditor', [LOGISTICS]), asFile(file), { source: 'petrol_ofisi', usage: 'on_road' }));
    expect(result.status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an upload that names no source, or a card file with no usage — never assuming one', async () => {
    const { service } = harness();
    const masterkey = user('masterkey', [LOGISTICS]);
    expect((await refusal(service.preview(masterkey, asFile(file), { usage: 'on_road' }))).code).toBe('fuel_file_source_required');
    expect((await refusal(service.preview(masterkey, asFile(file), { source: 'petrol_ofisi' }))).code).toBe('fuel_file_usage_required');
    expect((await refusal(service.preview(masterkey, asFile(file), { source: 'shell', usage: 'marine' }))).code).toBe(
      'fuel_file_usage_required',
    );
  });

  it('refuses a CSV and a missing file', async () => {
    const { service } = harness();
    const masterkey = user('masterkey', [LOGISTICS]);
    expect((await refusal(service.preview(masterkey, asFile(file, 'x.csv'), { source: 'tanker' }))).code).toBe('bulk_file_type');
    expect((await refusal(service.preview(masterkey, undefined, { source: 'tanker' }))).code).toBe('bulk_file_missing');
  });

  it('refuses a file over the fuel upload’s size with 413', async () => {
    const { service } = harness();
    const big = { buffer: Buffer.alloc(1), size: 32 * 1024 * 1024 + 1, originalname: 'big.xlsx' } as Express.Multer.File;
    expect(await refusal(service.preview(user('masterkey', []), big, { source: 'tanker' }))).toEqual({
      code: 'fuel_file_too_large',
      status: 413,
    });
  });

  it('refuses an apply whose file is not the one previewed, and stores nothing', async () => {
    const { service, prisma } = harness();
    const result = await refusal(
      service.apply(user('masterkey', [LOGISTICS]), asFile(file), { source: 'petrol_ofisi', usage: 'on_road', fileSha256: 'f'.repeat(64) }),
    );
    expect(result).toEqual({ code: 'fuel_file_changed', status: 409 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('FuelFilesService — a preview', () => {
  const file = fixture('petrol-ofisi-satislistesi.xlsx');

  it('stores no data, says each account’s outcome with rows and litres, and leaves one audit row', async () => {
    const { service, prisma, audit } = harness();
    const preview = await service.preview(user('masterkey', [LOGISTICS, ASSOCIATE, OTHER]), asFile(file), {
      source: 'petrol_ofisi',
      usage: 'on_road',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'preview', entityId: null }));
    expect(preview).toMatchObject({ rowsRead: 23, refused: [{ row: 24, code: 'fuel_cell_missing' }] });
    expect(preview.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    const byCode = Object.fromEntries(preview.accounts.map((a) => [a.code, a]));
    expect(byCode['PO-0001']).toMatchObject({ subsidiaryId: LOGISTICS, outcomes: [{ outcome: 'batches', rows: 16, litres: '1837.38' }] });
    expect(byCode['PO-9001']).toMatchObject({ subsidiaryId: ASSOCIATE, outcomes: [{ outcome: 'excluded', rows: 4, litres: '80' }] });
  });

  it('names no company the caller may not read, and says those rows are outside its scope', async () => {
    const { service } = harness();
    // A central reporter granted the logistics company only.
    const preview = await service.preview(user('standard_user', [LOGISTICS]), asFile(file), {
      source: 'petrol_ofisi',
      usage: 'on_road',
    });
    const byCode = Object.fromEntries(preview.accounts.map((a) => [a.code, a]));
    expect(byCode['000456']).toMatchObject({
      subsidiaryId: null,
      subsidiaryName: null,
      outcomes: [{ outcome: 'outside_scope', rows: 1, litres: '19.63' }],
    });
    expect(byCode['PO-9001']).toMatchObject({ subsidiaryId: null, subsidiaryName: null, outcomes: [{ outcome: 'excluded' }] });
    // The companies' own names (the account names are the file's text, shown as written).
    const text = JSON.stringify(preview);
    expect(text).not.toContain('"Örnek İştirak"');
    expect(text).not.toContain('"Örnek İnşaat"');
    expect(text).not.toContain(ASSOCIATE);
    expect(text).not.toContain(OTHER);
  });

  it('lists a tanker file’s deliveries, each needing a declaration, and the total row as refused', async () => {
    const { service } = harness();
    const preview = await service.preview(user('masterkey', [LOGISTICS]), asFile(fixture('tanker-alimlari.xlsx')), {
      source: 'tanker',
    });
    expect(preview.usage).toBeNull();
    expect(preview.deliveries.map((d) => [d.documentNo, d.needs])).toEqual([
      ['000101', 'declaration'],
      ['000102', 'declaration'],
      ['000103', 'declaration'],
      ['000104', 'declaration'],
      ['000105', 'declaration'],
    ]);
    expect(preview.refused).toEqual([{ row: 9, code: 'fuel_key_missing' }]);
  });
});
