# Spec Delta

## Purpose

Defines the security headers every web response carries, so the browser refuses framing, content sniffing and other injected resources while the pilot's pages keep working.

## ADDED Requirements

### Requirement: Every web response carries the security headers

Every web response, redirects included, SHALL carry `X-Content-Type-Options: nosniff`, frame protection, a no-referrer policy and a permissions policy matching the API's, and a production image's responses SHALL carry HSTS.

#### Scenario: A page

- **WHEN** a browser requests `/login`
- **THEN** the response carries every header above

#### Scenario: A redirect

- **WHEN** an unauthenticated browser requests a protected page and is redirected
- **THEN** the redirect response carries them too

### Requirement: A split content security policy

The structural directives (`frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'`) SHALL be enforced. The resource directives SHALL be report-only until they are enforced after QA round 2, before the pen-test.

#### Scenario: A page in another site's frame

- **WHEN** another origin frames a TonyAI page
- **THEN** the browser refuses it

#### Scenario: The pilot's screens under the report-only policy

- **WHEN** the dashboard, Emissions and Reports load
- **THEN** they work, and no resource they need is reported as a violation
