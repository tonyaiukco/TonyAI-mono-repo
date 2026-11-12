# qa-release-operations Specification

## Purpose
Defines how hosted QA releases are classified for automatic deployment, read back from the live environment, rolled back on demand and checked for observability. Every operation keeps credential values out of logs, arguments and files.

## Requirements

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

### Requirement: Public hostnames drive every QA origin
Hosted QA SHALL derive its public web and API origins from one optional `public_hosts` input. With the input absent or not bound, every derivation SHALL produce the generated Container Apps origins unchanged. Once bound, Terraform, the build, the candidate contract, smoke, session resources, the browser-key check and Supabase Auth SHALL all use the custom hosts. Only hosts under the configured parent domain SHALL be accepted.

#### Scenario: No public hosts configured
- **WHEN** a release is planned without `public_hosts`
- **THEN** the API's `WEB_ORIGIN` and `APP_URL`, the candidate origins and the smoke targets equal the generated `<prefix>-staging-<kind>.<default_domain>` origins

#### Scenario: Bound public hosts
- **WHEN** `public_hosts` is `{ web: "qa.tonyai.io", api: "api.qa.tonyai.io", bound: true }`
- **THEN** `APP_URL` is `https://qa.tonyai.io`, `WEB_ORIGIN` lists `https://qa.tonyai.io` and the generated web origin, the candidate's origins are the custom ones, and Supabase Auth's `site_url` is `https://qa.tonyai.io` with both origins in its allow-list

#### Scenario: Host outside the parent domain
- **WHEN** `public_hosts.web` is `qa.example.com`
- **THEN** validation refuses the input before any plan or API call, with a safe message

### Requirement: Custom domains bind in stages
A public host SHALL first be added with binding `Disabled`, then receive a managed certificate in the foundation lane, then be switched to `SniEnabled` with that certificate. Deployment readback SHALL require the custom-domain shape of the configured stage. The image-only rollout SHALL leave it unchanged.

#### Scenario: Unbound stage
- **WHEN** `bound` is false
- **THEN** each app's ingress lists its host with `bindingType` `Disabled` and no certificate, and readback passes

#### Scenario: Autodeploy after binding
- **WHEN** an image-only rollout runs on apps whose hosts are `SniEnabled`
- **THEN** the patch sends no ingress, and verification finds the custom domains unchanged

### Requirement: Mail is sent from the verified custom domain
The ACS email configuration SHALL support a CustomerManaged domain with a configured sender username. It SHALL link the domain only once it is marked verified. The foundation SHALL output the DNS records to publish as nonsecret values.

#### Scenario: DNS contract before verification
- **WHEN** foundation is applied with a custom domain that is not yet verified
- **THEN** its output lists the Domain, SPF, DKIM and DKIM2 records, the CNAME record and `asuid` host name for each public host, and the sender is still on the managed domain

#### Scenario: Verified domain
- **WHEN** `custom_domain_verified` is true and the sender username is `no-reply`
- **THEN** the Communication service links the custom domain and the email contract's sender is `no-reply@tonyai.io`

### Requirement: Availability tests alert the operator
Once its opt-in switch is set, hosted QA SHALL run one standard availability test, on the API readiness path, from several locations, and none on the web app. The test SHALL have a metric alert routed to the operator action group. The availability-aware monitoring readback SHALL fail when the test is disabled, targets an unexpected URL, or has no enabled, routed alert.

#### Scenario: Opt-in off
- **WHEN** a foundation apply has monitoring configured but the availability switch is off
- **THEN** no component, test or alert is planned, and the default readback does not check them

#### Scenario: Tests read back
- **WHEN** the monitoring readback runs after the foundation apply
- **THEN** it reports the API test enabled on its expected URL and its alert enabled and routed to the operator

#### Scenario: Test disabled out of band
- **WHEN** the availability test is disabled in the portal
- **THEN** the readback fails, naming that test

### Requirement: Hosted QA holds no demo data
A read-only check SHALL report, for hosted QA, the number of seed Auth users and profiles, the presence of the demo organisation and the number of demo-source factor rows. It SHALL return PASS only when all are zero. Its identifiers SHALL stay equal to those in the seed.

#### Scenario: Clean hosted database
- **WHEN** the check runs on a hosted database with no seed data
- **THEN** every row reports 0 and PASS

#### Scenario: Seed identifiers drift
- **WHEN** the seed changes a seed account's domain or the demo organisation ID
- **THEN** a unit test fails until the check is updated

### Requirement: The live release binding carries registration settings
The live release binding export SHALL include the registration settings the live API holds — the registration code's secret version and the placeholder allowance — and SHALL omit them when the live API holds none. It SHALL refuse a live API whose registration settings are incomplete or whose code is not a reference to the reviewed vault's secret.

#### Scenario: Live API with registration enabled
- **WHEN** the binding is exported from a live API that references a registration code secret version
- **THEN** the binding names that version and the live placeholder allowance, and passes the same verification as a hand-written release

#### Scenario: Live API without registration
- **WHEN** the binding is exported from a live API with no registration settings
- **THEN** the binding has no registration settings

#### Scenario: Incomplete live settings
- **WHEN** the live API holds the placeholder allowance without a registration code, or a registration code given as a plain value
- **THEN** the export is refused and no file is written

### Requirement: Deployment readback holds registration settings to the release
The deployment readback SHALL fail when the live API's registration settings differ from the release: a registration code secret the release does not name, a named one that is missing, a different secret version, a code given as a plain value, a placeholder allowance that differs, or any registration setting on the web app.

#### Scenario: Unreleased registration secret on the live API
- **WHEN** the live API references a registration code secret and the release names no registration settings
- **THEN** the readback fails

#### Scenario: Released settings present and exact
- **WHEN** the live API references the registration code version the release names and holds the released placeholder allowance
- **THEN** the readback passes

#### Scenario: Registration setting on the web app
- **WHEN** the web app holds a registration setting
- **THEN** the readback fails
