# Proposal

## Why

`README.md` has grown to 322 KB and 2,592 lines. About 300 KB of it is API contracts, a deployment runbook, a test inventory and a status log. The cause is the standing rule "keep README current after any change to setup, API, architecture or status", which makes the README the default place for every contract and status note. A new developer can't find the setup path. The opening line also overstates scope ("Scope 1/2/3") while the pilot is Scope 1 & 2. After the production launch, enterprise customers will read the same file, so it has to be presentable to them.

## What Changes

- Move every section that is not entry-level, unchanged, into dedicated documents:
  - API reference and the four API contracts go to `docs/api/`.
  - Security, localisation, data model, roles and observability go to `docs/architecture/`.
  - Testing, troubleshooting detail, manual setup, the full command list and the AI-assisted workflow go to `docs/development/`.
  - The staging deployment runbook goes to `infra/staging-deployment.md`.
- Delete the README's *Project status* and *Roadmap* sections. They duplicate `docs/roadmap_docs/project_status_roadmap_phases.md`, which stays the one status file; the README links to it.
- Repoint the README section citations in 44 code comments and specs (for example `README "Fingerprint encoding"`) to the new document paths.
- Rewrite `README.md` to about 260 lines in 14 sections. A customer-presentable top part covers overview, pilot scope, features, architecture, security and compliance, and environments. A *For contributors* part covers getting started with a success check, commands, configuration, testing, troubleshooting, layout and contributing. A documentation index and the licence close the file.
- Correct the scope claim to "Scope 1 & 2 (pilot); Scope 3 after the pilot". Drop the internal work-package codes (LP/WP/D/K), the "Planned" tech-stack row and the dated test counts from the README.
- Narrow the documentation rule in `CLAUDE.md`, `AGENTS.md` and the `localise-ui` and `workflow-gate` skills. The README carries entry-level content only, and a contract or architecture change updates its document under `docs/api/` or `docs/architecture/` in the same pull request.
- **BREAKING (links):** anchors into README sections that move stop resolving in `README.md`. The one known inbound link (`README.md#account-lifecycle-lp4-01`) and all internal links are repointed.

## Capabilities

### New Capabilities

None. This change restructures documentation only; no system behaviour changes.

### Modified Capabilities

None. `.openspec.yaml` sets `skip_specs: true`.

## Impact

- **Docs:** `README.md`; new `docs/api/`, `docs/architecture/`, `docs/development/` and `infra/staging-deployment.md`; `infra/README.md` gains a link to the staging document.
- **Code comments only:** 44 files under `apps/api/src` (report-datasets, report-issuances, inventory-boundary, calculations, mail), `apps/web` and `e2e/`. No runtime change. Changes under `apps/` count as image-relevant for `infra/scripts/qa_autodeploy.py`, so that PR triggers a QA deploy.
- **Rules:** `CLAUDE.md`, `AGENTS.md`, `.claude/skills/localise-ui/SKILL.md`, `.claude/skills/workflow-gate/SKILL.md`.
- **Digest:** `infra/scripts/replacement_bundle.py` hashes `README.md`, so the replacement-bundle source digest changes (self-hosted route, paused).
- **Unchanged:** the anchors into `infra/runbooks/11-qa-hosted.md` used by `deploy-qa.yml` and `rollback-qa.yml`; `docs/md_docs/Revision MD.md`.
- **Coordination:** Codex's in-flight changes (`lp4-02-tr-factor-package`, `close-l10-hosted-acceptance`) edit the README. Each PR here is timed with the owner so that it does not conflict with them.
