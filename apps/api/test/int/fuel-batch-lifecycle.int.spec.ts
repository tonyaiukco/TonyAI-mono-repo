import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COUNTED_STATUSES, fuelBatchCursor, isCalculated, type ActivityCalculationSnapshot } from '@tonyai/shared-types';
import type { RequestUser } from '../../src/auth/auth.types';
import { AuditService } from '../../src/audit/audit.service';
import { errorCodeOf } from '../../src/common/api-error';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { FuelBatchFormationService } from '../../src/fuel-batches/fuel-batch-formation.service';
import { FuelBatchesService } from '../../src/fuel-batches/fuel-batches.service';
import { FuelFilesService } from '../../src/fuel-files/fuel-files.service';
import { FuelUploadsService } from '../../src/fuel-files/fuel-uploads.service';
import { ReportsService } from '../../src/reports/reports.service';
import { PdfRenderer } from '../../src/common/pdf-renderer';
import { batchVerdictsOf, rewriteVerdict, storedVerdict } from '../../../../packages/db/scripts/anomaly-recompute.lib.mjs';
import { row as sheetRow, xlsx } from '../xlsx';
import { attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { BASE_SQL, DRIFT_WHERE } from '../../../../packages/db/scripts/anomaly-probe.lib.mjs';
import { lifecycleServices, pdfFile } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * inc28-fuel-bulk task 7.1: the batch is the lifecycle unit. Every step moves
 * all of a batch's records or none, under the record service's own gates.
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

function services() {
  const audit = new AuditService(runtime);
  const uploads = new FuelUploadsService(runtime, audit);
  const { records, periodLocks } = lifecycleServices(runtime);
  const { evidence } = lifecycleServices(runtime);
  return {
    evidence,
    uploads,
    files: new FuelFilesService(runtime, audit, uploads),
    formation: new FuelBatchFormationService(runtime, audit, records, uploads),
    batches: new FuelBatchesService(runtime, audit, records, evidence),
    records,
    periodLocks,
  };
}

async function masterkey(): Promise<RequestUser> {
  const companies = await owner.subsidiary.findMany({ where: { organisationId: tenant.organisationId }, select: { id: true } });
  return { ...tenant.users.masterkey, accessibleSubsidiaryIds: companies.map((c) => c.id) };
}

/** A formed batch of on-road diesel: one row per date given, 100 L each. */
async function formedBatch(user: RequestUser, dates: string[], invoice = 'OZK-LC'): Promise<string> {
  // One account for an anomaly series (its history is the account's), one per invoice otherwise.
  const code = invoice.startsWith('OZK-AN') ? 'LC-AN' : `LC-${invoice}`;
  if (!(await owner.fuelAccount.findFirst({ where: { organisationId: tenant.organisationId, code } }))) {
    await runtime.fuelAccount.create({
      data: {
        organisationId: tenant.organisationId, source: 'petrol_ofisi', code, name: code, subsidiaryId: tenant.subsidiaryId,
        state: 'confirmed', confirmedBy: user.id, confirmedAt: new Date(), createdBy: user.id,
      },
    });
  }
  const header = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
  const buffer = xlsx({
    sheetData: [sheetRow(1, header), ...dates.map((d, i) => sheetRow(i + 2, [`${invoice}-${d}`, code, 'Fleet', `${d} 08:00`, 'Motorin', 100, invoice]))].join(''),
  });
  const s = services();
  const up = await s.files.apply(user, { buffer, size: buffer.length, originalname: 'f.xlsx' } as Express.Multer.File, {
    source: 'petrol_ofisi', usage: 'on_road', fileSha256: createHash('sha256').update(buffer).digest('hex'),
  });
  await s.formation.formBatches(user, up.id);
  const batch = await owner.fuelBatch.findFirstOrThrow({ where: { organisationId: tenant.organisationId, invoiceRef: invoice }, orderBy: { sequence: 'desc' } });
  return batch.id;
}

const statuses = async (batchId: string) =>
  (await owner.activityRecord.findMany({ where: { fuelBatchId: batchId }, orderBy: { id: 'asc' } })).map((r) => r.status);
async function withEvidence(batchId: string) {
  const ids = (await owner.activityRecord.findMany({ where: { fuelBatchId: batchId }, select: { id: true } })).map((r) => r.id);
  await attachEvidence(owner, tenant, ids);
}
/** The company's counted total, tCO₂e. */
async function counted(): Promise<number> {
  const records = await owner.activityRecord.findMany({ where: { subsidiaryId: tenant.subsidiaryId, status: { in: [...COUNTED_STATUSES] } } });
  return records.reduce((sum, r) => {
    const calc = r.calculation as unknown as ActivityCalculationSnapshot;
    return sum + (isCalculated(calc) ? calc.tCo2e : 0);
  }, 0);
}

describe('the batch lifecycle (task 7.1)', () => {
  it('refuses a submit without evidence and changes nothing; with a file every record moves together', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025', '04.04.2025']);
    expect(await statuses(id)).toEqual(['draft', 'draft']);
    const refused = await services().batches.submit(user, id).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('evidence_required');
    expect(await statuses(id)).toEqual(['draft', 'draft']);
    await withEvidence(id);
    const submitted = await services().batches.submit(user, id);
    expect(submitted).toMatchObject({ status: 'submitted', submissionCount: 1 });
    expect(await statuses(id)).toEqual(['submitted', 'submitted']);
  });

  it('submits neither record of a batch over two months while one month is locked', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025', '04.04.2025']);
    await withEvidence(id);
    await services().periodLocks.lock(user, { subsidiaryId: tenant.subsidiaryId, reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'April' } as never);
    expect(errorCodeOf(await services().batches.submit(user, id).catch((e: unknown) => e))).toBe('period_locked');
    expect(await statuses(id)).toEqual(['draft', 'draft']);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id } })).status).toBe('draft');
  });

  it('moves the counted total +X at submit, −X at return, +X at resubmit, and not at approval', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025']);
    await withEvidence(id);
    const s = services();
    const base = await counted();
    const x = (await s.batches.detail(user, id)).tCo2e!;
    expect(x).toBeGreaterThan(0);
    const first = await s.batches.submit(user, id);
    expect(await counted()).toBeCloseTo(base + x, 9);
    // A return needs a reason, and names the submission seen.
    expect(errorCodeOf(await s.batches.reject(user, id, '  ', first.submittedAt).catch((e: unknown) => e))).toBe('validation_failed');
    await s.batches.reject(user, id, 'Wrong usage', first.submittedAt);
    expect(await statuses(id)).toEqual(['rejected']);
    expect(await counted()).toBeCloseTo(base, 9);
    const second = await s.batches.submit(user, id);
    expect(second).toMatchObject({ submissionCount: 2 });
    expect(await counted()).toBeCloseTo(base + x, 9);
    // An approval naming the first submission is refused as changed.
    expect(errorCodeOf(await s.batches.approve(user, id, first.submittedAt).catch((e: unknown) => e))).toBe('record_changed');
    const approved = await s.batches.approve(user, id, second.submittedAt);
    expect(approved.status).toBe('approved');
    expect(await statuses(id)).toEqual(['approved']);
    expect(await counted()).toBeCloseTo(base + x, 9);
    // A masterkey's own batch: a self-approval, on the batch's trail.
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', entityId: id, action: 'self_approve' } })).toBe(1);
  });

  it('lets exactly one of a recall and an approval racing on one batch succeed', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025']);
    await withEvidence(id);
    const submitted = await services().batches.submit(user, id);
    const results = await Promise.allSettled([
      services().batches.recall(user, id),
      services().batches.approve(user, id, submitted.submittedAt),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['record_changed', 'record_not_approvable', 'record_not_recallable']).toContain(errorCodeOf(loser.reason));
  });

  it('closes recall once the batch is taken into review', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025']);
    await withEvidence(id);
    const submitted = await services().batches.submit(user, id);
    await services().batches.startReview(user, id, submitted.submittedAt);
    expect(await services().batches.recall(user, id).catch((e: unknown) => errorCodeOf(e))).toBe('record_changed');
    expect(await statuses(id)).toEqual(['under_review']);
  });

  it('stores per-invoice verdicts that the recompute reaches unchanged (task 6.4)', async () => {
    const user = await masterkey();
    for (const [i, day] of ['03.01.2025', '03.02.2025', '03.03.2025', '03.04.2025'].entries()) {
      const id = await formedBatch(user, [day], `OZK-AN-${i}`);
      await withEvidence(id);
      await services().batches.submit(user, id, 'checked');
    }
    const records = await owner.activityRecord.findMany({ where: { fuelBatch: { organisationId: tenant.organisationId } } });
    const invoices = await owner.$queryRaw<Array<{ id: string; accountId: string; usage: string; invoiceRef: string; status: string; period: number }>>`
      SELECT b.id::text, b.fuel_account_id::text AS "accountId", b.usage, b.invoice_ref AS "invoiceRef", b.status,
             min(COALESCE(to_char(r.transaction_at, 'YYYYMMDD')::int, r.year * 10000 + r.month * 100 + 1))::int AS period
      FROM fuel_batches b JOIN fuel_rows r ON r.fuel_batch_id = b.id AND r.state = 'assigned'
      WHERE b.organisation_id = ${tenant.organisationId}::uuid GROUP BY b.id`;
    const fresh = batchVerdictsOf(invoices, records) as Map<string, { anomalous: boolean; priorCount: number | null }>;
    for (const r of records) {
      expect({ flag: r.anomalyFlag, count: r.anomalyBaselinePriorCount }).toEqual({
        flag: fresh.get(r.id)!.anomalous,
        count: fresh.get(r.id)!.priorCount,
      });
    }
    // The fourth invoice was judged against the three before it.
    const last = records.find((r) => r.periodValue === 'April')!;
    expect(last.anomalyBaselinePriorCount).toBe(3);
  });

  it('lets anomaly:recompute --apply rewrite a batch record’s stale verdict, inside its batch’s step (WP9 PR B review, P2)', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-RS');
    const r = await owner.activityRecord.findFirstOrThrow({
      where: { fuelBatchId: id },
      include: { subsidiary: { select: { organisationId: true } } },
    });
    // Without its batch's step the trigger refuses the write (TA029): the repair must declare it.
    const bare = await runtime.activityRecord.updateMany({ where: { id: r.id }, data: { anomalyFlag: true } }).then(() => 'allowed', (e: unknown) => String(e));
    expect(bare).toMatch(/TA029|fuel batch/i);
    const fresh = { anomalous: !r.anomalyFlag, priorCount: 7, baseline: 1.5 };
    expect(await rewriteVerdict(runtime, r, storedVerdict(r), fresh)).toBeNull();
    const after = await owner.activityRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect([after.anomalyFlag, after.anomalyBaselinePriorCount, after.anomalyBaselineTCo2e]).toEqual([fresh.anomalous, 7, 1.5]);
    expect(await owner.auditLog.count({ where: { entity: 'activity_record', entityId: r.id, action: 'rescore' } })).toBe(1);
    // A record changed since the read is skipped, never clobbered.
    expect(await rewriteVerdict(runtime, r, storedVerdict(r), fresh)).toBe('it changed between the read and the write');
  });

  it('is checked by anomaly:probe as D12 judges it: a manual record never counts a batch record as its history (fourth review, P2)', async () => {
    const user = await masterkey();
    for (const [i, day] of ['03.01.2025', '03.02.2025', '03.03.2025'].entries()) {
      const id = await formedBatch(user, [day], `OZK-PR-${i}`);
      await withEvidence(id);
      await services().batches.submit(user, id, 'checked');
    }
    // A manual April record of the same company, category and fuel, stored as the API stores it: no history.
    const april = await createRecord(owner, tenant, {
      category: 'Mobile Combustion', activityType: 'on_road_diesel', activityUnit: 'litres', reportingYear: 2025, periodValue: 'April',
      status: 'approved', calculation: { tCo2e: 5, factorId: 'int-test-placeholder' },
      anomalyFlag: false, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null,
    });
    const rows = await owner.$queryRawUnsafe<Array<{ id: string; priors: number }>>(
      `${BASE_SQL}\nSELECT id, priors FROM verdict WHERE subsidiary_id = $1::uuid`,
      tenant.subsidiaryId,
    );
    // The batch records are not in the manual check at all, and April sees none of them.
    expect(rows.map((r) => [r.id, r.priors])).toEqual([[april.id, 0]]);
    const drift = await owner.$queryRawUnsafe<Array<{ id: string }>>(`${BASE_SQL}\nSELECT id FROM verdict WHERE ${DRIFT_WHERE} AND subsidiary_id = $1::uuid`, tenant.subsidiaryId);
    expect(drift).toEqual([]);
  });

  it('refuses a flagged batch submitted without a variance reason and moves nothing; with one it submits', async () => {
    const user = await masterkey();
    for (const [i, day] of ['03.01.2025', '03.02.2025', '03.03.2025'].entries()) {
      const id = await formedBatch(user, [day], `OZK-AN-${i}`);
      await withEvidence(id);
      await services().batches.submit(user, id);
    }
    // Ten fills of 100 L against a history of one: a spike.
    const spike = await formedBatch(user, Array.from({ length: 10 }, () => '03.04.2025').map((d, i) => `${String(i + 1).padStart(2, '0')}${d.slice(2)}`), 'OZK-AN-3');
    await withEvidence(spike);
    const refused = await services().batches.submit(user, spike).catch((e: unknown) => errorCodeOf(e));
    expect(refused).toBe('variance_reason_required');
    expect(await statuses(spike)).toEqual(['draft']);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id: spike } })).status).toBe('draft');
    expect((await services().batches.submit(user, spike, 'A second vehicle joined the fleet')).varianceReason).toBe('A second vehicle joined the fleet');
  });

  it('routes a standard user’s batch to the company’s active super_admin, and to a masterkey when it has none', async () => {
    const { standardUser: author, superAdmin } = tenant.users;
    const mk = await masterkey();
    const s = services();
    const id = await formedBatch(author, ['03.03.2025'], 'OZK-RT');
    await withEvidence(id);
    const submitted = await s.batches.submit(author, id);
    expect(submitted.approver).toBe('super_admin');
    // A masterkey is not this batch's approver while the company has an active super_admin.
    expect(await s.batches.approve(mk, id, submitted.submittedAt).catch((e: unknown) => errorCodeOf(e))).toBe('not_record_approver');
    expect(await statuses(id)).toEqual(['submitted']);
    expect((await s.batches.approve(superAdmin, id, submitted.submittedAt)).status).toBe('approved');
    expect(await statuses(id)).toEqual(['approved']);
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', entityId: id, action: 'approve', userId: superAdmin.id } })).toBe(1);

    // The company's only super_admin disabled: the next batch is a masterkey's to decide.
    await owner.profile.update({ where: { id: superAdmin.id }, data: { disabledAt: new Date() } });
    const next = await formedBatch(author, ['04.03.2025'], 'OZK-RT2');
    await withEvidence(next);
    const pending = await s.batches.submit(author, next);
    expect(pending.approver).toBe('masterkey');
    expect((await s.batches.approve(mk, next, pending.submittedAt)).status).toBe('approved');
  });
});

