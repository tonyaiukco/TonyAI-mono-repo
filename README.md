# TonyAI — Monorepo

Enterprise carbon accounting / ESG SaaS for multi-subsidiary holdings.
Headless architecture: **Next.js** frontend + **NestJS** API + **Supabase** (Postgres/Auth/Storage), managed as a **Turborepo** monorepo with shared TypeScript types.

```
apps/
  web/   → Next.js 16 frontend (Tailwind v4 + shadcn/ui)
  api/   → NestJS 11 API (Prisma + Supabase Auth JWT)
packages/
  shared-types/ → canonical domain + API types (single source of truth)
  db/           → Prisma schema, migrations, seed (Supabase Postgres)
docs/  → product + technical specs (md_docs, tech_docs)
.claude/agents/ → 7-subagent development team definitions
```

## Prerequisites
- Node ≥ 20, pnpm, Docker Desktop (running), Supabase CLI

## Local setup (first run)

```bash
pnpm install

# 1. Start local Supabase (Postgres, Auth, Storage)
supabase start

# 2. Copy the printed keys into env files if they differ from the defaults:
#    supabase status -o env
#    - apps/web/.env.local      → NEXT_PUBLIC_SUPABASE_ANON_KEY
#    - apps/api/.env            → SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
#    - packages/db/.env         → SUPABASE_SERVICE_ROLE_KEY

# 3. Create schema + seed demo data
pnpm db:migrate      # prisma migrate dev
pnpm db:seed         # org + 5 subsidiaries + 2 users

# 4. Run everything
pnpm dev             # web :3000  ·  api :3001
```

### Seed users
| Email | Password | Role | Sees |
|-------|----------|------|------|
| admin@tonyai.local | `TonyAI!2026` | super_admin | all 5 subsidiaries |
| entry@tonyai.local | `TonyAI!2026` | data_entry | 2 subsidiaries (tenant isolation demo) |

## Useful scripts
- `pnpm dev` — run web + api (Turbo)
- `pnpm build` / `pnpm typecheck` / `pnpm test`
- `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset`

## Vertical slice (Milestone 1)
Login → Dashboard/Subsidiaries with **live data**, enforced **tenant isolation** (NestJS guard, primary) and **audit logging**. RBAC: only `super_admin` may mutate subsidiaries.
