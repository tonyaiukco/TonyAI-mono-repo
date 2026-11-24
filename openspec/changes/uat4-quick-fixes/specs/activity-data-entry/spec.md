# Spec Delta

## ADDED Requirements

### Requirement: A record carries an optional invoice number and supplier
Data Entry SHALL offer two optional text fields in Additional context for every category: the invoice number and the supplier. They SHALL be saved with the record, audited like any other field, and never used by the calculation. An Electricity record's supplier SHALL be its existing utility provider field. The API SHALL refuse a value that is not text, an invoice number over 64 characters and a supplier over 200.

#### Scenario: Both fields left empty
- **WHEN** a user saves a Mobile Combustion record without an invoice number or a supplier
- **THEN** the record is saved and submitted as before, and neither field is stored

#### Scenario: Both fields entered
- **WHEN** a user enters invoice number `OZK2025000011923` and supplier `Petrol Ofisi` on a Mobile Combustion draft and saves
- **THEN** the record stores both, its tCO₂e is the same as without them, and opening the draft again shows both with Additional context open

#### Scenario: An Electricity record's supplier
- **WHEN** a user opens Additional context on an Electricity record
- **THEN** the section shows the invoice number field and the utility provider field, and no second supplier field

#### Scenario: An invoice number that is too long
- **WHEN** the API receives a record whose invoice number has 65 characters, or is a number or an object
- **THEN** it answers 400 and stores nothing

#### Scenario: A change is audited
- **WHEN** the author changes a draft's invoice number
- **THEN** the audit row's before and after hold the old and the new value

### Requirement: Data Entry links to the entered records from the top
Data Entry SHALL show, above the form, a control labelled "View or edit your entries" (TR: "Girdiğiniz verileri görüntüleyin / düzenleyin") with the number of records the selected subsidiary has. Using it SHALL scroll to the records table and move keyboard focus to it. It SHALL be shown whenever a subsidiary is selected, and SHALL say so when the subsidiary has no records yet.

#### Scenario: Jumping to the entries
- **WHEN** a user with 12 records for the selected subsidiary uses the control at the top of Data Entry
- **THEN** the records table is scrolled into view, focus is on the table's heading, and the form's contents are unchanged

#### Scenario: The count follows the subsidiary
- **WHEN** the user selects another subsidiary that has 3 records
- **THEN** the control shows 3

#### Scenario: No entries yet
- **WHEN** the selected subsidiary has no records
- **THEN** the control says there are no entries yet and still leads to the empty table

#### Scenario: Reduced motion
- **WHEN** the user's system asks for reduced motion
- **THEN** the page jumps to the table without an animated scroll

## MODIFIED Requirements

### Requirement: Natural gas per-record inputs
For a TR natural gas record in Sm³, the form SHALL show NCV prefilled with 8,250 kcal/Sm³ and editable. It SHALL show an optional billed GCV field, and the two are mutually exclusive. For a record in m³, the form SHALL require a volume correction factor. The form SHALL also offer TR natural gas in kWh and MWh, after the volume units, so that a new record still starts on the volume unit it starts on today. For a record in kWh or MWh, the form SHALL require a calorific basis and SHALL show no NCV, billed GCV or volume correction field. It SHALL offer the two bases in plain words, gross first as the figure on the bill (upper calorific value) and net second (lower calorific value), in TR and EN. Whenever the choice is shown and the form holds no basis, gross SHALL come selected, because gas bills in Türkiye state energy on the upper calorific value. The form holds a basis only when a record's stored basis came with its figure (an opened or copied record, or a form carried from an opened record to a new one) or when the author chose one; the form SHALL never select net by itself. The author MAY change it. A bill SHALL never be previewed or saved without a basis. Changing the basis SHALL keep the quantity. Edits SHALL be saved with the record and audited like any other field. Bulk upload SHALL accept the same inputs as optional columns. It SHALL also accept a `cvBasis` column, `net` or `gross` in any letter case, which a TR natural gas row in kWh or MWh requires, and the dry run SHALL show the basis it read.