describe('a batch’s record is not acted on singly (task 7.2)', () => {
  it('refuses every single-record step with record_in_batch and writes nothing; void and the period lock still act', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025']);
    const [record] = await owner.activityRecord.findMany({ where: { fuelBatchId: id } });
    const s = services();
    const before = await owner.activityRecord.findUniqueOrThrow({ where: { id: record!.id } });
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => errorCodeOf(e));
    expect(await code(s.records.update(user, record!.id, { activityValue: 1 } as never))).toBe('record_in_batch');
    expect(await code(s.records.submit(user, record!.id))).toBe('record_in_batch');
    expect(await code(s.evidence.upload(user, record!.id, pdfFile()))).toBe('record_in_batch');
    expect(await code(s.records.remove(user, record!.id))).toBe('record_in_batch');
    expect(await owner.activityRecord.findUniqueOrThrow({ where: { id: record!.id } })).toEqual(before);

    await withEvidence(id);
    const submitted = await s.batches.submit(user, id);
    expect(await code(s.records.recall(user, record!.id))).toBe('record_in_batch');
    expect(await code(s.records.startReview(user, record!.id, submitted.submittedAt))).toBe('record_in_batch');
    expect(await code(s.records.reject(user, record!.id, 'no', submitted.submittedAt))).toBe('record_in_batch');
    expect(await code(s.records.approve(user, record!.id, submitted.submittedAt))).toBe('record_in_batch');
    expect(await statuses(id)).toEqual(['submitted']);

    await s.batches.approve(user, id, submitted.submittedAt);
    // The period lock treats a batch's record as any record; void stays per record, with the masterkey.
    await s.periodLocks.lock(user, { subsidiaryId: tenant.subsidiaryId, reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'March' } as never);
    expect(await statuses(id)).toEqual(['locked']);
  });

  it('lets a masterkey void one approved record of a batch, which leaves the totals', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025', '04.04.2025']);
    await withEvidence(id);
    const s = services();
    const submitted = await s.batches.submit(user, id);
    await s.batches.approve(user, id, submitted.submittedAt);
    const [first] = await owner.activityRecord.findMany({ where: { fuelBatchId: id }, orderBy: { id: 'asc' } });
    const base = await counted();
    await s.records.void(user, first!.id, 'Entered twice');
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('voided');
    expect(await counted()).toBeLessThan(base);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id } })).status).toBe('approved');
  });

  it('never moves an approved batch whose every record is voided: no review, no return, no records come back (QA review of PR B)', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025', '04.04.2025']);
    await withEvidence(id);
    const s = services();
    const submitted = await s.batches.submit(user, id);
    await s.batches.approve(user, id, submitted.submittedAt);
    for (const r of await owner.activityRecord.findMany({ where: { fuelBatchId: id } })) await s.records.void(user, r.id, 'Entered twice');
    const decider = tenant.users.superAdmin;
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => errorCodeOf(e));
    expect(await code(s.batches.startReview(decider, id, submitted.submittedAt))).toBe('fuel_batch_not_open');
    expect(await code(s.batches.reject(decider, id, 'reopen', submitted.submittedAt))).toBe('fuel_batch_not_open');
    expect(await code(s.batches.changeDeclarations(user, id, { usage: 'off_road' }))).toBe('fuel_batch_not_open');
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id } })).status).toBe('approved');
    expect(await statuses(id)).toEqual(['voided', 'voided']);
  });
});

