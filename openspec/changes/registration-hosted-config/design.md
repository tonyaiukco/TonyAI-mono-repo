# Design

## Context

See `proposal.md` for the motivation. What shapes the approach:

- Hosted QA (`tonyaiqt-staging`) is deployed by the **main** roots, `infra/terraform/foundation` and `infra/terraform/application`. The `qa/` siblings are the paused self-host route's independent copies, with their own contract scripts (`qa_contract.py`, `qa_expected.py`, `qa_release.py`, `qa_plan_contract.py`).
- The optional `mail` block is the precedent for an API secret a release may or may not carry, and every place it is wired is a place that refuses anything else:
  - `terraform_run.validate_release` refuses a manifest key other than its fixed set plus `runtime_limits` and `mail`.
  - `deploy_apps.verify` compares the live API's secret set **exactly** with what the release implies ("Unexpected runtime secret set"), and holds mail settings to the release through `verify_mail_environment`.
  - `release_secrets.py` stores and verifies a closed list of secret names; any name it does not special-case is validated as a Supabase backend key.
  - `foundation_contract.validate_foundation` refuses unknown foundation keys; the API's read grant is per secret, behind a `*_ready` flag (`foundation/access.tf`).
  - `qa_autodeploy.export_inputs` rebuilds the release from the live API and runs `deploy_apps.verify` on it, so a live secret it does not rebuild fails the export.
