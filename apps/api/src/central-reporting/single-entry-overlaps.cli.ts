import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { findSingleEntryOverlaps, type SingleEntryOverlapReport } from './single-entry-overlaps';

/**
 * `pnpm single-entry:overlaps` — read only, no switches: the record pairs of
 * opposite parties whose periods overlap, stored before single entry judged
 * overlapping periods (migration `20261128200000_single_entry_overlapping_periods`).
 * Exit 0 when there are none, 2 when there are (or on a failure), so a pre-pilot
 * check can gate on it. On hosted QA it runs in the live API container
 * (runbook 11, "Single entry over overlapping periods").
 */

class UsageError extends Error {}
type Sink = Pick<NodeJS.WriteStream, 'write'>;

// Only the database: the main API context would start the storage sweeper.
@Module({ imports: [PrismaModule] })
class SingleEntryOverlapsModule {}

async function run(): Promise<SingleEntryOverlapReport> {
  const context = await NestFactory.createApplicationContext(SingleEntryOverlapsModule, { logger: false, abortOnError: false });
  try {
    const db = context.get(PrismaService);
    const [session] = await db.$queryRaw<{ login: string; role: string }[]>`SELECT session_user AS login, current_user AS role`;
    if (session?.login !== 'tonyai_runtime' || session.role !== 'tonyai_runtime') {
      throw new UsageError('DATABASE_URL must use the tonyai_runtime login.');
    }
    // A read-only transaction: this command can write nothing, whatever it reads.
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return findSingleEntryOverlaps(tx);
    });
  } finally {
    await context.close();
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  out: Sink = process.stdout,
  err: Sink = process.stderr,
  execute: () => Promise<SingleEntryOverlapReport> = run,
  databaseUrl = process.env.DATABASE_URL,
): Promise<number> {
  try {
    if (argv.length > 0) throw new UsageError('This command takes no switches: it only reads.');
    if (!databaseUrl) throw new UsageError('DATABASE_URL must use the tonyai_runtime login.');
    const report = await execute();
    out.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.pairs === 0 ? 0 : 2;
  } catch (error) {
    // A connection or database error may carry credentials: only usage errors are echoed.
    err.write(error instanceof UsageError ? `${error.message}\n` : 'The single-entry overlap read failed.\n');
    return 2;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