describe('evidence on the batch (task 7.3)', () => {
  const links = (fileId: string) => owner.activityRecordEvidence.count({ where: { evidenceId: fileId } });

  it('attaches one file to every record; a detach from one batch leaves a file another batch holds; the last link deletes it', async () => {
    const user = await masterkey();
    const a = await formedBatch(user, ['03.03.2025', '04.04.2025'], 'OZK-EA');
    const b = await formedBatch(user, ['05.03.2025'], 'OZK-EB');
    const s = services();
    expect((await s.batches.detail(user, a)).evidenceCount).toBe(0);
    const file = await s.evidence.uploadForFuelBatch(user, a, pdfFile());
    expect(await links(file.id)).toBe(2);
    expect((await s.batches.detail(user, a)).evidenceCount).toBe(1);
    // The same file on the second batch: link it as the batch's step does (one company's file).
    const bRecords = await owner.activityRecord.findMany({ where: { fuelBatchId: b } });
    await owner.activityRecordEvidence.createMany({
      data: bRecords.map((r) => ({ activityRecordId: r.id, evidenceId: file.id, subsidiaryId: tenant.subsidiaryId, linkedBy: user.id })),
    });
    expect(await s.evidence.detachFromFuelBatch(user, a, file.id)).toEqual({ fileDeleted: false });
    expect(await links(file.id)).toBe(1);
    expect(await s.evidence.detachFromFuelBatch(user, b, file.id)).toEqual({ fileDeleted: true });
    expect(await owner.evidence.count({ where: { id: file.id } })).toBe(0);
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', entityId: a, action: { in: ['attach', 'detach'] } } })).toBe(2);
  });

  it('gives a record that joins the open batch later the batch’s files, so the batch submits whole (WP9 PR B review, P1)', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-EJ');
    const s = services();
    const file = await s.evidence.uploadForFuelBatch(user, id, pdfFile());
    // The same invoice's petrol row arrives in a later file: a new record of the open batch.
    const code = 'LC-OZK-EJ';
    const header = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
    const buffer = xlsx({ sheetData: [sheetRow(1, header), sheetRow(2, ['OZK-EJ-P1', code, 'Fleet', '04.03.2025 08:00', 'Kurşunsuz Benzin 95', 50, 'OZK-EJ'])].join('') });
    const up = await s.files.apply(user, { buffer, size: buffer.length, originalname: 'g.xlsx' } as Express.Multer.File, {
      source: 'petrol_ofisi', usage: 'on_road', fileSha256: createHash('sha256').update(buffer).digest('hex'),
    });
    expect(await s.formation.formBatches(user, up.id)).toMatchObject({ joinedBatches: 1, formedBatches: 0 });
    const records = await owner.activityRecord.findMany({ where: { fuelBatchId: id }, orderBy: { createdAt: 'asc' } });
    expect(records).toHaveLength(2);
    expect(await links(file.id)).toBe(2);
    const joinedAudit = await owner.auditLog.findFirstOrThrow({ where: { entity: 'fuel_batch', entityId: id, action: 'update' }, orderBy: { createdAt: 'desc' } });
    expect((joinedAudit.diff as { fuelBatch: { filesLinked?: number } }).fuelBatch.filesLinked).toBe(1);
    await s.batches.submit(user, id);
    expect(await statuses(id)).toEqual(['submitted', 'submitted']);
  });

  it('refuses attach and detach on a submitted batch, and a submit after the only file is taken off', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-ES');
    const s = services();
    const file = await s.evidence.uploadForFuelBatch(user, id, pdfFile());
    await s.batches.submit(user, id);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => errorCodeOf(e));
    expect(await code(s.evidence.uploadForFuelBatch(user, id, pdfFile()))).toBe('fuel_batch_not_open');
    expect(await code(s.evidence.detachFromFuelBatch(user, id, file.id))).toBe('fuel_batch_not_open');
    await s.batches.recall(user, id);
    // A detach racing a submit: either the file stays and the batch is submitted, or it goes and the submit is refused.
    const [detach, submit] = await Promise.allSettled([s.evidence.detachFromFuelBatch(user, id, file.id), s.batches.submit(user, id)]);
    const batch = await owner.fuelBatch.findUniqueOrThrow({ where: { id } });
    if (submit.status === 'fulfilled') {
      expect(detach.status).toBe('rejected');
      expect(batch.status).toBe('submitted');
      expect(await links(file.id)).toBe(1);
    } else {
      expect(detach.status).toBe('fulfilled');
      expect(errorCodeOf(submit.reason)).toBe('evidence_required');
      expect(batch.status).toBe('draft');
    }
  });
});

