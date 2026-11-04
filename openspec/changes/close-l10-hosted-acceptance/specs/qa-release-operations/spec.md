# Spec Delta

## Purpose

Defines how hosted QA releases are classified for automatic deployment, read back from the live environment, rolled back on demand and checked for observability. Every operation keeps credential values out of logs, arguments and files.

## ADDED Requirements

### Requirement: Planning artifacts do not redeploy QA
Deploy classification SHALL treat changes confined to `openspec/` as non-image changes, alongside the existing non-image prefixes. Image-affecting prefixes such as `infra/certs/` SHALL keep their precedence.

#### Scenario: Only OpenSpec files changed
- **WHEN** the commits since the deployed source change only files under `openspec/`
- **THEN** planning reports SKIP with "no image-relevant change" and no image is built

#### Scenario: OpenSpec and application files changed together
- **WHEN** a commit changes files under `openspec/` and under `apps/api/`
- **THEN** planning reports DEPLOY and counts only the application files as image-relevant

### Requirement: Live release binding export
A read-only operation SHALL write the live QA release binding to an owner-only file. The binding SHALL contain source SHA, release ID, both image digests, runtime secret versions, storage settings, `mail` and `runtime_limits`. It SHALL refuse instead of writing a partial binding.

#### Scenario: Consistent live state
- **WHEN** both apps carry the same source tag and revision suffix, and their secret references match the vault contract
- **THEN** the operation writes a binding that the release verifier accepts unchanged, with file mode 0600

#### Scenario: Apps disagree
- **WHEN** the API and web apps carry different source tags or revision suffixes
- **THEN** the operation fails with a safe message and writes no file

#### Scenario: No secret values
- **WHEN** the binding is written
- **THEN** it contains Key Vault version identifiers only, never a secret value, token or connection string

### Requirement: On-demand rollback to a previously deployed candidate
An operation started only from a manual workflow on `main` in the `qa` environment SHALL move both apps to a named, previously published candidate. It SHALL use the rollout's verification and smoke, and a new revision suffix that marks it as a rollback.

#### Scenario: Rollback to an earlier release
- **WHEN** the owner dispatches the rollback with the candidate artifact of an earlier QA deploy whose source is an ancestor of the live source
- **THEN** API then web are updated to that candidate's digests, the source tags name that candidate's commit, and smoke passes

#### Scenario: Return forward after a drill
- **WHEN** the owner dispatches the same operation with the candidate artifact that was live before the rollback
- **THEN** QA serves that candidate's digests again under a new revision suffix, and smoke passes

#### Scenario: Candidate not from main
- **WHEN** the named candidate's source commit is not an ancestor of main's head, or its artifact is missing or malformed
- **THEN** the operation refuses before draining the API and nothing changes

#### Scenario: Target equals live
- **WHEN** the named candidate's digests equal the live digests and no same-image redeploy was requested
- **THEN** the operation refuses before draining the API and nothing changes

#### Scenario: Concurrent deploy
- **WHEN** a QA deploy is running
- **THEN** the rollback waits in the same concurrency group and never overlaps it

### Requirement: Rollback refuses to cross a migration
The rollback SHALL refuse before touching any app when the migrations of the target candidate differ from the migrations of the live source.

#### Scenario: Live source added a migration
- **WHEN** the live source contains a migration directory that the target candidate does not
- **THEN** the operation fails with "rollback would cross a migration" and both apps keep serving the live release

### Requirement: Failed rollback returns to the live release
When any step of a rollback fails after the API was drained, the operation SHALL restore the images that were live before it began, run smoke, and report which app, if any, it could not restore.

#### Scenario: Target revision never becomes ready
- **WHEN** the target API revision does not become ready within its budget
- **THEN** the operation restores the previous API image, smoke passes, and the job fails with a message naming the rollback as failed and restored

### Requirement: Same-image redeploy as a fallback drill
The rollback operation SHALL accept an explicit same-image mode. That mode redeploys the live candidate under a new revision suffix, so the switch can be rehearsed when no earlier compatible release exists.

#### Scenario: Same-image drill
- **WHEN** the owner dispatches the rollback in same-image mode
- **THEN** both apps get a new revision suffix with unchanged digests and source tags, and smoke passes

### Requirement: Monitoring readback
A read-only operation SHALL report the Container Apps environment's log destination, whether the console and system log tables exist and received rows in a bounded window, and each alert rule's enabled state, scope and action group. It SHALL change nothing.

#### Scenario: Logs are not routed
- **WHEN** the environment's log destination is unset, or the diagnostic setting is missing
- **THEN** the report marks the log chain FAIL and names the missing link, without proposing or applying a fix

#### Scenario: Chain is wired
- **WHEN** the destination, diagnostic setting, tables, rows and enabled routed rules are all present
- **THEN** the report marks each link PASS with the observed row count and window, and contains no log line content
