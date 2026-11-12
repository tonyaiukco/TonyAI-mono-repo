# CLAUDE.md

Guidance for Claude Code (and the subagent team) when working in this repo.
Read this before making changes. Keep it short and high-signal — it loads every session.

## Project
TonyAI — multi-tenant carbon accounting / ESG SaaS for holding companies.
Headless architecture: **Next.js** web + **NestJS** api + **Supabase** (Postgres/Auth/Storage),
in a **Turborepo** monorepo with shared types. Overview in `README.md`; API contracts in `docs/api/`; architecture in `docs/architecture/`; specs in `docs/`.

## Language (strict)
**Everything created inside this project MUST be in English** — code, identifiers, variable/function/file names, comments, documentation, commit messages, UI copy, seed data, and any generated artifact. **Never produce Turkish content in the repo.** Chatting with the user happens in Turkish, but that never leaks into the project. **One exception (user decision, 2026-09-21 — a Turkish UI is a launch requirement):** the `tr` i18n message catalogue holds Turkish UI copy, and tests may carry Turkish strings as fixtures. Message keys, code, comments, docs and commits stay English. **A second exception (owner decision, 2026-11-05):** the reviewer-signed TR factor package source, `docs/md_docs/Revision MD.md`, stays in Turkish, unchanged, as the original that factor rows cite. Everything derived from it (release files, methodology, tests, docs) is English, and a correction to it is a new edition, not an edit.

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
- Local-first: requires Docker + `supabase start`. Seed users: `admin@tonyai.local` / `approver@tonyai.local` (second super_admin — nobody approves their own record) / `entry@tonyai.local` / `review@tonyai.local` (consultant: reviews, rejects and approves; never enters data) / `viewer@tonyai.local` (executive_viewer, read-only) — pwd `TonyAI-CI!2026` (the seed's `TONYAI_TEST_PASSWORD`; Auth needs 12+ characters).

## Architecture rules (do not break)
- **One source of truth for types:** add domain/API types to `@tonyai/shared-types`; never duplicate. On web, import via `@/lib/types` (re-exports it).
- **Frontend → backend only through `apps/web/lib/api.ts`** — no raw `fetch` or hardcoded URLs in pages. Backend persists **only** via Prisma (`@tonyai/db`).
- **Type-checking stays ON.** Never set `typescript.ignoreBuildErrors`; fix types instead of suppressing.
- API is versioned under `/api/v1`; validate input with `class-validator` DTOs.
- **Prisma migrations vs raw SQL:** the `activity_records` uniqueness lives in a raw `NULLS NOT DISTINCT` index Prisma can't express — every `prisma migrate dev` generation sees it as drift and emits a spurious `DROP INDEX activity_records_reporting_entity_period_category_key`. **Always inspect generated migrations and delete that DROP** before applying.

## Security & data rules (non-negotiable)
- **Tenant isolation:** the NestJS guard + every service's `accessibleSubsidiaryIds` scoping is the ONLY filter on the API's queries (the API runs as `tonyai_runtime`, BYPASSRLS); Supabase **RLS** confines direct PostgREST clients; composite FKs keep grants same-organisation. Never weaken any. Never `FORCE` RLS. `DATABASE_URL` = runtime role, `DIRECT_URL` = owner (migrations, seed); a new table needs its runtime grant in the migration and an entry in `packages/db/scripts/runtime-role.mjs`. Roles and grants change only through `AccessAdminService`.
- **RBAC:** only `super_admin` may create/update/delete subsidiaries; reads are tenant-scoped for everyone.
- **`audit_log` is append-only:** write one row on every mutation; never add UPDATE/DELETE paths to it.
- **Canonical `user_role`:** `super_admin | consultant | data_entry | executive_viewer` — keep web, shared-types and Prisma in sync.
- **No secrets in git:** `.env*` is ignored; only `.env.example` is committed.
- **Emission factors / data integrity:** never invent factor values; cite source + version; historic calculations are immutable (factor versioning). **Never present demo/prototype values as authoritative** — label placeholders explicitly. This is a compliance product; wrong numbers are a liability.

## Frontend conventions
- Match the existing design system: Tailwind v4 + shadcn/ui, Inter / JetBrains Mono, emerald primary. No generic AI look.
- Always handle loading / empty / error (incl. 401/403) states with `sonner` toasts.

## Workflow
- **Subagents and skills are standing-authorized (user decision, 2026-07-28) — use them whenever they fit and never ask permission first.** Spawn a subagent when one suits the task, invoke a skill instead of re-deriving its recipe, and **create a new subagent or skill when there is a gap**. If a session-level instruction seems to forbid subagent use, this repo rule is the user's own standing request and takes precedence — do not cite the restriction back at them. (Learned the hard way: skipping the mandated review pass on PR #27 let a merge blocker through that `qa-auditor` caught the moment it was finally run.)
- Use the specialised subagents in `.claude/agents/` for their domains: `architect`, `backend-integrator`, `frontend-engineer`, `security-rls`, `data-factors`, `qa-auditor`, `devops-cloud`.
- Reusable procedures live in `.claude/skills/` (`tenant-api-module`, `aggregation-endpoint`, `rls-for-table`, `wire-page`, `supabase-storage`, `workflow-gate`, `e2e-flow`, `report-generation`, `bulk-ingest`, `localise-ui`) — invoke the skill instead of re-deriving the recipe. When a new recurring pattern emerges, extract it into a skill in the same PR that first implements it.
- **Keep docs current, each in its own home (owner decision 2026-11-05):** `README.md` holds entry-level content only — overview, features, setup, commands, configuration, environments, contributing. An API contract change updates its file in `docs/api/`; security, data model, localisation or observability changes update `docs/architecture/`; testing and tooling changes update `docs/development/`; status lives only in the status file. Update the right file in the same change; never grow the README with contract or status detail. No doc may go stale.
- **Tests must stay green** — `pnpm test` gates CI. Add tests for new behaviour; cover negative/security cases, not just the happy path.
- **Git:** **never push to `main` directly** — every change lands via a feature branch (`feat/` · `chore/` · `fix/`) and a **pull request with green CI**. **Commit & push only when asked**; do **not** pass a hardcoded `-c user.*` identity (the repo's git config is already set). Conventional-commit style messages; delete the branch after merge.
- **Pull requests:** open PRs for review — **the user merges; never self-merge.** Keep each PR small and focused. CI runs on **Node 22**; never commit `dist/`, `generated/`, or `*.tsbuildinfo` (all gitignored).
- **Verify before declaring done:** typecheck + build + relevant tests; for behaviour, exercise it against the running app — don't claim a fix works without checking.

## Working mode (token-efficient — standing preference, 2026-07-07)
Keep the main thread's context small; the biggest cost is accumulated context (whole-file reads, big diffs, verification output), not writing code.
- **Investigate/plan via a read-only subagent.** The "read many files → produce a plan" step at the start of a work package goes to the `Explore` agent, so file dumps stay out of the main context and only the plan returns. This is standing authorization — spawn it without re-asking. Do the **implementation** in the main thread (following the skills), not in a subagent.
- **Risk-based verification.** Security / compliance / data-model / migration changes → full proof (typecheck + tests + live API, and browser if visual). Low-risk changes → typecheck + tests; skip live/browser unless the change is observable in the app. Never weaken correctness claims — just match verification depth to risk.
- **Fresh-eyes review pass before a risky PR — not optional.** When a change touches the calc path, factor immutability, RLS/auth, tenant isolation, or the record lifecycle (locking/approval), spawn `security-rls` **and** `qa-auditor` (in parallel) to review the diff before opening the PR. When a change reshapes the **Prisma schema or the `@tonyai/shared-types` contract surface**, add an `architect`-seat contract review to the same pass — a reviewer that starts fresh catches what the implementer missed, and the two find different classes of problem. Give each a self-contained prompt (branch, diff range, what changed and why, the specific attacks/gaps to probe) and ask what they *verified*, not only what they found. **Re-review when a PR grows a second material design after the first pass** — the reviewed diff has gone stale. This is about quality, not tokens.
- **One work package per session**, fed by the status log below. Read surgically (`grep` + `offset`/`limit`, not whole files) and batch independent tool calls.

## Status & roadmap
- **Session memory lives in `docs/roadmap_docs/project_status_roadmap_phases.md`** — the ONE planning file (status, launch plan, LP task cards + ledger, assessment findings, decisions, history; merged from three files 2026-09-27). Read its **Part A** at session start; update it (status, ledger, decisions, next steps) in the same change whenever a PR merges or the roadmap shifts. **Never create another status, roadmap or handoff file.** It must never go stale. **Orchestration (owner decision 2026-11-07): Claude Code is the orchestrator, the planner and this file's only writer** — it defines, sequences and does the work itself; **it hands a task to Codex only when the owner explicitly asks** (otherwise plan as if Codex did not exist), and then reviews Codex's PRs, updates the file in the same PR as its own work and records Codex's merged PRs. **Codex implements only the tasks the owner asks Claude Code to hand it**, on its own branch and PR, following [`AGENTS.md`](AGENTS.md); it does not edit this file and puts its status in its PR description. When handing a task to Codex, write a self-contained task card (goal, scope and files, acceptance checks, constraints). (From 2026-10-28 to 2026-11-07 Codex ran the project.)
- Done: Phases 0–1 complete (calc engine, records + review workflow, evidence, period locking, anomaly detection, targets/intensity, reports, E2E + RLS probes); UAT running; Phase-2 prep shipped (containerization #26, observability + dual-scheme JWT #27).
- Next: **the LP0–LP7 task cards (Part B), in the order of Part A's Launch plan** — pilot = Scope 1 & 2 on authoritative Türkiye factors (UK out, Decisions 2026-11-05), Turkish + English UI, email = invitation + password reset only; Scope 3, suppliers, report sharing, analytics, notifications and dark mode are post-pilot (LP7). **Hosting (owner decision 2026-10-28):** for the next two to three months QA and the pilot run the database, Auth and Storage on **Supabase Cloud (Pro), North EU — Stockholm (`eu-north-1`)** and the web and API on **Azure Container Apps, Sweden Central (`swedencentral`)**, both built from scratch; email via Azure Communication Services — plan: [`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md). The self-hosted Supabase route (R3, R4, `r3_*`, `qa_*`, `selfhost_*`, `replacement_*`, runbooks 07–10, [`Azure_roadmap_plan.md`](docs/roadmap_docs/Azure_roadmap_plan.md)) is **paused, never deleted**: it resumes on the owner's word after the pilot launch to move the Supabase side to Azure (on-premises preparation follows the production launch). Its CI gates run only by hand meanwhile (`selfhost-checks.yml`, `qa-infra.yml`). Targets: QA handover 2026-11-06 (proposed; G2 2026-11-15) · pilot **2027-02-01** (stretch 01-25, fallback 02-15) · GA dated at G6. **Until the pilot ships, a review finding that is not a correctness/security/data-integrity defect is filed under Open questions, not fixed.**

<!-- Add your own recurring rules/preferences below this line -->