describe('the author’s standing at the write (WP9 PR B review, P1)', () => {
  /** Rows of on-road diesel applied, not formed. */
  async function applyRows(user: RequestUser, dates: string[], invoice: string): Promise<string> {
    const code = `LC-${invoice}`;
    const header = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
    const buffer = xlsx({
      sheetData: [sheetRow(1, header), ...dates.map((d, i) => sheetRow(i + 2, [`${invoice}-${d}`, code, 'Fleet', `${d} 08:00`, 'Motorin', 100, invoice]))].join(''),
    });
    const up = await services().files.apply(user, { buffer, size: buffer.length, originalname: 'f.xlsx' } as Express.Multer.File, {
      source: 'petrol_ofisi', usage: 'on_road', fileSha256: createHash('sha256').update(buffer).digest('hex'),
    });
    return up.id;
  }
  const refusal = (p: Promise<unknown>) => p.then(() => 'allowed', (e: unknown) => errorCodeOf(e) ?? (e as { getStatus?: () => number }).getStatus?.() ?? String(e));

  it('attaches no file, submits nothing and changes no declaration once the author’s grant is withdrawn after the request (D14)', async () => {
    const author = tenant.users.standardUser;
    const id = await formedBatch(author, ['03.03.2025'], 'OZK-GR');
    await withEvidence(id);
    const recordIds = (await owner.activityRecord.findMany({ where: { fuelBatchId: id }, select: { id: true } })).map((r) => r.id);
    const linksBefore = await owner.activityRecordEvidence.count({ where: { activityRecordId: { in: recordIds } } });
    // The grant goes; the request, authorised before, still names it.
    await owner.userSubsidiaryAccess.deleteMany({ where: { userId: author.id } });
    const s = services();
    expect(await refusal(s.evidence.uploadForFuelBatch(author, id, pdfFile()))).toBe('subsidiary_not_found');
    expect(await owner.activityRecordEvidence.count({ where: { activityRecordId: { in: recordIds } } })).toBe(linksBefore);
    expect(await refusal(s.batches.submit(author, id))).toBe('subsidiary_not_found');
    expect(await refusal(s.batches.changeDeclarations(author, id, { usage: 'off_road' }))).toBe('subsidiary_not_found');
    expect(await refusal(s.batches.withdraw(author, id, 'gone'))).toBe('subsidiary_not_found');
    expect(await statuses(id)).toEqual(['draft']);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id } })).usage).toBe('on_road');
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', entityId: id, action: { in: ['attach', 'submit', 'update', 'retract'] } } })).toBe(0);
  });

  it('moves nothing for an author since made an auditor: no submit, no formation, and no row joins its existing record', async () => {
    const author = tenant.users.standardUser;
    const id = await formedBatch(author, ['03.03.2025'], 'OZK-RO');
    await withEvidence(id);
    const before = await owner.activityRecord.findMany({ where: { fuelBatchId: id }, orderBy: { id: 'asc' } });
    // A later row of the same invoice and month, applied while still an author.
    const upload = await applyRows(author, ['10.03.2025'], 'OZK-RO');
    await owner.profile.update({ where: { id: author.id }, data: { role: 'auditor' } });
    const s = services();
    const asAuditor: RequestUser = { ...author, role: 'auditor' };
    expect(await refusal(s.batches.submit(asAuditor, id))).toBe('record_submit_forbidden');
    expect(await refusal(s.formation.formBatches(asAuditor, upload))).toBe(403);
    // The request authorised before the role change: refused under lock, in the join too.
    expect(await refusal(s.batches.submit(author, id))).toBe(403);
    await s.formation.formBatches(author, upload);
    const joined = await owner.fuelRow.findFirstOrThrow({ where: { importBatchId: upload } });
    expect(joined.fuelBatchId).toBeNull();
    expect(joined.state).toBe('held');
    const after = await owner.activityRecord.findMany({ where: { fuelBatchId: id }, orderBy: { id: 'asc' } });
    expect(after.map((r) => [r.id, r.status, JSON.stringify(r.parameters), r.updatedAt.getTime()])).toEqual(
      before.map((r) => [r.id, r.status, JSON.stringify(r.parameters), r.updatedAt.getTime()]),
    );
  });
});

