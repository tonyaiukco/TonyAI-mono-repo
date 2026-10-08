# AGENTS.md

Instructions for Codex, and for any agent that loads `AGENTS.md`, in the TonyAI repository.

## Read first

1. **[`CLAUDE.md`](CLAUDE.md) is the rulebook for every agent, not only Claude.** Its Language, Architecture, Security & data, Frontend, Workflow and Git rules apply to you in full. Where it names Claude-only tooling (the subagents in `.claude/agents/`, the skills in `.claude/skills/`), read those Markdown files as the house recipe for the task and follow the recipe.
2. **[`docs/roadmap_docs/project_status_roadmap_phases.md`](docs/roadmap_docs/project_status_roadmap_phases.md)** is the one planning file. Read Part A (including *Two-tool lanes* and the *Assignment ledger*), sections B1–B4, your task card, and the Part C findings your card cites. Check the code itself; the file is a plan, not proof.

## You are the Codex lane

Two tools work in parallel — one Claude Code session, one Codex session — and the project owner coordinates, reviews and merges (decision 2026-09-27).

- **Your cards and the files you own** are listed in Part A, *Two-tool lanes*. Do not edit a file the other lane owns. If your task needs one, stop and ask the owner for a slot.
- **Never edit `docs/roadmap_docs/project_status_roadmap_phases.md`** (its update rule 7). Put your status, your test evidence and the ledger change you propose in the PR description, using the handoff template in section B9. Claude Code records it after the owner merges.
- **Shared files** — `packages/shared-types/src/index.ts`, `apps/web/lib/api.ts`, the root `package.json` and `pnpm-lock.yaml`, the app shell — only in a slot the owner granted, in a PR that merges alone and first.
- **Migrations** only in a granted migration slot. Inspect every generated migration and delete the spurious `DROP INDEX activity_records_reporting_entity_period_category_key` (CLAUDE.md, Architecture rules).
- **The local Supabase stack belongs to the Claude Code lane.** Do not start, reset or seed it unless the owner lent it to you for that session: the development machine has 16 GB and cannot run two stacks.
- **Work in your own worktree or clone**, branched from the base commit the owner gives you.

## Non-negotiables (summary — CLAUDE.md is authoritative)

- **English** for everything in the repository: code, identifiers, comments, docs, commit messages, UI copy. The only exception is the values of the `tr` i18n catalogue and Turkish test fixtures.
- **Git:** never push to `main`. Branch as `feat/`, `fix/`, `chore/`, `docs/`, `test/` or `refactor/`; conventional-commit messages; open a pull request. **The owner merges — never self-merge.** Commit and push only when the owner asked for it.
- **Never invent emission-factor values**; cite source and version, and never present demo or prototype values as authoritative. Historic calculation snapshots are immutable.
- **Never weaken tenant isolation** (the API guard and RLS), never `FORCE` RLS, never add an UPDATE or DELETE path to `audit_log`; every mutation writes one audit row.
- **Runtime grants:** a new table needs its runtime grant in the migration and an entry in `packages/db/scripts/runtime-role.mjs` (LP3-01 added `UPDATE (language)` on `profiles` this way).
- **UI copy and API errors (LP3-01):** every user-facing string goes through the TR/EN catalogues in `apps/web/messages/`, and an API refusal a screen words gets a registered error code — follow [`.claude/skills/localise-ui/SKILL.md`](.claude/skills/localise-ui/SKILL.md) and README "Localisation and error codes".
- **One source of types:** `@tonyai/shared-types`. The web reaches the API only through `apps/web/lib/api.ts`; the API persists only through Prisma.
- **Keep `README.md` current** in the same PR as the change it describes.
- **Never commit** `.env*` (except `.env.example`), `dist/`, `generated/` or `*.tsbuildinfo`.

## Before you hand off

Run `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` (Node 22; `pnpm`, never `npx`). Report which ran, where, on which commit, and what you could not run — never a check you did not execute. Changes to security, auth, tenant isolation, calculations or the record lifecycle get an independent review before merge (planning file, section B8).
