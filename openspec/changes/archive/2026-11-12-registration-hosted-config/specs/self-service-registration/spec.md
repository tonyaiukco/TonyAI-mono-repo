# Spec Delta

## ADDED Requirements

### Requirement: A hosted environment enables registration through its release
A hosted environment SHALL receive its registration code only as a reference to one exact version of a Key Vault secret named in its release, held by the API alone. A release that names no registration settings SHALL leave the environment without registration and SHALL plan no change to it.

#### Scenario: Release without registration settings
- **WHEN** a release that names no registration settings is planned for an environment that has none
- **THEN** the plan changes nothing about registration, and the API has neither the registration code nor the placeholder allowance

#### Scenario: Release with registration settings
- **WHEN** a release names a registration code secret version and is applied
- **THEN** the API reads the registration code from exactly that secret version, and the web app holds no registration setting

#### Scenario: Code value in a release
- **WHEN** a release carries a registration code value instead of a secret version
- **THEN** the release is refused before anything is planned

#### Scenario: Switching registration off
- **WHEN** a release that no longer names registration settings is applied to an environment that had them
- **THEN** the API holds no registration code and the registration endpoint answers as a missing resource

### Requirement: The placeholder allowance cannot be released outside staging
The system SHALL refuse any release that allows the placeholder KVKK notice for an environment other than staging, before anything is planned or applied.

#### Scenario: Production release allowing the placeholder
- **WHEN** a production release names registration settings with the placeholder allowance on
- **THEN** the release is refused and nothing is planned

#### Scenario: Staging release allowing the placeholder
- **WHEN** a staging release names registration settings with the placeholder allowance on
- **THEN** the release is accepted and the API starts with registration enabled over the placeholder notice

### Requirement: A stored registration code has the shape the API accepts
The system SHALL store a registration code in the vault only when it is exactly five letters or digits and is not a code the repository publishes for local development, and SHALL verify the same of the version a release names, without printing the code.

#### Scenario: Storing a code of the wrong shape
- **WHEN** the owner enters a registration code that is not exactly five letters or digits
- **THEN** nothing is stored and the refusal does not repeat the code

#### Scenario: Storing the published development code
- **WHEN** the owner enters the registration code the repository publishes for local development
- **THEN** nothing is stored

#### Scenario: Verifying a release's code version
- **WHEN** a release names a registration code version that holds a value of the wrong shape, or a version that is missing or disabled
- **THEN** verification fails before the release is applied
