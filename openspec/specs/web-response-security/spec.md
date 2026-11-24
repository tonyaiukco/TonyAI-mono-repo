# web-response-security Specification

## Purpose
Defines the security headers every web response carries, so the browser refuses framing, content sniffing and other injected resources while the pilot's pages keep working.

## Requirements

### Requirement: Every web response carries the security headers

Every web response, redirects included, SHALL carry `X-Content-Type-Options: nosniff`, frame protection, a no-referrer policy and a permissions policy matching the API's, `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`, and a production image's responses SHALL carry HSTS.

#### Scenario: A page

- **WHEN** a browser requests `/login`
- **THEN** the response carries every header above

#### Scenario: A redirect

- **WHEN** an unauthenticated browser requests a protected page and is redirected
- **THEN** the redirect response carries them too

### Requirement: An enforced content security policy

The structural directives (`frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'`) and the resource directives (`default-src`, `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`) SHALL be enforced in one policy. `connect-src` SHALL name only the page's own origin, the API's, Supabase's and, when one is configured, the error-reporting service's. No resource directive SHALL remain report-only.

#### Scenario: A page in another site's frame

- **WHEN** another origin frames a TonyAI page
- **THEN** the browser refuses it

#### Scenario: The pilot's screens under the enforced policy

- **WHEN** the dashboard, Emissions, Data Entry, Review, Reports, Users, sign-in and registration load and are used
- **THEN** they work, and the browser reports no violation of the policy

#### Scenario: The development server

- **WHEN** the web app runs under `next dev`
- **THEN** its policy also allows `'unsafe-eval'`, which React's development build needs, and a built image's policy never does

#### Scenario: A script from another origin

- **WHEN** a page tries to load a script or connect to an origin the policy does not name
- **THEN** the browser blocks it

### Requirement: Policy violations are reported

When the image knows the API's address, the enforced policy SHALL name a violation report endpoint on the API through `report-uri`, which every supported browser posts at once, and SHALL NOT name a Reporting API group, under which Chrome ignores `report-uri` and queues the report instead. Without that address it SHALL name no receiver rather than a guess.

#### Scenario: A blocked resource

- **WHEN** the browser blocks a resource under the policy
- **THEN** it sends a violation report to the API's report endpoint

### Requirement: The API receives violation reports without exposing anything

The API SHALL accept violation reports without authentication, in both report formats, up to a fixed body size, under a per-IP quota of its own taken before the body is read and apart from the address's quota for every other route, and SHALL answer 204 whatever the body. It SHALL log only each report's directive, blocked origin, page path and disposition, as values a browser could send (anything else as `unknown`), never a query string or fragment, and SHALL store nothing.

#### Scenario: A report

- **WHEN** a browser posts a `application/csp-report` or `application/reports+json` body to the report endpoint
- **THEN** the API answers 204 and logs the directive, blocked origin and page path

#### Scenario: A hostile body

- **WHEN** a client posts malformed JSON, another content type (a form included), a body over the cap, free text in a field or a URL carrying a query string
- **THEN** the API answers 204, 413 or 415 without failing, and logs no query string, fragment or unbounded text

#### Scenario: A flood

- **WHEN** one IP posts more reports than its quota allows
- **THEN** the API answers 429 and the other routes' quotas are unaffected

### Requirement: API responses carry a resource policy

Every API response SHALL carry `Cross-Origin-Resource-Policy: same-site`, besides the headers it already sends.

#### Scenario: An API response

- **WHEN** any client requests an API route, a refusal or a CORS preflight included
- **THEN** the response carries `Cross-Origin-Resource-Policy: same-site`
