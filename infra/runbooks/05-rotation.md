# 5. Rotation, rollback and recovery

> **Historical hosted reference, not a deployment route for current QA or production.**
> Active application/data resources use **Azure Sweden Central** and self-hosted
> Supabase. Use [runbook 08](08-qa-application.md) for application preparation and
> [runbook 07](07-selfhost.md) for host ownership. The Germany/Frankfurt commands
> below describe the retained legacy implementation only; do not run them for
> Sweden or bypass their subscription/project checks.

Use a private owner session restored through runbook 00. Keep the last verified
release manifest and DB/schema compatibility evidence. **Every application
change uses a new immutable manifest and the same `deploy-apps.sh` path**. Never
mix mutable candidates, ad hoc Container App updates or latest secret references.
Every selected manifest must explicitly carry `storage_cleanup_hold` and
`storage_sweep_interval_seconds`; copy the current incident hold into any older
rollback manifest. Clearing an on/unknown hold requires owner-run
`--ack-clear-storage-hold` only after the runbook 04 reports have been reviewed.

## Initial LP1-03 runtime handoff (owner-run, before G2)

Keep application traffic and `runtime_secrets_ready` off during first setup.
Runbook 02 stores only owner `direct-url` (`postgres.<project-ref>`, session 5432).
The application `database-url` must use `tonyai_runtime.<project-ref>` on
transaction port 6543, with its own random password. Never reuse the owner password.
The API and scheduled storage-verify job get only `database-url` and the backend
Storage key. `storage:reconcile` needs only the runtime role. `direct-url` reaches
only owner tooling (migrations, private psql and synthetic fixtures);
it is never a workload secret or an application environment variable.

