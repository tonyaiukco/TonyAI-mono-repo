# Spec Delta

## ADDED Requirements

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