#### Scenario: The user edits the NCV
- **WHEN** a user changes NCV to 8,100 and saves
- **THEN** the record stores 8,100 as user-entered, and the preview's conversion note shows it

#### Scenario: A new TR gas record offers kWh and MWh
- **WHEN** a user starts a new TR natural gas record from a fresh form, a category change or a link
- **THEN** the unit list offers m³, Sm³, kWh and MWh, and the form starts on m³ as before

#### Scenario: A bill in kWh needs its basis
- **WHEN** a user picks kWh on a new TR natural gas record and enters 1,000
- **THEN** the basis choice appears with "kWh on the bill (upper calorific value)" selected (TR: "Faturadaki kWh (üst ısıl değer)") and "Net kWh (lower calorific value)" second, no NCV, billed GCV or volume correction field is shown, the preview shows 182.17 kgCO2e on the TR 2025 release with the net quantity it was priced on, and the save buttons are enabled

#### Scenario: The preselected basis is saved as chosen
- **WHEN** the user saves that record without touching the choice
- **THEN** the record is created in kWh with `cvBasis` `gross`, and its audit row holds the basis like any other field

#### Scenario: The form never selects net by itself
- **WHEN** the basis choice is shown and the form holds no basis: on a fresh form, after a category change, after a unit change that cleared it, after the form was reset (a submit, Start a new record, another subsidiary), or after a move back under the TR rules
- **THEN** the selected option is gross, never net

#### Scenario: A net bill entered on the form
- **WHEN** a user picks kWh on a new TR natural gas record, enters 1,000, chooses net and saves
- **THEN** the record is created in kWh with `cvBasis` `net`, priced against the net factor, which on the TR 2025 release is 202.16 kgCO2e

#### Scenario: A bill in MWh
- **WHEN** a user enters 1 MWh on a TR natural gas record and chooses gross
- **THEN** the record is created in MWh with `cvBasis` `gross`, and on the TR 2025 release it is priced at 182.17 kgCO2e

#### Scenario: The basis is corrected before save
- **WHEN** a user has entered 1,000 kWh with net chosen and switches to gross
- **THEN** the quantity stays 1,000, and the preview and the save send `cvBasis` `gross`

#### Scenario: A bulk kWh row with its basis
- **WHEN** a bulk file's TR natural gas row states 1,000 kWh and `cvBasis` `GROSS`
- **THEN** the dry run accepts it at 182.17 kgCO2e and shows its basis as gross (TR: brüt), and the import stores `cvBasis` `gross` on the record

#### Scenario: A bulk kWh row without its basis
- **WHEN** a bulk file's TR natural gas row states kWh and leaves `cvBasis` empty
- **THEN** the row is refused as invalid, and its message asks for net or gross rather than reporting a missing factor

#### Scenario: A bulk basis that is not net or gross
- **WHEN** a bulk row carries `cvBasis` `brut`
- **THEN** the row is refused as invalid, and its message names the two accepted values

#### Scenario: A basis on a row of another category
- **WHEN** a bulk Electricity row, or a refrigerant equipment line, carries a `cvBasis`
- **THEN** the row is refused as invalid, as for any gas column on another category, and the basis is never silently dropped

#### Scenario: The template documents the column
- **WHEN** a user downloads the bulk template
- **THEN** its calculation-inputs reference names `cvBasis`, its two values, and that a TR natural gas row in kWh or MWh requires it

### Requirement: Data Entry carries a stored calorific basis
When Data Entry opens, or copies, a TR natural gas record in kWh or MWh, it SHALL keep the record's unit, quantity and `cvBasis` while the record stays under the geography it was priced in. A form carried from an opened record to a new one (another period, year or site, without Edit) SHALL keep them the same way, as it keeps every other field. It SHALL show the stored basis selected in the net / gross choice, which the author MAY change. It SHALL send the chosen basis with every preview and save while the record stays under the TR rules in an energy unit. A gross bill's preview SHALL name the gross-to-net ratio.

