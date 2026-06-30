# CLAUDE.md

Guidance for Claude Code (and the subagent team) when working in this repo.
Read this before making changes. Keep it short and high-signal — it loads every session.

## Project
TonyAI — multi-tenant carbon accounting / ESG SaaS for holding companies.
Headless architecture: **Next.js** web + **NestJS** api + **Supabase** (Postgres/Auth/Storage),
in a **Turborepo** monorepo with shared types. Full picture in `README.md`; specs in `docs/`.

## Where things live
- `apps/web` — Next.js 16 frontend (App Router, Tailwind v4, shadcn/ui, Zustand)
- `apps/api` — NestJS 11 API (Prisma, Supabase JWT auth)
- `packages/shared-types` — canonical domain + API types (single source of truth)
- `packages/db` — Prisma schema, migrations, seed
- `e2e/` — Playwright · `docs/` — specs · `.claude/agents/` — the 7-subagent team

## Commands (pnpm, from repo root)
- `pnpm setup` — one-command local bootstrap (Supabase up → sync `.env` → migrate → seed)
- `pnpm dev` — web :3000 + api :3001 · `pnpm typecheck` · `pnpm build` · `pnpm test` (Vitest) · `pnpm e2e` (Playwright)
- `pnpm db:migrate | db:deploy | db:seed | db:reset`
- Local-first: requires Docker + `supabase start`. Seed users: `admin@tonyai.local` / `entry@tonyai.local` (pwd `TonyAI!2026`).

## Architecture rules (do not break)
- **One source of truth for types:** add domain/API types to `@tonyai/shared-types`; never duplicate. On web, import via `@/lib/types` (re-exports it).
- **Frontend → backend only through `apps/web/lib/api.ts`** — no raw `fetch` or hardcoded URLs in pages. Backend persists **only** via Prisma (`@tonyai/db`).
- **Type-checking stays ON.** Never set `typescript.ignoreBuildErrors`; fix types instead of suppressing.
- API is versioned under `/api/v1`; validate input with `class-validator` DTOs.

## Security & data rules (non-negotiable)
- **Tenant isolation is two-layer:** NestJS guard (primary, `accessibleSubsidiaryIds`) + Supabase **RLS** (defense-in-depth). Never weaken either. Never `FORCE` RLS (it would break the owner/Prisma path).
- **RBAC:** only `super_admin` may create/update/delete subsidiaries; reads are tenant-scoped for everyone.
- **`audit_log` is append-only:** write one row on every mutation; never add UPDATE/DELETE paths to it.
- **Canonical `user_role`:** `super_admin | consultant | data_entry | executive_viewer` — keep web, shared-types and Prisma in sync.
- **No secrets in git:** `.env*` is ignored; only `.env.example` is committed.
- **Emission factors:** never invent values; cite source + version; historic calculations are immutable (factor versioning).

## Frontend conventions
- Match the existing design system: Tailwind v4 + shadcn/ui, Inter / JetBrains Mono, emerald primary. No generic AI look.
- Always handle loading / empty / error (incl. 401/403) states with `sonner` toasts.

## Workflow
- Use the specialised subagents in `.claude/agents/` for their domains: `architect`, `backend-integrator`, `frontend-engineer`, `security-rls`, `data-factors`, `qa-auditor`, `devops-cloud`.
- **Tests must stay green** — `pnpm test` gates CI. Add tests for new behaviour; cover negative/security cases, not just the happy path.
- **Git:** branch off `main`; **commit & push only when asked**; do **not** pass a hardcoded `-c user.*` identity (the repo's git config is already set). Conventional-commit style messages.
- **Verify before declaring done:** typecheck + build + relevant tests; for behaviour, exercise it against the running app — don't claim a fix works without checking.

## Status & roadmap
- Done: M0 foundation + M1 vertical slice (auth, tenant isolation, subsidiaries CRUD, dashboard KPIs, RLS, 21 unit + 2 e2e tests).
- Next: **Phase 1** (Data Entry, calculation engine, factor seeding) and **Phase 2** (cloud + CI/CD). See README "Roadmap".

<!-- Add your own recurring rules/preferences below this line -->
