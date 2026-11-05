# TonyAI: Commands and operator tools

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Scripts

Run from the repo root (Turborepo fans out to each package):

| Script | Description |
| --- | --- |
| `pnpm setup` | One‑command local bootstrap (deps, Supabase, `.env` sync, migrate, seed) |
| `pnpm dev` | Run web + api in watch mode |
| `pnpm build` | Build all packages |
| `pnpm lint` | ESLint 9 (flat config, one root `eslint.config.mjs`) over all 277 files — every workspace plus `e2e/`, `scripts/` and the root configs. **Run at the root, not through Turbo:** a per-workspace fan-out silently skips every file that belongs to no workspace. `pnpm lint:fix` applies the fixable ones |
| `pnpm typecheck` | Type‑check the whole repo, `e2e/` and `playwright.config.ts` included (`tsconfig.e2e.json` — Playwright's own runner strips types without checking them) |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm e2e` | Playwright E2E: demo flow, gates, RBAC, smoke (requires Supabase running) |
| `pnpm e2e:ui` | The same suite in Playwright's UI mode, for debugging one spec |
| `pnpm rls:probe` | Live RLS containment probes via PostgREST (requires Supabase running) |
| `pnpm storage:reconcile` | The database ↔ Storage reconciliation, every bucket — evidence, import sources and issued reports' PDFs (builds the API first; in the image: `node dist/storage/reconcile.cli.js`). Prints one JSON report: pending/stuck intents, **orphans** (objects no row owns and no intent names), **rows whose object is missing** (with the records an evidence file backs and their status) and evidence rows no record links to — reported, never deleted. `--verify` downloads and hashes up to `--limit` rows that carry a sha256; `--sweep` runs one sweep of pending intents now; `--reclaim-orphans` lists the orphans old enough to remove (`--older-than=<hours>`, default 168) and removes them with `--apply`, never while `STORAGE_CLEANUP_HOLD` is set. `--forget-uploads` (only under `STORAGE_CLEANUP_HOLD`) is the post-restore step above. `--sweep`, `--apply` and `--forget-uploads` off a loopback host need `--allow-remote` — a guard against a typo, not a control (a tunnel is "localhost" too) — and off loopback `--older-than` cannot go below 24 hours. Refuses to run under a role RLS filters. Exits 1 when something needs a person (missing or changed bytes, an unlinked row, a stuck intent). Replaces `pnpm evidence:reclaim` |
| `pnpm onboarding <provision\|offboard\|reconcile>` | The operator's tenant boundary (D18, K3, K6; builds the API first; in the image: `node dist/onboarding/onboarding.cli.js`). **A dry run unless `--apply`**, `--operator=<email>` required and written to every audit row (`userId` null), `--allow-remote` needed to write off a loopback database or Supabase. Runs on `DIRECT_URL` and refuses any login but the tables' owner. `provision` creates an organisation (or takes `--organisation-id`) and its first `super_admin`, and sends the invitation; re-run, it completes a half-done provisioning and re-sends an unaccepted invitation (a fresh link), and changes nothing else. `offboard` marks the organisation offboarded (D21's clock; nothing is deleted), disables every member and bans them in Auth. `reconcile` retries Auth bans left pending and lists undelivered invitations. Locally `set -a; source apps/api/.env; set +a` first. Exits 1 while something needs a person |
| `pnpm --filter @tonyai/api factor-release <load\|withdraw>` | The factor library's loader (LP4-02; builds with the API; in the image: `node dist/factor-releases/factor-release.cli.js`; no root wrapper, P9). **A dry run unless `--apply`**, `--operator=<firm or role>` (never a person — the library's record names it), `--allow-remote` needed to write off a loopback database. Runs on `FACTOR_LOADER_DATABASE_URL` and refuses any login but `tonyai_factor_loader`. `load --file=<release.json>` checks the file with `validateFactorReleaseImport` and loads the release, its rows and its seal in one transaction; re-run, it is a no-op, and other content under a loaded edition is refused; `--supersedes=<edition> --reason=<why>` withdraws the edition an erratum corrects in the same transaction. `withdraw --publisher --edition --reason` withdraws one release. See the `factor-release-import` skill |
| `pnpm anomaly:probe` | Recompute the anomaly baseline (VAR §4) in SQL over every committed record: how many priors each was scored against, and whether the stored `anomalyFlag` still matches the pool beneath it (read-only; exits 1 on drift) |
| `pnpm anomaly:recompute` | Repair verdicts that have gone stale as the pool moved beneath them (dry run; add `-- --apply`, and `-- --allow-remote=<host>` off loopback). Re-scores `draft`/`rejected`/`submitted`/`under_review` through the same shared rule the API uses, one `rescore` audit row each. **Two refusals:** a record that is itself `approved`/`locked`, and any record inside a **closed period** — both reported, neither touched. Exits 1 while drift remains |
| `pnpm docker:up` / `docker:down` | Containerized web+api against the host's local Supabase (keys sourced from your real env files) |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:migrate` | `prisma migrate dev` |
| `pnpm db:deploy` | Apply committed migrations (`prisma migrate deploy`) |
| `pnpm db:seed` | Seed demo data |
| `pnpm db:reset` | Drop, re‑migrate, re‑seed, then reclaim every orphaned object (`storage:reconcile --reclaim-orphans --older-than=0 --apply`: the reset drops the schema but not the buckets) |
