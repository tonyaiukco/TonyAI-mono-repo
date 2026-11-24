import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { CalculationsService } from '../calculations/calculations.service';
import { FACTOR_POLICY, bootFactorPolicy } from '../calculations/factor-policy';
import { isLocalDatabase } from '../factor-releases/factor-release.cli';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { DraftRepriceService, type DraftRepriceReport } from './draft-reprice.service';

interface Options {
  apply: boolean;
  allowRemote: boolean;
}

class UsageError extends Error {}
type Sink = Pick<NodeJS.WriteStream, 'write'>;

export function parseArgs(argv: readonly string[]): Options {
  const flags = new Set<string>();
  for (const flag of argv) {
    if (flag !== '--apply' && flag !== '--allow-remote') throw new UsageError('Expected --apply or --allow-remote.');
    if (flags.has(flag)) throw new UsageError('A switch may only be passed once.');
    flags.add(flag);
  }
  return { apply: flags.has('--apply'), allowRemote: flags.has('--allow-remote') };
}

export function requireDatabase(options: Options, url: string | undefined): void {
  if (!url) throw new UsageError('DATABASE_URL must use the tonyai_runtime login.');
  if (options.apply && !options.allowRemote && !isLocalDatabase(url)) {
    throw new UsageError('--apply off a loopback database requires --allow-remote.');
  }
}

// Only DB-backed providers. The main API context starts the storage sweeper,
// which must never run as a side effect of this command or its dry run.
@Module({
  imports: [PrismaModule],
  providers: [
    AuditService,
    CalculationsService,
    { provide: FACTOR_POLICY, useFactory: bootFactorPolicy },
    DraftRepriceService,
  ],
})
class DraftRepriceModule {}

async function run(options: Options): Promise<DraftRepriceReport> {
  const context = await NestFactory.createApplicationContext(DraftRepriceModule, { logger: false, abortOnError: false });
  try {
    const db = context.get(PrismaService);
    const [session] = await db.$queryRaw<{ login: string; role: string }[]>`
      SELECT session_user AS login, current_user AS role
    `;
    if (session?.login !== 'tonyai_runtime' || session.role !== 'tonyai_runtime') {
      throw new UsageError('DATABASE_URL must use the tonyai_runtime login.');
    }
    return await context.get(DraftRepriceService).run(options.apply);
  } finally {
    await context.close();
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: Sink = process.stdout,
  err: Sink = process.stderr,
  execute: (options: Options) => Promise<DraftRepriceReport> = run,
  databaseUrl = process.env.DATABASE_URL,
): Promise<number> {
  try {
    const options = parseArgs(argv);
    requireDatabase(options, databaseUrl);
    const report = await execute(options);
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.counts.refused === 0 ? 0 : 2;
  } catch (error) {
    // Engine refusals are reported by code. Unexpected connection or database
    // errors may contain credentials or caller data, so keep those out of output.
    err.write(error instanceof UsageError ? `${error.message}\n` : 'Draft re-pricing failed.\n');
    return 2;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
