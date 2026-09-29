# 2. Owner-run Supabase staging setup

First [restore the Bash session](00-session.md) from the Azure foundation. Every dashboard step
below is part of recreation, even when there is no CLI command. Record settings
and pass/fail results only; crop credentials from any evidence before saving it.

## 2.1 Create and isolate the project

In the intended Supabase organisation, create **tonyai-staging**, region
**Central EU (Frankfurt), `eu-central-1`**. Generate a unique database password in
the owner's password manager; never use a local/demo password. Keep it in the
approved secure store, never in repository/env files or screenshots. Select the
owner-approved plan; a free project can pause while idle, so active UAT needs a
plan/availability decision. Wait for project health to become ready.

```bash
export SUPABASE_PROJECT_REF='<20-letter-project-ref>'
export SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
az group update -n "$RESOURCE_GROUP" --set "tags.supabaseProjectRef=$SUPABASE_PROJECT_REF" --output none
```

Expected/evidence: project ID, name, region, plan and healthy status. Existing
local/dev and production projects are untouched. On recreation create a new
isolated project (new ref/password/keys) and rebuild the web for its new inputs.

**Never run `supabase link` or `supabase config push` from this checkout against
staging.** Local `supabase/config.toml` enables signups and localhost redirects;
pushing it would undo cloud controls. These runbooks configure cloud separately.

## 2.2 Auth settings (before exposing apps)

In Authentication settings:

- Disable **Allow new users to sign up** and anonymous sign-ins. Disable providers
  not used for the pilot. Provision controlled users only through approved owner
  onboarding; no local fixture accounts.
- Configure an asymmetric JWT signing key (ES256 or RS256) as current. Verify the
  project's JWKS endpoint advertises it. Never switch the API to `auto` or `hs256`
  to repair a failed cloud login.
- Set Site URL to the exact `$WEB_ORIGIN`. Redirect allowlist: only
  `$WEB_ORIGIN` and `$WEB_ORIGIN/login` for the current release, with no wildcard,
  localhost or preview origins. LP4-01/LP2-04 must add their actual invitation and
  reset callback routes when implemented; this release has none to invent.
- Evaluate database network restrictions against ACA's actual egress addresses
  and the owner's migration access. This default Consumption environment has no
  fixed outbound IP; do not install an allowlist that strands new replicas.
  Record the current restriction setting and accepted staging exposure. Static
  egress/private networking is a separate owner decision, not a claimed control.

```bash
curl --fail --silent --show-error "$SUPABASE_URL/auth/v1/.well-known/jwks.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); a=[k.get("alg") for k in d.get("keys",[])]; assert a and all(x in ("ES256","RS256") for x in a); print("PASS: asymmetric JWKS published")'
```

Expected/evidence: signup/anonymous sign-in disabled; exact Site URL/allowlist;
JWKS check passes. The live public-key/Auth probe below must pass too; dashboard
inspection alone is insufficient. Redirect URLs are not exposed by that endpoint
and still require separate dashboard evidence. Do not save keys or full Auth dashboard exports. Email delivery
is LP2-04; this configuration alone does not prove invitations/password resets.

## 2.3 Store credentials in Key Vault

In the Azure portal, open `$VAULT_NAME` → Secrets. Add enabled secrets directly
using secure copy/paste. Never use `az ... --value <secret>` or a local env file.

| Secret name | Value selected privately by the owner |
|---|---|
| `database-url` | Project Connect → **Supavisor transaction** URL, port **6543**, database `postgres`; add `pgbouncer=true`, `sslmode=require`, `sslaccept=strict`, `sslcert=/app/infra/certs/prod-ca-2021.crt`, and a bounded `connection_limit=5`. |
| `direct-url` | Project Connect → **Supavisor session** URL, port **5432**, database `postgres`; add `sslmode=require`, `sslaccept=strict`, `sslcert=/app/infra/certs/prod-ca-2021.crt`. This is for owner-run Prisma migrations. |
| `supabase-service-role-key` | This staging project's separately rotatable **`sb_secret_` backend key** (preferred); a legacy service_role key is supported but has coupled rotation, used only by the API/owner Storage calls. Never the local demo key. |

