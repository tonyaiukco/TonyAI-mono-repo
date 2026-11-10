# Spec Delta

## Purpose

Record lifecycle decides an activity record's statuses and who may change the record or move it between them in each status. It covers editing, recalling a submission, and correcting an approved figure, and the audit rows each writes.

## ADDED Requirements

### Requirement: Only draft and rejected records are edited
A record SHALL be editable only while it is `draft` or `rejected`. An edit of a record in any other status SHALL be refused with `record_not_editable`, naming the status, and SHALL change nothing.

#### Scenario: A submitted record is not edited
- **WHEN** the author edits the activity value of a submitted record
- **THEN** the request is refused with `record_not_editable` and status `submitted`

#### Scenario: An approved record is not edited
- **WHEN** the author edits an approved record's category
- **THEN** the request is refused with `record_not_editable` and status `approved`

### Requirement: Only the author edits a record
Only the user who created a record SHALL edit it. Any other user, a `super_admin` included, SHALL be refused with `record_author_forbidden`, and nothing SHALL change. A role that may not author records SHALL be refused as today.

#### Scenario: A super_admin edits a colleague's draft
- **WHEN** a super_admin edits a draft created by a data_entry user
- **THEN** the request is refused with `record_author_forbidden` and the draft is unchanged

#### Scenario: A super_admin edits their own draft
- **WHEN** a super_admin edits a draft they created
- **THEN** the edit is saved

#### Scenario: A consultant edits a record
- **WHEN** a consultant edits any record
- **THEN** the request is refused, as today

### Requirement: Deleting a draft stays open to its author and super_admin
A draft or rejected record SHALL be deletable by its author or by a `super_admin`, as today. The author-only edit rule SHALL NOT narrow deletion.

#### Scenario: A super_admin deletes a colleague's draft
- **WHEN** a super_admin deletes a draft created by a data_entry user
- **THEN** the draft is deleted and an audit row is written

### Requirement: Identity fields are edited in place
On a draft or rejected record, an edit SHALL be able to change the activity value, category, activity type, reporting year, period and location. The record SHALL keep its id. Its figure SHALL be recalculated from the new inputs, and the edit SHALL write one `update` audit row holding the record before and after.

#### Scenario: A record is re-filed under another category and period
- **WHEN** the author edits a Fuel Q3 draft to Electricity Q1 with a new value and unit
- **THEN** the same record now holds Electricity Q1, its figure is recalculated, and one `update` audit row holds both states

#### Scenario: The new identity is already taken
- **WHEN** the edited record would share its category, period, location and type with another record that is not voided
- **THEN** the request is refused as a duplicate and the record is unchanged

#### Scenario: The target period is locked
- **WHEN** the author moves a draft into a locked period
- **THEN** the request is refused with the period-lock refusal

### Requirement: A record does not change subsidiary
An edit SHALL NOT move a record to another subsidiary. A request naming a subsidiary SHALL be refused, and the record SHALL be unchanged.

#### Scenario: An edit names another subsidiary
- **WHEN** the author sends an edit with a subsidiary id
- **THEN** the request is refused and the record keeps its subsidiary

### Requirement: The author recalls a submitted record
The author of a `submitted` record SHALL be able to recall it to `draft`. Its inputs and figure SHALL NOT change. `submittedAt` SHALL be cleared, and one `recall` audit row SHALL be written. A user other than the author, a `super_admin` included, SHALL be refused with `record_author_forbidden`.

#### Scenario: The author recalls a submission
- **WHEN** a data_entry user recalls a record they submitted that is still `submitted`
- **THEN** the record is a draft again with the same inputs and figure, and a `recall` audit row is written

#### Scenario: The recalled draft is edited and submitted again
- **WHEN** the author edits the recalled draft and submits it
- **THEN** the record is submitted with the new figure

#### Scenario: Someone else recalls it
- **WHEN** a super_admin who did not create a submitted record recalls it
- **THEN** the request is refused with `record_author_forbidden`

### Requirement: Only a submitted record is recalled
Recall SHALL be refused with `record_not_recallable`, naming the status, for any record that is not `submitted`. Recall and the reviewer's actions SHALL be serialised on the record, so that exactly one of two concurrent requests succeeds.

#### Scenario: A record under review is not recalled
- **WHEN** the author recalls a record that a reviewer has taken into review
- **THEN** the request is refused with `record_not_recallable` and status `under_review`

#### Scenario: Recall races the start of review
- **WHEN** the author recalls a submitted record while a reviewer takes it into review
- **THEN** exactly one request succeeds and the other is refused, and the record ends as `draft` or `under_review`, never in between

#### Scenario: An approved record is not recalled
- **WHEN** the author recalls an approved record
- **THEN** the request is refused with `record_not_recallable` and status `approved`

### Requirement: The database allows recall and no other way back
The database SHALL accept `submitted` to `draft` as a lifecycle step. It SHALL keep refusing every other move back to `draft`, and SHALL keep refusing any change to the frozen inputs on the recall step itself.

#### Scenario: A direct move from under_review to draft
- **WHEN** a writer moves an `under_review` record to `draft` in the database
- **THEN** the write is refused

#### Scenario: Recall that also changes the value
- **WHEN** one database write moves a submitted record to `draft` and changes its activity value
- **THEN** the write is refused

### Requirement: An approved figure is corrected by void and a new record
An approved or locked record SHALL never return to `draft`. Its correction SHALL be D04: void the approved record with a reason, then enter a new record. A voided record SHALL free its identity for the new record.

#### Scenario: A corrected record replaces a voided one
- **WHEN** an approved record is voided and a new draft is created with the same category, period and location
- **THEN** the new draft is accepted and the voided record keeps its reason and figure

### Requirement: A review decision is about the submission the reviewer saw
An approve or reject request over the API SHALL name the record's `submittedAt` as the reviewer saw it, or `null` for a record with none. When it names a different value from the record's current `submittedAt`, or names none, the request SHALL be refused with `record_changed` after the role check, and nothing SHALL change.

#### Scenario: Approving a submission that was recalled and resubmitted since
- **WHEN** a reviewer opens a submitted record, its author recalls it, changes the value and submits it again, and the reviewer then approves with the first submission time
- **THEN** the approval is refused with `record_changed`, and the record stays submitted with the new value

#### Scenario: Approving the submission seen
- **WHEN** the reviewer approves with the record's current submission time
- **THEN** the record is approved

#### Scenario: A review tab from before this release
- **WHEN** a client approves or rejects without naming any submission
- **THEN** the request is refused with `record_changed`, whose copy tells the reviewer to reload

#### Scenario: A role refusal still comes first
- **WHEN** a consultant approves without naming any submission
- **THEN** the request is refused as forbidden, not as `record_changed`
