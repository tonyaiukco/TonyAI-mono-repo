# 6. LP2-03 operational acceptance (owner-run)

These steps are procedures, **not evidence of cloud execution**. Record each
result against source SHA, API/web digests, migration hashes, environment, UTC
time and the named operator in B9. Use dedicated synthetic tenants and labelled
**DEMO — not authoritative** factors selected from a reviewed source/version;
never invent a factor or run the local demo seed in staging. Preserve audit rows.
The staging gate is open until the complete flow and recovery checks pass.

## Readiness and authenticated synthetic checks

`GET /api/v1/health` checks the running HTTP process. Readiness at `/health/ready`
uses runtime `SELECT 1` in a transaction (500 ms pool wait, 1,500 ms transaction,
1,000 ms statement timeout), plus authenticated metadata reads for both private
Storage buckets (2,000 ms fetch deadline). It returns generic 503 on failure and
has a 2,500 ms outer deadline and a five-second cache. A pending probe aged
10 seconds is abandoned for scheduling purposes; a later request can start a
replacement. At most two unresolved probes may exist per process. If both hang,
readiness stays false until one settles or the operator restarts the process. It reads no tenant rows, migration tables or privileged DB catalogues.
LP1-03 must run it using the **actual least-privilege runtime credential**; success
is connectivity proof, not a complete grant/isolation proof. Prisma connects on
Nest startup, so an initial DB outage can prevent HTTP boot; this existing limit
is not hidden by liveness. ACA startup/liveness use `/health`; readiness alone
uses `/health/ready`, avoiding dependency-triggered restart loops after boot.

Using a dedicated synthetic user's short-lived token in a private terminal,
request `/api/v1/health/synthetic`: expect 200. Repeat without a token and with an
expired/foreign-project token: expect 401. The normal global guard verifies the
token, profile and tenant grants; there is no separate bypass key. Run the same
login through the deployed web and verify `/me` and tenant-scoped data.

In an isolated staging rehearsal, deny DB connectivity to the already-running
API (owner-controlled network rule), then restore it. Repeat separately for
Storage. Allow up to 7.5 seconds for a cached success to expire and the next
probe deadline, plus the polling interval; record readiness 503 and liveness 200
through the in-process/container address (ACA ingress may remove unready replicas).
Confirm expected readiness 503s produce no error stack or Sentry event. Record no
restart loop and recovery on the next eligible probe after cache expiry. Rehearse
a hung connection separately: replacement is eligible once the flight is at least
10 seconds old and the cache expires. Two unresolved flights exhaust the cap;
prove recovery when one settles, or record the required operator restart. Do not weaken grants or
probe customer data to simulate failure. Also test a cold start with DB down.

## Scheduled Storage verification and operator delivery

After selecting the deployed API digest, add `config.monitoring` to the private
foundation input (all other foundation fields remain unchanged):

```json
{
  "operator_name": "<named operator>",
  "operator_email": "<operator email>",
  "api_digest": "sha256:<deployed API digest>",
  "supabase_project_ref": "<staging ref>",
  "database_secret_version": "<current runtime version>",
  "backend_secret_version": "<current backend key version>"
}
```

No default recipient is guessed. `runtime_secrets_ready` must be true. Owner
plan/applies the foundation through runbook 01; no GitHub settings or deployer
permissions change. Review that only the intended job/action group/alert changes.
The job uses the API identity's existing runtime-secret and ACR grants, runs at
02:00 UTC daily, with no retries and a 16-minute replica timeout. Its wrapper
runs `node dist/storage/reconcile.cli.js --verify --allow-remote`, with the hold
set, a 15-minute child deadline and a bounded output buffer. It emits only
`storage_verify` plus exitCode, never raw paths, report contents or child errors.
Exit 1 (including truncated coverage) and exit 2 require attention. No result in
26 hours also alerts, covering image pull, scheduling and timeout failures. The
missing-result alert fires from enablement until the first result is ingested;
run an initial verification and confirm ingestion when enabling monitoring.

Update these **pinned job references on every release and rotation**, before
retiring the old versions; application deployment does not update owner-managed
foundation resources. Keep the same runtime privilege checks as the API.

Start an on-demand execution using `az containerapp job start --resource-group
"$RESOURCE_GROUP" --name "$PREFIX-staging-storage-verify"`. Read execution status
and the structured result privately. Confirm the `ContainerAppConsoleLogs`
`JobName`/`Log` fields contain that execution before accepting the alert query;
Azure schema/ingestion behavior remains a live check. Use the Azure action-group
**Test** action and retain the named operator's received time/acknowledgement.
Then in the isolated synthetic rehearsal remove one synthetic object's bytes
while retaining its row: the next verify must exit 1 and the operator must
receive the alert. Restore the bytes, rerun and confirm clean verification.
Also exercise exit 2 and the missing-result condition. An email test alone does
not prove the job-to-alert chain. Do not publish raw Log Analytics output.

