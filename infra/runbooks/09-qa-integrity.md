# QA credential containment and clean rebuild after dashboard exposure

Use this procedure before connecting applications or introducing real data when
PD-3 generation provenance is unresolved. A successful dashboard credential
rotation addresses only that dashboard credential. It neither revokes other
potentially exposed credentials nor establishes prior database integrity. This runbook is a review plan, not authorization to query the live
DB, create a baseline, restore data or rebuild. Preserve the accepted host,
normal-reboot and credential-rotation evidence as distinct records.

## Evidence and route selection

The reviewed source is Supabase `self-hosted/v0.8.2`, commit
`564eab8ad7840b13324f68b1bfac074ef8d51c21`, with the repository's immutable
`linux/amd64` image lock. Twenty-four non-environment upstream source files were
checked locally against [the upstream lock](../selfhost/upstream.lock.json).
A trustworthy clean catalog/Auth baseline has **not been established** from the
available evidence. File listings alone cannot prove no such record exists.
The installed initializer historically differed from reviewed source; the current
initializer is not proof of what ran against the existing disks.

A bare PostgreSQL instance plus TonyAI Prisma migrations is insufficient. The
pinned Postgres image initializes intrinsic roles/extensions, mounted SQL creates
`_supabase`, `_realtime`, `_analytics`, `_supavisor` and webhook objects, and Auth,
Storage and Realtime apply their own migrations. An inactive Supavisor profile
does not imply its database schema should be absent. Expected privileged functions
and event triggers must be bound to source, not classified by name alone.

Primary planned route: **preservation decision → approved containment → clean
Sweden Central replacement with fresh credentials → old-credential rejection and
independent cutover acceptance**. This is a planning direction, not live approval.
I1 is supporting inventory only. I3 is an optional consistency investigation when
needed for preservation; it is not the primary route or a way to prove no secrets
escaped. Never reset, initialize or reuse the existing disks to make a comparison
match. A clean recreation contributes to LP2-01 evidence but does not by itself
complete that card, application QA or recoverability. Retain LP5-03's database +
file-byte restore and measured RPO/RTO launch blockers.

### Credential exposure scope and closure gate

PD-3 covers the potential DB-admin/Studio exposure during the historical public
challenge window, not just unknown dashboard password generation. The locked
`docker-compose.yml` supplies Studio with `AUTH_JWT_SECRET`, anon/service-role
keys, the Postgres password and pg-meta crypto material; pg-meta connects as
`postgres`. Locked `volumes/db/roles.sql` sets multiple service-role passwords
from `POSTGRES_PASSWORD`. These nonsecret source files were hash-checked against
`upstream.lock.json`; no live secret value was examined. For this exact upstream
version, `volumes/db/jwt.sql` sets **only `app.settings.jwt_exp`**, not
`app.settings.jwt_secret`. Do not cite the latter as an established DB storage
path. Service configuration proves distribution, not that an attacker extracted
any particular secret through Studio. Actual access/exfiltration remains unknown.

The repository initializer generates five-year legacy anon/service-role JWTs and
an ES256 private key. QA wiring supplies private signing keys to Auth and legacy
symmetric verification material to other JWT consumers. Current source does not
prove the installed initializer's provenance or any live credential's generation.
An anon JWT is intentionally public, but a known signed token permits offline
guessing of a weak HS256 signing secret; public delivery is not a strength check.
A leaked service-role token can remain usable against allowed REST/Storage paths
after dashboard rotation. Do not assume API JWKS mode disables HS256 elsewhere.

The remediation inventory must cover every credential reachable under the threat
model: dashboard; `POSTGRES_PASSWORD` and all derived/independent login passwords;
HS256 `JWT_SECRET`, legacy oct material in `JWT_KEYS`/`JWT_JWKS`, derived anon and
service-role tokens; ES256 private signing keys/kids; enabled storage/S3, pg-meta
and other runtime secrets; and any reachable external-provider or control-plane
credentials after an explicit scope assessment. Do not assume a credential is
safe because I1 did not return it. Public verification keys are not confidential,
but old verification trust must be retired. Session/refresh-token continuity,
crypto-key dependencies, recovery copies and every consumer belong in this plan.

There are two possible remediation paths, neither executed by this document:

- **Primary: clean replacement.** Trusted sources, fresh independent credentials,
  new empty disks, preservation/isolation of the old environment, and verified
  rejection of old credentials on every active consumer and old endpoint.
