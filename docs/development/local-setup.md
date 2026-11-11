# TonyAI: Local setup

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Getting started

### Prerequisites

- **Node ≥ 22.12** (the API's email catalogue uses `intl-messageformat`, an ES module the CommonJS build `require`s — unflagged from 22.12; CI and the images run 22), **pnpm** (enable Corepack so the pinned version is used: `corepack enable`), **Docker Desktop** (running), **Supabase CLI with an owner-qualified database image** ([image gate and proposed CLI pin](../../infra/runbooks/10-qa-clean-replacement.md#database-image-qualification-before-r2)); installation alone does not qualify the bundled database. The shared local stack belongs to Claude Code; obtain its owner's upgrade window before changing it.

`pnpm setup` enforces the CLI floor and finishes with a login smoke check that prints how your project signs tokens (`HS256` shared secret or asymmetric via JWKS) — both are supported, so a newer CLI is fine.

### First‑time setup

```bash
# Option A — one command (recommended). Idempotent; safe to re-run anytime.
pnpm setup          # deps -> Supabase up -> sync .env -> migrate -> generate -> seed
pnpm dev            # web :3000 · api :3001

# ---------------------------------------------------------------------------
# Option B — manual, step by step:

# 1. Install dependencies
pnpm install

# 2. Start local Supabase (Postgres, Auth, Storage in Docker)
supabase start

# 3. (If the printed keys differ from the defaults) copy them into env files:
#    supabase status -o env
#      apps/web/.env.local  -> NEXT_PUBLIC_SUPABASE_ANON_KEY
#      apps/api/.env        -> SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY
#      packages/db/.env     -> SUPABASE_SERVICE_ROLE_KEY
#    (copy each app's .env.example to the real file first)

# 4. Create the schema and seed demo data
pnpm db:migrate     # applies Prisma migrations (incl. RLS policies)
pnpm db:seed        # 1 org, 5 subsidiaries, 8 locations, 5 users (one per role, two super_admins), the placeholder factor library for DEMO_YEAR (2026) — insert-if-absent
                    # + 96 approved Scope 1&2 records (90 subsidiary-level monthly, 6 location-level),
                    # one demo evidence file each, 3 targets + 12 intensity denominators
                    # A month reported per site is NOT also reported company-wide: the two
                    # attribution levels coexist across the year, never for the same month.
                    # Jan-Mar for TonyAI Energy (Electricity) and TonyAI Logistics (Fuel) are
                    # therefore reported per site ONLY, by one site of two — so those months
                    # are deliberately incomplete at company level. The company figure is
                    # withdrawn, not redistributed; the coverage grid shows the open slots.

# 5. Run everything
pnpm dev            # web -> http://localhost:3000   api -> http://localhost:3001/api/v1
```

### Seed users

| Email | Password | Role | Sees |
| --- | --- | --- | --- |
| `admin@tonyai.local` | `TonyAI!2026` | `super_admin` | all 5 subsidiaries |
| `approver@tonyai.local` | `TonyAI!2026` | `super_admin` | all 5 subsidiaries — the second approver: nobody approves a record they created (D01) |
| `entry@tonyai.local` | `TonyAI!2026` | `data_entry` | 2 subsidiaries (tenant‑isolation demo) |
| `review@tonyai.local` | `TonyAI!2026` | `consultant` | organisation‑wide read; review/reject only (cannot enter, edit, submit or approve) |
| `viewer@tonyai.local` | `TonyAI!2026` | `executive_viewer` | organisation‑wide read only — dashboards, Emissions and reports; no writes (LP4-04 slice 2 PR C, the UAT catalogue's fourth role) |

The seed passwords predate the 12-character minimum (LP4-01) and still sign in — the minimum applies when a password is set. Invitation and password-reset emails sent locally land in the stack's mail catcher, **mailpit, at http://127.0.0.1:54324** (`pnpm setup` points the API at its SMTP port).

---

## Running in containers (Phase-2 prep)

Both apps ship Dockerfiles (`apps/api/Dockerfile` includes distro Chromium for PDF generation; `apps/web/Dockerfile` uses Next.js standalone output). With the local Supabase running:

```bash
pnpm docker:up      # builds + starts web (:3000) and api (:3001) containers
pnpm docker:down
```

The wrapper sources `apps/api/.env` + `apps/web/.env.local`, reuses an existing loopback `tonyai_runtime` password and provisions its login idempotently, so host `pnpm dev`, `test:int`, `storage:reconcile` and `anomaly:*` retain working credentials. When no such runtime URL exists it generates a fresh password; the API container receives only the runtime URL, never `DIRECT_URL`. Containers use your instance's real keys (supabase-cli demo JWTs differ per CLI version — never hardcoded). `NEXT_PUBLIC_*` values are inlined into the web bundle at build time, so images are environment-specific; server-side auth can override the Supabase URL at runtime via `SUPABASE_URL_INTERNAL`. CI builds both images on every PR (`docker-build` job, no push).

---

## Environment variables

Templates live in each package's `.env.example`. Never commit real `.env*` files.

| File | Key | Used for |
| --- | --- | --- |
| `apps/web/.env.local` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_BASE_URL` | Browser Supabase client + API base |
| `apps/api/.env` | LP4-01: `SMTP_HOST`, `MAIL_FROM` and `APP_URL` (set together or not at all — without them invitations and resets are recorded as `mail_not_configured`), optional `SMTP_PORT` (587), `SMTP_SECURE`, `SMTP_USER`/`SMTP_PASSWORD`, `AUTH_EMAIL_PER_IP_PER_MINUTE` (5); self-service registration: `REGISTRATION_CODE` (`local` — `/register` is open behind it; unset, there is no registration) and `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT` (`true` locally: the KVKK notice is a placeholder, and the API refuses to start with a code set and no allowance); `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_JWT_SCHEME`, optional `SUPABASE_JWT_ISSUER` (default: `SUPABASE_URL`'s origin + `/auth/v1`) and `SUPABASE_JWT_AUDIENCE` (default `authenticated`, also when empty), `ALLOW_INSECURE_LOCAL_AUTH`, `ALLOW_PLACEHOLDER_FACTORS` (local/CI only — calculate from the seed's placeholder factors), `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (runtime role), `DIRECT_URL` (owner — the integration tests' fixtures only), `PORT`, `WEB_ORIGIN`; optional `STORAGE_SWEEP_INTERVAL_SECONDS` (default 300, `0` = off) and `STORAGE_CLEANUP_HOLD` (`1` while a backup/restore runs — nothing removes bytes) | JWT verification (`SUPABASE_URL` is the JWKS origin and the default issuer; the flag is local-dev only), CORS, server, the Storage sweeper (LP1-02) |
| `apps/api/.env` | `FACTOR_LOADER_DATABASE_URL` (LP4-02, optional) | The factor-release loader's own login (`tonyai_factor_loader`); only an operator loading or withdrawing a release needs it — see `apps/api/.env.example` |
| `packages/db/.env` | `DATABASE_URL` (runtime role — `storage:reconcile`, `anomaly:recompute`), `DIRECT_URL` (owner — migrations and the seed), `SUPABASE_SERVICE_ROLE_KEY` | Prisma + seed |
