import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ImportBatchesService } from './import-batches.service';
import type { BulkSubmitService } from './bulk-submit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import type { RequestUser } from '../auth/auth.types';

const ORG = 'e1111111-1111-4111-8111-11111111111e';
const SUB_A = 'a1111111-1111-4111-8111-11111111111a';
const SUB_B = 'b2222222-2222-4222-8222-22222222222b';
const BATCH = 'c3333333-3333-4333-8333-33333333333c';

function batch(over: Record<string, unknown> = {}) {
  return {
    id: BATCH,
    organisationId: ORG,
    uploadedBy: 'user-entry',
    subsidiaryIds: [SUB_A],
    fileName: 'q3.csv',
    fileFormat: 'csv',
    sizeBytes: 100,
    sha256: 'f'.repeat(64),
    storagePath: `${ORG}/${BATCH}/source.csv`,
    status: 'completed',
    totalRows: 3,
    acceptedCount: 2,
    rejectedCount: 1,
    completedAt: new Date('2026-09-19T10:00:00Z'),
    createdAt: new Date('2026-09-19T09:59:00Z'),
    updatedAt: new Date('2026-09-19T10:00:00Z'),
    ...over,
  };
}

const user = (over: Partial<RequestUser> = {}): RequestUser => ({
  id: 'user-entry',
  email: 'entry@tonyai.local',
  fullName: 'Entry User',
  role: 'data_entry',
  organisationId: ORG,
  accessibleSubsidiaryIds: [SUB_A],
  ...over,
});

function build() {
  const prisma = {
    importBatch: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    activityRecord: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    profile: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const storage = { createSignedUrl: vi.fn().mockResolvedValue('https://signed') };
  const bulkSubmit = {
    submitIds: vi.fn().mockResolvedValue({ requested: 0, submitted: [], failed: [] }),
  };
  const service = new ImportBatchesService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    bulkSubmit as unknown as BulkSubmitService,
  );
  return { prisma, storage, bulkSubmit, service };
}