1. Before applying the LP1-03 migration, use the owner-only helper below from a
   clean reviewed checkout. It resolves the exact `direct-url` version from Key
   Vault into psql's libpq environment, verifies the Frankfurt/project/owner/TLS
   contract, disables psql startup files/history, and never puts a password or
   URL in argv or prints it. A private interactive terminal and psql are required.
   The freshly generated owner password need not be retrieved or reset manually.
   Use the same `versions.direct_url_version` from runbook 02 for this session,
   migrations and fixtures; after owner rotation use its explicitly recorded
   replacement. Never use a dashboard reset without storing/selecting a new URL.

   ```bash
   python3 infra/scripts/cloud_ops.py owner-psql --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --source-sha '<reviewed-helper-full-sha>' --direct-secret-version '<selected-direct-url-version>'
   ```

   Confirm the hosted `postgres` retains CREATEROLE and BYPASSRLS and can read
   `storage.objects`. After the full migration chain, this owner executes the
   two `public.storage_catalogue_*` SECURITY DEFINER readers. The runtime login
   must have neither USAGE on `storage` nor direct SELECT on `storage.objects`;
   do not restore the former LP1-03 grants. Grant options are not a steady-state
   prerequisite for the readers:

   ```sql
   SHOW server_version;
   SELECT current_user, rolcreaterole, rolbypassrls
   FROM pg_roles WHERE rolname = current_user;
   SELECT has_schema_privilege(current_user, 'storage', 'USAGE') AS storage_usage,
          has_table_privilege(current_user, 'storage.objects', 'SELECT') AS storage_select;
   BEGIN;
   CREATE ROLE lp1_probe BYPASSRLS;
   ROLLBACK;
   ```

   All four booleans must be true and the rolled-back role probe must succeed.
   A fresh replay still executes the immutable LP1-03 migration's historical
   GRANT statements before the later migration revokes them. Its migration owner
   must be able to execute that chain; verify this in the isolated migration
   rehearsal. Do not rewrite historical migrations or manually restore their
   grants after the reader migration to satisfy this pre-check.
   `server_version` must be 17.x: the [owner reconciliation check](#owner-reconciliation-check)
   pins CHECK constraints by md5 of PostgreSQL 17's `pg_get_constraintdef` output.
   After migration, run the owner reconciliation check and the runtime privilege
   check below; the readers must exist, remain SECURITY DEFINER with the reviewed
   search path, and their owner must retain SELECT and BYPASSRLS. The Storage
   sweeper refuses a missing reader, an invoker or a filtered owner.
   Record the server version and probe output. If the probe fails, roll back or
   exit the session; never drop an existing role named `lp1_probe`. Stop and
   resolve with the platform owner on failure; do not weaken the migration or grant wider runtime privileges.
2. Generate the runtime password using `openssl rand -hex 32` in the private,
   unrecorded owner terminal, and save the 64-character hex string in the password
   manager. Do not use symbols, percent-encoding or a password-manager substitute:
   use this exact hex string for both the URL and psql's hidden `\password` prompts.
   Never paste it into a recorded shell command, PR or evidence output. Build the
   complete runtime URL from this template (all query parameters are required):

   ```text
   postgresql://tonyai_runtime.<project-ref>:<64-character-hex-password>@aws-N-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt&pgbouncer=true
   ```

   Use the project's actual Frankfurt pooler host. Store the URL through hidden
   input below; this validates its structure, not a login, because the role does
   not exist until migration.

   ```bash
   python3 infra/scripts/release_secrets.py store --foundation .infra-local/staging/foundation.json --project-ref "$SUPABASE_PROJECT_REF" --name database-url
   ```

   This initial-storage path validates the foundation and project without needing
   a release manifest or an existing runtime version. Put the returned version ID and runbook 02's backend version in the initial
   release manifest. This allows a complete immutable manifest before migration;
   the migration helper does not read or connect through the runtime URL.
3. Apply the reviewed migration chain using runbook 03 §3.2 and the explicit
   owner secret version. Reconnect using the `owner-psql` command above with the same selected owner version.
   Use the same saved runtime password at both hidden prompts:

   ```text
   \password tonyai_runtime
   ALTER ROLE tonyai_runtime LOGIN;
   ```

   **Never use `ALTER ROLE … PASSWORD '…'` with a cleartext password.** Supabase
   statement logs and `pg_stat_statements` can retain it. psql's `\password`
   computes the verifier on the client. Do not run the loopback-only local
   provisioning helper against staging, including through a forwarded port.
4. Keep **pg_net disabled** in Dashboard → Database → Extensions unless a feature
   explicitly needs it. The runtime check reports PUBLIC exposures, including
   any outbound HTTP queue and Storage SECURITY DEFINER helpers; retain and
   review every warning. An unexpected exposure requires operator review.
5. For an existing shared-owner installation, close traffic and disable all old
   owner-backed `database-url` vault versions before granting runtime access.
   Rotate the owner password too: old workloads may have held it. Follow both
   independent procedures below; disabling a vault version alone does not revoke
   its database password. The first deployment of this change must have a new
   `release_id`, even for unchanged images/secret versions, because it creates a
   fresh `revisionSuffix`. `deploy-apps.sh --verify-only` against the pre-change
   deployment will fail closed while its runtime `DIRECT_URL` alias remains.
   For new setup, no owner-backed runtime version exists.
6. Verify the selected runtime version (`release_secrets.py verify`), then run
   the **Runtime connection and privilege evidence** procedure below before
   opening traffic. Enable foundation `runtime_secrets_ready`, deploy via runbook
   03, update the scheduled storage-verify job via runbook 06, and repeat the same
   evidence procedure against the deployed version. Attach both identity and
   privilege output, including all PUBLIC warnings, to the LP1-03 handoff.

## Runtime connection and privilege evidence

In the private owner shell, load the exact selected runtime URL from the password
manager into exported `DATABASE_URL` through hidden input, never shell history or
tracing. Replace only `sslcert`'s container path with the absolute local repository
CA path when running outside the image. Keep that same variable for **both** commands:

```bash
node infra/scripts/runtime-identity.mjs && node packages/db/scripts/runtime-role.mjs check
```

The first command executes **`SELECT current_user, session_user`** through that URL
and refuses unless both are **`tonyai_runtime`**. It must print
`PASS: current_user=tonyai_runtime; session_user=tonyai_runtime`. A login failure or
owner session fails this step and prevents the second command. `runtime-role.mjs check` now runs `checkAll` for **both roles**, not the caller identity;
**"privileges as intended" alone is not sufficient evidence**.

Require both commands to pass. Attach full stdout **and stderr**, including every
PUBLIC warning, plus source SHA, deployed release and exact secret version IDs
(never values). Clear `DATABASE_URL` afterwards. Repeat after restoration or grant
changes. LP1-03 is DONE only after the deployed identity and privilege evidence
and required security review close. Hardening the DB checker itself belongs to
the Claude Code lane; this PR does not modify `packages/db`.

Under this runtime URL `check` also prints `! the library's record was not
reconciled: tonyai_runtime cannot read factor_release_events …`. That line is
**expected** here, not a failure: the runtime role cannot read the library's
record, so the reconciliation runs only in the owner check below.

## Owner reconciliation check

Run it after **every** restore, every deploy that applies a migration and every
factor-library load. Use the private owner shell, never a shared host, on a clean
checkout of the **deployed** source SHA. Load the exact selected owner session URL
(`direct-url`: session pooler, port 5432, user `postgres.<project-ref>`) into
exported `DATABASE_URL` through hidden input, never shell history or tracing, and
replace only `sslcert`'s container path with the absolute local repository CA path,
as for the runtime URL above. Then run:

```bash
node packages/db/scripts/runtime-role.mjs check
```

The command reads the exported owner URL; never type the URL inline in front of
it. Through the owner, the check also compares every factor release's held rows with
`factor_release_events`. It scans the data for mixed record slots and for
`unspecified` rows under an authoritative release, two of the insert-time rules a
replica-mode restore bypasses. It does not repeat the others or foreign keys
(runbook 04). Expected:

- exit 0 and the final line `tonyai_runtime and tonyai_factor_loader on <host>: privileges as intended`;
- **no** `- …` problem line;
- **no** `the library's record was not reconciled` line (if it appears, the URL
  is not the owner's);
- on staging and production, **no** `! factor library holds a placeholder release`
  or `… fixture release` line. Neither environment ever holds one (K3), so such a
  line is a finding even though the exit code stays 0.

Record **both** `! tonyai_runtime can also reach …` and
`! tonyai_factor_loader can also reach …` PUBLIC warnings as in the runtime
procedure. These are warnings, not a reason to discard stderr or assume the
loader is confined; review every exposure. Attach full stdout and stderr with the source SHA and clear
`DATABASE_URL` afterwards. Three limits apply (independent review F5):

1. Its CHECK pins are md5 hashes of PostgreSQL 17 output. Confirm `SHOW
   server_version` is 17.x in the same session before relying on it.
   For an image minor-version change (including 17.6 to 17.11), re-run the
   unchanged integrity checker against the migrated candidate: all 57 CHECK
   and three FK definition pins must still match. Record the observed server
   version and exact source/image with the integration evidence. A static
   deparser comparison does not replace this catalog check; do not repin a
   mismatch without separate review.
2. It reads its integrity-function bodies from the checkout's migrations. Run it
   only from the deployed SHA; any other checkout can report false drift or miss
   real drift.
3. Use the checker from the schema's matching source SHA. This B1 checker needs
   `20261011120000_lp4_02_loader`, including `sealed_at` and the loader role.
   An older schema may fail before producing any privilege result. During a
   restore at an older migration head, first use that head's checker, then the
   new checker after migrating forward; never treat a missing-relation/column
   error as a successful privilege check.

## Both-role evidence and refusal lines

For runtime and owner checks require exit 0 and the exact final line:

```text
tonyai_runtime and tonyai_factor_loader on <host>: privileges as intended
```

Keep stdout **and** stderr. Exit 0 can coexist with PUBLIC exposure warnings and
skipped event reconciliation. Require the owner check to close that reconciliation;
the loader identity probe alone is not a grants or integrity check. A `- …`
problem line and exit 1 stop the handoff. Examples from the current checker:

```text
  ! tonyai_factor_loader can also reach …
  - tonyai_factor_loader has BYPASSRLS — its policies would no longer bound it
  - tonyai_factor_loader has DELETE on public.factor_releases
  - <grantee> may INSERT public.<table> — the factor library is written by its loader and the owner alone
  - tonyai_factor_loader may SET session_replication_role — replica mode turns the library's load-time triggers off
  - <n> factor release(s) not sealed — a release is sealed in the transaction that loads it, and pricing ignores an unsealed one
  - release <id> holds <n> <table> row(s) but factor_release_events records <n>
```

These illustrate loader privileges, unexpected library writers, replica-mode
privilege, unsealed releases and event mismatches; the list is not exhaustive.
Do not widen grants or patch seals/events to make it green. `check` does not prove
LOGIN is disabled or sessions are closed: collect the separate SQL evidence below.

## Provision the loader login per environment

**Hosted procedure — NOT RUN by this PR.** After the B1 migration, in the private
owner terminal open `owner-psql` with the exact selected `direct-url` version
(command under Initial LP1-03 handoff above). Confirm current_user and session_user
are both the project's owner (`postgres`), and review the both-role owner check.
Do not grant memberships: TA013 expects the loader's **own** session login.

Before enabling LOGIN, prove the owner can terminate the loader's sessions:

```sql
SELECT pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS can_signal_backends;
```

Require **true**; otherwise stop and resolve with the platform owner. On PG16+
the creator's implicit membership has INHERIT FALSE / SET FALSE, so creating the
loader role alone does not establish this ability. Repeat this check before
every LOGIN activation, including routine loads and rotation.

Generate `openssl rand -hex 32` privately and store the 64-character hex password
and URL as a separate, versioned **password-manager secret**, named for this
project/environment and loader role. Use an unrecorded terminal; no shell tracing,
clipboard recording, terminal capture or logs. No Azure resources are introduced.
Never copy this secret to a release manifest, API Container App environment,
`database-url`, `direct-url` or any API-readable Key Vault reference. Never reuse
an owner/runtime password. In owner-psql, enter it only at the hidden prompts:

```text
\password tonyai_factor_loader
ALTER ROLE tonyai_factor_loader LOGIN;
```

Never use a cleartext `ALTER ROLE … PASSWORD` statement. Store this session URL:

```text
postgresql://tonyai_factor_loader.<project-ref>:<64-character-hex-password>@aws-N-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=<absolute-repository-path>/infra/certs/prod-ca-2021.crt&connection_limit=1&connect_timeout=15
```

Use the actual project's Frankfurt pooler host and URL-encode the absolute CA
path if needed. The private workstation checker deliberately accepts only that
local CA, session port 5432, the exact project-qualified username and these five
query parameters. No `host`, `options`, `pgbouncer` or TLS downgrade is accepted.
The wire username has the project suffix; PostgreSQL must return the **bare**
role for both identities. A direct endpoint is an alternative requiring separate
endpoint qualification; transaction port 6543 is not approved by this procedure.

Before the first apply, retain hosted proof that this session endpoint and its
server/proxy timeouts permit one transaction of **up to 300 seconds** (the CLI's
transaction timeout). In a private loader psql session, use the same host, 5432,
project-qualified loader user, `PGSSLMODE=verify-full` and the repository
`PGSSLROOTCERT`; supply the password at `psql -X -W`, never argv. As the loader,
record all three settings before starting the probe:

```sql
SHOW statement_timeout;
SHOW idle_in_transaction_session_timeout;
SHOW transaction_timeout;
```

Require PostgreSQL 17's `transaction_timeout` to be 0 (disabled) or at least
300 seconds, with enough headroom for the actual probe duration below.
Require `idle_in_transaction_session_timeout` to be 0 or at least a few seconds
(use 5 seconds as the minimum here) to cover gaps between statements.
`statement_timeout` must be 0 or exceed the loader's longest individual statement,
not its whole 300-second transaction; retain representative per-statement timing
evidence before applying a release. A single `pg_sleep(300)` tests the wrong limit.

In the same loader psql session, run a read-only transaction lasting **at least
300 seconds** through short statements. For example, psql's `\gexec` sends each
of these 31 statements separately (at least 310 seconds plus round trips):

```sql
BEGIN READ ONLY;
SELECT current_user, session_user;
SELECT 'SELECT pg_sleep(10);' FROM generate_series(1, 31) \gexec
SELECT current_user, session_user;
ROLLBACK;
```

Both identity results must be the bare loader role. The 10-second example needs
a statement timeout above 10 seconds (or 0); if it is shorter, use shorter sleeps
and more separate statements to retain at least 300 seconds in the transaction.
A transaction timeout of exactly 300 seconds cannot complete the 310-second
example; allow headroom for the chosen probe and round trips when qualifying the
endpoint. Record the completed duration and pooler outcome. **Do not override
timeouts for the probe:** it must reflect what the CLI inherits. A failure stops
qualification; resolve the configuration with the platform owner, then repeat
the unchanged-environment probe and the both-role check before loading.
This is owner-run evidence, **NOT RUN** here; the identity unit tests prove no
hosted timeout or pooler behaviour.

## Load or withdraw from the owner workstation

**Activate the existing login for each operation.** In `owner-psql` with the
selected owner credential, first repeat the `pg_signal_backend` check under
[provisioning](#provision-the-loader-login-per-environment) and require true.
Then, without changing the password, run:

```sql
ALTER ROLE tonyai_factor_loader LOGIN;
SELECT rolcanlogin FROM pg_roles WHERE rolname = 'tonyai_factor_loader';
```

Require `rolcanlogin = true`, then perform the loader identity check below before
loading or withdrawing. The disable/terminate procedure still runs at the end of
every operation, including a failure during setup or identity checking.

**Recommendation:** use a private owner workstation, Node 22, and a clean checkout
of the deployed source SHA. It must contain **no `.env` files**, including
`packages/db/.env`; inspect `git status --ignored --short` and require that no
environment file is present (committed `.env.example` templates are not secrets
and may remain). Use a fresh isolated checkout if needed; do not delete another
work session's environment files. Prisma's generated client can load
`packages/db/.env` into `process.env`, including owner/runtime and Supabase
variables, despite the wrapper's explicit spawn environment. Recheck that no
environment files were introduced before running either helper.
Build with `pnpm install --frozen-lockfile`,
`pnpm db:generate`, `pnpm --filter @tonyai/api... build` (including workspace
dependencies) **before** introducing the
loader secret. Mount the approved release directory read-only from private
storage, and point `RELEASE_FILE` at its JSON file (maximum **16 MiB**). Keep the
file unchanged from dry run through apply; record its SHA-256 and source/licence
approval privately. No fixture/placeholder release belongs on staging/production.
At B1 the registry holds no real publisher: an authoritative load waits for PR C's
approved source/licence and publisher registration. Review GWP sets across the
inventory year and follow-up (12)'s erratum ordering before that first load.

A one-off job using the deployed API **image digest** is the alternative: read-only
release mount, separate identity/private loader secret and private reports,
working directory `/app/apps/api`, entry point
`node dist/factor-releases/factor-release.cli.js load|withdraw`. It must have no
owner URL or API secret references. **Proposal only:** ask the owner before adding
job/Key Vault/Azure resources; none are implemented here. Never exec a load inside
the running API Container App or add the loader secret to it.

For the recommended workstation route, use a private Bash shell without tracing
or recording, from the repository root. Set nonsecret `SUPABASE_PROJECT_REF`,
`RELEASE_FILE` (absolute read-only mount path) and `EVIDENCE_DIR` (a new private
operation directory). Use restrictive permissions and new filenames:

```bash
set +x
umask 077
set -o noclobber
unset DATABASE_URL DIRECT_URL
read -rs -p 'Loader URL: ' FACTOR_LOADER_DATABASE_URL
export FACTOR_LOADER_DATABASE_URL SUPABASE_PROJECT_REF
node infra/scripts/loader-identity.mjs
node infra/scripts/loader-command.mjs load --file="$RELEASE_FILE" --operator='Factor operations' > "$EVIDENCE_DIR/dry-run.json"
```

Require identity output
`PASS: current_user=tonyai_factor_loader; session_user=tonyai_factor_loader`
and a successful dry-run exit with `would_load` (or a reviewed `already_loaded`).
The identity checker and CLI both refuse the owner, runtime or member login.
`loader-command.mjs` invokes the built CLI from `apps/api`; at spawn it passes
only the loader URL and fixed nonsecret Node settings. This is not isolation
from environment files loaded later by Prisma: the checkout precondition above
is required. It captures raw diagnostics,
withholds them on failure, and prints only a successful JSON report. Do not run
or `tee` the raw CLI in a recorded shell: unexpected driver errors can contain
connection details. Keep successful reports private too (publisher/operator data).

**Stop and review the dry-run report before the next command.** Keep it as evidence
with the source SHA, file hash, project, endpoint, private secret version reference
and operator's **firm or role, never a person** (P8). On approval of that report:

```bash
node infra/scripts/loader-command.mjs load --file="$RELEASE_FILE" --operator='Factor operations' --apply --allow-remote > "$EVIDENCE_DIR/apply.json"
unset FACTOR_LOADER_DATABASE_URL
```

For an erratum add the same `--supersedes='<old edition>' --reason='<reason>'`
to **both** commands; the replacement's higher ordinal and old withdrawal commit
in one transaction. A withdrawal uses `withdraw --publisher='<publisher>'
--edition='<edition>' --reason='<reason>' --operator='Factor operations'`, first
without apply, then with `--apply --allow-remote`, retaining both reports.
There is no root wrapper (P9). Never use DIRECT_URL for a load: the CLI refuses it.

A nonzero exit, interrupted command, timeout (the wrapper bounds the child to
360 seconds), missing report or unexpected outcome means **stop**: an apply may
have committed before its response was lost. Disable/close the loader below,
reconcile through the owner, then repeat the [activation step at the start of
the load procedure](#load-or-withdraw-from-the-owner-workstation) only for a
reviewed idempotent retry with a fresh dry run. Never infer rollback from a missing report. After success,
disable/close it too, run the owner reconciliation check, verify the release via
`GET /api/v1/factors`, and retain both-role evidence. Users may need to save drafts
again; B2's stale-calculation refusal is required by the staging gate.

## Disable, rotate or revoke the loader credential

After **every** operation (successful, refused or interrupted), use the owner's
own login. Set NOLOGIN **before** closing existing sessions, in autocommit:

```sql
ALTER ROLE tonyai_factor_loader NOLOGIN;
SELECT pid, pg_terminate_backend(pid) AS terminated
  FROM pg_stat_activity WHERE usename = 'tonyai_factor_loader';
SELECT rolcanlogin FROM pg_roles WHERE rolname = 'tonyai_factor_loader';
SELECT count(*) AS open_loader_sessions FROM pg_stat_activity
 WHERE usename = 'tonyai_factor_loader';
```

Require every termination to succeed, `rolcanlogin = false`, and zero remaining
sessions; repeat the session check from a fresh owner transaction. NOLOGIN and
`VALID UNTIL` do not terminate open sessions. The role is cluster-wide, so do not
restrict termination to the current database. A pooled backend can outlive its
client. Require an explicit refusal of a fresh loader connection at the chosen
endpoint (private `psql -X -W` with strict libpq TLS as above); a network/TLS error
is not revocation proof. If cached authentication still works or termination is
refused, stop and resolve with the platform owner before declaring closure.
Record only sanitized outcomes, identities, counts and secret version references.

To rotate, first repeat the provisioning `pg_signal_backend` check and require
true before any LOGIN activation; otherwise stop with the platform owner.
Disable/terminate and verify closure as above. Save a **new**
private password-manager version, then owner-psql `\password tonyai_factor_loader`
and `ALTER ROLE tonyai_factor_loader LOGIN`. Prove the new version with
`loader-identity.mjs`; require an explicit authentication refusal for the **old**
password through a fresh strict-TLS session-pooler connection, followed by another
successful new-version identity check. Only then retire the old secret version.
Run the owner both-role check; disable/terminate again when finished. Do not retire
an old vault/password-manager copy as a substitute for revoking its DB password.
The API/runtime credential and release manifest do not change. After interruption,
recover forward with another private password reset, not an old secret selection.

For permanent revocation, disable and terminate first, then as owner
`ALTER ROLE tonyai_factor_loader PASSWORD NULL;`, verify fresh-login refusal and
retire its stored credential. Do not drop the cluster-wide role or its policies.
A new project requires provisioning again; a data-only restore carries no role
password. All these hosted steps remain **NOT RUN** until the owner records them.

## Owner draft clean-up

Any owner-approved draft/rejected-record clean-up uses the owner's **own login**
from selected `DIRECT_URL` via `owner-psql`, verifying `session_user = current_user
= postgres`. A dashboard session that `SET ROLE`s to the owner is insufficient:
the draft-delete guard reads `session_user` (TA006), whereas a committed record's
existing delete rule reads `current_user`. Do not bypass the guard, use the loader,
or disable triggers to clean up drafts. Preserve the audited record-lifecycle
procedure and never rewrite a committed snapshot.

## Rotate the runtime credential

Use a write-free maintenance window: new connections using the old password may
fail as soon as it changes. Supavisor may cache authentication; revocation is not
proved until a fresh connection with the old password is explicitly refused.
The owner `direct-url` stays unchanged. Follow this order:

1. Copy the last **deployed** manifest to `release-r002.json`, assign a new
   `release_id`, and retain both image digests, cleanup hold, sweep interval and
   backend version. Keep the previous manifest unchanged as evidence.
2. Generate a new `openssl rand -hex 32` password privately as in initial step 2.
   Save the old and new runtime URLs privately until revocation is verified.
   Store the new full URL at the hidden prompt, using the already-created manifest:

   ```bash
   python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name database-url
   ```

3. Select the returned exact runtime version in `release-r002.json` and freeze
   that manifest; the currently deployed release still selects the old version.
4. Validate the selected secret references and new URL before changing PostgreSQL:

   ```bash
   python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r002.json
   ```

   This is structural/project verification, not a runtime login test. An
   interruption here leaves the old deployed release and password usable.
5. Open `owner-psql` using the selected owner version. Run
   `\password tonyai_runtime` with the exact saved new hex string, followed by
   `ALTER ROLE tonyai_runtime LOGIN;`. Once this executes, an interruption needs
   forward recovery: old revisions may fail on their next database connection.
6. Immediately run **Runtime connection and privilege evidence** above using the
   new URL. Stop on any identity, login or privilege failure; repair forward
   through the private owner session before proceeding.
7. Deploy the new manifest through `deploy-apps.sh` (runbook 03).
8. Update the scheduled storage-verify job to the same digest/secret versions
   through runbook 06.
9. Repeat the full runtime identity/privilege check with PUBLIC warnings against
   the deployed version. Verify readiness, authenticated login/exports, bucket
   probes and storage reconciliation.
10. Probe the **old password** through a fresh Supavisor transaction connection.
    Use the project's actual host and enter the old saved hex password only at
    psql's hidden `-W` prompt (the arguments below contain no secret):

    ```bash
    PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/infra/certs/prod-ca-2021.crt" psql -X -W -h 'aws-N-eu-central-1.pooler.supabase.com' -p 6543 -U "tonyai_runtime.$SUPABASE_PROJECT_REF" -d postgres -c 'SELECT current_user, session_user'
    ```

    Require an explicit authentication refusal, not a network/TLS failure; prove
    the new URL still succeeds immediately afterwards. Record the old version ID
    and sanitized refusal outcome. If the old password still works, stop
    retirement and resolve Supavisor authentication caching/revocation with the
    platform owner; do not claim rotation complete.
11. Only after that refusal and all new-version checks, disable superseded runtime
    vault versions and clear both URLs from the terminal environment.

Rollback uses current credentials and runtime-qualified images. An interrupted
password change may require a second reset, new secret version and new manifest;
never assume that reselecting an old manifest restores a revoked password.

## Rotate the owner credential

In the secure Supabase provider session, rotate the hosted `postgres` password
under an owner-reviewed maintenance plan. Use the **currently deployed** manifest
(`release-r001.json` in this example); no new release is needed. Store only the new session URL:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r001.json --name direct-url
```

Record its exact version for future migrations and smoke fixture provisioning.
Verify a fresh `owner-psql` connection using that new exact version and the prerequisite queries above, then
retire the old owner vault versions. The runtime password, `database-url`, API
revisions and scheduled job stay unchanged. No application deployment or seed is
needed for owner-only rotation. If the provider reset revokes the old password
immediately, pause owner jobs until verification; preserve enough information
for a second reset after interruption. Never rerun initial setup to rotate keys.

## Rotate the backend key and deploy selected versions

For a backend-key change, retain the old provider key through verification if the
provider supports overlap. Copy the deployed manifest into a new immutable release
ID, retaining its digests and operational settings. Use hidden entry:

```bash
python3 infra/scripts/release_secrets.py store --inputs .infra-local/staging/release-r002.json --name supabase-service-role-key
python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r002.json
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r002.json
```

Each store prints only a validated Key Vault version ID; copy it into the new
manifest before verification. Strict URL checks reject wrong roles, projects,
regions, ports, query keys, TLS settings and CA paths. Backend keys require a live
exact-project probe. New release IDs create fresh revisions even with unchanged
images. Verify login, authenticated requests/new DB connections, both bucket
probes and the browser build; update the scheduled job through runbook 06 before
revoking old provider keys or disabling vault versions. Key-only rotation applies
no migrations. A legacy JWT/anon-key rotation changes compiled browser inputs:
rebuild the same qualified web source for the target/public key, select its digest,
and retain the deployed API digest unless explicitly promoting an API release.
Record references and results only.

## Roll back images

First prove the previous binaries can consume the current schema/data **and pass
the actual-image smoke under `tonyai_runtime` grants**. Pre-#147 images were not
qualified with that role and cannot be assumed compatible. Image
rollback does not undo migrations. Clone the last compatible release into a new
manifest, assign a new revision suffix, use its qualified API/web digests and
current enabled credential versions. If the web's embedded public key was revoked,
rebuild that compatible source for the current project/public key first. Record
the resulting digest and provenance. Run exact-version verification and
`deploy-apps.sh` with this manifest; repeat runbook 04. The newer candidate JSON
never participates automatically. Retain the failed release and recovery evidence.

## Recover backend state or a vault

For state recovery, stop all writers, inspect blob versions/lease metadata and
follow [the backend recovery procedure](../terraform/README.md). Reapply bootstrap
with identical identifiers after a recoverable partial operation; retain firewall,
Entra-only access, retention and deletion lock. To change deployer principals,
review/remove the old scoped assignments first; bootstrap does not remove old
principal grants automatically. Do not leave a stale principal with state access.

Key Vault purge protection prevents name-reuse shortcuts. Use the recorded vault
name, group and region; as owner inspect deletion metadata then recover it:

```bash
az keyvault list-deleted --query '[].{name:name,location:properties.location,id:id}' -o table
az keyvault recover --name '<recorded-vault>' --resource-group '<original-staging-group>' --location '<recorded-original-region>' --output none
```

**Current Sweden resources require `swedencentral`, matching the recorded original region. Never relocate a recovered vault.**

All old versions return too. Keep workload credentials revoked/traffic closed
until reconciliation; review secret **metadata** in the portal, disable stale
versions, restore RBAC and recreate fresh project-matched values with the helpers.
If Terraform state was lost, do not blindly import a recovered vault/app: first
review ownership, provider GET surfaces and absence of inline secrets. After
state reconciliation reapply foundation, then application through a reviewed
release. Never purge the vault, disable purge protection or grant broad runtime
secret access to make recovery easier.

Supabase DB backups do not contain Storage bytes. Protect evidence/import-source
objects, checksum inventory, bucket/Auth policies and release configuration.
RPO/RTO and retention are owner decisions; LP5-03 proves an isolated restore and
report reconciliation through the [database restore procedure and drill](04-verify.md#database-restore-procedure-and-lp5-03-drill)
in runbook 04. A state/vault restore alone is not disaster-recovery proof.
