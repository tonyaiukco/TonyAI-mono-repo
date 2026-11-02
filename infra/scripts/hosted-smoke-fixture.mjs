/** Exact-image Linux Prisma fixture. Secrets enter only through stdin. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateSmoke } from './smoke-contract.mjs';
import { provisionRows } from './smoke-fixture-transaction.mjs';

const refusal = () => new Error('Hosted fixture refused; details withheld.');
const CA = '/app/infra/certs/prod-ca-2021.crt';
export function validateOwnerUrl(value, project) {
  if (typeof value !== 'string') throw refusal();
  const url = new URL(value);
  const allowed = new Set(['pgbouncer', 'sslmode', 'sslaccept', 'sslcert', 'connection_limit', 'pool_timeout']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !/^aws-[0-9]+-eu-north-1\.pooler\.supabase\.com$/.test(url.hostname)
      || url.port !== '5432' || decodeURIComponent(url.username) !== `postgres.${project}`
      || !url.password || url.pathname !== '/postgres' || url.hash
      || [...url.searchParams.keys()].some((key) => !allowed.has(key))) throw refusal();
  for (const [key, expected] of [['sslmode', 'require'], ['sslaccept', 'strict'], ['sslcert', CA]]) {
    if (JSON.stringify(url.searchParams.getAll(key)) !== JSON.stringify([expected])) throw refusal();
  }
  for (const key of ['connection_limit', 'pool_timeout']) {
    const values = url.searchParams.getAll(key);
    if (values.length && (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0]) || Number(values[0]) > 2147483647)) throw refusal();
  }
  return value;
}

export async function execute(input, dependencies) {
  if (!input || !['verify', 'fixtures'].includes(input.operation)) throw refusal();
  if (dependencies.nodeMajor !== '22' || dependencies.prismaVersion !== '6.19.3'
      || dependencies.caSha256 !== input.caSha256 || !/^[a-f0-9]{64}$/.test(input.caSha256)) throw refusal();
  if (input.operation === 'verify') return { status: 'RUNTIME_VERIFIED', node_major: 22, prisma_version: '6.19.3', ca_sha256: input.caSha256 };
  const target = validateSmoke(input.target);
  if (target.mode !== 'staging') throw refusal();
  const url = validateOwnerUrl(input.url, target.projectRef);
  const prisma = new dependencies.Client({ datasourceUrl: url, log: [] });
  try { await provisionRows(target, prisma); }
  finally { await prisma.$disconnect(); }
  return { status: 'FIXTURES_CREATED', application_rows: 6, audit_rows: 6 };
}

async function main() {
  let stage = 'INPUT'; let observed = {};
  try {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length; if (length > 32768) throw refusal(); chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    stage = 'RUNTIME_IMPORT';
    const require = createRequire('/app/apps/api/dist/onboarding/onboarding.cli.js');
    const { PrismaClient, Prisma } = require('@tonyai/db');
    stage = 'CA_READ';
    const dependencies = { Client: PrismaClient, prismaVersion: Prisma.prismaVersion.client,
      nodeMajor: process.versions.node.split('.')[0], caSha256: createHash('sha256').update(readFileSync(CA)).digest('hex') };
    observed = { node_major: /^[0-9]{1,3}$/.test(dependencies.nodeMajor) ? dependencies.nodeMajor : null,
      prisma_version: /^[0-9]+\.[0-9]+\.[0-9]+$/.test(dependencies.prismaVersion) ? dependencies.prismaVersion : null,
      ca_matches: dependencies.caSha256 === input.caSha256 };
    stage = input.operation === 'verify' ? 'VERIFY' : 'PROVISION';
    const report = await execute(input, dependencies);
    process.stdout.write(JSON.stringify(report));
  } catch (error) {
    const code = ['EACCES', 'ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)
      || /^P[1-3][0-9]{3}$/.test(error?.code ?? '') ? error.code : null;
    const missingModule = ['@tonyai/db', '@prisma/client'].find((name) => error?.message?.includes(`Cannot find module '${name}'`)) ?? null;
    process.stdout.write(JSON.stringify({ status: 'STOPPED', stage, code, missingModule, observed, retry: false }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
