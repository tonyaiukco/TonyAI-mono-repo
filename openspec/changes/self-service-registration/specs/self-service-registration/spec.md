# Spec Delta

## Purpose

Lets an invited company create its own organisation and first administrator from a public, code-gated form, and hands the new administrator to the existing invitation flow.

## ADDED Requirements

### Requirement: Registration is enabled per environment by its registration code
The system SHALL offer registration only in an environment that has a registration code configured. Without one, the registration endpoint SHALL answer as a missing resource and the registration page SHALL say that registration is unavailable.

#### Scenario: Environment without a code
- **WHEN** a client submits a registration to an environment with no registration code configured
- **THEN** the system answers 404 and creates nothing

#### Scenario: Page in an environment without a code
- **WHEN** a visitor opens the registration page in an environment with no registration code configured
- **THEN** the page shows that registration is unavailable and no form

### Requirement: A registration needs the registration code
The system SHALL refuse a registration whose code does not match the environment's code, and SHALL say that the code is invalid. A refused attempt SHALL count against the client address's request quota.

#### Scenario: Wrong code
- **WHEN** a client submits a registration with a code that does not match
- **THEN** the system answers with the error code `registration_code_invalid` and creates nothing

#### Scenario: Code differing only in letter case
- **WHEN** a client submits a registration whose code matches the environment's code except for the case of a letter
- **THEN** the system answers with the error code `registration_code_invalid` and creates nothing

#### Scenario: Repeated wrong codes
- **WHEN** one client address submits wrong codes past its per-minute quota
- **THEN** the system answers 429 until the quota window passes

### Requirement: Registration input is validated
The system SHALL require a first name, a last name, a company name, a job title, an email address the authentication service accepts (an unquoted ASCII local part and ASCII domain labels) and an accepted consent, and SHALL refuse a submission that lacks any of them without creating anything. It SHALL accept an address from any email domain.

#### Scenario: Consent not accepted
- **WHEN** a client submits a registration with a valid code and the consent not accepted
- **THEN** the system answers with a validation error and creates nothing

#### Scenario: Address with a non-ASCII character
- **WHEN** a client submits a registration whose email address contains a non-ASCII character
- **THEN** the system answers with a validation error and creates nothing

#### Scenario: Quoted address
- **WHEN** a client submits a registration whose email address has a quoted local part
- **THEN** the system answers with a validation error and creates nothing

#### Scenario: Free email provider
- **WHEN** a client submits a valid registration with an address at a free email provider
- **THEN** the system accepts it like any other address

### Requirement: A valid registration creates the organisation and its first administrator
For a valid registration with an address that has no account, the system SHALL create an organisation named by the company name with country `TR`, geography `TR` and reporting currency `TRY`, one `super_admin` profile in it holding the full name and job title, and an invitation in the language the form was submitted in — all or nothing.

#### Scenario: New address
- **WHEN** a client submits a valid registration with an address that has no account
- **THEN** one organisation, one `super_admin` profile and one invitation exist for it, and no subsidiary access grants

#### Scenario: A failure part-way
- **WHEN** writing any of the organisation, profile, invitation or consent record fails
- **THEN** none of them is stored

#### Scenario: Two companies with the same name
- **WHEN** two valid registrations with different addresses give the same company name
- **THEN** two separate organisations are created

### Requirement: The new administrator receives the invitation email
After a registration is stored, the system SHALL send the address an invitation email in the registration's language whose link opens the existing invitation acceptance flow, and SHALL record the delivery outcome on the invitation. The email SHALL tell a self-registered administrator to submit the form again if the link has expired, and SHALL contain nothing the registrant typed.

#### Scenario: Email delivered
- **WHEN** a valid registration with a new address is stored
- **THEN** an invitation email is sent to that address and the invitation is recorded as sent

#### Scenario: Typed text stays out of the email
- **WHEN** a registration's name or company name contains a web address
- **THEN** neither the subject nor the body of the invitation email contains it

#### Scenario: Password reset before the invitation is accepted
- **WHEN** a password reset is requested for a registered address whose invitation is not accepted
- **THEN** the reset email greets nobody and contains nothing the registrant typed

