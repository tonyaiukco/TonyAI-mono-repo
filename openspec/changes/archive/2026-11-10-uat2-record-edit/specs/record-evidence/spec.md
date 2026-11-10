# Spec Delta

## ADDED Requirements

### Requirement: A category change takes every file off the record
An edit that changes a record's category SHALL name every file linked to the record for detaching. If it leaves any linked file attached, it SHALL be refused with `evidence_detach_required`, and nothing SHALL change. The named files SHALL be detached in the same transaction as the edit, so the edit and the detaches commit together or not at all.

#### Scenario: A category change names every file
- **WHEN** the author changes a draft with two linked files from Electricity to Natural Gas and names both files for detaching
- **THEN** the record is Natural Gas, has no linked files, and each detach writes its audit row

#### Scenario: A category change leaves a file attached
- **WHEN** the author changes a draft with two linked files to another category and names only one of them
- **THEN** the request is refused with `evidence_detach_required`, the category is unchanged, and both files stay linked

#### Scenario: A record without files changes category
- **WHEN** the author changes the category of a draft with no linked files
- **THEN** the edit is saved without naming any file

#### Scenario: The edit fails after the detaches were checked
- **WHEN** a category change names every file but is refused as a duplicate
- **THEN** every file stays linked

### Requirement: Other identity edits may detach chosen files
An edit that changes the activity type, reporting year, period or location, but not the category, SHALL accept a list of linked files to detach. Linked files it does not name SHALL stay linked. An edit that changes only the value SHALL accept the same list. A named file that is not linked to the record SHALL be refused, and nothing SHALL change.

#### Scenario: A period move keeps an annual invoice
- **WHEN** the author moves a draft from Q3 to Q4 and names no file
- **THEN** the record moves and its files stay linked

#### Scenario: A period move drops one file
- **WHEN** the author moves a draft from Q3 to Q4 and names one of its two files
- **THEN** the record moves, the named file is detached, and the other stays linked

#### Scenario: A file from another record is named
- **WHEN** an edit names a file that is linked only to another record
- **THEN** the request is refused and nothing changes

### Requirement: Detaching on edit follows the detach rules
A file detached by an edit SHALL be treated as a detach is today. It SHALL be deleted, file and stored content, when it backs no other record. It SHALL stay when it still backs another record. Each SHALL write the same audit row a detach writes today.

#### Scenario: The last link goes
- **WHEN** an edit detaches a file that backs no other record
- **THEN** the file and its stored content are deleted, and a `delete` audit row is written for it

#### Scenario: A shared file stays
- **WHEN** an edit detaches a file that also backs another record
- **THEN** the file stays linked to the other record, and a `detach` audit row is written
