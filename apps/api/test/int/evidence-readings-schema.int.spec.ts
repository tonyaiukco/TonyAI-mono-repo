import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EVIDENCE_READING_STATUSES } from '@tonyai/shared-types';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, createTenant, type Tenant } from './db';

let runtime: PrismaService;
let tenant: Tenant;

beforeAll(async () => {
  runtime = connect();
  const [role] = await runtime.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
  expect(role?.current_user).toBe('tonyai_runtime');
});

afterAll(async () => {
  await runtime?.$disconnect();
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant?.cleanup();
});

function createEvidence() {
  return runtime.evidence.create({
    data: {
      subsidiaryId: tenant.subsidiaryId,
      storagePath: `schema-tests/${randomUUID()}.pdf`,
      fileName: 'synthetic.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      uploadedBy: tenant.users.masterkey.id,
    },
  });
}

function insertReading(evidenceId: string, subsidiaryId: string, status = 'no_text', version = 'test-v1') {
  return runtime.$executeRaw`
    INSERT INTO evidence_readings (evidence_id, subsidiary_id, reader_version, status, page_count, invoices)
    VALUES (${evidenceId}::uuid, ${subsidiaryId}::uuid, ${version}, ${status}, 1, '[]'::jsonb)
  `;
}

describe('evidence reading schema', () => {
  it('enables RLS and gives no table or column privileges to client roles', async () => {
    const access = await runtime.$queryRaw<{
      role: string; rls: boolean; forced: boolean; has_policy: boolean; table_grant: boolean; column_grant: boolean;
    }[]>`
      SELECT role.name AS role, relation.relrowsecurity AS rls, relation.relforcerowsecurity AS forced,
        EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = relation.oid) AS has_policy,
        has_table_privilege(role.name, relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          AS table_grant,
        has_any_column_privilege(role.name, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES') AS column_grant
      FROM pg_class AS relation
      CROSS JOIN (VALUES ('anon'::name), ('authenticated'::name), ('service_role'::name)) AS role(name)
      WHERE relation.oid = 'public.evidence_readings'::regclass
      ORDER BY role.name
    `;
    expect(access).toEqual(['anon', 'authenticated', 'service_role'].map((role) => ({
      role, rls: true, forced: false, has_policy: false, table_grant: false, column_grant: false,
    })));
  });

  it('requires the complete provenance of a cut and accepts whole files and valid ranges', async () => {
    const file = await createEvidence();
    const sha256 = 'a'.repeat(64);

    await expect(runtime.$executeRaw`
      UPDATE evidence SET source_sha256 = ${sha256}, source_page_from = 1 WHERE id = ${file.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    await expect(runtime.$executeRaw`
      UPDATE evidence SET source_sha256 = ${sha256}, source_page_from = 2, source_page_to = 1
      WHERE id = ${file.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });

    const refused = { code: 'P2010', meta: { code: '23514' } };
    await expect(runtime.$executeRaw`
      UPDATE evidence SET source_page_from = 1, source_page_to = 1 WHERE id = ${file.id}::uuid
    `).rejects.toMatchObject(refused);
    await expect(runtime.$executeRaw`
      UPDATE evidence SET source_sha256 = ${sha256}, source_page_from = 0, source_page_to = 1
      WHERE id = ${file.id}::uuid
    `).rejects.toMatchObject(refused);
    for (const digest of ['A'.repeat(64), 'g'.repeat(64)]) {
      await expect(runtime.$executeRaw`
        UPDATE evidence SET source_sha256 = ${digest}, source_page_from = 1, source_page_to = 1
        WHERE id = ${file.id}::uuid
      `).rejects.toMatchObject(refused);
    }

    await expect(runtime.evidence.update({
      where: { id: file.id },
      data: { sourceSha256: sha256, sourcePageFrom: 2, sourcePageTo: 2 },
    })).resolves.toMatchObject({ sourceSha256: sha256, sourcePageFrom: 2, sourcePageTo: 2 });
  });

  it('ties readings to the evidence company and enforces the version, status, page count and invoices checks', async () => {
    const file = await createEvidence();
    await expect(insertReading(file.id, tenant.otherSubsidiaryId))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } });
    await expect(insertReading(file.id, file.subsidiaryId, 'reader_busy'))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    const refused = { code: 'P2010', meta: { code: '23514' } };
    await expect(insertReading(file.id, file.subsidiaryId, 'no_text', '  ')).rejects.toMatchObject(refused);
    await expect(runtime.$executeRaw`
      INSERT INTO evidence_readings (evidence_id, subsidiary_id, reader_version, status, page_count, invoices)
      VALUES (${file.id}::uuid, ${file.subsidiaryId}::uuid, 'test-negative', 'no_text', -1, '[]'::jsonb)
    `).rejects.toMatchObject(refused);
    await expect(runtime.$executeRaw`
      INSERT INTO evidence_readings (evidence_id, subsidiary_id, reader_version, status, page_count, invoices)
      VALUES (${file.id}::uuid, ${file.subsidiaryId}::uuid, 'test-object', 'no_text', 1, '{}'::jsonb)
    `).rejects.toMatchObject(refused);
    for (const status of EVIDENCE_READING_STATUSES) {
      await insertReading(file.id, file.subsidiaryId, status, `test-${status}`);
    }
    expect(await runtime.evidenceReading.count({ where: { evidenceId: file.id } }))
      .toBe(EVIDENCE_READING_STATUSES.length);
  });

  it('lets the runtime delete a file and cascade its readings while refusing direct changes', async () => {
    const file = await createEvidence();
    await insertReading(file.id, file.subsidiaryId);
    await insertReading(file.id, file.subsidiaryId, 'no_text', 'test-v2');
    const where = { evidenceId: file.id };
    expect(await runtime.evidenceReading.count({ where })).toBe(2);

    await expect(runtime.$executeRaw`
      UPDATE evidence_readings SET status = 'unreadable' WHERE evidence_id = ${file.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    await expect(runtime.$executeRaw`
      DELETE FROM evidence_readings WHERE evidence_id = ${file.id}::uuid
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    expect(await runtime.evidenceReading.count({ where })).toBe(2);

    await runtime.evidence.delete({ where: { id: file.id } });
    expect(await runtime.evidenceReading.count({ where })).toBe(0);
  });
});
