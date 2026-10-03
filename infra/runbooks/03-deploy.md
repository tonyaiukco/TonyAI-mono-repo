# 3. One versioned application deployment path

Restore the session/project variables (runbook 00). Keep infrastructure and image
source SHAs distinct. First create is owner-run; app-scoped OIDC deployment starts
only after both apps exist and runbook 01 grants their exact scopes.

## 3.1 Build and verify immutable images

Select a clean, reviewed source checkout. The script refuses dirty trees and a
SHA differing from HEAD. From that checkout, with restored foundation variables:

```bash
bash infra/scripts/build-images.sh '<image-source-full-sha>' .infra-local/staging/candidate-r001.json
```

Enter only the public anon/publishable browser key at the hidden prompt (obtain
it securely from Supabase). The script binds the key to the project via the Auth
settings endpoint, enforces disabled signup/providers, builds linux/amd64 images,
pushes them, records digests from **these build results**, pulls the exact web
digest, and scans its browser assets for privileged keys. It writes public
candidate provenance only after the scan passes, using exclusive file creation.
A failed scan leaves images unqualified; never promote their tags. Builds do not
change RG tags or application state. API may be promoted by digest; the web must
be rebuilt for each environment because NEXT_PUBLIC values are compiled in.

Copy the candidate's source SHA and both digests to the new release manifest;
verify its project and origins against the foundation contract. Release files
are immutable evidence: keep each version privately and create a new file and
`release_id` for later changes. Do not infer a selected image from a mutable ACR
tag or a newer candidate. For the initial release also fill the two exact Key
Vault version IDs from runbook 02. Never put the secret values into this file.

## 3.2 Deploy migrations separately

Run migrations from the clean checkout at the manifest’s image `source_sha`. The
helper checks HEAD and refuses a different chain. Node 22 and pnpm must be on PATH. Review the committed migration chain and compatibility with the
previous images before applying. No reset, seed, `migrate dev`, or down migration.

```bash
pnpm install --frozen-lockfile
pnpm db:generate
python3 infra/scripts/cloud_ops.py migrate --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF" --inputs .infra-local/staging/release-r001.json --direct-secret-version '<selected-direct-url-version>'
```

Expected: `prisma migrate deploy` then `prisma migrate status` succeed using
the explicitly selected session URL and the repo's Supabase CA. For initial setup,
select `versions.direct_url_version` from the journal; after rotation use its
recorded replacement version. The runtime version comes from the release manifest.
Both URLs currently share database-owner credentials; deploy access equals
database-owner access until LP1-03 introduces a separate runtime role. Both rotate
together. The helper is owner-run, but its DB authority is also available to the API.
Both URLs are validated before
Prisma starts. The child receives credentials through its environment; output is
captured/suppressed and errors never print URLs. Do not run on a shared shell host.
A failure requires owner inspection of migration history and a forward recovery
plan; don't re-run until the partially applied state is understood.

## 3.3 Verify exact secret versions and apply the application root

```bash
python3 infra/scripts/release_secrets.py verify --inputs .infra-local/staging/release-r001.json
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r001.json
```

The first command is **owner-only**. It reads exact versions into memory, verifies
enabled state, strict runtime TLS and backend-key project binding. The deployment
path itself requires no Key Vault data read: it takes IDs from the approved
manifest, plans/applies only Container Apps, then reads both apps independently.
Readback must match both digests, both exact secret references/identities, HTTPS
origins and ready revision IDs. Expected `PASS` for both apps. If Azure is still
converging, wait and run verification only:

```bash
bash infra/scripts/deploy-apps.sh --backend .infra-local/staging/backend.json --inputs .infra-local/staging/release-r001.json --verify-only
```

No readback failure is recorded as success. Do not restart arbitrary revisions
or use `az containerapp update/secret set/revision activate`: Terraform is the sole
application writer. Runbook 05 handles rotation/rollback with another manifest.
After the first creation, enable foundation `apps_ready` and apply the exact-app
OIDC grants per runbook 01. Preserve manifest, provider locks, infrastructure SHA,
image-source SHA, migration evidence and ready revision IDs for the release.