describe('a standard user’s own batch rows after a category untick (second review of the branch, P2)', () => {
  it('still counts its own batch’s rows in its upload’s summary, as it still reads the batch', async () => {
    const author = tenant.users.standardUser;
    const id = await formedBatch(author, ['03.03.2025', '04.03.2025'], 'OZK-UT');
    const importId = (await owner.fuelRow.findFirstOrThrow({ where: { fuelBatchId: id } })).importBatchId;
    // Mobile Combustion is unticked; the company stays granted.
    await owner.userSubsidiaryAccess.updateMany({ where: { userId: author.id }, data: { categories: ['Fuel'] } });
    const now: RequestUser = { ...author, categoryGrants: { [tenant.subsidiaryId]: ['Fuel'] } };
    const s = services();
    expect((await s.batches.detail(now, id)).id).toBe(id);
    expect((await s.uploads.detail(now, importId)).rows.assigned).toEqual({ rows: 2, litres: '200' });
  });
});

describe('the batch list past one page (WP9 PR B review, P2)', () => {
  it('pages through every batch in one order, the metadata naming the total', async () => {
    const user = await masterkey();
    const ids = [
      await formedBatch(user, ['03.03.2025'], 'OZK-PG1'),
      await formedBatch(user, ['04.03.2025'], 'OZK-PG2'),
      await formedBatch(user, ['05.03.2025'], 'OZK-PG3'),
    ];
    const s = services();
    const first = await s.batches.list(user, {});
    expect((await s.batches.metadata(user, {})).total).toBe(3);
    expect(new Set(first.map((b) => b.id))).toEqual(new Set(ids));
    // Each cursor continues right after its batch, so pages of any size join into the whole list.
    for (const at of [0, 1]) {
      expect((await s.batches.list(user, { after: fuelBatchCursor(first[at]!) })).map((b) => b.id)).toEqual(first.slice(at + 1).map((b) => b.id));
    }
    expect(await s.batches.list(user, { after: fuelBatchCursor(first[2]!) })).toEqual([]);
    expect(await s.batches.list(user, { after: '2025-02-30T00:00:00.000Z~~3596acd1-8cda-4dc2-b648-91caf38d6a2c' }).then(() => 'listed', (e: unknown) => errorCodeOf(e))).toBe('validation_failed');

    // A batch that leaves a loaded page never makes the next page skip one (QA review of the fixes, P2):
    // the drafts' first page is read, its first batch is withdrawn, and the page after it is still whole.
    const drafts = await s.batches.list(user, { status: 'draft' });
    await s.batches.withdraw(user, drafts[0]!.id, 'left the list');
    expect((await s.batches.list(user, { status: 'draft', after: fuelBatchCursor(drafts[0]!) })).map((b) => b.id)).toEqual(drafts.slice(1).map((b) => b.id));

    // In the review order, a page's last batch recalled meanwhile (its submission cleared) still
    // leads to the rest of the queue (the second review of the branch, P2).
    for (const id of drafts.slice(1).map((b) => b.id)) {
      await withEvidence(id);
      await s.batches.submit(user, id, 'checked');
    }
    const queue = await s.batches.list(user, { status: 'submitted' });
    expect(queue).toHaveLength(2);
    await s.batches.recall(user, queue[0]!.id);
    expect((await s.batches.list(user, { status: 'submitted', after: fuelBatchCursor(queue[0]!) })).map((b) => b.id)).toEqual([queue[1]!.id]);
  });
});

