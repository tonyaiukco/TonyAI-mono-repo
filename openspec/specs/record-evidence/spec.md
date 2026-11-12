# record-evidence Specification

## Purpose
Record evidence decides which activity categories need a supporting file, such as an invoice, meter reading, fuel receipt or service record, before a record joins the inventory, and enforces that rule at every point where a record is committed.

## Requirements

### Requirement: Evidence-required categories
Every Scope 1 and Scope 2 category SHALL require evidence: Electricity, Natural Gas, Fuel, Mobile Combustion, Refrigerants and Fugitive Gas. Water SHALL also require evidence, because it has no factor or anomaly check and its reading is verified only by its file. No other Scope 3 category SHALL require evidence.

#### Scenario: Every Scope 1 and 2 category requires evidence
- **WHEN** the category list is checked against each category's scope
- **THEN** every Scope 1 and Scope 2 category is evidence-required

#### Scenario: Water is the only Scope 3 category that requires evidence
- **WHEN** the Scope 3 categories are checked
- **THEN** Water is evidence-required, and Purchased Goods, Waste, Business Travel, Commuting and Logistics are not

### Requirement: Submit needs a file in an evidence-required category
Submitting a draft or rejected record in an evidence-required category with no attached file SHALL be refused with the stable code `evidence_required`, naming the category. Nothing SHALL change and no audit row SHALL be written. The check SHALL run after the period-lock check and before the activity-type (C8) and freshness (K11) checks.

#### Scenario: A mobile record without a file is refused
- **WHEN** the author submits a Mobile Combustion draft with no evidence attached
- **THEN** the request is refused with `evidence_required` and category Mobile Combustion, and the record stays a draft

#### Scenario: Refrigerants and Fugitive Gas are refused the same way
- **WHEN** the author submits a Refrigerants or Fugitive Gas draft with no evidence attached
- **THEN** the request is refused with `evidence_required` naming that category

#### Scenario: A rejected record is resubmitted without a file
- **WHEN** the author resubmits a rejected Refrigerants record that still has no file
- **THEN** the request is refused with `evidence_required`

#### Scenario: One file is enough
- **WHEN** the author submits a Mobile Combustion draft with one evidence file attached
- **THEN** the record becomes submitted

#### Scenario: An exempt category submits without a file
- **WHEN** the author submits a Waste draft with no evidence attached
- **THEN** the record becomes submitted

#### Scenario: Evidence is named before a missing activity type
- **WHEN** a Mobile Combustion draft has no file and no activity type
- **THEN** the refusal is `evidence_required`, not the missing activity type

### Requirement: Approve needs a file in an evidence-required category
Approving a submitted or under-review record in an evidence-required category with no attached file SHALL be refused with a stable approve-specific code, naming the category and telling the approver to reject the record so its author can attach a file. Nothing SHALL change and no audit row SHALL be written. The check SHALL run after the self-approval and period-lock checks and before the C8 and K11 checks. No record SHALL be exempt by its creation date or audit history.

#### Scenario: A record submitted before the rule cannot be approved without a file
- **WHEN** a super_admin who did not create it approves a submitted Mobile Combustion record that has no evidence attached
- **THEN** the request is refused with the approve-specific evidence code naming Mobile Combustion, and the record stays submitted

#### Scenario: An under-review record is refused the same way
- **WHEN** a super_admin approves an under-review Fugitive Gas record that has no evidence attached
- **THEN** the request is refused with the approve-specific evidence code

#### Scenario: The approver returns the record and the author fixes it
- **WHEN** the refused record is rejected, its author attaches a file and submits it again
- **THEN** a super_admin who did not create it can approve it

#### Scenario: An exempt category approves without a file
- **WHEN** a super_admin approves a submitted Waste record that has no evidence attached
- **THEN** the record becomes approved

#### Scenario: Self-approval and period lock are named first
- **WHEN** the record's creator approves it, or its period is locked, and it has no file
- **THEN** the refusal is the self-approval or period-lock refusal, not the evidence one

#### Scenario: Evidence is named before C8 and K11 at approve
- **WHEN** a record with no file also has no activity type or a stale figure
- **THEN** the refusal is the approve-specific evidence code

### Requirement: Bulk paths treat evidence-required rows alike
A bulk-imported row in an evidence-required category SHALL carry the `evidence_required` warning. An import batch's "send drafts" action and bulk submit SHALL hold back every record in an evidence-required category that has no attached file, and SHALL send one that has a file.

#### Scenario: An imported mobile row warns
- **WHEN** a bulk file row names Mobile Combustion or Fugitive Gas
- **THEN** the row is imported as a draft with the `evidence_required` warning

#### Scenario: Send drafts holds back a refrigerant draft without a file
- **WHEN** an import batch holds a Refrigerants draft with no file and a Waste draft
- **THEN** sending the batch's drafts submits the Waste draft and leaves the Refrigerants draft as a draft

#### Scenario: A draft that gained a file is sent
- **WHEN** a Mobile Combustion draft from a batch has a file attached
- **THEN** bulk submit and the batch's send action submit it

### Requirement: Committed records without a file are incomplete
The dashboard's tracking matrix SHALL treat a committed record in an evidence-required category with no attached file as incomplete. (The completeness panel counts invoice-tracked categories only, which the three K3 categories are not.)

#### Scenario: An approved refrigerant record without a file
- **WHEN** an approved Refrigerants record for a month has no evidence attached
- **THEN** that month's cell is not complete, and its figure still counts