A successful Terraform apply is not a DB-backed smoke pass. Run runbook 04 and
LP2-02/03's actual image/login/export and readiness acceptance before release.

## 3.4 LP2-02 release sequence (D22/D23)

These are **owner-run instructions**, not recorded cloud evidence. Terraform is
still the only Azure application writer. LP2-01 cloud/fresh-recreation acceptance
remains open. LP2-02 is not DONE until the exact deployed candidate passes below.

### One-time owner setup

- Finish runbooks 00–02 and the first owner-created application deployment. Apply
  `apps_ready` grants and bind the existing OIDC app to `environment:staging` as
  runbook 01 requires. Never grant the workflow foundation, Key Vault data-plane,
  migration or backend-firewall administration permissions.
- Keep the `staging` environment required reviewers, prevent-self-review and
  **main-only** branch policy. Attest admin bypass is disabled (not readable via
  REST). The approval is a deployment security boundary: runtime DB credentials
  still have DB-owner authority until LP1-03.
- Configure a dedicated GitHub-hosted runner labelled `tonyai-staging-eu`, in an
  EU region with a static public IPv4, for the two staging workflows. Allow that
  exact `/32` through the existing state-backend bootstrap configuration. Do not
  open the firewall to all GitHub IPs or let the deploy job edit it. The workflows
  intentionally stay pending if the runner is absent; no runner is provisioned
  by this PR. Scope runner access to this repository's protected release jobs.
- Set public environment variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID`, `STAGING_PREFIX`, `STAGING_ACA_DEFAULT_DOMAIN`,
  `STAGING_ACR_NAME`, `STAGING_RESOURCE_GROUP`, `STAGING_SUPABASE_PROJECT_REF`,
  `STAGING_SUPABASE_PUBLIC_KEY` (publishable/anon only), `STAGING_BACKEND_JSON`
  (the validated backend config, identifiers and IPs only). Supabase stays in
  Frankfurt and Azure in Germany West Central. No backend key, DB URL, password,
  refresh token or Terraform state belongs in a workflow input/variable/artifact.

### Candidate → migration → approval → deployment

1. Merge with owner approval, then select a clean **main SHA**. Run full E2E on
   this SHA (`gh workflow run e2e.yml --ref main`); manual flow-changing PR runs
   remain required by D22. CI and E2E must both be successful on the exact SHA.
   A newer pending/failed run supersedes an earlier green run. Nightly evidence
   at another SHA cannot qualify this candidate.
2. Dispatch `candidate.yml` on main. Its protected staging job uses OIDC, builds
   both environment-bound images, labels their source SHA, pushes to ACR,
   retrieves these build-result digests, scans the exact web digest, and uploads
   `staging-candidate-<sha>` / `candidate.json`. It records the lockfile hash and
   every migration name/content hash. **This is build/scan evidence, not smoke.**
3. Download the candidate artifact from that successful run. Prepare the normal
   application release manifest from section 3.1, using the exact two digests,
   source SHA, target project, a new `release_id`, and exact secret version IDs.
   From the candidate's clean checkout run:

   ```bash
   python3 infra/scripts/candidate.py verify --sha '<full-sha>' --candidate .infra-local/staging/candidate.json --inputs .infra-local/staging/release-r001.json
   ```

4. Review migration compatibility with the previous release. Run section 3.2
   migration deploy/status and section 3.3 exact-secret verification as the
   owner. Attach sanitised results and direct-secret version ID to the release
   review. Neither workflow runs migrations or reads Key Vault values. Stop on
   a failed/partial migration; no seed, reset, or automatic database rollback.
5. Dispatch `deploy-staging.yml` on the **same main SHA**, supplying the successful
   candidate **run ID** and reviewed public release JSON. If main has advanced,
   build a new candidate; this workflow does not accept arbitrary checkout refs.
   Before approval, compare the manifest, candidate artifact, CI/E2E runs,
   migration/secret checks, schema rollback plan and backend runner IP. The job
   independently reads the candidate run's repository/branch/SHA/event/result,
   checks the immutable artifact archive hash, refuses unknown entries, and
   binds all provenance to the release and checkout **before Azure login**.
6. The protected job plans the application root into a private temporary file
   and applies that exact plan without replanning. Plan files are deleted and
   never uploaded. State stays in the Entra-authenticated application backend.
   Independent ARM readback checks ready revisions, digests, secret versions,
   managed identities and HTTPS origins. A failed readback stays failed; inspect
   convergence and use `--verify-only`, never imperative Azure app mutation.

### Qualify the actual deployed images

Use a trusted owner workstation with Node 22, pnpm, Python, the candidate's clean
checkout, generated Prisma client and Playwright Chromium:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @tonyai/shared-types build
pnpm exec playwright install chromium
python3 infra/scripts/cloud_smoke.py --candidate .infra-local/staging/candidate.json --inputs .infra-local/staging/release-r001.json --journal .infra-local/staging/smoke-r001.json
```