#### Scenario: Accepting the invitation
- **WHEN** the new administrator follows the link and chooses a password
- **THEN** they are signed in as `super_admin` of the new organisation

#### Scenario: Email fails
- **WHEN** the email cannot be sent
- **THEN** the organisation, profile and invitation remain, and the invitation records the failed step

### Requirement: The answer does not reveal whether an address has an account
The system SHALL give the same answer, with the same body, to a valid registration whether the address is new, has an unaccepted invitation or has an active account, and SHALL do the work after answering.

#### Scenario: Address with an active account
- **WHEN** a client submits a valid registration with an address that already has an active account
- **THEN** the system gives the same answer as for a new address, creates nothing and sends no email

#### Scenario: Address with an unaccepted invitation
- **WHEN** a client submits a valid registration with an address that registered before and has not accepted its invitation, outside the re-send cooldown
- **THEN** the system gives the same answer, creates no second organisation and sends that invitation again with a fresh link

#### Scenario: Address invited by someone else
- **WHEN** a client submits a valid registration with an address an administrator invited or the operator provisioned, whose invitation is not accepted
- **THEN** the system gives the same answer and sends nothing

#### Scenario: Re-sends are bounded
- **WHEN** a registered address that has already been sent five invitation emails submits a valid registration again, outside the cooldown
- **THEN** the system gives the same answer and sends nothing

#### Scenario: Re-send inside the cooldown
- **WHEN** a client submits a valid registration with an address whose invitation was sent less than the cooldown ago
- **THEN** the system gives the same answer and sends nothing

### Requirement: Consent is recorded with the notice version
The system SHALL store, with every created registration, a consent record naming the profile, the consent kind, the version of the notice shown, the language it was shown in and the time. Consent records SHALL be append-only, and no client of the database API SHALL read or write one.

#### Scenario: Consent stored
- **WHEN** a valid registration with a new address is stored
- **THEN** one consent record exists for the new profile with the notice version the form sent

#### Scenario: Page from another build
- **WHEN** a visitor opens a registration page whose notice version differs from the one the system records consent to
- **THEN** the page shows that it is out of date and offers a reload, and no form

#### Scenario: Unknown notice version
- **WHEN** a client submits a registration naming a notice version the system does not serve
- **THEN** the system answers with a validation error and creates nothing

#### Scenario: Reading or writing a consent through the database API
- **WHEN** a signed-in user, an anonymous client or the service role reads or writes consent records through the database API
- **THEN** the request is refused

### Requirement: A placeholder notice cannot go live unnoticed
The system SHALL label a placeholder KVKK notice as a placeholder on the page, and SHALL refuse to start with registration enabled while the notice is a placeholder unless the environment explicitly allows a placeholder notice.

#### Scenario: Placeholder shown
- **WHEN** a visitor opens the registration page while the notice is a placeholder
- **THEN** the notice text states that it is a placeholder

#### Scenario: Pilot with a placeholder notice
- **WHEN** an environment has a registration code, a placeholder notice and no placeholder allowance
- **THEN** the API refuses to start and names the reason

### Requirement: Registration is audited without personal data
The system SHALL write an audit row for the organisation, the invitation and the consent it creates, with no acting user and a source naming registration, and SHALL keep the name, address, job title and company name out of every audit row.

#### Scenario: Audit rows of a registration
- **WHEN** a valid registration with a new address is stored
- **THEN** audit rows exist for the organisation, the invitation and the consent, none containing the name, the address, the job title or the company name

### Requirement: The registration page
The web app SHALL serve a registration page to signed-out visitors, in Turkish and English, with the fields first name, last name, company name, job title, company email and registration code, the notice text with its consent checkbox, and a confirmation after submission that tells the visitor to check their email or, if they already have an account, to sign in or reset their password.

#### Scenario: Successful submission
- **WHEN** a visitor submits the form with valid values and the right code
- **THEN** the page shows the confirmation and no form

#### Scenario: Wrong code on the page
- **WHEN** a visitor submits the form with a wrong code
- **THEN** the page keeps the form with its values and says that the code is invalid

#### Scenario: Language
- **WHEN** a visitor whose interface language is Turkish submits the form
- **THEN** the invitation email is in Turkish