describe('the review queue’s “show all” (sixth review of the branch, P2)', () => {
  it('lists submitted and under-review batches as one list, oldest submission first, with one total', async () => {
    const user = await masterkey();
    const ids: string[] = [];
    for (const [i, day] of ['03.03.2025', '04.03.2025', '05.03.2025'].entries()) {
      const id = await formedBatch(user, [day], `OZK-IR${i}`);
      await withEvidence(id);
      await services().batches.submit(user, id, 'checked');
      ids.push(id);
    }
    const s = services();
    // The middle one is taken into review: the list still runs in submission order.
    const middle = await owner.fuelBatch.findUniqueOrThrow({ where: { id: ids[1]! } });
    await s.batches.startReview(user, ids[1]!, middle.submittedAt!.toISOString());
    const listed = await s.batches.list(user, { inReview: true });
    expect(listed.map((b) => [b.id, b.status])).toEqual([[ids[0], 'submitted'], [ids[1], 'under_review'], [ids[2], 'submitted']]);
    expect((await s.batches.metadata(user, { inReview: true })).total).toBe(3);
    expect((await s.batches.list(user, { inReview: true, after: fuelBatchCursor(listed[0]!) })).map((b) => b.id)).toEqual([ids[1], ids[2]]);
    // The months each covers, for the queue's row (D10).
    expect(listed[0]!.periods).toEqual([{ year: 2025, month: 3 }]);
  });
});

