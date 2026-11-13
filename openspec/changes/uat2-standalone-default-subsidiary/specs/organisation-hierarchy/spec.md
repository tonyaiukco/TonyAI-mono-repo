# Spec Delta

## ADDED Requirements

### Requirement: A new parent company starts with one subsidiary
When the system creates an organisation, by operator provisioning or by self-service registration, it SHALL create one subsidiary for it in the same transaction, so that a facility can be added at once. Adding an administrator to an existing organisation SHALL create no subsidiary.

#### Scenario: Operator provisions a new organisation
- **WHEN** the operator provisions a new organisation with `--apply`
- **THEN** the organisation has exactly one subsidiary, and its administrator sees it on the subsidiaries screen after accepting the invitation

#### Scenario: Operator dry run
- **WHEN** the operator provisions a new organisation without `--apply`
- **THEN** the plan states that a default subsidiary would be created, and nothing is written

#### Scenario: Administrator added to an existing organisation
- **WHEN** the operator adds an administrator to an existing organisation
- **THEN** the organisation's subsidiaries are unchanged

#### Scenario: A failure part-way
- **WHEN** writing the default subsidiary fails during provisioning
- **THEN** neither the organisation nor its administrator is stored

### Requirement: The default subsidiary mirrors its parent company
The default subsidiary SHALL take the organisation's legal name and geography, and, when the operator gave them, its trading name and sector. It SHALL include Scope 1 and 2, track data at subsidiary level, be pending, and have no facility, no access grant and no inventory-boundary entry.

#### Scenario: Registered company
- **WHEN** a company registers as "Örnek Gıda A.Ş."
- **THEN** its one subsidiary is named "Örnek Gıda A.Ş.", has geography `TR`, includes Scope 1 and 2, tracks at subsidiary level and has no facility

#### Scenario: Data entry without a facility
- **WHEN** the administrator of a newly created organisation opens Data Entry
- **THEN** the default subsidiary is offered, and a record can be entered for it without a facility

### Requirement: The default subsidiary is an ordinary subsidiary
After creation, the default subsidiary SHALL be renamed, edited, given facilities and deleted under the same rules as any other subsidiary. Apart from its creation audit row, no screen or report SHALL mark it as a default.

#### Scenario: Standalone company adds a facility
- **WHEN** a standalone company's administrator opens the default subsidiary and adds a facility
- **THEN** the facility is created under it, as for any subsidiary

#### Scenario: Holding renames it
- **WHEN** a holding's administrator renames the default subsidiary to its first subsidiary's name
- **THEN** the subsidiary keeps its id and every screen shows the new name

#### Scenario: Holding deletes it while empty
- **WHEN** a holding's administrator deletes the default subsidiary before any record, facility or lock refers to it
- **THEN** it is deleted as an empty subsidiary is today

### Requirement: The default subsidiary is audited without the company name
The system SHALL write one audit row for the default subsidiary. The row SHALL have no acting user, SHALL name its source (registration, or the operator) and SHALL omit the legal name, the trading name and the sector.

#### Scenario: Audit row of a provisioned organisation
- **WHEN** the operator provisions a new organisation
- **THEN** one `create subsidiary` audit row exists for it, naming the operator, with no acting user and without the organisation's legal name

### Requirement: Existing organisations are not given a subsidiary
The system SHALL NOT create a default subsidiary for an organisation that existed before this behaviour shipped. Such an organisation keeps its subsidiaries, or none, until its administrator changes them.

#### Scenario: Organisation with no subsidiary from before the release
- **WHEN** an organisation registered before the release is opened after it
- **THEN** it still has no subsidiary, and its screens show the existing empty states

### Requirement: Provisioning refuses names no subsidiary can have
Operator provisioning of a new organisation SHALL refuse, before writing anything, a legal name shorter than two or longer than 200 characters, and a trading name or sector longer than 200 characters, since the default subsidiary carries them.

#### Scenario: One-character legal name
- **WHEN** the operator provisions a new organisation with `--legal-name=X`
- **THEN** the CLI refuses with a usage error naming the bounds, and nothing is written

#### Scenario: Sector past its bound
- **WHEN** the operator provisions a new organisation with a 201-character `--sector`
- **THEN** the CLI refuses with a usage error, and nothing is written

### Requirement: Provisioning refuses a geography no subsidiary can have
Operator provisioning of a new organisation SHALL refuse a geography code that a subsidiary cannot have, before writing anything, and SHALL name the accepted codes.

#### Scenario: Unsupported geography
- **WHEN** the operator provisions a new organisation with `--geography-code=DE`
- **THEN** the CLI refuses with a usage error naming `UK`, `TR` and `EU`, and nothing is written

#### Scenario: Supported geography in lower case
- **WHEN** the operator provisions a new organisation with `--geography-code=tr`
- **THEN** the organisation and its default subsidiary are created with geography `TR`
