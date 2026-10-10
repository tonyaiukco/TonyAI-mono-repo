/**
 * LP4-01 — the cascade path is closed (Open questions, "LP3-03 PR B" (11)).
 *
 * A foreign key's action runs as the referencing table's owner, past every
 * record trigger; so no key of `activity_records` has one (RESTRICT / NO
 * ACTION), and an organisation is deleted by the owner's session alone
 * (`organisations_delete_owner_only`, which compares `session_user`). The
 * record-level halves — a site or a subsidiary that holds a record refuses
 * the runtime role and the owner — are in `factor-model.int.spec.ts`, next to
 * K5; the catalogue half (keys, trigger, body) in `runtime-role.int.spec.ts`
 * through `checkIntegrityTriggers`.
 *
 * The service role's refusal is proven through PostgREST with the service key,
 * as an attacker holding it would act: an owner session that `SET ROLE`s to
 * `service_role` keeps `session_user` = the owner, and the guard rightly lets
 * the owner through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectOwner, createRecord, createTenant, withRollback, type Tenant } from './db';

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;

beforeAll(async () => {
  runtime = connect();
  owner = connectOwner();
  tenant = await createTenant();
  await createRecord(owner, tenant, { status: ActivityRecordStatus.approved });
});

afterAll(async () => {
  await tenant?.cleanup();
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** Prisma's error code, or a raw query's SQLSTATE. */
function codeOf(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return (e.meta as { code?: string } | undefined)?.code ?? e.code;
  return /code: "([0-9A-Z]{5})"/.exec(String((e as Error | null)?.message))?.[1] ?? null;
}

/** The local stack's PostgREST with the service key — the credential OQ (11)'s first attack used. */
function serviceRest(method: string, path: string): Promise<Response> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'The service-role probe needs the local stack: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (`set -a; source apps/api/.env; set +a`). CI exports both.',
    );
  }
  const target = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error(`refusing a non-local SUPABASE_URL (${target.hostname})`);
  return fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=minimal' },
  });
}

describe('LP4-01 — an organisation is the operator’s to delete', () => {
  it('refuses the service role through PostgREST (TA004), and the tenant stays whole', async () => {
    const res = await serviceRest('DELETE', `organisations?id=eq.${tenant.organisationId}`);
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    expect(res.ok).toBe(false);
    expect(body.code).toBe('TA004');
    expect(body.message).toMatch(/deleted by the database owner alone/);
    expect(await owner.organisation.count({ where: { id: tenant.organisationId } })).toBe(1);
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(1);
  });

  it('refuses the service role a subsidiary that holds a record — its key, not a cascade, answers (23503)', async () => {
    const res = await serviceRest('DELETE', `subsidiaries?id=eq.${tenant.subsidiaryId}`);
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    expect(res.ok).toBe(false);
    expect(body.code).toBe('23503');
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(1);
  });

  it('gives the runtime role no DELETE on organisations at all (42501, before any trigger)', async () => {
    const e = await failure(withRollback(runtime, (tx) => tx.$executeRawUnsafe(`DELETE FROM organisations WHERE id = '${tenant.organisationId}'`)));
    expect(codeOf(e)).toBe('42501');
  });

  it('refuses the owner too while the organisation holds records — they go first, then it may (the teardown order)', async () => {
    const e = await failure(withRollback(owner, (tx) => tx.organisation.delete({ where: { id: tenant.organisationId } })));
    expect(['P2003', '23503']).toContain(codeOf(e));
    const left = await withRollback(owner, async (tx) => {
      await tx.activityRecord.deleteMany({ where: { subsidiaryId: tenant.subsidiaryId } });
      await tx.organisation.delete({ where: { id: tenant.organisationId } });
      return tx.organisation.count({ where: { id: tenant.organisationId } });
    });
    expect(left).toBe(0);
    expect(await owner.organisation.count({ where: { id: tenant.organisationId } })).toBe(1); // rolled back
  });
});
