# record-lifecycle Specification

## Purpose
Record lifecycle decides an activity record's statuses and who may change the record or move it between them in each status. It covers editing, recalling a submission, and correcting an approved figure, and the audit rows each writes.

## Requirements

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
- **WHEN** a data entry user approves without naming any submission
- **THEN** the request is refused as forbidden, not as `record_changed`

#### Scenario: A consultant approving without naming a submission
- **WHEN** a consultant approves without naming any submission
- **THEN** the request is refused with `record_changed`, because the consultant passes the role check

### Requirement: A withdrawn record is described as not included in the calculation
Wherever the dashboard, Emissions, the void dialog or bulk upload describes how a withdrawn (voided) or draft record affects figures, the wording SHALL say that the record is not included in the calculation. In Turkish it SHALL read "hesaplamaya dahil edilmedi" or "hesaplamaya dahil edilmez", or say that it is not included ("dahil edilmez") in the named totals. Informal counting phrasing such as "hiçbir şeye sayılmaz", "hiçbir toplama sayılmaz" or "sayılmaz hale gelir" SHALL not be used.

#### Scenario: Dashboard cell with a withdrawn record
- **WHEN** a matrix cell holds one withdrawn record and the user reads its summary in Turkish
- **THEN** it reads "Geri çekilen kayıt (hesaplamaya dahil edilmedi)" with the count

#### Scenario: Emissions record with no figure
- **WHEN** a user opens a withdrawn record on Emissions in English
- **THEN** it reads "Withdrawn — the entry is not included in the calculation."

#### Scenario: The void dialog states the effect
- **WHEN** a user opens the void dialog for an approved record in Turkish
- **THEN** its effect line says the record is no longer included in totals, reports and invoice coverage ("artık dahil edilmez")
- **AND** it does not say "sayılmaz hale gelir"

#### Scenario: Bulk upload describes imported drafts
- **WHEN** a user reads a bulk upload dry-run summary or its apply confirmation in Turkish
- **THEN** it says the imported drafts are not included in the calculation until they are submitted ("hesaplamaya dahil edilmez")
- **AND** it does not say "hiçbir toplama sayılmaz"

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

### Requirement: The review queue row names the record's activity type
Each review queue row SHALL name the record's activity type beside its category, using the activity-type label that Data Entry uses, in the user's language (Turkish or English). This SHALL hold for every category that has activity types. A record with no activity type, or in a category without activity types, SHALL show its category alone. The row's anomaly and first-period markers SHALL be unchanged.

#### Scenario: Two refrigerant records of one site differ only by gas
- **WHEN** the review queue lists two submitted Refrigerants records of the same site and year, one for R-410A and one for R-32
- **THEN** one row reads "Refrigerants (R-410A)" and the other "Refrigerants (R-32)", so the reviewer can tell them apart

#### Scenario: Another typed category
- **WHEN** the review queue lists a submitted Fuel record for diesel
- **THEN** its row names the category with the diesel label, as Data Entry's records table does

#### Scenario: The type in Turkish
- **WHEN** a user whose language is Turkish opens the review queue
- **THEN** the category and the activity type are shown with their Turkish labels

#### Scenario: A record without an activity type
- **WHEN** the review queue lists a record whose activity type is empty, or whose category has no activity types
- **THEN** its row shows the category alone, with no empty brackets

#### Scenario: A flagged refrigerant record keeps its mark
- **WHEN** the review queue lists an anomaly-flagged Refrigerants record for R-410A
- **THEN** its row names R-410A and still carries the flag mark

### Requirement: The review sheet names the record's activity type
The review sheet's title SHALL name the record's activity type beside its category, as the queue row does, before the period and year. A record with no activity type SHALL keep the title it has today.

#### Scenario: Opening a refrigerant record
- **WHEN** a reviewer opens the review sheet of an annual 2026 Refrigerants record for R-410A
- **THEN** the sheet's title reads "Refrigerants (R-410A) · Annual 2026" in English, and the Turkish equivalent in Turkish

#### Scenario: Opening a record without a type
- **WHEN** a reviewer opens the review sheet of a record with no activity type
- **THEN** the title shows the category, period and year as before

### Requirement: An activity type outside the catalogue is shown as stored
On the review queue row and the review sheet, an activity type that is not in its category's catalogue list SHALL be shown as stored, not hidden. A record whose stored type is the factor lookup's `unspecified` value SHALL show the "not specified" wording that Data Entry uses, in Turkish or English, never the raw value.

