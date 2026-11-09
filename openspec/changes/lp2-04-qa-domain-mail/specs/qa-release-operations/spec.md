## ADDED Requirements

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
- **THEN** its output lists the Domain, SPF, DKIM and DKIM2 records, the CNAME and `asuid` records for each public host, and the sender is still on the managed domain

#### Scenario: Verified domain
- **WHEN** `custom_domain_verified` is true and the sender username is `no-reply`
- **THEN** the Communication service links the custom domain and the email contract's sender is `no-reply@tonyai.io`

### Requirement: Availability tests alert the operator
Hosted QA SHALL run a standard availability test on the API health path and one on the web login path from several locations. Each test SHALL have a metric alert routed to the operator action group. The monitoring readback SHALL fail when a test is disabled, targets an unexpected URL, or has no enabled, routed alert.

#### Scenario: Tests read back
- **WHEN** the monitoring readback runs after the foundation apply
- **THEN** it reports both tests enabled on their expected URLs and both alerts enabled and routed to the operator

#### Scenario: Test disabled out of band
- **WHEN** one availability test is disabled in the portal
- **THEN** the readback fails, naming that test

### Requirement: Hosted QA holds no demo data
A read-only check SHALL report, for hosted QA, the number of seed Auth users and profiles, the presence of the demo organisation and the number of demo-source factor rows. It SHALL return PASS only when all are zero. Its identifiers SHALL stay equal to those in the seed.

#### Scenario: Clean hosted database
- **WHEN** the check runs on a hosted database with no seed data
- **THEN** every row reports 0 and PASS

#### Scenario: Seed identifiers drift
- **WHEN** the seed changes a seed account's domain or the demo organisation ID
- **THEN** a unit test fails until the check is updated