describe('a batch file in a locked period (security review of PR B)', () => {
  it('refuses to take a file off a draft batch whose period is locked, and keeps every link and the file', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-PL');
    const s = services();
    const file = await s.evidence.uploadForFuelBatch(user, id, pdfFile());
    // A draft's period may be locked (only pending or returned records refuse a lock).
    await s.periodLocks.lock(user, { subsidiaryId: tenant.subsidiaryId, reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'March' } as never);
    const refused = await s.evidence.detachFromFuelBatch(user, id, file.id).then(() => 'ok', (e: unknown) => errorCodeOf(e));
    expect(refused).toBe('period_locked');
    expect(await owner.activityRecordEvidence.count({ where: { evidenceId: file.id } })).toBe(1);
    expect(await owner.evidence.count({ where: { id: file.id } })).toBe(1);
  });
});

describe('declarations, withdrawal and bulk submit (task 7.4)', () => {
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => errorCodeOf(e));

  it('changes a returned batch’s usage: same litres as off-road records, its files kept, its trail kept, submittable again', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025', '04.04.2025'], 'OZK-DC');
    const s = services();
    const file = await s.evidence.uploadForFuelBatch(user, id, pdfFile());
    const first = await s.batches.submit(user, id);
    await s.batches.reject(user, id, 'It was off-road', first.submittedAt);
    const after = await s.batches.changeDeclarations(user, id, { usage: 'off_road' });
    expect(after).toMatchObject({ usage: 'off_road', status: 'rejected', category: 'Mobile Combustion' });
    const records = await owner.activityRecord.findMany({ where: { fuelBatchId: id }, orderBy: { periodValue: 'asc' } });
    expect(records.map((r) => [r.activityType, r.activityValue])).toEqual([['off_road_diesel', 100], ['off_road_diesel', 100]]);
    expect(await owner.activityRecordEvidence.count({ where: { evidenceId: file.id } })).toBe(2);
    expect(await owner.auditLog.count({ where: { entity: 'fuel_batch', entityId: id, action: { in: ['submit', 'reject', 'update'] } } })).toBe(3);
    expect((await s.batches.submit(user, id)).submissionCount).toBe(2);
    // A submitted batch refuses a change and a withdrawal.
    expect(await code(s.batches.changeDeclarations(user, id, { usage: 'on_road' }))).toBe('fuel_batch_not_open');
    expect(await code(s.batches.withdraw(user, id, 'no'))).toBe('fuel_batch_not_open');
  });

  it('changes the declarations of a batch holding a tiny quantity, and its rows read as plain decimals (WP9 PR B review, P2)', async () => {
    const user = await masterkey();
    const code = 'LC-TINY';
    await runtime.fuelAccount.create({
      data: { organisationId: tenant.organisationId, source: 'petrol_ofisi', code, name: code, subsidiaryId: tenant.subsidiaryId, state: 'confirmed', confirmedBy: user.id, confirmedAt: new Date(), createdBy: user.id },
    });
    const header = ['Satış ID', 'Filo Kod Adı', 'Filo', 'Tarih', 'Tip', 'Miktar', 'Fatura Numarası'];
    const buffer = xlsx({ sheetData: [sheetRow(1, header), sheetRow(2, ['TINY-1', code, 'Fleet', '03.03.2025 08:00', 'Motorin', 0.0000001, 'OZK-TINY']), sheetRow(3, ['TINY-2', code, 'Fleet', '04.03.2025 08:00', 'Motorin', 50, 'OZK-TINY'])].join('') });
    const s = services();
    const up = await s.files.apply(user, { buffer, size: buffer.length, originalname: 'tiny.xlsx' } as Express.Multer.File, {
      source: 'petrol_ofisi', usage: 'on_road', fileSha256: createHash('sha256').update(buffer).digest('hex'),
    });
    await s.formation.formBatches(user, up.id);
    const id = (await owner.fuelBatch.findFirstOrThrow({ where: { organisationId: tenant.organisationId, invoiceRef: 'OZK-TINY' } })).id;
    const page = await s.batches.rows(user, id, {});
    expect(page.rows.map((r) => r.litres).sort()).toEqual(['0.0000001', '50']);
    const after = await s.batches.changeDeclarations(user, id, { usage: 'off_road' });
    expect(after.usage).toBe('off_road');
  });

  it('leaves everything as it was when the rebuild is refused by a locked period', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-DL');
    const s = services();
    const before = await owner.activityRecord.findMany({ where: { fuelBatchId: id } });
    await s.periodLocks.lock(user, { subsidiaryId: tenant.subsidiaryId, reportingYear: 2025, reportingPeriod: 'monthly', periodValue: 'March' } as never);
    expect(await code(s.batches.changeDeclarations(user, id, { usage: 'stationary' }))).toBe('period_locked');
    expect(await owner.activityRecord.findMany({ where: { fuelBatchId: id } })).toEqual(before);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id } })).usage).toBe('on_road');
    expect((await owner.fuelRow.findMany({ where: { fuelBatchId: id } })).map((r) => r.usage)).toEqual(['on_road']);
  });

  it('withdraws a draft batch, keeping it and its rows readable; the same file again forms a new batch of replacing rows', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-WD');
    const s = services();
    await s.batches.withdraw(user, id, 'Uploaded under the wrong usage');
    expect(await owner.activityRecord.count({ where: { fuelBatchId: id } })).toBe(0);
    const batch = await owner.fuelBatch.findUniqueOrThrow({ where: { id } });
    expect(batch).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Uploaded under the wrong usage' });
    const rows = await owner.fuelRow.findMany({ where: { fuelBatchId: id } });
    expect(rows.map((r) => [r.state, r.withdrawnState])).toEqual([['withdrawn', 'assigned']]);
    const again = await formedBatch(user, ['03.03.2025'], 'OZK-WD');
    expect(again).not.toBe(id);
    const replacing = await owner.fuelRow.findFirstOrThrow({ where: { fuelBatchId: again } });
    expect(replacing.replacesId).toBe(rows[0]!.id);
    expect((await owner.fuelBatch.findUniqueOrThrow({ where: { id: again } })).sequence).toBe(2);
  });

  it('submits a mixed selection batch by batch, naming each refusal', async () => {
    const user = await masterkey();
    const ready = await formedBatch(user, ['03.03.2025'], 'OZK-B1');
    const bare = await formedBatch(user, ['04.03.2025'], 'OZK-B2');
    await withEvidence(ready);
    const result = await services().batches.bulkSubmit(user, [ready, bare]);
    expect(result).toEqual({ submitted: [ready], failed: [{ batchId: bare, code: 'evidence_required' }] });
  });
});