#### Scenario: The same record with a file
- **WHEN** the approved Refrigerants record has one evidence file
- **THEN** the cell can be complete

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

### Requirement: A refrigerant record names the evidence it accepts
When a refrigerant record has no file, its Evidence section SHALL list, in Turkish and English, four accepted documents: the equipment inventory list (signed or stamped), the authorised service maintenance or periodic inspection form, the nameplate photo or technical specification page, and the annual refill or maintenance invoice where there is one. Other evidence-required categories SHALL keep the general note.

#### Scenario: A refrigerant record without a file
- **WHEN** a user enters a refrigerant record and has not chosen or attached a file
- **THEN** the Evidence section lists the four accepted documents

#### Scenario: A natural gas record without a file
- **WHEN** a user enters a natural gas record and has not attached a file
- **THEN** the Evidence section shows the general note, not the refrigerant list

### Requirement: A shortcut attaches one document to the year's gas records
Refrigerant records SHALL stay one record per gas. A saved refrigerant record SHALL offer, in its Evidence section, a shortcut that attaches one document to the other gas records of its year, when its subsidiary and reporting year hold at least two refrigerant records the user may attach files to.

#### Scenario: Three gases for one facility
- **WHEN** a user has saved R-410A, R-32 and FM200 records for one subsidiary and 2025, none with a file yet, and chooses the shortcut on the R-410A record
- **THEN** the records table opens its attach step with the three records ticked, and one chosen file is attached to all three

#### Scenario: A gas record that already has a file
- **WHEN** the R-410A record already holds a file and the user chooses the shortcut on it
- **THEN** R-32 and FM200 are ticked and R-410A is not, though the user may tick it

#### Scenario: Only one gas that year
- **WHEN** the saved refrigerant record is the only attachable refrigerant record for its subsidiary and year
- **THEN** the shortcut is not offered

### Requirement: The shortcut uses the existing attach step
The shortcut SHALL open the records table's existing one-new-file-to-several-records step, with that subsidiary's same-year refrigerant records that the user may attach files to and that hold no file yet ticked in advance, so that no record receives a second copy unasked. The user SHALL be able to tick or untick any record the step allows. The upload SHALL follow that step's rules (one subsidiary, all or nothing). The shortcut SHALL NOT link an already stored file to another record.

#### Scenario: A record the user cannot attach to
- **WHEN** a same-year refrigerant record is one the user may not attach files to
- **THEN** it is not ticked and cannot be ticked

### Requirement: Only a record's author changes its evidence
Uploading a file to a record, uploading one file for several records, taking a file off a record, and deleting a file SHALL be allowed only to the author of every record concerned, `super_admin` included, on an editable record in an open period. A refused request SHALL change nothing and write no audit row; its answer is set by the next requirement. Deleting a whole draft or rejected record SHALL stay open to its author and to `super_admin`.

#### Scenario: A super_admin uploads a file to a colleague's draft
- **WHEN** a `super_admin` uploads a file to a draft created by a data entry user
- **THEN** the upload is refused as forbidden, and no file or link is stored

#### Scenario: A super_admin takes a file off a colleague's rejected record
- **WHEN** a `super_admin` takes a file off a rejected record created by a data entry user
- **THEN** the request is refused as forbidden, and the file stays linked

#### Scenario: One file for several records, one of them a colleague's
- **WHEN** a `super_admin` uploads one file for three draft records of one subsidiary, one of which a data entry user created
- **THEN** the whole upload is refused with `evidence_records_refused` (400), naming the colleague's record, and nothing is stored

#### Scenario: A super_admin deletes a file that backs a colleague's record
- **WHEN** a `super_admin` deletes a file linked to a draft created by a data entry user
- **THEN** the request is refused as forbidden, and the file and its links stay

#### Scenario: The author still manages their own evidence
- **WHEN** the author of a draft uploads a file to it and later takes it off
- **THEN** both succeed and each is audited

#### Scenario: A super_admin deletes a colleague's draft
- **WHEN** a `super_admin` deletes a draft created by a data entry user
- **THEN** the draft is deleted, and its files are removed as before

#### Scenario: The attach step offers only the user's own records
- **WHEN** a `super_admin` opens the step that attaches one new file to several records, on a list holding their own drafts and a colleague's
- **THEN** only their own drafts can be ticked, and the colleague's draft names authorship as the reason

### Requirement: An authorship refusal keeps each route's answer
A refusal for authorship SHALL use the answer each evidence route already gives for a record the caller may not change. On one record (an upload, a detach, or deleting a file that backs only that record) it SHALL be forbidden (403). The several-records upload SHALL be refused whole with `evidence_records_refused` (400), naming every refused record. Deleting a file that backs several records SHALL be refused with `evidence_backs_locked_records` (409), naming them.

#### Scenario: A refusal on one record
- **WHEN** a `super_admin` takes a file off a single record created by a data entry user
- **THEN** the answer is 403 forbidden

#### Scenario: A refusal inside a several-records upload
- **WHEN** a `super_admin` uploads one file for their own draft and a colleague's draft
- **THEN** the answer is 400 `evidence_records_refused`, listing only the colleague's record

#### Scenario: A shared file backing a colleague's record
- **WHEN** a `super_admin` deletes a file that backs their own draft and a colleague's draft
- **THEN** the answer is 409 `evidence_backs_locked_records`, naming the colleague's record, and the file and both links stay