#### Scenario: An unknown stored type
- **WHEN** the review queue lists a record whose activity type is not in its category's catalogue list
- **THEN** its row shows the category followed by the stored value

#### Scenario: A stored `unspecified` type
- **WHEN** the review queue lists a Fuel record whose stored activity type is `unspecified`
- **THEN** its row shows the category followed by the "not specified" wording, not the raw value

#### Scenario: A legacy record entered before fuels were tracked
- **WHEN** the review queue lists a Fuel record written before activity types existed, whose activity type is empty
- **THEN** its row shows the category alone

### Requirement: The review sheet shows a gas energy record's calorific basis
The review sheet SHALL show, read-only, the `cvBasis` a TR natural gas record in kWh or MWh carries, as net or gross in the reader's language, beside its quantity, so the reviewer can compare it with the bill. A record without a basis SHALL show no basis line.

#### Scenario: Reviewing a gross kWh record
- **WHEN** a reviewer opens the review sheet of a submitted TR natural gas record of 1,000 kWh with `cvBasis` `gross`
- **THEN** the sheet shows the calorific basis as "Gross" in English and "Brüt" in Turkish, beside 1,000 kWh

#### Scenario: Reviewing a volume record
- **WHEN** a reviewer opens the review sheet of a TR natural gas record in Sm³
- **THEN** the sheet shows no calorific-basis line

### Requirement: A net energy bill's quantity is sent again when an update moves it
An update to a natural gas record stored in kWh or MWh that changes its unit or category, on either basis, or, stored with `cvBasis` `net`, its site or basis, SHALL carry the quantity, or be refused with `activity_value_reentry_required` (400) and change nothing. The inherited figure would otherwise be read at another scale or meaning, or as gross. The refusal comes after the record's scope, period-lock and calculation checks, which keep their answers.

#### Scenario: A net bill moved to another site without its quantity
- **WHEN** an update moves a stored net kWh bill to another site and sends no quantity
- **THEN** it is refused with `activity_value_reentry_required`, and the record keeps its site, unit, quantity and basis

#### Scenario: The quantity sent with the move
- **WHEN** the same update also sends the quantity
- **THEN** the record moves and is priced from the figure sent

#### Scenario: A gross bill moved
- **WHEN** an update moves a stored gross kWh bill to another site without its quantity
- **THEN** it moves, since a gross figure is what every geography prices

#### Scenario: A gross bill given another unit
- **WHEN** an update changes a stored gross 1,000 kWh bill to MWh without its quantity
- **THEN** it is refused with `activity_value_reentry_required`, and the record keeps 1,000 kWh

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

### Requirement: The review sheet shows a self-generation block
The review sheet SHALL show, read-only, the self-generation block an Electricity record carries: the source in the reader's language, the generated kWh, and the exported and facility consumption kWh when the block states them. A record without a block SHALL show no self-generation lines.

#### Scenario: Reviewing a record with a solar roof
- **WHEN** a reviewer opens the review sheet of a submitted Electricity record of 600,000 kWh whose block states solar and 400,000 generated kWh
- **THEN** the sheet shows the source as solar and 400,000 kWh generated, and no exported or facility consumption line

#### Scenario: The source in Turkish
- **WHEN** a reviewer whose language is Turkish opens that sheet
- **THEN** the source and the line labels are shown in Turkish

#### Scenario: A plain grid record
- **WHEN** a reviewer opens the review sheet of an Electricity record without a block
- **THEN** the sheet shows no self-generation line

### Requirement: A record read states whether a fuel-sourced block has its fuel record
Every read of a record and every answer to a write SHALL carry `generationFuelRecord`: `present` or `missing` for an Electricity record whose block names a fuel source, null otherwise. A match is a record that is not voided, in the same subsidiary and the same location (including none), in any period of the same reporting year: Natural Gas for `natural_gas_chp`, Fuel of type diesel for `diesel_generator`.

#### Scenario: The site has its gas record
- **WHEN** a quarterly Electricity record of a site for 2026 names `natural_gas_chp`, and the same site holds a monthly Natural Gas draft for January 2026
- **THEN** the record's `generationFuelRecord` is `present`

#### Scenario: No fuel record
- **WHEN** such an Electricity record's site holds no Natural Gas record for 2026
- **THEN** its `generationFuelRecord` is `missing`

#### Scenario: A fuel record at another site
- **WHEN** the only Natural Gas record of 2026 belongs to another site of the same subsidiary, or to the whole company
- **THEN** the site's Electricity record reads `missing`

#### Scenario: A voided fuel record
- **WHEN** the site's only Natural Gas record for 2026 is voided
- **THEN** the Electricity record reads `missing`

