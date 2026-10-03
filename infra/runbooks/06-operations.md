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
has a 2,500 ms outer deadline, a five-second cache and one underlying probe per
process. It reads no tenant rows, migration tables or privileged DB catalogues.
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
Storage. Record readiness 503 within five seconds, liveness 200 through the
in-process/container address (ACA ingress may remove unready replicas), no
restart loop, and recovery after the five-second cache. Do not weaken grants or
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
26 hours also alerts, covering image pull, scheduling and timeout failures.

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

**No `SENTRY_DSN` in an environment holding real tenant data until this branch's
breadcrumb filtering is deployed and reviewed.** HTTP/fetch breadcrumbs are
removed before entering a later event. This check is a fixed synthetic message,
not a public crash endpoint. In a private owner shell using the built API image,
provide the staging DSN through the approved secret channel and run
`node dist/observability/sentry-check.cli.js`. It fails if disabled or flush times
out. Confirm the event/release in Sentry, absence of Storage URLs/keys/tokens in
breadcrumbs, and delivery/acknowledgement by the named operator. A successful
SDK flush alone is not delivery proof. Do not paste DSNs or event tenant data.

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
   compatibility. If the old binary fails, choose a maintenance/forward-fix plan;
   never imply that image rollback restores a database.
3. Deploy the candidate digests. In dedicated synthetic tenants: login as author,
   create entry with the selected labelled factor, upload genuine valid evidence,
   submit, log in as a **different** super_admin to review/approve, then download
   and reconcile PDF/XLSX/CSV. Own approval and non-author submission must be
   refused; foreign-tenant IDs must remain inaccessible. Record fixture IDs and
   digest/SHA without passwords/file names. No broad cleanup or audit deletion.
4. Follow runbook 05 to select the previous **compatible** image digests with
   current enabled credentials and a new revision ID; deploy/read back, repeat
   readiness and the authenticated journey. Record elapsed recovery time and
   preserved record/evidence/report state. Redeploy the candidate and repeat.
5. Record pass/fail, operator acknowledgement and unresolved gaps in B9. No other
   E2E may run during the exact-SHA release qualification window (runbook 03).

Resource contracts: [Container Apps jobs](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-01-01/jobs),
[log alerts](https://learn.microsoft.com/en-us/azure/templates/microsoft.insights/2023-12-01/scheduledqueryrules),
[console log schema](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/containerappconsolelogs).