Take the exact pooler host from Connect (do not guess the `aws-N-...` segment).
Only `aws-N-eu-central-1.pooler.supabase.com` is accepted. Both usernames end in `.<project-ref>`. URL-encode special characters in the
password privately. Do not use the IPv6-first direct database hostname. Runtime
initially uses the project's owner-backed Prisma path as the baseline does; its
privileges do **not** prove end-user RLS containment. LP1-03 verifies the intended
runtime privileges; do not invent a restricted DB role without migration review.
The API's `DIRECT_URL` resolves to `database-url` for schema compatibility; only
the migration runner receives the session URL from `direct-url`. Both URLs are
validated before Prisma runs; the runner rewrites only the CA path in memory to
this checkout. The public [bundled CA](../certs/README.md) is included by the
existing API Dockerfile. Compare it to the project's CA before use; never bypass
a certificate failure. Strict Supavisor handshakes still require owner evidence.
The installed supabase-js supports opaque secret-key transport; live acceptance
is checked by the bucket probes. The environment name remains
`SUPABASE_SERVICE_ROLE_KEY` for compatibility. Follow [rotation](05-rotation.md)
for either key scheme.

```bash
az keyvault secret list --vault-name "$VAULT_NAME" --query '[].{name:name,enabled:attributes.enabled}' -o table
az deployment group create -g "$RESOURCE_GROUP" -n lp2-secret-access --template-file infra/azure/secret-access.bicep --parameters prefix="$PREFIX" --query properties.provisioningState -o tsv
```

Expected/evidence: three enabled names, no values; access deployment `Succeeded`.
Only API can resolve `database-url` and `supabase-service-role-key`. Web and GitHub
receive no direct secret-reading role; API cannot read `direct-url` through RBAC.
Wait for RBAC propagation before running later steps.

## 2.4 Machine-check Auth before proceeding

```bash
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_API_BASE_URL="$API_ORIGIN/api/v1"
read -r -s -p 'Paste staging public browser key: ' NEXT_PUBLIC_SUPABASE_ANON_KEY
printf '\n'
export NEXT_PUBLIC_SUPABASE_ANON_KEY
python3 infra/scripts/check_browser_key.py
unset NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Expected: public URL/key accepted by this project and `/auth/v1/settings` asserts
signup disabled, anonymous/phone/SAML/passkeys off, email enabled and every unused
provider off. Missing controls fail closed. A publishable key has no project claim;
its project binding is established by this live request, not its prefix.

## 2.5 Deploy the schema; create and verify buckets

Review committed migrations before execution. On a fresh project run the full
chain, never generate migrations or seed demo data. For an existing environment,
arrange a maintenance window and verified DB/file backup first: the historical
evidence many-to-many migration is incompatible with older images. An image
rollback cannot reverse that schema change.

```bash
bash <<'BASH'
set -euo pipefail
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
python3 infra/scripts/cloud_ops.py migrate --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF"
python3 infra/scripts/cloud_ops.py buckets --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF"
python3 infra/scripts/cloud_ops.py probe-storage --vault "$VAULT_NAME" --project-ref "$SUPABASE_PROJECT_REF"
BASH
```

Expected/evidence: migration deploy **and status** pass; two reconciled private
buckets; upload/public denial/60-second signed-download byte comparison/cleanup
pass for each. Rerun `buckets`: same settings, no duplicate buckets. The probe
creates only uniquely named disposable CSV objects. If interrupted, inspect the
`lp2-foundation-probe/` prefix and remove only this run's orphan probe objects.

In Supabase SQL editor run [verify.sql](../supabase/verify.sql). Expected: zero
unfinished migrations, zero demo/Auth users and factors on a fresh project; exactly two
private buckets with their MIME/size limits; zero `storage.objects` policies and
no returned public tables with RLS disabled or forced. Review the anon/authenticated/
public policy inventory against committed migrations, including SELECT-only scope. Preserve default-deny object access:
**do not add browser `authenticated` or `anon` Storage policies**. The API's service
role bypasses Storage RLS after app tenant authorization; table RLS comes from the
committed Prisma migrations. If any query disagrees, stop before application use.

No factor-only safe seed exists at this baseline: leave factors empty (the UI
will correctly report missing factors) until LP4-02 or separately approved
labelled UAT fixtures. Never present prototype factors as authoritative.

Sources: [Prisma and Supavisor](https://supabase.com/docs/guides/database/prisma),
[Storage access control](https://supabase.com/docs/guides/storage/security/access-control),
[Auth redirects](https://supabase.com/docs/guides/auth/redirect-urls).
