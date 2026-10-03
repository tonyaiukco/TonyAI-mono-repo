import { createHash } from 'node:crypto';
import { BUCKETS, type Bucket } from '../../src/storage/buckets';
import { StorageService } from '../../src/storage/storage.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { Tenant } from './db';

/**
 * Real Supabase Storage for the integration tests (LP1-02): the local stack's
 * own buckets, reached with the service-role key exactly as the API reaches
 * them. B8 rules mocks out as proof of Storage recovery, so the recovery
 * tests assert on the objects themselves; faults are injected by spying on
 * one method of this real service (`vi.spyOn(storage, 'remove')…Once`), so
 * every other call still reaches Storage.
 */
export function localStorage(): StorageService {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'The Storage recovery tests need the local Supabase Storage: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (`set -a; source apps/api/.env; set +a`). CI exports both.',
    );
  }
  return new StorageService();
}

/** Whether Storage's catalogue holds the object — `storage.objects`, the table the Storage API itself reads. */
export async function objectExists(observer: PrismaService, bucket: Bucket, path: string): Promise<boolean> {
  const [{ found }] = await observer.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = ${bucket} AND name = ${path}) AS found`;
  return found;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The key prefixes a tenant's objects live under: evidence by subsidiary, import sources by organisation. */
export function tenantPrefixes(tenant: Pick<Tenant, 'subsidiaryId' | 'organisationId'>): Record<Bucket, string> {
  return { evidence: `${tenant.subsidiaryId}/`, 'import-sources': `${tenant.organisationId}/` };
}

/** Every object under the tenant's prefixes, from the catalogue. */
export async function tenantObjects(
  observer: PrismaService,
  tenant: Pick<Tenant, 'subsidiaryId' | 'organisationId'>,
): Promise<{ bucket: Bucket; path: string }[]> {
  const found: { bucket: Bucket; path: string }[] = [];
  for (const bucket of BUCKETS) {
    const prefix = tenantPrefixes(tenant)[bucket];
    const rows = await observer.$queryRaw<{ name: string }[]>`
      SELECT name FROM storage.objects WHERE bucket_id = ${bucket} AND starts_with(name, ${prefix})`;
    found.push(...rows.map((r) => ({ bucket, path: r.name })));
  }
  return found;
}

/** Test-only teardown: remove every object under the tenant's prefixes. */
export async function removeTenantObjects(
  observer: PrismaService,
  storage: StorageService,
  tenant: Pick<Tenant, 'subsidiaryId' | 'organisationId'>,
): Promise<void> {
  const objects = await tenantObjects(observer, tenant);
  for (const bucket of BUCKETS) {
    const paths = objects.filter((o) => o.bucket === bucket).map((o) => o.path);
    for (let i = 0; i < paths.length; i += 100) await storage.remove(bucket, paths.slice(i, i + 100));
  }
}
