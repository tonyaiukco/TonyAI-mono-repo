# Proposal

## Why

Self-service registration is merged and deployed (#309, `ci43-1`), but it is off on every hosted environment and cannot be turned on: the API reads its switch, `REGISTRATION_CODE`, from a setting no release can carry. The release tooling refuses what it does not know — an unknown key in the release manifest, an unlisted secret on the live API — so the code has to be taught to the whole release path at once before QA can register a company.

## What Changes

- The release manifest gains an optional `registration` block: the exact Key Vault version of a `registration-code` secret, and whether the environment allows the placeholder KVKK notice. Absent, a release plans and deploys exactly as today.
- The application Terraform root turns the block into the API's two settings: `REGISTRATION_CODE` as a Key Vault reference by exact version, and `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT` as a plain value. The web app receives neither.
- **The placeholder allowance is refused outside staging**, in the manifest validation and again in Terraform, so a production release cannot be written that opens registration over the placeholder notice.
- The foundation root gains an opt-in grant: the API's identity may read the `registration-code` secret once the owner says the secret exists.
- The owner's secret tool stores and verifies `registration-code`, accepting only a code of the shape the API accepts (exactly five letters or digits).
- The deploy readback expects the secret and the two settings exactly when the release names them, and refuses them when it does not.
- The live release export (`qa_autodeploy.py inputs`) rebuilds the `registration` block from the live API, so a later rollback or probe sees the release that is running.
- Runbook steps: choose and store the code, grant, release, verify, rotate, switch off, and close an unaccepted registration.
- The owner applies it to hosted QA and registers one company end to end on `https://qa.tonyai.io/register`.

Out of scope: the paused self-host roots (`infra/terraform/application/qa`, `infra/terraform/foundation/qa`) and their contract scripts, which stay untouched; a `register.<env>` hostname; the reviewed KVKK notice; enabling registration on the pilot; expiry or purge of unaccepted registrations; any change to the API or the web app.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `self-service-registration`: adds how a hosted environment enables registration — through its release, by exact secret version — and that the placeholder allowance cannot be released outside staging.
- `qa-release-operations`: adds the registration block to the live release binding, and the readback's refusal of registration settings that differ from the release.

## Impact

- **Terraform:** `infra/terraform/application/{variables.tf,security.tftest.hcl}`; `infra/terraform/foundation/{variables.tf,access.tf,security.tftest.hcl}`.
- **Scripts:** a new `infra/scripts/registration_settings.py`; `terraform_run.py`, `deploy_apps.py`, `release_secrets.py`, `foundation_contract.py`, `qa_autodeploy.py`.
- **Tests:** a new `infra/tests/test_registration_settings.py`; additions to `test_qa_autodeploy.py`; two mutants in `check_mutations.py`.
- **Config and docs:** `infra/config/application.example.json`, `infra/README.md`, runbooks `01-azure.md`, `03-deploy.md`, `04-verify.md`, `11-qa-hosted.md`; `docs/architecture/security.md`; the planning file.
- **Hosted QA (owner-run):** one new Key Vault secret, one foundation apply (a role assignment), one application apply (a new API revision). No database change, no image change, no DNS or certificate change.
- **Deploy on merge:** the change is under `infra/`, so merging it rebuilds and redeploys QA's images with the configuration unchanged; registration stays off until the owner's release.
- **Review:** secrets and deploy tooling — `security-rls` and `qa-auditor` review the diff before the PR.
