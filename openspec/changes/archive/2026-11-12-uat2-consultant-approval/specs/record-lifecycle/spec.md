# Spec Delta

## ADDED Requirements

### Requirement: A consultant or super_admin approves a record
Only a user whose current role is `consultant` or `super_admin` SHALL approve a record. Any other role SHALL be refused as forbidden, and the refusal SHALL name both roles. A consultant's approval SHALL meet every other approval condition that applies to a `super_admin`, and SHALL be recorded the same way: in the record's reviewer and review time, and in the audit row, which carries the actor's role.

#### Scenario: A consultant approves another user's submission
- **WHEN** a consultant approves a submitted record, created by a data entry user, naming the submission time they saw, with evidence attached and the period open
- **THEN** the record is approved, its reviewer is the consultant, and the audit row records the approval with the role `consultant`

#### Scenario: A data entry user approves
- **WHEN** a data entry user approves a submitted record created by someone else
- **THEN** the request is refused as forbidden, and nothing changes

#### Scenario: An executive viewer approves
- **WHEN** an executive viewer approves a submitted record
- **THEN** the request is refused as forbidden, and nothing changes

#### Scenario: A consultant approves into a locked period
- **WHEN** a consultant approves a submitted record whose period is locked
- **THEN** the approval is refused exactly as it is for a `super_admin`

#### Scenario: A consultant approves a record without evidence
- **WHEN** a consultant approves a submitted record in a category that requires evidence and has none attached
- **THEN** the approval is refused exactly as it is for a `super_admin`

### Requirement: Nobody approves a record they created
An approval SHALL be refused with `self_approval_forbidden` when the approver created the record, whatever role the approver holds when approving. This SHALL hold for a user whose role changed after they created the record.

#### Scenario: A super_admin approves their own record
- **WHEN** a `super_admin` approves a record they created
- **THEN** the request is refused with `self_approval_forbidden`, and the record stays submitted

#### Scenario: A former author, now a consultant, approves their own old record
- **WHEN** a user created and submitted a record as a data entry user, their role is then changed to consultant, and they approve that record
- **THEN** the request is refused with `self_approval_forbidden`, and the record stays submitted

#### Scenario: The review screen does not offer self-approval
- **WHEN** a consultant or `super_admin` opens a submitted record they created in the review queue
- **THEN** no Approve action is offered, and the screen says that they cannot approve a record they entered

### Requirement: Review and reject stay with consultant and super_admin
Only a `consultant` or `super_admin` SHALL take a record into review or reject it. Rejecting SHALL NOT be refused because the reviewer created the record.

#### Scenario: A consultant takes a record into review
- **WHEN** a consultant takes a submitted record into review
- **THEN** the record moves to under review, and stays in the review queue

#### Scenario: A consultant rejects with a comment
- **WHEN** a consultant rejects a submitted record with a comment, naming the submission time they saw
- **THEN** the record is rejected and returns to its author with the comment

#### Scenario: A data entry user rejects
- **WHEN** a data entry user rejects a submitted record
- **THEN** the request is refused as forbidden

### Requirement: Void stays with super_admin
Only a `super_admin` SHALL void an approved record. A consultant's right to approve SHALL NOT give a right to void, and the consultant SHALL NOT be offered a void action.

#### Scenario: A consultant voids an approved record
- **WHEN** a consultant asks the API to void an approved record with a reason
- **THEN** the request is refused as forbidden, and the record stays approved

#### Scenario: The consultant's record view has no void action
- **WHEN** a consultant opens an approved record on the Emissions screen
- **THEN** no void action is offered

### Requirement: The consultant still cannot author records
A consultant's right to approve SHALL NOT let the consultant create, edit, submit, recall or delete a record, or upload or detach evidence. Those requests SHALL be refused as they are today.

#### Scenario: A consultant creates a record
- **WHEN** a consultant asks the API to create an activity record
- **THEN** the request is refused as forbidden

## MODIFIED Requirements

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
- **WHEN** a data entry user approves without naming any submission
- **THEN** the request is refused as forbidden, not as `record_changed`

#### Scenario: A consultant approving without naming a submission
- **WHEN** a consultant approves without naming any submission
- **THEN** the request is refused with `record_changed`, because the consultant passes the role check
