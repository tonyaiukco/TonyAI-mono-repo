# activity-data-entry Specification

## Purpose
Activity data entry is how users supply the quantities and per-record inputs a calculation needs, on the Data Entry form and through bulk upload, in Turkish and English.

## Requirements

### Requirement: Catalogue for the pilot's Scope 1 sources
The Data Entry form and the bulk template SHALL offer the following:
- Fuel types petrol, coal and LNG.
- The `kg` unit for Fuel.
- The five Mobile Combustion vehicle modes.
- The Mobile Combustion type marine gas oil (MGO), with the `kg` and `tonnes` units.
- The gases HFC-227ea, SF6 and R-22.
- A Fugitive Gas category with the Sm³ unit.

Labels SHALL exist in both the TR and EN catalogues. Existing activity types SHALL stay valid for existing records.

#### Scenario: A mobile record names its mode
- **WHEN** a user picks Mobile Combustion and a vehicle mode
- **THEN** the form asks for one of the five vehicle modes, and the unit is litres

#### Scenario: A vessel's fuel is entered by mass
- **WHEN** a user picks Mobile Combustion and marine gas oil
- **THEN** the form offers kg and tonnes, and states that MGO covers vessels the organisation owns or operates (Scope 1), an operated bareboat charter included, not vessels it charters without operating them or third-party shipping

#### Scenario: MGO is not read as the stationary gas oil
- **WHEN** the TR or EN type list is shown for Mobile Combustion and for Fuel
- **THEN** the MGO label names marine gas oil, and it differs from the Fuel type `gas_oil`'s label

#### Scenario: A bulk row names MGO
- **WHEN** a bulk file row names Mobile Combustion, marine gas oil and tonnes
- **THEN** it is accepted and calculated as the form's record would be

### Requirement: Natural gas per-record inputs
For a TR natural gas record in Sm³, the form SHALL show NCV prefilled with 8,250 kcal/Sm³ and editable. It SHALL show an optional billed GCV field, and the two are mutually exclusive. For a record in m³, the form SHALL require a volume correction factor. Edits SHALL be saved with the record and audited like any other field. Bulk upload SHALL accept the same inputs as optional columns.

#### Scenario: The user edits the NCV
- **WHEN** a user changes NCV to 8,100 and saves
- **THEN** the record stores 8,100 as user-entered, and the preview's conversion note shows it

### Requirement: Refrigerant equipment inputs
For a refrigerant record, the form SHALL be annual and SHALL ask, per equipment line, for equipment type, installed capacity (kg) and refilled mass (kg), showing their total as the record's quantity. A line with zero capacity and a refill SHALL be accepted. It SHALL show the equipment type's default leak rate. Only for split air conditioners and chillers, it SHALL offer the release's alternative rate as a choice.

#### Scenario: Alternative offered only where defined
- **WHEN** a user picks equipment type `refrigerator`
- **THEN** no alternative leak rate is offered

### Requirement: Decimal input follows the locale
New numeric inputs (NCV, GCV, volume correction factor, capacity, refill) SHALL parse in the user's locale with the existing decimal rules. An ambiguous separator SHALL be refused, as for activity quantities.

#### Scenario: Turkish decimal comma
- **WHEN** a Turkish-locale user enters `8078,67` as NCV
- **THEN** it is read as 8,078.67

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

### Requirement: Edit mode saves identity changes to the same record
In Edit mode, saving SHALL update the record being edited, including a changed category, activity type, reporting year, period, location or value. Before saving, a band SHALL show, in TR or EN, each identity field that will change, from its old value to its new one. Cancel SHALL leave Edit mode without saving.

#### Scenario: Fuel Q3 becomes Electricity Q1
- **WHEN** the author edits a Fuel Q3 draft in Edit mode, switches to Electricity Q1, fills its fields and saves
- **THEN** the same record now holds Electricity Q1, no new record is created, and the band named both changes before the save

#### Scenario: Cancel keeps the record
- **WHEN** the author changes the period in Edit mode and clicks Cancel
- **THEN** the record is unchanged and the form leaves Edit mode

### Requirement: A record opened without Edit is not overwritten
A record opened without Edit, by a records table row or a dashboard link, SHALL behave as before this change. Changing its category, reporting year or period SHALL start a new record, and the opened record SHALL be unchanged.

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

### Requirement: Data Entry shows the factor coverage legend
Data Entry SHALL show, under the record's factor geography, the geographies and reporting years the library covers, taken from the library's coverage report. Coverage that rests only on placeholder or fixture releases SHALL be labelled "placeholder — not authoritative". When the record's geography and year are not covered, the legend SHALL say so in a warning colour.

#### Scenario: Pilot coverage
- **WHEN** a user opens Data Entry on hosted QA, which holds only the authoritative TR releases
- **THEN** the legend reads that factors are defined for Türkiye (TR) for 2024–2026, with no placeholder label

#### Scenario: Geography outside coverage
- **WHEN** the record's factor geography is UK and UK is not in the coverage report
- **THEN** the legend shows, in amber, that no factor is defined for UK in that year

#### Scenario: Placeholder coverage
- **WHEN** the coverage report lists UK 2026 as placeholder only, and the record is UK 2026
- **THEN** the legend lists UK 2026 with the label "placeholder — not authoritative"

#### Scenario: Report unavailable
- **WHEN** the coverage request fails
- **THEN** the legend is omitted, the rest of the form works, and nothing claims coverage

### Requirement: The volume correction factor is explained on Data Entry
Where a natural gas record in m³ asks for a volume correction factor, an information control beside the field SHALL open an explanation with four points: the factor converts metered m³ to standard m³ (Sm³) at 15 °C and 1013.25 mbar; value × factor gives Sm³, which is then converted to energy at the net calorific value shown on the form; the accepted range is 0.75–30; and a bill already in Sm³ is entered in the Sm³ unit with no factor.

#### Scenario: Opening the explanation
- **WHEN** a user selects m³ for a natural gas record and activates the information control beside the volume correction factor
- **THEN** the four points appear in the user's language, and Escape closes them

#### Scenario: Not offered for Sm³
- **WHEN** the record's unit is Sm³
- **THEN** neither the volume correction factor nor its information control is shown

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
