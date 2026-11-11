# Spec Delta

## ADDED Requirements

### Requirement: Data Entry orders its sections
The Data Entry form column SHALL show, top to bottom: Reporting scope, Activity data, Evidence document, Additional context, then the anomaly note, the Edit-mode band and the Save draft and Submit buttons, then Bulk upload. The Evidence document section SHALL be shown for every record, saved or not. The calculation preview, invoice coverage and boundary coverage SHALL be shown beside the form on wide screens and below it on narrow ones.

#### Scenario: A user opens Data Entry
- **WHEN** a data_entry user opens Data Entry with no record open
- **THEN** the second section is Activity data, the third is Evidence document, and Bulk upload comes after the Save draft and Submit buttons

#### Scenario: The evidence section before a save
- **WHEN** a user picks an Electricity category on a new, unsaved record
- **THEN** the Evidence document section is shown, with the "required" badge

#### Scenario: A screen narrower than the wide layout
- **WHEN** Data Entry is shown at a tablet width, such as 820 px
- **THEN** the preview and coverage panels follow the form in one column and nothing scrolls sideways outside the records table

### Requirement: Secondary sections start collapsed
Additional context and Bulk upload SHALL each be collapsible and SHALL start collapsed. Additional context SHALL start expanded when the record opened in the form holds a context value. Recent imports SHALL be shown inside Bulk upload. A collapsed section SHALL name itself and be opened by mouse or keyboard.

#### Scenario: A new record
- **WHEN** a user opens Data Entry
- **THEN** Additional context and Bulk upload are collapsed, and each can be expanded with Enter or Space

#### Scenario: A record with context
- **WHEN** a user opens a saved record that holds a context value
- **THEN** Additional context is expanded and shows the value

#### Scenario: Importing a file
- **WHEN** a data_entry user expands Bulk upload and imports a file
- **THEN** the import runs as before and its batch is listed under Recent imports in the same section

### Requirement: Files can be chosen before the record is saved
On a record that has not been saved, the Evidence document section SHALL let a user who may author records choose files. It SHALL refuse a file of an unaccepted type or over the size limit, in TR or EN, list the chosen files and let the user remove one. Chosen files SHALL stay in the browser until a save creates the record, and SHALL be dropped when the form starts another record, switches subsidiary or opens another record.

#### Scenario: Choosing a file before saving
- **WHEN** a data_entry user fills a new Natural Gas record and chooses a PDF in the Evidence document section
- **THEN** the file is listed as waiting for the save, and nothing is uploaded yet

#### Scenario: An unaccepted file
- **WHEN** the user chooses a file of an unaccepted type or larger than the size limit
- **THEN** the file is not listed and a toast names it and the reason

#### Scenario: Starting another record drops the files
- **WHEN** the user has chosen a file, then starts a new record or switches subsidiary
- **THEN** the chosen file is no longer listed and is never uploaded

#### Scenario: A review-only user
- **WHEN** a consultant views a new record on Data Entry
- **THEN** the Evidence document section offers no way to choose a file

### Requirement: The first save uploads the chosen files
When Save draft or Submit creates a record, the form SHALL upload each chosen file to that record before any evidence check or submit request. Chosen files SHALL be uploaded only to the record that the same save created. Each upload SHALL go through the existing evidence API, which keeps its own checks and audit.

#### Scenario: Save draft with a chosen file
- **WHEN** the user chooses a file on a new Water record and clicks Save draft
- **THEN** the draft is created, the file is attached to it, and the form stays open on the draft with the file listed in the vault

#### Scenario: A save that fails
- **WHEN** the user has chosen a file and the save is refused
- **THEN** no file is uploaded and the file stays listed for the next attempt

#### Scenario: A late save answer
- **WHEN** a save is still in flight and the user starts another record before it answers
- **THEN** the files chosen for the first record are not uploaded to any record created by the new form

### Requirement: A failed upload leaves a saved draft
If a chosen file fails to upload after the record was created, the form SHALL stay open on the saved draft, say in TR or EN which files did not upload, list them with Retry and Remove, and SHALL NOT send a submit request.

#### Scenario: One of two files fails
- **WHEN** the user submits a new Fuel record with two chosen files and the second upload fails
- **THEN** the record is a draft with the first file attached, the second file is listed with Retry and Remove, and the record is not submitted

#### Scenario: Retry then submit
- **WHEN** the user clicks Retry, the upload succeeds, and the user clicks Submit
- **THEN** the record is submitted with both files attached

### Requirement: Data Entry lists the entered records in a table
Data Entry SHALL show the selected subsidiary's records in a full-width table below the form. Each row SHALL show the period and reporting year, the category and activity, the site or whole company, the value and unit, tCO₂e or "not calculated", the evidence (file count, or "missing" where the category requires a file), the status, and the actions the user may take. The table SHALL show no total.

