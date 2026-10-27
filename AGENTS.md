# AGENTS.md

Instructions for Codex, and for any agent that loads `AGENTS.md`, in the TonyAI repository.

## Read first

1. **[`CLAUDE.md`](CLAUDE.md) is the rulebook for every agent, not only Claude.** Its Language, Architecture, Security & data, Frontend, Workflow and Git rules apply to you in full. Where it names Claude-only tooling (the subagents in `.claude/agents/`, the skills in `.claude/skills/`), read those Markdown files as the house recipe for the task and follow the recipe.
2. **[`docs/roadmap_docs/project_status_roadmap_phases.md`](docs/roadmap_docs/project_status_roadmap_phases.md)** is the one planning file. Read Part A (including *Single-tool mode* and the *Assignment ledger*), sections B1–B4, your task card, and the Part C findings your card cites. Check the code itself; the file is a plan, not proof.
3. **[`docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md`](docs/TMP_Supabase_Azure_Doc/tmp_supabase_azure_roadmap.md)** is the deployment plan for the hosted phase (QA and the pilot, about two to three months): Supabase Cloud (Pro) in North EU — Stockholm (`eu-north-1`) for the database, Auth and Storage; the web and API on Azure Container Apps in Sweden Central (`swedencentral`); both built from scratch; its work packages and the owner-run live operations. The self-hosted plan [`docs/roadmap_docs/Azure_roadmap_plan.md`](docs/roadmap_docs/Azure_roadmap_plan.md) is paused.

## You run the project

**Single-tool mode (owner decision 2026-10-28).** Codex is the only implementer. The project owner reviews and merges every pull request and runs or approves every live cloud operation. Claude Code joins only when the owner opens a session for it (for example as an independent review seat).

- **You own every file**, the local Supabase stack, CI (`.github/**`) and the infrastructure (`infra/**`). The development machine has 16 GB: run one Supabase stack at a time, and stop it before heavy Docker builds.
- **You write the planning file.** Update `project_status_roadmap_phases.md` in the same PR as the work it describes (its update rules 1–6; rule 7 records single-tool mode): a *Current status* entry, the ledger row, any decision, and *Next up*. Never create another status, roadmap or handoff file.
- **Contracts and migrations** no longer need a slot, but a change to `packages/shared-types/src/index.ts`, `apps/web/lib/api.ts` or the error-code registry, and every migration, merges alone and first. Inspect every generated migration and delete the spurious `DROP INDEX activity_records_reporting_entity_period_category_key` (CLAUDE.md, Architecture rules).
- **Work in your own worktree or clone**, branched from current `main`.
- **The self-hosted Supabase route is paused — never delete any of it.** R3, R4, `infra/selfhost/**`, `infra/terraform/selfhost/**`, the `qa/` Terraform roots, `infra/scripts/{r3_,qa_,selfhost_,replacement_}*`, runbooks 07–10, their workflows and their Azure resources stay. Do not run, dispatch or extend them until the owner resumes the work (after the pilot launch, to move the Supabase side to Azure). Their CI gates run only by hand: the self-hosted scripts import most hosted modules (`pooler`, `bootstrap_backend`, …), so before merging any change to `infra/scripts/**`, `infra/tests/**`, `infra/terraform/**`, `infra/config/**`, `infra/selfhost/**` or these two workflows, dispatch `selfhost-checks.yml` and `qa-infra.yml` on the PR's branch and report both runs.

## Independent review (not optional)

A change to the calculation path, factor immutability, RLS/auth, tenant isolation, the record lifecycle (locking/approval), a CI gate, the deployment gate or secrets handling gets a fresh-eyes review **before the PR opens**. Run it as separate review sessions that did not write the change, each briefed from `.claude/agents/security-rls.md` and `.claude/agents/qa-auditor.md` (in parallel); add `.claude/agents/architect.md` for a Prisma schema or `@tonyai/shared-types` contract change, `.claude/agents/devops-cloud.md` for infrastructure, and `.claude/agents/data-factors.md` for factor data. Give each a self-contained brief (branch, diff range, what changed and why, the attacks and gaps to probe), ask what it *verified*, and put the outcome in the PR description. Re-review when the PR grows a second material design.

## Live cloud operations

Owner-run from the owner's machine, or run by you only with the owner's explicit approval for that one operation. A merged PR or a passing mock never authorizes an apply, a deploy, a migration against the cloud or a deletion. Secrets are typed at hidden prompts and live in the owner's password manager and Key Vault — never in chat, git, Terraform state, logs or a PR. The seed never runs against the cloud.

## Non-negotiables (summary — CLAUDE.md is authoritative)

- **English** for everything in the repository: code, identifiers, comments, docs, commit messages, UI copy. The only exception is the values of the `tr` i18n catalogue and Turkish test fixtures.
- **Git:** never push to `main`. Branch as `feat/`, `fix/`, `chore/`, `docs/`, `test/` or `refactor/`; conventional-commit messages; open a pull request. **The owner merges — never self-merge.** Commit and push only when the owner asked for it.
- **Never invent emission-factor values**; cite source and version, and never present demo or prototype values as authoritative. Historic calculation snapshots are immutable.
- **Never weaken tenant isolation** (the API guard and RLS), never `FORCE` RLS, never add an UPDATE or DELETE path to `audit_log`; every mutation writes one audit row.
- **Runtime grants:** a new table needs its runtime grant in the migration and an entry in `packages/db/scripts/runtime-role.mjs`.
- **UI copy and API errors:** every user-facing string goes through the TR/EN catalogues in `apps/web/messages/`, and an API refusal a screen words gets a registered error code — follow [`.claude/skills/localise-ui/SKILL.md`](.claude/skills/localise-ui/SKILL.md) and README "Localisation and error codes".
- **One source of types:** `@tonyai/shared-types`. The web reaches the API only through `apps/web/lib/api.ts`; the API persists only through Prisma.
- **Keep `README.md` current** in the same PR as the change it describes.
- **Never commit** `.env*` (except `.env.example`), `dist/`, `generated/` or `*.tsbuildinfo`.

## Before you hand off

Run `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` (Node 22; `pnpm`, never `npx`), plus `pnpm --filter @tonyai/api test:int` and the RLS probes when the change touches the API's data path. Report which ran, where, on which commit, and what you could not run — never a check you did not execute.
