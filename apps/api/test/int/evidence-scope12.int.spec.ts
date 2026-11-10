import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus } from '@tonyai/db';
import { evidenceReadyWhere } from '../../src/activity-records/activity-records.service';
import { ApprovalEvidenceMissingError, EvidenceRequiredError } from '../../src/activity-records/errors';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { attachEvidence, connect, connectOwner, createRecord, createTenant, type Tenant } from './db';
import { lifecycleServices } from './services';
import { loadTrReleases } from './tr-releases';

/**
 * K3 (owner, 2026-11-10; QA BUG-R2-02; OpenSpec `uat2-evidence-scope12`)
 * against real PostgreSQL: every Scope 1–2 category needs a file before it is
 * committed. A Mobile Combustion record is refused at submit until a file is
 * linked; one that reached `submitted` without a file — as records did before
 * the rule — is refused at approve until the reviewer returns it and its author
 * attaches one; and the "send drafts" query holds back a Refrigerants draft
 * with no file while a Waste draft goes.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let s: ReturnType<typeof lifecycleServices>;

beforeAll(async () => {
  await loadTrReleases();
  runtime = connect();
  owner = connectOwner();
  s = lifecycleServices(runtime);
}, 120_000);

afterAll(async () => {
  await runtime.$disconnect();
  await owner.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant?.cleanup();
});

/** A priced TR marine gas oil record: the MGO edition covers 2024–2026. */
async function mgoRecord(status: ActivityRecordStatus = ActivityRecordStatus.draft) {
  const location = await owner.location.create({
    data: { subsidiaryId: tenant.subsidiaryId, name: `K3 TR ${randomUUID().slice(0, 8)}`, geographyCode: 'TR' },
  });
  return createRecord(
    runtime,
    tenant,
    {
      locationId: location.id,
      reportingYear: 2025,
      reportingPeriod: 'annual',
      periodValue: 'Annual',
      category: 'Mobile Combustion',
      activityType: 'marine_gas_oil',
      activityValue: 1000,
      activityUnit: 'kg',
      status,
    },
    { priced: true },
  );
}

async function statusOf(id: string) {
  return (await runtime.activityRecord.findUniqueOrThrow({ where: { id } })).status;
}

async function auditCount(id: string) {
  return owner.auditLog.count({ where: { entityId: id } });
}

describe('K3 — submit', () => {
  it('refuses a Mobile Combustion draft with no file, then submits it once one is linked', async () => {
    const record = await mgoRecord();
    const before = await auditCount(record.id);

    await expect(s.records.submit(tenant.users.dataEntry, record.id)).rejects.toBeInstanceOf(EvidenceRequiredError);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.draft);
    expect(await auditCount(record.id)).toBe(before);

    await attachEvidence(runtime, tenant, [record.id]);
    await s.records.submit(tenant.users.dataEntry, record.id);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
  });
});

describe('K3 — approve', () => {
  it('refuses a record submitted without a file; rejected, fixed and resubmitted, it is approved', async () => {
    // Walked to `submitted` by the lifecycle's own steps, past the API's
    // submit gate — a record submitted before Mobile Combustion needed a file.
    const record = await mgoRecord(ActivityRecordStatus.submitted);
    const before = await auditCount(record.id);

    const refusal = await s.records.approve(tenant.users.superAdmin, record.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(ApprovalEvidenceMissingError);
    expect((refusal as ApprovalEvidenceMissingError).getResponse()).toMatchObject({
      code: 'approval_evidence_missing',
      params: { category: 'Mobile Combustion' },
    });
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.submitted);
    expect(await auditCount(record.id)).toBe(before);

    // The remedy the refusal names: return it to the author, who attaches a
    // file (allowed again once the record is rejected) and submits it.
    await s.records.reject(tenant.users.superAdmin, record.id, 'Attach the bunker delivery note');
    await attachEvidence(runtime, tenant, [record.id]);
    await s.records.submit(tenant.users.dataEntry, record.id);
    await s.records.approve(tenant.users.superAdmin, record.id);
    expect(await statusOf(record.id)).toBe(ActivityRecordStatus.approved);
  });
});

describe('K3 — the batch "send drafts" query', () => {
  it('holds back a Refrigerants draft with no file and lets a Waste draft go', async () => {
    const refrigerant = await createRecord(runtime, tenant, {
      category: 'Refrigerants',
      activityType: 'R-32',
      activityUnit: 'kg',
      periodValue: 'February',
    });
    const waste = await createRecord(runtime, tenant, {
      category: 'Waste',
      activityUnit: 'tonnes',
      periodValue: 'March',
    });
    const ready = async () =>
      (
        await runtime.activityRecord.findMany({
          where: { id: { in: [refrigerant.id, waste.id] }, ...evidenceReadyWhere() },
          select: { id: true },
        })
      ).map((r) => r.id);

    expect(await ready()).toEqual([waste.id]);

    await attachEvidence(runtime, tenant, [refrigerant.id]);
    expect((await ready()).sort()).toEqual([refrigerant.id, waste.id].sort());
  });
});