#### Scenario: A fuel record of another year
- **WHEN** the site's only Natural Gas record is for 2025
- **THEN** the 2026 Electricity record reads `missing`

#### Scenario: A fuel record of another subsidiary
- **WHEN** another subsidiary holds a Natural Gas record for 2026 and the record's own subsidiary holds none
- **THEN** the Electricity record reads `missing`, whichever subsidiaries the reader can access

#### Scenario: A diesel generator
- **WHEN** an Electricity record names `diesel_generator` and the same site and year hold a Fuel record of type diesel
- **THEN** the record reads `present`; a Mobile Combustion record for diesel alone leaves it `missing`

#### Scenario: The read fails after a write
- **WHEN** a submit's record is written and audited, and reading its fuel-record state then fails
- **THEN** the submit is refused as a whole: the record keeps its earlier status and no audit row is written

#### Scenario: A renewable source
- **WHEN** an Electricity record's block names solar or wind, or the record has no block
- **THEN** its `generationFuelRecord` is null

#### Scenario: The review queue
- **WHEN** a reviewer lists the review queue
- **THEN** each row carries its `generationFuelRecord`, and so does the answer to a review decision on it

### Requirement: The review sheet notes a missing fuel record
When a record's `generationFuelRecord` is `missing`, the review sheet SHALL show a notice that names the fuel record not found for the record's site and year. The notice SHALL NOT block or change any review action.

#### Scenario: A CHP record without gas
- **WHEN** a reviewer opens the sheet of an Electricity record with source natural gas CHP whose site has no Natural Gas record for the year
- **THEN** the sheet shows the notice, and the reviewer can still approve or reject the record

#### Scenario: The fuel record exists
- **WHEN** the site holds a Natural Gas record for the year
- **THEN** the sheet shows no such notice

#### Scenario: The notice after a review step
- **WHEN** the reviewer starts the review of such a record and the sheet stays open
- **THEN** the notice is still shown

#### Scenario: The decisions wait for the sheet's read
- **WHEN** a reviewer opens the sheet and its read of the record has not answered, or failed
- **THEN** the reason field and the review actions are disabled, and a failed read offers to read it again

#### Scenario: A record decided elsewhere since the queue was read
- **WHEN** the sheet's read finds the record no longer pending
- **THEN** the sheet closes, the reviewer is told, and the queue is read again

#### Scenario: A record resubmitted while the sheet is open
- **WHEN** a reviewer types a reason, the author recalls the record and submits it again, and the reviewer then starts the review
- **THEN** the start is refused with `record_changed`, and the sheet reads the record again with an empty reason

#### Scenario: A review answer from an earlier opening
- **WHEN** a reviewer starts the review, closes the sheet and opens the same record again, and the first answer arrives before the new opening's read
- **THEN** the new opening still waits for its own read, and acts on what that read says

#### Scenario: A page of files from an earlier list
- **WHEN** more files were asked for, and the list started again before that page answered
- **THEN** the page is not added to the list

#### Scenario: A record gone since the queue was read
- **WHEN** the sheet's read answers that the record is not found
- **THEN** the sheet closes, the reviewer is told, and no Retry is offered

#### Scenario: A record submitted again since the queue was read
- **WHEN** the sheet's read finds a newer submission than the queue row's
- **THEN** the reason starts empty and the files are read again, so no decision goes out on the earlier submission's

#### Scenario: The fuel record appears while the queue is open
- **WHEN** the queue was read before the site's Natural Gas record was entered, and the reviewer then opens the sheet without reloading the page
- **THEN** the sheet shows no such notice

### Requirement: The review sheet notes an energy balance gap
When a block states the facility consumption, the review sheet SHALL show a notice under the rule Data Entry applies: the import, in kWh, differs from consumption − generation + exports by more than 5% of that expected import, or the expected import is zero or less while the import is above zero. The notice SHALL name both figures and SHALL NOT block any review action.

#### Scenario: A gap above 5%
- **WHEN** a reviewer opens the sheet of a record of 600,000 kWh that states 900,000 kWh of consumption and 400,000 generated kWh
- **THEN** the sheet notes an import of 600,000 kWh against an expected 500,000 kWh, and the reviewer can still approve the record

#### Scenario: A balanced record
- **WHEN** the record states 1,000,000 kWh of consumption and 400,000 generated kWh
- **THEN** the sheet shows no balance notice

#### Scenario: No facility consumption
- **WHEN** the block states no facility consumption
- **THEN** the sheet shows no balance notice
