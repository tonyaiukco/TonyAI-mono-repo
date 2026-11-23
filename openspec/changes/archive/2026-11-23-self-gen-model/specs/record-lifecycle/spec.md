# Spec Delta

## ADDED Requirements

### Requirement: An edit is made on the version it names
An edit MAY name the record's `updatedAt` as the editor read it (`seenUpdatedAt`). An edit naming another version SHALL be refused with `record_changed` (HTTP 409) after the tenant, role, status and author checks, writing nothing. An edit naming no version SHALL be refused the same way when it would change or remove a stored self-generation block.

#### Scenario: An edit made on an older version
- **WHEN** an editor reads a draft, another client edits it, and the editor's edit names the version first read
- **THEN** the edit is refused with `record_changed`, and the record keeps the other client's values

#### Scenario: A refusal of the author still comes first
- **WHEN** a user who is not the record's author edits it naming an older version
- **THEN** the edit is refused as `record_author_forbidden`, not as `record_changed`

#### Scenario: An edit made on the current version
- **WHEN** an edit names the record's current `updatedAt`
- **THEN** the edit is applied

#### Scenario: A tab from before the deploy erases a block
- **WHEN** a client that names no version sends `parameters: null` for an Electricity draft that holds a self-generation block
- **THEN** the edit is refused with `record_changed`, and the block stays

#### Scenario: A client that names no version leaves the block alone
- **WHEN** a client that names no version changes only the quantity of an Electricity draft that holds a block
- **THEN** the edit is applied, and the block stays
