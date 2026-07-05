# CLAUDE.md

Guidance for Claude Code (and the subagent team) when working in this repo.
Read this before making changes. Keep it short and high-signal — it loads every session.

## Project
TonyAI — multi-tenant carbon accounting / ESG SaaS for holding companies.
Headless architecture: **Next.js** web + **NestJS** api + **Supabase** (Postgres/Auth/Storage),
in a **Turborepo** monorepo with shared types. Full picture in `README.md`; specs in `docs/`.

## Language (strict)
**Everything created inside this project MUST be in English** — code, identifiers, variable/function/file names, comments, documentation, commit messages, UI copy, seed data, and any generated artifact. **Never produce Turkish content in the repo.** Chatting with the user happens in Turkish, but that never leaks into the project.

## Where things live
- `apps/web` — Next.js 16 frontend (App Router, Tailwind v4, shadcn/ui, Zustand)
- `apps/api` — NestJS 11 API (Prisma, Supabase JWT auth)
- `packages/shared-types` — canonical domain + API types (single source of truth)
- `packages/db` — Prisma schema, migrations, seed
- `e2e/` — Playwright · `docs/` — specs · `.claude/agents/` — 7-subagent team · `.claude/skills/` — reusable procedures

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
- **Emission factors / data integrity:** never invent factor values; cite source + version; historic calculations are immutable (factor versioning). **Never present demo/prototype values as authoritative** — label placeholders explicitly. This is a compliance product; wrong numbers are a liability.

## Frontend conventions
- Match the existing design system: Tailwind v4 + shadcn/ui, Inter / JetBrains Mono, emerald primary. No generic AI look.
- Always handle loading / empty / error (incl. 401/403) states with `sonner` toasts.

## Workflow
- Use the specialised subagents in `.claude/agents/` for their domains: `architect`, `backend-integrator`, `frontend-engineer`, `security-rls`, `data-factors`, `qa-auditor`, `devops-cloud`.
- Reusable procedures live in `.claude/skills/` (`tenant-api-module`, `aggregation-endpoint`, `rls-for-table`, `wire-page`) — invoke the skill instead of re-deriving the recipe. When a new recurring pattern emerges (e.g. Supabase Storage buckets), extract it into a skill in the same PR that first implements it.
- **Keep `README.md` current:** after any change that affects setup, commands, architecture, structure, API, conventions or status, update `README.md` in the same change. The README must never go stale.
- **Tests must stay green** — `pnpm test` gates CI. Add tests for new behaviour; cover negative/security cases, not just the happy path.
- **Git:** **never push to `main` directly** — every change lands via a feature branch (`feat/` · `chore/` · `fix/`) and a **pull request with green CI**. **Commit & push only when asked**; do **not** pass a hardcoded `-c user.*` identity (the repo's git config is already set). Conventional-commit style messages; delete the branch after merge.
- **Pull requests:** open PRs for review — **the user merges; never self-merge.** Keep each PR small and focused. CI runs on **Node 22**; never commit `dist/`, `generated/`, or `*.tsbuildinfo` (all gitignored).
- **Verify before declaring done:** typecheck + build + relevant tests; for behaviour, exercise it against the running app — don't claim a fix works without checking.

## Status & roadmap
- **Session memory lives in `docs/roadmap_docs/project-status.md`** — read it at session start to see where work left off; update it (status, decisions, next steps) in the same change whenever a PR merges or the roadmap shifts. It must never go stale.
- Done: M0 + M1 vertical slice; Phase-1 emission-factor library + Scope 1&2 calc engine + activity-records API & review workflow + Data Entry UI + Emissions Analytics wiring.
- Next (Phase 1): dashboard `/` wiring, locations level, evidence upload, period locking, anomaly detection, hardening; then **Phase 2** (staging cloud + CI/CD). Full phased plan (0–4 + post-launch) in the status log above.

<!-- Add your own recurring rules/preferences below this line -->