#### Scenario: An imported kWh draft edited on Data Entry
- **WHEN** a user opens an imported TR natural gas draft in kWh with `cvBasis` `gross`, changes an ordinary field, attaches its evidence file, saves, and submits it
- **THEN** the form shows gross (TR: brüt) selected, the preview and the save send `cvBasis` `gross`, the figure equals the one calculated at import, and the submit is accepted

#### Scenario: A stored basis corrected on Data Entry
- **WHEN** a user opens an imported TR natural gas draft of 1,000 kWh with `cvBasis` `net`, chooses gross and saves
- **THEN** the record keeps 1,000 kWh, stores `cvBasis` `gross`, and is priced as a gross bill

#### Scenario: A voided kWh record copied to a new draft
- **WHEN** the author copies a voided TR natural gas record of 1,000 kWh with `cvBasis` `net`
- **THEN** the new form keeps kWh, 1,000 and net selected, and does not fall back to a volume unit or clear the quantity

#### Scenario: An opened bill carried to another period keeps its basis
- **WHEN** a user opens a TR natural gas draft of 1,000 kWh with `cvBasis` `net` without choosing Edit, and changes the period
- **THEN** the form says a new record is being entered, and keeps kWh, 1,000 and net selected, as a copy does

#### Scenario: A gross bill's preview names the ratio
- **WHEN** an imported gross kWh draft is previewed
- **THEN** the preview says the figure was reduced to net by the factor release's ratio, and never that kWh was converted to kWh

#### Scenario: A UK kWh copy moved to a TR subsidiary
- **WHEN** a voided UK natural gas record in kWh is copied and moved to a TR subsidiary
- **THEN** the unit and the quantity are kept, the basis choice appears with gross selected, which is what a UK energy bill states, and the preview and the save send `cvBasis` `gross` unless the author changes it

#### Scenario: A copy moved across the TR rules is narrowed like a new record
- **WHEN** a voided UK natural gas record in therms is copied and moved to a TR subsidiary
- **THEN** the unit falls back to what the TR rules offer and the quantity is cleared, as for a new record

#### Scenario: A volume record never sends a basis
- **WHEN** a TR natural gas record in Sm³ or m³ is previewed or saved
- **THEN** no `cvBasis` is sent

### Requirement: A net energy figure leaving the TR rules is entered again
Whenever Data Entry holds a natural gas record in kWh or MWh with `cvBasis` `net` under a subsidiary or site outside the TR rules, however it got there (moved, opened after its site's geography changed, or copied there), it SHALL clear the quantity and its basis and ask for the quantity again, because those rules price an energy bill as gross. It SHALL NOT price a net figure as gross, nor a figure entered afterwards as net. A gross figure SHALL be kept. Outside the TR rules the form SHALL show no basis choice.

#### Scenario: A net draft moved to a UK site
- **WHEN** a user moves a TR natural gas draft of 1,000 kWh with `cvBasis` `net` to a UK site
- **THEN** the quantity is cleared, a notice asks for the bill's gross figure, and nothing is previewed or saved until it is entered

#### Scenario: A gross draft moved to a UK site
- **WHEN** the same draft holds `cvBasis` `gross`
- **THEN** the quantity is kept and priced as a gross kWh figure, and no basis is sent

#### Scenario: A draft opened after its site was re-classified
- **WHEN** a TR net kWh draft is opened after its site's geography was changed to UK
- **THEN** the quantity and the basis are cleared on opening, and a notice asks for the bill's gross figure

#### Scenario: A voided net bill copied into a UK subsidiary's form state
- **WHEN** a voided net kWh record is copied and the copy is placed under a UK subsidiary
- **THEN** the quantity and the basis are cleared, as for a move

#### Scenario: A site the page has not loaded
- **WHEN** a draft is opened whose site was created after the page loaded
- **THEN** nothing is previewed or saved until the site is read, so the record is never priced, or cleared, under its subsidiary's geography in place of its site's

#### Scenario: Back to Türkiye after the figure was entered again
- **WHEN** the user enters the gross figure on the UK site and moves the draft back to the TR subsidiary
- **THEN** the basis choice appears with gross selected, the figure is priced as a gross bill unless the author changes the basis, and it is never priced as net by the form's own choice