describe('ImportBatchesService — who may see a batch (the RLS rule, applied by the API)', () => {
  it.each([
    ['its data_entry uploader, who reaches every subsidiary it names', user(), true],
    ['a data_entry colleague who did not upload it', user({ id: 'user-other' }), false],
    [
      'its uploader after losing one of its subsidiaries',
      user(),
      false,
      { subsidiaryIds: [SUB_A, SUB_B] },
    ],
    ['its uploader, when it names no subsidiary at all', user(), false, { subsidiaryIds: [] }],
    ['a consultant of the organisation', user({ id: 'u-c', role: 'consultant' }), true],
    ['an executive viewer of the organisation', user({ id: 'u-x', role: 'executive_viewer' }), true],
    ['a super_admin of the organisation', user({ id: 'u-a', role: 'super_admin' }), true],
    [
      'a super_admin of ANOTHER organisation',
      user({ id: 'u-a', role: 'super_admin', organisationId: 'd4444444-4444-4444-8444-44444444444d' }),
      false,
    ],
  ] as [string, RequestUser, boolean, Record<string, unknown>?][])(
    '%s → %s',
    async (_label, caller, visible, over) => {
    const { prisma, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(batch(over ?? {}));

    const read = service.detail(caller, BATCH);

    if (visible) await expect(read).resolves.toMatchObject({ id: BATCH });
    else await expect(read).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('answers a missing batch exactly like an invisible one — no existence oracle', async () => {
    const { prisma, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(null);
    const missing = await service.detail(user(), BATCH).catch((e: Error) => e.message);
    prisma.importBatch.findUnique.mockResolvedValue(batch({ uploadedBy: 'someone-else' }));
    const hidden = await service.detail(user(), BATCH).catch((e: Error) => e.message);
    expect(missing).toBe(hidden);
  });

  it('lists only what the caller may see, newest first, and never the storage key', async () => {
    const { prisma, service } = build();
    prisma.importBatch.findMany.mockResolvedValue([
      batch({ id: 'b1' }),
      batch({ id: 'b2', subsidiaryIds: [SUB_A, SUB_B] }),
    ]);

    const list = await service.list(user());

    expect(list.map((b) => b.id)).toEqual(['b1']);
    expect(prisma.importBatch.findMany.mock.calls[0][0]).toMatchObject({
      where: { organisationId: ORG, uploadedBy: 'user-entry' },
      orderBy: { createdAt: 'desc' },
    });
    expect(list[0]).not.toHaveProperty('storagePath');
    expect(list[0]).toMatchObject({ hasSourceFile: true, fileFormat: 'csv' });
  });

  it('lists nothing for a caller with no organisation', async () => {
    const { prisma, service } = build();
    expect(await service.list(user({ organisationId: null }))).toEqual([]);
    expect(prisma.importBatch.findMany).not.toHaveBeenCalled();
  });
});

describe('ImportBatchesService — the source file', () => {
  it('signs a short-lived download under the file name the caller uploaded', async () => {
    const { prisma, storage, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(batch());

    const out = await service.sourceUrl(user(), BATCH);

    expect(out).toEqual({ url: 'https://signed', expiresIn: 60 });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'import-sources',
      `${ORG}/${BATCH}/source.csv`,
      60,
      'q3.csv',
    );
  });

  it('404s a batch whose file is not kept, and signs nothing for an invisible one', async () => {
    const { prisma, storage, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(batch({ storagePath: null }));
    await expect(service.sourceUrl(user(), BATCH)).rejects.toBeInstanceOf(NotFoundException);

    prisma.importBatch.findUnique.mockResolvedValue(batch({ uploadedBy: 'someone-else' }));
    await expect(service.sourceUrl(user(), BATCH)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
});

describe('ImportBatchesService — submitting a batch', () => {
  it("hands the bulk submit only the caller's own drafts of this batch, in their subsidiaries", async () => {
    const { prisma, bulkSubmit, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(batch());
    prisma.activityRecord.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);

    await service.submit(user(), BATCH);

    expect(prisma.activityRecord.findMany.mock.calls[0][0].where).toEqual({
      importBatchId: { in: [BATCH] },
      status: 'draft',
      subsidiaryId: { in: [SUB_A] },
      createdBy: 'user-entry',
      // Only drafts not waiting for an evidence file — what the button counted.
      OR: [
        { category: { notIn: ['Electricity', 'Natural Gas', 'Fuel', 'Water'] } },
        { evidence: { some: {} } },
      ],
    });
    expect(bulkSubmit.submitIds).toHaveBeenCalledWith(user(), ['r1', 'r2'], { batchId: BATCH });
  });

  it('lets a super_admin submit every draft of the batch, not only their own', async () => {
    const { prisma, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(batch());
    const admin = user({ id: 'u-a', role: 'super_admin', accessibleSubsidiaryIds: [SUB_A, SUB_B] });

    await service.submit(admin, BATCH);

    expect(prisma.activityRecord.findMany.mock.calls[0][0].where).not.toHaveProperty('createdBy');
  });

  it('sends a role that may not submit straight to the bulk submit, which refuses and audits it', async () => {
    const { prisma, bulkSubmit, service } = build();

    await service.submit(user({ id: 'u-c', role: 'consultant' }), BATCH);

    expect(bulkSubmit.submitIds).toHaveBeenCalledWith(expect.anything(), [], { batchId: BATCH });
    expect(prisma.importBatch.findUnique).not.toHaveBeenCalled();
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('404s a batch the caller cannot see, and submits nothing', async () => {
    const { prisma, bulkSubmit, service } = build();
    prisma.importBatch.findUnique.mockResolvedValue(batch({ uploadedBy: 'someone-else' }));

    await expect(service.submit(user(), BATCH)).rejects.toBeInstanceOf(NotFoundException);
    expect(bulkSubmit.submitIds).not.toHaveBeenCalled();
  });

  it('counts the caller\'s drafts, and separately the ones that can go now', async () => {
    const { prisma, service } = build();
    prisma.importBatch.findMany.mockResolvedValue([batch()]);
    prisma.activityRecord.groupBy
      .mockResolvedValueOnce([{ importBatchId: BATCH, _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ importBatchId: BATCH, _count: { _all: 1 } }]);

    const [dto] = await service.list(user());

    expect(dto).toMatchObject({ draftCount: 2, submittableDraftCount: 1 });
    expect(prisma.activityRecord.groupBy.mock.calls[0][0].where).toMatchObject({
      createdBy: 'user-entry',
      status: 'draft',
    });
    expect(prisma.activityRecord.groupBy.mock.calls[0][0].where).not.toHaveProperty('OR');
    expect(prisma.activityRecord.groupBy.mock.calls[1][0].where).toHaveProperty('OR');
  });

  it('counts nothing for a role that may not submit', async () => {
    const { prisma, service } = build();
    prisma.importBatch.findMany.mockResolvedValue([batch()]);

    const [dto] = await service.list(user({ id: 'u-c', role: 'consultant' }));

    expect(dto).toMatchObject({ draftCount: 0, submittableDraftCount: 0 });
    expect(prisma.activityRecord.groupBy).not.toHaveBeenCalled();
  });
});
