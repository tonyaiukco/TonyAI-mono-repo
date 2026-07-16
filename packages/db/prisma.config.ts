// Prisma configuration (replaces the deprecated `package.json#prisma` block,
// removed in Prisma 7). See https://pris.ly/prisma-config
//
// NOTE: with a config file present, Prisma no longer auto-loads `.env`, so we
// load it explicitly here — the datasource block reads `env("DATABASE_URL")` /
// `env("DIRECT_URL")` from packages/db/.env (cwd when running the db scripts).
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    // Used by `prisma migrate reset` / `prisma db seed`.
    seed: 'tsx prisma/seed.ts',
  },
});
