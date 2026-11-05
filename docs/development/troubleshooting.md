# TonyAI: Troubleshooting guide

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Docker daemon is not running` | Start Docker Desktop, wait until ready, re‑run `pnpm setup`. |
| `supabase: command not found` | Install the Supabase CLI (`brew install supabase/tap/supabase`). |
| Port `3000` / `3001` / `54321` already in use | Stop the other process (or `supabase stop`) and re‑run. |
| `401 Invalid or expired token` after restarting Supabase | Keys rotated — re‑run `pnpm setup` to re‑sync the `.env` files. |
| Login succeeds but every page is empty and shows an auth error | The API could not verify the token. Re‑run `pnpm setup` and read its final "Verifying the login chain" line: it reports the signing algorithm and, for asymmetric projects, whether the JWKS endpoint is reachable. A stale `apps/api/.env` (secret from a previous Supabase instance) is the usual cause. |
| A preview or save answers *"Only placeholder (non-authoritative) emission factors cover…"* (`placeholder_refused`) locally | The API runs without `ALLOW_PLACEHOLDER_FACTORS=true`, and every factor the seed loads is a placeholder (LP3-03, K3). Re-run `pnpm setup`, or add `ALLOW_PLACEHOLDER_FACTORS=true` to `apps/api/.env` (`.env` files predating LP3-03 lack it). The boot log's `factor_policy` line says which policy is in force. |
| API exits at startup: *"ALLOW_PLACEHOLDER_FACTORS=true is refused…"* | Working as designed — the flag is accepted only when `DATABASE_URL` and `SUPABASE_URL` are both set and loopback. Remove it anywhere else. The `pnpm docker:up` containers reach the stack through `host.docker.internal`, which the guard treats as remote: they boot without the flag and refuse every calculation (`placeholder_refused`) — use `pnpm dev` to enter figures locally. |
| API exits at startup: *"SUPABASE_JWT_SCHEME must be pinned…"* or *"…demo secret"* | Working as designed — the boot check refuses an unpinned scheme or the public demo secret unless the run is explicitly local. Re‑run `pnpm setup`, which writes `ALLOW_INSECURE_LOCAL_AUTH=true` into `apps/api/.env`. `.env` files predating this check do not have it. For a real deployment, pin `SUPABASE_JWT_SCHEME` and set the project's own secret instead. |
| Login works but no data shows | Make sure the DB was seeded (`pnpm db:seed`); or `pnpm db:reset`. |
| Stale schema / weird data | `pnpm db:reset` (drops, re‑migrates, re‑seeds). |
| `pnpm: command not found` | `npm i -g pnpm` (or enable via Corepack). |
| `pnpm dev` eats memory / freezes the machine | Check that `outputFileTracingRoot` is **not** applied to the dev phase in `apps/web/next.config.mjs` — Next's Turbopack dev server adopts it as the project root and would then index and watch the whole monorepo. If a stale cache is suspected, delete `apps/web/.next`. |