The public browser key is entered at a hidden prompt. Exact Key Vault backend
and DB versions go directly to process memory. The browser process receives
only synthetic account passwords and the public key; never DB/backend secrets.
Do not enable shell tracing, Playwright tracing, screenshots, debug logging or
HTTP body logging. The command suppresses child error payloads because browser
errors may echo credentials. It performs ARM readback before and after smoke.

Two new, UUID-bound, synthetic organisations/subsidiaries/super-admin users are
created specifically for this run. Application rows are created through Prisma
in one transaction, with one audit row per write. No factors or inventory values
are fabricated. Both tenants must pass browser login and PDF download,
authenticated PDF/XLSX/CSV bytes, own-tenant positive reads and foreign-tenant
negative reads via **both API and PostgREST**. The PDF starts Chromium inside the
actual API image. The web exercise tests its compiled project/API URLs and CORS.
This is smoke coverage, not the complete table-by-table RLS or lifecycle suite.

The ID-only journal is written **before** Auth creation. Each run closes browser
sessions, deletes only its exact Auth IDs after matching email and synthetic
metadata, then proves those IDs absent. Application rows and append-only audit
rows remain as labelled evidence; there is no broad cleanup or audit deletion.
Only after smoke, final ARM readback and cleanup pass is
`smoke-r001.json.passed.json` written, binding evidence to the candidate/release.
Retain it together with the workflow run IDs, release manifest and migration
results. No successful deploy workflow alone qualifies a release.

If interrupted (including a lost Auth-create response), keep the journal and run:

```bash
python3 infra/scripts/cloud_smoke.py --candidate .infra-local/staging/candidate.json --inputs .infra-local/staging/release-r001.json --journal .infra-local/staging/smoke-r001.json --cleanup-only
```

Cleanup attempts both exact accounts even if one fails; any mismatch/failure
keeps the command red. A cleanup-only run never emits passed-smoke evidence.
After cleanup, use a **new journal** for a fresh qualification attempt. No local
`db:seed`, `rls:probe`, E2E setup/teardown or demo credentials target cloud. The
RLS demo harness now refuses all non-loopback targets before its first request.

### Rollback and remaining proof

Use runbook 05's reviewed compatible-schema rollback manifest and the sole
Terraform writer. The automated path deliberately requires a current main
candidate; historical/secret-only rollbacks remain owner-run. Repeat exact-image
smoke after rollback. Preserve previous image digests and exact secret versions;
an image rollback cannot undo data migrations. Dependency readiness, DB-loss
probes and rollback rehearsal remain LP2-03; actual cloud execution and fresh
recreation remain owner evidence. Auth inventory/create/delete API responses,
OIDC, static runner access, provider apply and live browser behavior must still
be proven in staging.

Offline checks: `python3 -m unittest discover -s infra/tests -v`,
`node --test infra/tests/*.test.mjs`, the existing mutation/policy/Terraform suites,
plus root lint/typecheck/build/test. CI's `docker-build` now **loads and starts**
the actual linux/amd64 images against its isolated local Supabase stack and runs
startup/login/download/export smoke. Those localhost-bound web images are never
promoted to staging; staging's own digests require the owner-run smoke above.
