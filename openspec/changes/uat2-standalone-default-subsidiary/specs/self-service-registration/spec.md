# Spec Delta

## MODIFIED Requirements

### Requirement: Registration input is validated
The system SHALL require a first name, a last name, a company name of at least two characters, a job title, an email address the authentication service accepts (an unquoted ASCII local part and ASCII domain labels) and an accepted consent, and SHALL refuse a submission that lacks any of them without creating anything. It SHALL accept an address from any email domain.

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

#### Scenario: One-character company name
- **WHEN** a client submits a registration whose company name, trimmed, is one character
- **THEN** the system answers with a validation error and creates nothing, and the page says so before sending

### Requirement: A valid registration creates the organisation and its first administrator
For a valid registration with an address that has no account, the system SHALL create an organisation named by the company name with country `TR`, geography `TR` and reporting currency `TRY`, its default subsidiary, one `super_admin` profile in it holding the full name and job title, and an invitation in the language the form was submitted in — all or nothing.

#### Scenario: New address
- **WHEN** a client submits a valid registration with an address that has no account
- **THEN** one organisation, one subsidiary named by the company name, one `super_admin` profile and one invitation exist for it, and no subsidiary access grants

#### Scenario: A failure part-way
- **WHEN** writing any of the organisation, subsidiary, profile, invitation or consent record fails
- **THEN** none of them is stored

#### Scenario: Two companies with the same name
- **WHEN** two valid registrations with different addresses give the same company name
- **THEN** two separate organisations are created, each with its own subsidiary

#### Scenario: Registration submitted again
- **WHEN** a registration is submitted again for an address whose invitation is not accepted
- **THEN** no organisation or subsidiary is created

### Requirement: Registration is audited without personal data
The system SHALL write an audit row for the organisation, the subsidiary, the invitation and the consent it creates, with no acting user and a source naming registration, and SHALL keep the name, address, job title and company name out of every audit row.

#### Scenario: Audit rows of a registration
- **WHEN** a valid registration with a new address is stored
- **THEN** audit rows exist for the organisation, the subsidiary, the invitation and the consent, none containing the name, the address, the job title or the company name
