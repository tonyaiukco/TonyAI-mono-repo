# Spec Delta

## ADDED Requirements

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