- **Exceptional in-place path:** separately approved comprehensive credential
  rotation/revocation, trusted-source/host assurance and complete reconciliation
  under containment, with independent acceptance. Dashboard-only rotation or I3
  alone cannot meet this gate. HS256 rotation is unrehearsed (#175 question 11);
  require a tested consumer/ordering/rollback design before selecting this path.

A catalog comparison cannot detect stolen secrets or prove absence of malicious
history. It can at most establish scoped consistency with a trusted reference.
Potentially live old credentials must not be allowed to mutate data during or
after comparison. Old-key acceptance, an unexplained delta, incomplete credential
coverage or inability to establish host trust keeps PD-3 **OPEN**.

## I1: bounded catalog inventory

The [inventory helper](../scripts/selfhost_integrity_inventory.py) connects only
to `postgres` through the existing container's local Unix socket. The current format-2 helper emits twenty-one
catalog counts (including `login_event_triggers`) and three booleans indicating regular/partitioned relations named
`auth.users`, `storage.objects` and `public._prisma_migrations`. It does **not**
read their rows, count Auth users, list identities, inspect function bodies,
return password fields or business/object content. The server still reads catalog
rows to calculate aggregates; “not returned” is not “never read internally”. Counts are observations,
not expected clean values. A relation's presence does not prove its contents or
migration history. `_supabase` and other databases are not inspected by I1.

Every successful report explicitly returns `integrity_verdict=NOT_ASSESSED`,
`pd3=OPEN`, `baseline_compared=false`, and `safe_to_discard_data=false`, even if
all counts are zero. It rejects unknown/missing/duplicate JSON fields and wrong
scalar types instead of forwarding unexpected values. A successful execution
means collection completed, never that integrity passed. Catalog replies from a
potentially modified database are evidence to reconcile, not a trusted oracle.

Before requesting I1 approval, bind the exact source SHA256, private deployment
contract, VM resource ID, Sweden Central region, tenant/subscription, strict SSH
trust and maintenance window. Verify the QA resource group/name and locked DB
image. Install a separate nonsecret private `target.json` containing only the verified
QA environment, resource group, VM name and public hostname. The existing
`/etc/tonyai/host.json` is only required to contain its documented public hostname;
never add deployment fields to that live file for this procedure. The helper
checks the private QA binding against the installed hostname, container name,
project/service labels, exact image, running state and absence of published DB
ports, then executes against that exact container ID. Azure identity/location
and host provenance are separate operator checks; the helper does not prove them.

The complete bounded operation to approve is:

1. Recheck target and source hashes without reading credentials. Install only the
   reviewed helper and its hash-bound private `target.json`, both root-owned mode
   0600 under a new root-owned mode-0700
   `/usr/local/lib/tonyai/integrity-inventory-v2` directory; refuse an existing
   destination. Verify both installed hashes before execution. No runtime source,
   image, firewall, state or application configuration is replaced.
2. Run `sudo /usr/bin/python3 -I -B
   /usr/local/lib/tonyai/integrity-inventory-v2/selfhost_integrity_inventory.py` over
   the existing strict SSH connection. Keep stdout in a new owner-only local
   evidence file; never overwrite prior records. This command is one logical
   shell line. No output file or helper state is written on the host by the script.
3. The fixed command uses Docker's local socket, `exec --user postgres -i`,
   `env -i`, `psql -X -qAt -w`, `PGPASSFILE=/dev/null`, explicit socket/user/database
   and `ON_ERROR_STOP=1`. Password-file lookup is disabled; failed socket access
   stops the procedure rather than prompting for, retrieving or creating a
   credential. SQL comes from reviewed source through stdin, never database names
   substituted into a shell or SQL statement.
4. Connection startup requires `PGOPTIONS` with `-c event_triggers=off`, before
   PostgreSQL login triggers can run. This setting needs superuser or explicitly
   granted SET privilege; rejection stops the connection, with no weaker retry.
   The query also requires `event_triggers_disabled=true` in the strict format-2
   output. Count `evtevent='login'` separately; never execute those triggers to
   inspect them. Session defaults require read-only and `search_path=pg_catalog`; SQL starts
   `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` and ends `ROLLBACK`.
   Statement timeout is 5 seconds, lock timeout 1 second, idle-in-transaction
   timeout 10 seconds, and the outer subprocess timeout 25 seconds. No service
   restart or planned outage is included. Catalog reads still consume resources
   and can acquire locks; ordinary connection/logging activity is possible.
5. Recheck container identity/running status after collection. On timeout,
   authentication error, changed identity, unsupported version or invalid output,
   stop without retrying with wider privileges or relaxed guards. A disconnected
   client rolls back; the server idle timeout bounds a stranded transaction.
   Preserve status-only failure evidence. No database rollback/repair command is
   needed because no database change is intended.

I1's local test suite uses synthetic payloads and mocked subprocesses. Those tests
do not qualify live SQL syntax, socket authentication, privileges, image paths or
runtime latency. Record a separately approved live execution and its limits in
the B9 evidence; one accepted run does not qualify future hosts or full integrity. Failures are not permission to modify the database or bypass a guard.
Read-only SQL is not a sandbox against arbitrary extension/OS activity; the
collector does not intentionally invoke user-defined functions or restore source
SQL. A tampered catalog/view or server can still execute unexpected code.
The accepted 2026-10-15 I1 execution used format 1 and did **not** include the
startup event-trigger suppression or separate login-trigger count. Preserve its
original hash/report and limits; the new format-2 source is local-only, not deployed
or rerun. A future run needs a new package/approval and a new versioned destination,
not an overwrite of the accepted source. Disabling event triggers still does not
make a potentially modified server trustworthy. See PostgreSQL
[login-event behavior](https://www.postgresql.org/docs/17/event-trigger-definition.html)
and [event_triggers setting](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-EVENT-TRIGGERS).

See [PostgreSQL transaction semantics](https://www.postgresql.org/docs/17/sql-set-transaction.html),
[psql startup controls](https://www.postgresql.org/docs/17/app-psql.html) and
[password-file lookup](https://www.postgresql.org/docs/17/libpq-pgpass.html).

## I2: primary clean replacement plan (separate design/apply approval)

### Preservation and containment before provisioning

I1 cannot decide whether disks are disposable. Absence of a regular/partitioned
`public._prisma_migrations` table does not prove that TonyAI was never installed,
that no business data exists, or that all other schemas/databases are empty.
Obtain an explicit owner preservation decision; if needed, prepare a separately
reviewed and approved I1b returning only bounded row counts from named tables.
Even zero rows cannot establish the absence of files, secrets or relevant history.
No I1b is implemented or authorized here. Keep current database/object disks and
escrow intact and isolated under an approved retention/access plan; never detach,
stop, snapshot, export, delete or alter network access without concrete approval.

Containment is a prerequisite of the later cutover, not an assumed completed
step. The concrete package must block old REST/Storage/admin access and unwanted
outbound paths while retaining the approved operator `/32` and required evidence
access. Include the old public hostname/IP: a new DNS name does not disable the
old endpoint. Isolate old identities and recovery access as appropriate; revoke
reachable external credentials at their issuers. Specify maintenance impact and
exact resource/rule changes for approval. No containment is applied by this plan.

### Fresh trusted replacement in Sweden Central

Use a separately scoped **Sweden Central** replacement host, new empty database
and object disks, trusted digest-bound images, reviewed source/configuration and
fresh independent credentials for the entire inventory above. This replacement
is intended to become QA after acceptance; a separate comparison-only host and
full I3 comparator are not mandatory intermediate deliverables. Do not use the
Claude lane's local Supabase, old mounted filesystems, old runtime environment,
physical DB copy or an unreviewed live dump as the new baseline. New generation
must have recorded source provenance and private exact-version recovery escrow.

Before provisioning, prepare the exact resource names/IDs, subscription/tenant,
state ownership and import/handoff boundaries, SKU availability in Sweden Central,
current temporary overlap and steady-state cost, identity/network isolation,
existing operator `/32`, constrained egress and mail/webhook suppression. Do not
run the current selfhost root with duplicate staging names or create parallel
state. A separate resource/state arrangement is a proposal only until approved.
Keep application/data co-located; no other-region fallback or production resources.
Unverified credits cannot fund the estimate. Namecheap remains deferred; bind the
new verified Azure hostname/origin explicitly if replacement changes it.

Review initializer/runtime provenance before use; do not treat the repository
initializer as deploy-ready merely because it differs from the historical one.
Record intrinsic Postgres initialization and pinned Auth/Storage/Realtime
migrations. Apply only a newly approved TonyAI migration chain under the API/DB
lane's slot, not speculative reconstruction from an absent migration table.
Runtime/migration roles, bucket policies and application acceptance remain open.

### Selective preservation, credential retirement and cutover

If data must survive, first design a separate reviewed allowlist export/import and
object-byte verification path. Do not restore old roles/grants/functions/triggers,
Auth sessions/refresh tokens, server settings or signing material wholesale into
the clean host. Potentially executable dump content is not trusted by being
schema-only ([PostgreSQL dump warning](https://www.postgresql.org/docs/17/app-pgdump.html)).
For encrypted data, preserve old decryption material under controlled custody and
plan decrypt/re-encrypt with new keys; do not lose old `pgsodium_root.key` or reuse
it silently while claiming fully fresh credentials. Auth-user migration, if
required, needs a separate identity/session/reverification decision.

Acceptance must prove fresh provenance/custody and old-credential rejection by
all active JWT/DB/storage consumers, including legacy HS256/oct and ES256 keys,
service tokens and sessions. Test old/new behavior only through separately
approved secret-safe helpers, never by printing or handing credentials to an
agent. Revoke old trust and contain the old host; merely disabling a vault version
or switching DNS is not credential revocation. Retain old escrow for approved
forensic/recovery use separately from active startup/restore selection.

The cutover plan must identify writers, origin/redirect/certificate changes,
verification order and a maintenance window. Safe rollback is a stopped or
contained new deployment with preserved evidence; never re-expose the old trust
domain or silently accept old credentials to regain availability. A data rollback
is separately designed and approved. Independently review the exact recreation,
secret-consumer coverage, old-endpoint containment and cutover evidence before
PD-3 closure. This can support repeatable foundation evidence, but does not replace
LP2 application QA or DB + file-byte restore and measured RPO/RTO.

## I3: optional private consistency comparison (cannot close PD-3 alone)

This optional collector is **not implemented by I1** and is not the primary
rebuild route. Even a complete match is only scoped consistency evidence, not an
integrity PASS or proof of no credential disclosure. Its exact queries, output policy,
comparison rules and tests must be reviewed before a separate live approval.
Keep all differences and identities private. Do not collect password hashes,
tokens, private keys, connection strings or arbitrary settings/function text into
agent output. Definition comparison should emit reviewed fingerprints; a differing
fingerprint is unresolved until a separately controlled, secret-safe review
explains it. Matching fingerprints alone do not establish source trust.

| Coverage | Required comparison and limits |
| --- | --- |
| Roles | Memberships, admin options, owners, LOGIN/SUPERUSER/BYPASSRLS/CREATEROLE/REPLICATION and connection limits; no password fields |
| Grants | Object/column ACLs, default privileges, PUBLIC grants, function EXECUTE, schema CREATE/USAGE and ownership; include implicit privilege semantics |
| Extensions | Exact version, schema, owner, extension membership and procedural languages; do not hide all extension-owned differences |
| Schemas and relations | All connectable databases including `_supabase`; tables/views/materialized views, constraints/indexes, RLS enable/force and policies |
| Functions | Identity/signature, language, owner, SECURITY DEFINER, search-path behavior and body fingerprint; never execute a suspect function to test it |
| Triggers | Table and event triggers, enabled states, referenced functions and rewrite rules; legitimate upstream hooks require source evidence |
| Auth users | Private reconciliation of users/identities, privileged accounts, sessions/MFA and outstanding token-state aggregates; no tokens/password hashes/emails in agent output. Zero counts are insufficient |
| Auth settings | Allowlisted signup/provider/redirect/issuer/session/lifecycle values; unknown options are unresolved, not silently dropped. SMTP choice remains open |
| Persistence and outbound access | Relevant role/database/server settings, replication, publications/subscriptions, FDW/server/user-mapping presence, scheduled jobs/webhooks; credentials/endpoint details stay private |
| Storage and host trust | Bucket privacy/policies, object metadata versus file bytes, persistent DB/host configuration, mounted source and image provenance; catalog equality alone cannot exclude other persistence |

Normalize only enumerated nondeterministic fields with an explicit reason (for
example OIDs, generated credentials or an approved reference-origin substitution).
Do not exempt whole schemas/functions or treat current live settings as an
approved baseline. Historical synthetic Auth smoke may leave legitimate history;
it must be traced to accepted evidence rather than erased or dismissed.

Every required category must have complete coverage, reference provenance,
consistent capture boundaries and independent disposition of each difference.
Timeout, missing database, redaction gap, unreadable data or an unexplained delta
means **INCONCLUSIVE**, never PASS. If credentials or source trust may have been
compromised, widen containment/rebuild decisions explicitly with the owner; do
not claim a catalog diff proves no historical access or disclosure occurred.

Close PD-3 only after independently accepted **clean replacement with fresh
credentials and old-trust retirement**, or the explicitly selected exceptional
comprehensive rotation/revocation and trusted-host reconciliation path above.
Both require preservation/containment and complete credential-consumer acceptance;
dashboard credential rotation/custody and I3 consistency alone are insufficient.
Historical access/exfiltration uncertainty remains recorded. This does not close
application QA, SMTP/domain, rollback, missing-disk, OS-loss or database/file-byte
restore/RPO/RTO gates. Keep LP2-01/02/03 INTEGRATED, not DONE, and carry all #175/#178
Open questions forward in B9.
