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
