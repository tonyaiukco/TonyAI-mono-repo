# Tasks

## 1. Release contract

- [x] 1.1 Add `infra/scripts/registration_settings.py` with the block validation (exact field set, 32-hex version, boolean allowance, staging-only allowance), the code-shape validator, the API environment it implies and the `REGISTRATION_ENV` names; verify with new unit tests in `infra/tests/test_registration_settings.py` for each acceptance and refusal, including that no refusal repeats a submitted value
- [x] 1.2 Admit the optional `registration` key in `terraform_run.validate_release` and call the validation with the foundation; verify by tests that a release without the block is accepted unchanged, one with it is accepted on staging, a production release allowing the placeholder is refused, and an unknown key is still refused
- [x] 1.3 Add a test that the Python code pattern equals `REGISTRATION_CODE_PATTERN` in `packages/shared-types/src/index.ts`; verify it fails when either expression is changed
- [x] 1.4 Add the block to `infra/config/application.example.json` and describe it in `infra/README.md`; verify the example passes `validate_release`

## 2. Application Terraform root

- [x] 2.1 Add the optional `registration` object and its validation to `var.release`, the `registration-code` entry to `local.secret_versions` and the two settings to `api_env` only, in `infra/terraform/application/variables.tf`; verify `terraform fmt -check` and `terraform validate` pass
- [x] 2.2 Add `security.tftest.hcl` runs: absent block leaves no registration setting and no secret; present block gives the API the exact Key Vault reference and both settings and the web app neither; a malformed version is refused; a production release allowing the placeholder is refused; verify `terraform test` passes for the application root

## 3. Foundation grant

- [x] 3.1 Add `registration_secret_ready` (default false) to `foundation/variables.tf` and the `registration-code` grant to `foundation/access.tf`; verify by `security.tftest.hcl` runs that the default plans no new grant and the flag plans exactly one Secrets User assignment for the API identity on that secret
- [x] 3.2 Admit and type-check the flag in `foundation_contract.py`; verify by tests that a boolean is accepted and any other value or an unknown key is refused

## 4. Readback, export and the secret tool

- [x] 4.1 Hold the live apps to the release in `deploy_apps.verify`: expect the `registration-code` secret when the block is present and call `verify_registration_environment` for both apps; verify by tests for the exact match, an unreleased secret, a missing one, a wrong version, a code given as a value, a differing allowance and a registration setting on the web app
- [x] 4.2 Add `live_registration` to `qa_autodeploy.py` and use it in `export_inputs`; verify by tests in `test_qa_autodeploy.py` for a live API with the settings, without them, with only one of them, and with a reference outside the reviewed vault
- [x] 4.3 Teach `release_secrets.py` the `registration-code` name for `store` and `verify`; verify by tests that a wrong-shaped code is refused without being printed, a right one is stored, and `verify` fails on a missing, disabled or wrong-shaped version
- [x] 4.4 Add three mutants to `infra/tests/check_mutations.py` (the registration environment check skipped; the code-shape validation skipped; the placeholder allowed outside staging), and give its disposable copy the shared-types source the pattern test reads; verify all are killed by assertion failures and the whole run passes

## 5. Runbooks and documents

- [x] 5.1 Write the operator steps — choose and type the code, store, grant, release, verify, rotate, switch off, close an unaccepted registration — in `infra/runbooks/03-deploy.md`, with the secret and grant in `01-azure.md`, the expected references in `04-verify.md` and the hosted-QA sequence in `11-qa-hosted.md`; verify each command against the script it names
- [x] 5.2 Update `docs/architecture/security.md` (how a hosted environment gets the code, and the staging-only allowance) and record the change in the planning file; verify the planning file's entries cite this change

## 6. Verification and review

- [x] 6.1 Run `python3 -m unittest discover -s infra/tests`, `check_mutations.py`, `check_terraform_policy.py`, `terraform fmt -check -recursive infra/terraform` and, for the application and foundation roots, `terraform validate` and `terraform test`; verify all pass, and state which of them ran locally and which only in the Infrastructure workflow — all ran locally on Terraform 1.13.3 (the owner's backed-up binary) and passed; `terraform init -backend=false -lockfile=readonly` is left to the Infrastructure workflow, since the working roots' `.terraform` directories are bound to the real backend
- [x] 6.2 Confirm the self-host roots and their scripts are untouched and their tests still pass (`test_qa_*.py`); verify by the diff's file list and the test run
- [x] 6.3 Run the `security-rls` and `qa-auditor` reviews on the diff (the code never as a value in a manifest, plan, log or argument; the staging-only allowance at every entry; the readback's exactness; the export's refusals); verify every correctness, security or data-integrity finding is fixed and the rest are filed
- [x] 6.4 Run `openspec validate registration-hosted-config --strict`; verify it passes

## 7. Hosted QA rollout (with the owner)

- [ ] 7.1 After the merge, with the automatic deploy disabled and no `QA deploy` or `QA rollback` run running or queued: the owner stores `registration-code`, applies the foundation with `registration_secret_ready = true`, and applies the application with the live release plus the `registration` block under a new `release_id`; verify by `release_secrets.py verify`, the plans read before each apply, and the `deploy_apps` readback
- [ ] 7.2 Read back hosted QA: `GET https://api.qa.tonyai.io/api/v1/auth/registration` answers 200 with the placeholder marked, and the automatic deploy is re-enabled; verify by the responses and the workflow's state
- [ ] 7.3 Register one company end to end on `https://qa.tonyai.io/register` with an address the owner reads: the email arrives, the link signs in, the new `super_admin` sees an empty organisation; verify by the owner's written report and a wrong code being refused on the page
- [ ] 7.4 Record the rollout (release id, secret version id — never the code — and the registration made) in the planning file; verify the entry

## Workflow follow-up

- Archive the change after the rollout is recorded.
- When the self-host route resumes, carry the `registration` block to `application/qa`, `foundation/qa` and their contract scripts.
- The pilot's manifest names the block with the allowance off, and only after the reviewed KVKK notice ships.
