# Spec Delta

## ADDED Requirements

### Requirement: Edit is an explicit action
Data Entry SHALL offer an Edit action on each draft or rejected record that the user created, in Previous submissions and on a record opened in the form. It SHALL NOT offer Edit on another user's record, on a record in another status, or in a locked period. Edit SHALL put the form into Edit mode for that record.

#### Scenario: The author edits a rejected record
- **WHEN** a data_entry user clicks Edit on their rejected record
- **THEN** the form opens in Edit mode on that record

#### Scenario: No Edit on a colleague's draft
- **WHEN** a super_admin views a draft created by a data_entry user
- **THEN** no Edit action is offered

#### Scenario: No Edit on a submitted record
- **WHEN** the author views their submitted record
- **THEN** no Edit action is offered, and Recall is

### Requirement: Edit mode saves identity changes to the same record
In Edit mode, saving SHALL update the record being edited, including a changed category, activity type, reporting year, period, location or value. Before saving, a band SHALL show, in TR or EN, each identity field that will change, from its old value to its new one. Cancel SHALL leave Edit mode without saving.

#### Scenario: Fuel Q3 becomes Electricity Q1
- **WHEN** the author edits a Fuel Q3 draft in Edit mode, switches to Electricity Q1, fills its fields and saves
- **THEN** the same record now holds Electricity Q1, no new record is created, and the band named both changes before the save

#### Scenario: Cancel keeps the record
- **WHEN** the author changes the period in Edit mode and clicks Cancel
- **THEN** the record is unchanged and the form leaves Edit mode

### Requirement: A record opened without Edit is not overwritten
A record opened without Edit, by a Previous submissions row or a dashboard link, SHALL behave as before this change. Changing its category, reporting year or period SHALL start a new record, and the opened record SHALL be unchanged.

#### Scenario: A drill-in is used as a template
- **WHEN** a user opens a Fuel Q3 draft from the dashboard without Edit, switches to Q4 and saves
- **THEN** a new Q4 record is created and the Q3 record is unchanged

### Requirement: A category change in Edit mode resets the category's fields
When the category changes in Edit mode, the form SHALL clear the activity type, unit and category-specific inputs, so that the user enters them for the new category.

#### Scenario: Refrigerant lines go when the record becomes Fuel
- **WHEN** the author changes a Refrigerants draft to Fuel in Edit mode
- **THEN** the equipment lines are cleared and the form asks for a fuel type and unit

### Requirement: Edit mode states what happens to attached files
When the category changes in Edit mode and the record has files, the band SHALL list them. It SHALL warn that they will be removed and that a file backing no other record will be deleted, and saving SHALL need the user's confirmation. When the activity type, year, period or location changes, the band SHALL offer a keep or remove choice for each file, with the same warning.

#### Scenario: A category change with one file
- **WHEN** the author changes an Electricity draft with one invoice to Water in Edit mode
- **THEN** the band lists the invoice, warns it will be deleted, and the record saves only after the user confirms

#### Scenario: A period move keeps the file by default
- **WHEN** the author moves a draft with one file from Q3 to Q4 in Edit mode and saves without choosing
- **THEN** the file stays linked

### Requirement: The author recalls a submission from Data Entry
Data Entry SHALL offer Recall on each `submitted` record that the user created. Recall SHALL ask for confirmation in TR or EN. After a recall, the record SHALL be a draft that the user can edit. A refusal SHALL be shown with its own copy.

#### Scenario: Recall and edit
- **WHEN** a data_entry user recalls their submitted record and confirms
- **THEN** the record shows as a draft and offers Edit

#### Scenario: Review started first
- **WHEN** the user recalls a record that a reviewer has just taken into review
- **THEN** a toast says that the record is in review and can be returned only by the reviewer, and it stays under review

### Requirement: A late answer never overwrites a newer form
When the user opens another record, starts a new one, copies one or switches subsidiary while an earlier Cancel or Copy is still waiting for the API, the earlier answer SHALL be dropped. It SHALL NOT refill the form or overwrite what the user has typed since.

#### Scenario: Cancel answers after another record was opened
- **WHEN** the user cancels Edit mode on record A, then opens record B in Edit mode and types a value before A's read returns
- **THEN** the form still holds record B and the typed value

#### Scenario: A second Copy answers after a subsidiary switch
- **WHEN** a copied draft is on screen, the user copies a second voided record, then switches subsidiary and types a value before the second copy's read returns
- **THEN** the form keeps the chosen subsidiary and the typed value

### Requirement: A voided record can be copied to a new draft
A voided record SHALL offer Copy to new draft to its author and to a `super_admin`. Copy SHALL open the form for a new record, pre-filled with the voided record's values. The subsidiary SHALL stay selectable. No file SHALL be copied. Saving SHALL create a new draft whose author is the user who copied it.

#### Scenario: Correcting an approved figure
- **WHEN** a super_admin voids an approved record and its author clicks Copy to new draft
- **THEN** the form opens as a new record with the voided record's category, period, location, type, value, unit and inputs, and the evidence vault asks for a file

#### Scenario: Copy into another subsidiary
- **WHEN** the user copies a voided record and picks another subsidiary they can access
- **THEN** the new draft is created in that subsidiary

#### Scenario: Another user's voided record
- **WHEN** a data_entry user views a voided record they did not create
- **THEN** Copy to new draft is not offered
