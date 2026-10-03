import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@tonyai/db';

/**
 * The API's database client. It connects with DATABASE_URL — in every
 * environment the least-privileged runtime role `tonyai_runtime` (LP1-03),
 * never the owner. That role bypasses RLS by design (the API acts for every
 * tenant, and the Storage sweeper must see every row), so NOTHING in the
 * database filters these queries by tenant: each service must scope its own by
 * `accessibleSubsidiaryIds`. What the role may do at all is fixed in
 * `packages/db/scripts/runtime-role.mjs` — no DDL, no policy changes, no
 * TRUNCATE, `audit_log` append-only, nothing on `_prisma_migrations`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
