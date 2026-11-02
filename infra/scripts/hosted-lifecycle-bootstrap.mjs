/** One no-mail synthetic administrator; actual invited users still use the r004 API. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateOwnerUrl } from './hosted-smoke-fixture.mjs';

const fail = () => new Error('Lifecycle bootstrap refused; details withheld.');
export function validateTarget(target) {
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (!target || target.mode !== 'hosted-l10-lifecycle' || !/^[a-z]{20}$/.test(target.projectRef)
      || !/^[a-f0-9]{40}$/.test(target.sourceSha) || !uuid.test(target.organisationId) || !uuid.test(target.userId)
      || target.organisationId === target.userId || target.email !== `lp2-l10-${target.userId}@tonyai.test`
      || target.name !== `L10 synthetic acceptance ${target.organisationId}`) throw fail();
  return target;
}
export async function bootstrap(input, Client) {
  if (input.operation !== 'bootstrap') throw fail();
  const target = validateTarget(input.target);
  const url = validateOwnerUrl(input.url, target.projectRef);
  const prisma = new Client({ datasourceUrl: url, log: [] });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.organisation.create({ data: { id: target.organisationId, legalName: target.name, country: 'UK', geographyCode: 'UK' } });
      await tx.auditLog.create({ data: { action: 'create', entity: 'organisation', entityId: target.organisationId,
        organisationId: target.organisationId, diff: { purpose: 'L10 no-mail synthetic bootstrap; no customer inventory' } } });
      await tx.profile.create({ data: { id: target.userId, email: target.email, fullName: 'L10 bootstrap administrator',
        organisationId: target.organisationId, role: 'super_admin' } });
      await tx.auditLog.create({ data: { action: 'create', entity: 'profile', entityId: target.userId,
        organisationId: target.organisationId, diff: { purpose: 'L10 no-mail synthetic bootstrap; no invitation delivered' } } });
    });
  } finally { await prisma.$disconnect(); }
  return { status: 'BOOTSTRAP_CREATED', application_rows: 2, audit_rows: 2 };
}
async function main() {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 32768) throw fail(); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const require = createRequire('/app/apps/api/dist/onboarding/onboarding.cli.js');
    const { PrismaClient, Prisma } = require('@tonyai/db');
    if (process.versions.node.split('.')[0] !== '22' || Prisma.prismaVersion.client !== '6.19.3'
        || createHash('sha256').update(readFileSync('/app/infra/certs/prod-ca-2021.crt')).digest('hex') !== input.caSha256) throw fail();
    process.stdout.write(JSON.stringify(await bootstrap(input, PrismaClient)));
  } catch { process.stdout.write(JSON.stringify({ status: 'STOPPED', retry: false })); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