#### Scenario: A row's columns
- **WHEN** a subsidiary has a submitted Natural Gas record for Mar 2025 at a site, 12,400 Sm³, with one file
- **THEN** its row shows Mar 2025, Natural Gas, the site's name, 12,400 Sm³ in the user's locale, its tCO₂e, one file and Submitted

#### Scenario: A required file is missing
- **WHEN** a Mobile Combustion draft has no file
- **THEN** its evidence cell reads "missing"

#### Scenario: A voided record
- **WHEN** a record is voided
- **THEN** its row shows the Voided status and its tCO₂e struck through

#### Scenario: No total
- **WHEN** the table lists records of several statuses
- **THEN** no row, footer or heading sums their tCO₂e

### Requirement: The records table keeps the list's actions
The records table SHALL offer what Previous submissions offered: opening a record in the form from its row, Edit, Recall and Copy to new draft under the rules of their own requirements, selecting drafts for bulk submit, attaching one file to several records, and loading more rows. Each row's open control and checkbox SHALL be named by the record's period, year, category and entity.

#### Scenario: Opening a row
- **WHEN** a user clicks a draft's row
- **THEN** the record opens in the form as it did from Previous submissions

#### Scenario: Bulk submit
- **WHEN** a data_entry user selects two of their drafts in the table and sends them for review
- **THEN** both are submitted, and the table refreshes

#### Scenario: More rows
- **WHEN** the subsidiary has more records than one page
- **THEN** Load more appends the next page to the table

### Requirement: The records table filters by year, status and category
The records table SHALL filter by reporting year, status and category, applied by the API so every page honours them. The year filter SHALL start at the form's reporting year and follow it until the user picks a year in the filter, and SHALL offer All years. Switching subsidiary SHALL reset the filters. An empty result SHALL say that no record matches the filters.

#### Scenario: The year follows the form
- **WHEN** the user has not touched the year filter and changes the form's reporting year from 2025 to 2024
- **THEN** the table lists 2024 records

#### Scenario: A chosen year stays
- **WHEN** the user picks All years in the filter, then changes the form's reporting year
- **THEN** the table keeps listing all years

#### Scenario: Filtering by status
- **WHEN** the user filters by Draft
- **THEN** only draft records are listed, including on pages loaded with Load more

#### Scenario: Nothing matches
- **WHEN** no record matches the filters
- **THEN** the table says that no record matches the filters, not that the subsidiary has no records

## MODIFIED Requirements

### Requirement: Submit shows the evidence vault before sending
On Submit, the Data Entry form SHALL save the record first, then upload any file chosen before the save. If its category is evidence-required and it still has no file, the form SHALL stay open on the saved draft with the evidence vault visible, tell the user in TR or EN to attach a file, and not send the submit request. The API's refusal SHALL remain the final word.

#### Scenario: A new mobile record is submitted without a file
- **WHEN** a data_entry user fills a new Mobile Combustion record, chooses no file, and clicks Submit
- **THEN** the record is saved as a draft, the form stays open with the evidence vault visible, a toast asks for a file, and the record is not submitted

#### Scenario: The user attaches a file and submits again
- **WHEN** the user then uploads a file in the vault and clicks Submit
- **THEN** the record is submitted and the form resets

#### Scenario: A file chosen before the first save submits in one click
- **WHEN** a data_entry user fills a new Mobile Combustion record, chooses a fuel receipt in the Evidence document section, and clicks Submit
- **THEN** the record is created, the file is attached, the record is submitted, and the form resets

#### Scenario: An exempt category submits in one click
- **WHEN** a user fills a new Waste record and clicks Submit
- **THEN** the record is saved and submitted without asking for a file

#### Scenario: The required note fits the category
- **WHEN** the vault of a Mobile Combustion, Refrigerants or Fugitive Gas record has no file
- **THEN** it shows the "required" badge and a note, in TR and EN, naming evidence such as a fuel receipt or card, a service record or a leak report

### Requirement: Edit is an explicit action
Data Entry SHALL offer an Edit action on each draft or rejected record that the user created, in the records table and on a record opened in the form. It SHALL NOT offer Edit on another user's record, on a record in another status, or in a locked period. Edit SHALL put the form into Edit mode for that record.

#### Scenario: The author edits a rejected record
- **WHEN** a data_entry user clicks Edit on their rejected record
- **THEN** the form opens in Edit mode on that record

#### Scenario: No Edit on a colleague's draft
- **WHEN** a super_admin views a draft created by a data_entry user
- **THEN** no Edit action is offered

#### Scenario: No Edit on a submitted record
- **WHEN** the author views their submitted record
- **THEN** no Edit action is offered, and Recall is

### Requirement: A record opened without Edit is not overwritten
A record opened without Edit, by a records table row or a dashboard link, SHALL behave as before this change. Changing its category, reporting year or period SHALL start a new record, and the opened record SHALL be unchanged.

#### Scenario: A drill-in is used as a template
- **WHEN** a user opens a Fuel Q3 draft from the dashboard without Edit, switches to Q4 and saves
- **THEN** a new Q4 record is created and the Q3 record is unchanged