- `.github/workflows/deploy-qa.yml` changes image digests only: it patches a copy of the live template, so settings a Terraform apply put there persist across automatic deploys.
- The API itself (merged in #309) refuses to start with a code set over a placeholder notice unless `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT=true`, and with a code that is not exactly five letters or digits.

## Goals / Non-Goals

**Goals:**

- A release without a `registration` block behaves byte-for-byte as today: same plan, same readback.
- The registration code is never a value in a manifest, a Terraform variable, a plan, state, a log or an argument — only a secret version.
- A production release that allows the placeholder notice cannot be written.

**Non-Goals:**

- The self-host roots and their scripts. They do not run for QA or the pilot; carrying the block there is work for when that route resumes.
- Generating or distributing the code. The owner chooses it and shares it by hand.
- Any API, web, schema or image change.

## Decisions

### D1 — The manifest block

```json
"registration": { "code_secret_version": "<32-lowercase-hex>", "allow_placeholder_consent": true }
```

Optional as a whole; when present, exactly these two fields (as `mail` requires its exact set), the version matching `[a-f0-9]{32}` and the allowance a boolean. Both fields are required rather than defaulting the allowance: an explicit `false` in a pilot manifest is a statement someone reviewed, where an omitted field is not.

*Alternative:* two top-level keys — rejected: one is meaningless without the other, and a block makes "absent" one check.

### D2 — One module owns the rules: `registration_settings.py`

A sibling of `mail_settings.py`, holding `validate_registration(foundation, release)`, `registration_environment(release)`, `verify_registration_environment(items, release, kind)`, `validate_registration_code(value)` and the `REGISTRATION_ENV` name set. `terraform_run`, `deploy_apps`, `release_secrets` and `qa_autodeploy` import from it, so the shape of the block and of the code is written once in Python.

The code's shape (`[A-Za-z0-9]{5}`) is also written in `@tonyai/shared-types` (`REGISTRATION_CODE_PATTERN`). A unit test reads that source line and compares the two expressions, so the vault cannot hold a code the API would refuse to start on.

### D3 — The placeholder allowance is staging-only, checked twice

`validate_registration` takes the foundation and refuses `allow_placeholder_consent: true` unless `foundation.environment == "staging"`; the application root's variable validation says the same, so neither a hand-run `terraform plan` nor a script path gets past it. The API's own boot gate is the third layer and stays the only one that knows whether the notice is still a placeholder.

*Alternative:* bind the allowance to the hosted-QA exception tuple (subscription, group, prefix) — narrower, but it would have to be widened for any second staging environment and adds nothing against the risk that matters, which is production.

### D4 — Terraform: the mail pattern, one secret and two settings

In `application/variables.tf`: the optional `registration` object on `var.release` with its validation; `local.secret_versions` merges `registration-code = var.release.registration.code_secret_version` when present; a `local.registration_env` of `{ name = "REGISTRATION_CODE", secretRef = "registration-code" }` and `{ name = "REGISTRATION_ALLOW_PLACEHOLDER_CONSENT", value = "true"|"false" }` is concatenated into `api_env` and never into `web_env`. `main.tf` needs no change: it already builds the API's secrets from `local.secret_versions`.

The allowance is always set explicitly when the block is present (`"false"` included): the readback then compares one exact value instead of treating "absent" and "false" as equal.

### D5 — Foundation: an opt-in grant

`registration_secret_ready = optional(bool, false)` in `foundation/variables.tf`; `access.tf`'s per-secret list gains `"registration-code"` behind it, yielding a `secret-registration-code` Key Vault Secrets User assignment for the API identity; `foundation_contract.py` admits the key and requires a boolean. The owner already holds Secrets Officer on the vault, so storing needs nothing.

Order matters and the runbook states it: store the secret, then the foundation apply with the flag (the grant), then the application apply — a container app that references a secret its identity cannot read fails to provision the revision.

### D6 — Readback and export

`deploy_apps.verify` adds `registration-code` to the expected API secrets when the release names the block, and calls `verify_registration_environment` for both apps: on the API the two settings exactly as released (the code as `secretRef`, never a value; the allowance as its exact string), absent when the release has no block; on the web app always absent. The existing exact comparison of the secret set then covers the unreleased-secret case with no new code.

`qa_autodeploy.py` gains `live_registration(foundation, api)` beside `live_mail`: none of the two settings present → `None`; both present → the block, with the version parsed from the `registration-code` Key Vault URL under the reviewed vault; anything else is refused. `export_inputs` adds the block when it is not `None`.

### D7 — The owner's secret tool

`release_secrets.py`: `registration-code` joins `--name`'s choices; `store` and `verify` validate it with `validate_registration_code`, which refuses in a sentence that does not contain the value. It also refuses the development default the repository publishes (`local`, in `apps/api/.env.example` and `scripts/bootstrap.sh`): anyone who has read the repository knows it, and a test holds the refused set equal to what those two files publish. `verify` checks the version a release's block names like the others (present, enabled, identifier bound) and the PASS line says so.

The code is typed at the tool's hidden prompt, never pasted beside a command and never an argument: a five-character code is short enough to type, and the 2026-11-08 incident (a copied command overwrote a copied password) is the reason the runbook says so.

### D8 — Operating it

- **Rotate:** store a new version, release a manifest naming it under a new `release_id`, apply. The old code stops working when the new revision takes traffic.
- **Switch off:** release a manifest without the block. The secret and the grant may stay; nothing references them.
- **Close an unaccepted registration:** the existing `pnpm onboarding offboard`.
- **During the owner's release** the automatic deploy is disabled, as for every owner Terraform release (runbook 11), since it patches from a template it read before the apply. Disabling does not stop a run that has started, so the owner also waits until no deploy or rollback is running or queued before exporting the manifest.

## Risks / Trade-offs

- [A manifest written by hand could carry the code itself in a new field] → the exact-field-set check refuses any extra key, and the version pattern refuses a five-character value where 32 hex are required.
- [The grant exists before the secret is referenced, so a stale flag leaves an unused role assignment] → harmless; one scoped Secrets User assignment on one secret.
- [The self-host roots drift further from the main ones] → accepted while that route is paused; noted for its resumption.
- [The Python and TypeScript code patterns could diverge] → the D2 test pins them together.
- [An automatic deploy or rollback that is still running when the owner releases writes its older template back and removes the registration settings; disabling the workflow does not stop a started run, and Terraform is outside the workflow's concurrency group] → the runbooks require, after disabling and before the manifest is exported, that no `QA deploy` or `QA rollback` run is running or queued, and that a rollout is never cancelled part-way. The race is the existing deploy mechanism's; this procedure now guards against it.
- [A five-character code is guessable at scale] → an accepted owner decision of 2026-11-11 with its mitigations in the application; unchanged here.

## Migration Plan

1. Merge. Nothing deploys: the change touches no image-relevant path, so the automatic deploy skips it and QA keeps its release and settings.
2. Owner, with the automatic deploy disabled and no deploy or rollback run still running or queued: store `registration-code`; foundation apply with `registration_secret_ready = true`; export the live release, add the `registration` block and a new `release_id`; `release_secrets.py verify`; application plan, read, apply; `deploy_apps` readback.
3. Read back `GET https://api.qa.tonyai.io/api/v1/auth/registration` (200, placeholder true), re-enable the automatic deploy, register one company end to end.
4. Rollback: apply the previous manifest (no block). Registration is off again; nothing else moved.

## Open Questions

- Whether a local Terraform 1.13.3 binary is available for `terraform test` before the PR. If not, the application and foundation `tftest` runs are proven by the Infrastructure workflow on the PR instead, and the tasks say which.