The alert stays active while a failed result remains in its 26-hour window;
record the clean rerun and acknowledgement instead of disabling the rule.
For triage, run the original reconciliation CLI in a private matching-image
shell and retain the report securely. Default coverage is 500 items per list;
truncation requires an explicit coverage plan with the storage owner.

## Error reporting and secrets

**No `SENTRY_DSN` in an environment holding real tenant data until the request,
breadcrumb and transaction protections below are deployed and the required
security review passes.** API event requests contain only method and queryless
URL; request headers, cookies, body and query are excluded, incoming body
buffering is disabled, and path tags lose the query. HTTP/fetch breadcrumbs are
dropped. API transaction telemetry is forced off, even if
`SENTRY_TRACES_SAMPLE_RATE` is set; do not enable tracing without a separately
reviewed real-SDK span privacy test. These guarantees do not sanitise arbitrary
exception messages or establish the web SDK's privacy properties.

Before enabling a real-data DSN, retain the real-SDK regression result for the
exact source SHA: it calls `initSentry()`, captures envelopes using a memory
transport, sends a real multipart request with synthetic Authorization/cookie,
query and file markers, raises an in-request 500 and calls Storage with an object
path/token. Assert that no marker and no transaction reach the envelopes, and
that the request contains only method and queryless URL. Repeat in isolated
staging with a dedicated synthetic tenant and a Storage-failure upload rehearsal;
privately inspect the resulting event and confirm the same fields are absent.
Use synthetic bytes and credentials only; no public crash endpoint is added.

For delivery, in a private owner shell using the built API image, provide the
isolated staging DSN through the approved secret channel and run
`node dist/observability/sentry-check.cli.js`. This fixed-message check fails if
disabled or flush times out. It proves neither request redaction nor receipt by
itself: confirm the event/release in Sentry and delivery/acknowledgement by the
named operator. Do not paste DSNs or event tenant data.

Exercise [runbook 05](05-rotation.md) in the isolated staging rehearsal: record
old references, store new versions, retain deployed image digests, verify exact
versions, deploy a new revision, update the scheduled job, then run readiness,
synthetic login and both bucket checks. Only then revoke old provider keys and
disable old Vault versions. Prove revoked credentials fail using a private
provider probe. Exercise an interruption after storing but before deployment:
old release remains selected; resume with the same new version IDs. DB passwords
without overlap require a write-free maintenance window and forward recovery.
Offline tests exercise release selection/readback; provider rotation and receipt
remain owner-run. LP1-03's runtime and migration credentials must rotate according
to their separate roles once that separation lands.

## Migration compatibility, rollback and full staging journey

1. Retain the previous qualified manifest, schema/migration hashes, enabled secret
   references and a consistent DB+both-bucket backup. Use runbook 04's hold and
   post-restore sequence. Record the compatibility decision for **each migration**.
2. On an isolated representative previous database, run the new migration chain
   with the owner-only migration credential. Keep previous binaries running and
   exercise reads/writes, evidence and reports against the new schema. Fresh
   migration replay/schema diff in CI is necessary but cannot prove binary/data
   compatibility. A separate read-only catalogue check must verify the exact raw
   unique index (including NULLS NOT DISTINCT and its voided predicate) in the
   replayed shadow database before either an empty diff or the exact known DROP
   representation can pass. The DROP is never executed. Rolled-back index
   mutations prove the guard fails closed. Prisma diff cannot
   see RLS policies, grants, CHECK constraints or triggers: retain `rls-probe`
   and `test:int` as their guards. If the old binary fails, choose a maintenance/forward-fix plan;
   never imply that image rollback restores a database.
3. Deploy the candidate digests. In dedicated synthetic tenants: login as author,
   create entry with the selected labelled factor, upload genuine valid evidence,
   submit, log in as a **different** super_admin to review/approve, then download
   and reconcile PDF/XLSX/CSV. Own approval and non-author submission must be
   refused; foreign-tenant IDs must remain inaccessible. Record fixture IDs and
   digest/SHA without passwords/file names. No broad cleanup or audit deletion.
4. Follow runbook 05 to select the previous **compatible** image digests with
   current enabled credentials and a new revision ID. Include explicit hold and
   sweep settings in every rollback manifest, preserving any incident hold; never
   clear it before runbook 04 report review and owner acknowledgement. Deploy/read back, repeat
   readiness and the authenticated journey. Record elapsed recovery time and
   preserved record/evidence/report state. Redeploy the candidate and repeat.
5. Record pass/fail, operator acknowledgement and unresolved gaps in B9. No other
   E2E may run during the exact-SHA release qualification window (runbook 03).

Resource contracts: [Container Apps jobs](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-01-01/jobs),
[log alerts](https://learn.microsoft.com/en-us/azure/templates/microsoft.insights/2023-12-01/scheduledqueryrules),
[console log schema](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/containerappconsolelogs).