describe('the card-fuel attribution follows the report\'s selection (task 8.2)', () => {
  it('is stated once a card batch record counts, for its company, scope and category only', async () => {
    const user = await masterkey();
    const id = await formedBatch(user, ['03.03.2025'], 'OZK-RA');
    await withEvidence(id);
    const reports = new ReportsService(runtime, new AuditService(runtime), new PdfRenderer());
    const flag = (subsidiaryId?: string, filters: { scope?: 1 | 2 | 3; category?: 'Mobile Combustion' | 'Electricity' } = {}) =>
      reports.meta(user, 2025, subsidiaryId, filters).then((m) => m.cardFuelAttribution);
    // A draft is not counted.
    expect(await flag()).toBe(false);
    await services().batches.submit(user, id);
    expect(await flag()).toBe(true);
    expect(await flag(tenant.subsidiaryId)).toBe(true);
    expect(await flag(tenant.subsidiaryId, { scope: 1, category: 'Mobile Combustion' })).toBe(true);
    // Another company's filter, a scope or a category that leaves card fuel out.
    expect(await flag(tenant.otherSubsidiaryId)).toBe(false);
    expect(await flag(undefined, { scope: 2 })).toBe(false);
    expect(await flag(undefined, { scope: 3 })).toBe(false);
    expect(await flag(undefined, { category: 'Electricity' })).toBe(false);
  });
});
