# Spec Delta

## MODIFIED Requirements

### Requirement: Data Entry keeps a stored self-generation block
Data Entry SHALL send the self-generation block the form shows with every save of an Electricity record, an edit included, and no block when no source is chosen. Every edit SHALL name the version of the record the form read, and a save refused as `record_changed` SHALL read the record again. A preview and a copy SHALL carry the block on the form, and a move to another category SHALL send no block.

#### Scenario: A draft with a block edited on Data Entry
- **WHEN** a user opens an Electricity draft that holds a self-generation block, changes its quantity and saves
- **THEN** the save sends the block as the form shows it, and the record keeps every field of the block

#### Scenario: A block corrected on the form
- **WHEN** a user opens an Electricity draft whose block states 4,000 generated kWh, changes it to 5,000 kWh and saves
- **THEN** the record holds 5,000 generated kWh, and its emissions figure is unchanged

#### Scenario: A block removed on the form
- **WHEN** a user opens an Electricity draft that holds a block, sets the source to none and saves
- **THEN** the record is stored as a plain grid record with no block

#### Scenario: A block corrected elsewhere while the form is open
- **WHEN** a user opens an Electricity draft whose block states 4,000 generated kWh, another client corrects it to 5,000 kWh, and the user changes the quantity and saves
- **THEN** the save is refused with `record_changed`, the record keeps the 5,000 kWh block, and the form shows the record as stored, so the next save is made on it

#### Scenario: A block added elsewhere while the form is open
- **WHEN** a user opens an Electricity draft without a block, another client adds one, and the user changes the quantity and saves
- **THEN** the save is refused with `record_changed`, the record keeps the added block, and the form then shows it

#### Scenario: A draft turned into Electricity elsewhere
- **WHEN** a user opens a Natural Gas draft, another client changes it to Electricity with a block, and the user also picks Electricity and saves
- **THEN** the save is refused with `record_changed`, and the record keeps the block

#### Scenario: A preview of a draft with a block
- **WHEN** a user opens an Electricity draft that holds a self-generation block and the form previews its figure
- **THEN** the preview sends the block the form shows

#### Scenario: The unit changes
- **WHEN** a user changes such a draft from kWh to MWh, enters the quantity again and saves
- **THEN** the record keeps the block unchanged, its kWh fields included

#### Scenario: The record becomes another category
- **WHEN** a user changes such a draft to Natural Gas in Edit mode and saves
- **THEN** the save sends no self-generation block, and the record is saved as a Natural Gas record

#### Scenario: A category changed by mistake and undone
- **WHEN** a user changes such a draft to Natural Gas, then back to Electricity, enters the quantity again and saves
- **THEN** the form shows the block as it was before the change, and the saved record keeps it

#### Scenario: A voided record copied to a new draft
- **WHEN** the author copies a voided Electricity record that holds a self-generation block and saves the copy
- **THEN** the form shows the copied block, and the new draft holds the same block

#### Scenario: A plain grid record
- **WHEN** a user saves a new Electricity record with no source chosen
- **THEN** no block is sent, and the record is stored without parameters

### Requirement: A category change in Edit mode resets the category's fields
When the category changes in Edit mode, the form SHALL clear the activity type, unit and category-specific inputs, so that the user enters them for the new category. In any mode, a quantity already entered SHALL be cleared with a notice when the category changes, because another category reads the figure as something else. An Electricity record's self-generation fields SHALL be kept, and shown again if the category returns to Electricity.

#### Scenario: Refrigerant lines go when the record becomes Fuel
- **WHEN** the author changes a Refrigerants draft to Fuel in Edit mode
- **THEN** the equipment lines are cleared and the form asks for a fuel type and unit

#### Scenario: An imported gas bill re-filed as Water
- **WHEN** the author changes an imported natural gas draft of 1,000 kWh to Water in Edit mode
- **THEN** the quantity is cleared with a notice, and nothing is saved until a Water quantity is entered

#### Scenario: Self-generation fields survive a detour
- **WHEN** the author changes an Electricity draft with a solar block to Natural Gas and back to Electricity in Edit mode
- **THEN** the quantity is cleared with a notice, and the self-generation section shows the source and the kWh fields as they were

#### Scenario: A figure the form could not read survives a detour
- **WHEN** the author types "500," as the exported kWh of such a draft, changes the category to Natural Gas and back, and enters the quantity again
- **THEN** the field still reads "500,", the section still says the figure could not be read, and nothing is saved until it is corrected

## ADDED Requirements

### Requirement: Electricity shows a self-generation section that opens by source
For an Electricity record, in any geography, Data Entry SHALL show a self-generation section with a source choice: none (the default), solar, wind, natural gas CHP or diesel generator. Choosing a source SHALL open the generated kWh (required), the kWh exported to the grid (optional) and the facility consumption in kWh (optional). With no source chosen, the section SHALL show no further field. No other category SHALL show the section.

#### Scenario: A new Electricity record
- **WHEN** a user picks Electricity for a new record
- **THEN** the section shows the source choice set to none and no kWh field

#### Scenario: A source opens the fields
- **WHEN** the user chooses solar
- **THEN** the section shows the generated, exported and facility consumption fields, each in kWh

#### Scenario: Outside Türkiye
- **WHEN** a user picks Electricity for a subsidiary in the United Kingdom
- **THEN** the section is shown as it is for a subsidiary in Türkiye

#### Scenario: Another category
- **WHEN** a user picks Natural Gas
- **THEN** no self-generation section is shown

#### Scenario: A stored block is opened
- **WHEN** a user opens an Electricity draft whose block states solar, 4,000 generated kWh and 500 exported kWh
- **THEN** the section shows solar, 4,000 and 500, and an empty facility consumption field

#### Scenario: The fields follow the locale
- **WHEN** a user whose language is Turkish types 4.000,5 as the generated kWh
- **THEN** the form reads 4,000.5 kWh, as it reads the quantity

#### Scenario: A language switch re-reads a field
- **WHEN** a user types 0,500 as the generated kWh in English, where it is refused, and switches to Turkish
- **THEN** the form reads 0.5 kWh and no longer holds the save

#### Scenario: A figure the form could not read survives None and back
- **WHEN** a user types "500," as the exported kWh, sets the source to none and back to solar
- **THEN** the field still reads "500,", and nothing is saved until it is corrected

### Requirement: The self-generation section states the topology it records
The section SHALL state that it records generation behind the same meter as the grid import (Case A), and that a plant on its own meter cannot be recorded yet. It SHALL offer no topology choice, and a block saved from the form SHALL carry topology `A`.

#### Scenario: A block saved from the form
- **WHEN** a user chooses wind, enters 2,000 generated kWh and saves
- **THEN** the stored block carries `generationTopology` `A`

#### Scenario: The statement is shown with the fields
- **WHEN** a source is chosen
- **THEN** the section shows the Case A statement in the user's language

### Requirement: An incomplete or invalid block holds the preview and the save
While a source is chosen, Data Entry SHALL NOT preview or save the record until the block is valid: the generated kWh is given and not negative, the exported kWh is not negative and not above the generation, and a facility consumption, when given, is above zero. The section SHALL say which rule is unmet. The block rule SHALL be the one the API applies, so the form holds what the API would refuse.

#### Scenario: A source without a generation figure
- **WHEN** a user chooses solar and leaves the generated kWh empty
- **THEN** nothing is previewed, the save buttons are disabled, and the section says the generated kWh is missing

#### Scenario: Exports above generation
- **WHEN** a user enters 400,000 generated kWh and 500,000 exported kWh
- **THEN** nothing is saved, and the section says exports cannot exceed the generation

#### Scenario: Exports equal to generation
- **WHEN** a user enters 400,000 generated kWh and 400,000 exported kWh
- **THEN** the record can be previewed and saved

#### Scenario: A plant that generated nothing
- **WHEN** a user chooses solar and enters 0 generated kWh
- **THEN** the record can be previewed and saved

#### Scenario: A facility consumption of zero
- **WHEN** a user enters 0 as the facility consumption
- **THEN** nothing is saved, and the section says the consumption must be above zero or left empty

#### Scenario: A facility consumption below the API's floor
- **WHEN** a user enters a facility consumption above zero but below 1e-300 kWh
- **THEN** nothing is saved, and the section says the consumption must be above zero or left empty

#### Scenario: No source chosen
- **WHEN** a user leaves the source at none
- **THEN** the section holds nothing back, and the record is previewed and saved as a plain grid record

### Requirement: The section says the quantity is the grid import
While a source is chosen, the section SHALL state that the record's quantity is the electricity imported from the grid, as the meter's import register reads, and that a netted figure, import minus export, is not to be entered. Exported kWh SHALL never change the previewed or saved figure.

#### Scenario: The import statement
- **WHEN** a user chooses solar
- **THEN** the section shows the import statement in the user's language

#### Scenario: Exports do not offset the figure
- **WHEN** a TR Electricity record of 600,000 kWh is previewed with 400,000 generated kWh, first with no exports and then with 100,000 exported kWh
- **THEN** both previews show the same figure

### Requirement: A fuel source reminds the author to enter the fuel record
When the source is natural gas CHP or diesel generator, the section SHALL remind the author that the fuel is entered as its own record for the same site and reporting year: the site's Natural Gas record for CHP, its Fuel record for diesel for a generator. The reminder SHALL NOT block the preview or the save. Solar and wind SHALL show no reminder.

#### Scenario: A CHP unit
- **WHEN** a user chooses natural gas CHP
- **THEN** the section reminds the author to include the unit's gas in the site's Natural Gas record for the year

#### Scenario: A diesel generator
- **WHEN** a user chooses diesel generator
- **THEN** the section reminds the author to enter the generator's fuel as the site's Fuel record for diesel

#### Scenario: A renewable source
- **WHEN** a user chooses solar or wind
- **THEN** no reminder is shown

#### Scenario: The fuel record does not exist yet
- **WHEN** a user saves an Electricity record with source natural gas CHP for a site that has no Natural Gas record
- **THEN** the record is saved

### Requirement: An energy balance gap warns and never blocks
When a block states the facility consumption, Data Entry SHALL compare the record's import, in kWh, with the expected import: consumption − generation + exports. It SHALL warn when the two differ by more than 5% of the expected import, or when the expected import is zero or less and the import is above zero. The warning SHALL name both figures, and SHALL NOT block the preview, the save or the submit.

#### Scenario: A balanced record
- **WHEN** a record of 600,000 kWh states 1,000,000 kWh of consumption and 400,000 generated kWh
- **THEN** the expected import is 600,000 kWh and no warning is shown

#### Scenario: A gap above 5%
- **WHEN** a record of 600,000 kWh states 900,000 kWh of consumption and 400,000 generated kWh
- **THEN** the section warns that the import is 600,000 kWh against an expected 500,000 kWh, and the record can still be saved and submitted

#### Scenario: A gap of exactly 5%
- **WHEN** a record of 525,000 kWh states 900,000 kWh of consumption and 400,000 generated kWh
- **THEN** no warning is shown

#### Scenario: A real gap between large figures
- **WHEN** a record states 1,000,000,000 kWh of consumption, 1,000,000,000 generated kWh and 0.001 exported kWh, and an import of 0.001051 kWh
- **THEN** the warning is shown

#### Scenario: Small figures keep their digits
- **WHEN** a warning compares an import of 0.004 kWh with an expected 0.003 kWh
- **THEN** it names 0.004 and 0.003 kWh, never figures rounded to 0

#### Scenario: A netted bill figure
- **WHEN** a record of 600,000 kWh states 1,000,000 kWh of consumption, 400,000 generated kWh and 100,000 exported kWh
- **THEN** the expected import is 700,000 kWh and the warning is shown

#### Scenario: A record in MWh
- **WHEN** a record of 600 MWh states 1,000,000 kWh of consumption and 400,000 generated kWh
- **THEN** the import is read as 600,000 kWh and no warning is shown

#### Scenario: Generation above consumption
- **WHEN** a record of 50,000 kWh states 300,000 kWh of consumption and 400,000 generated kWh with no exports
- **THEN** the expected import is below zero and the warning is shown

#### Scenario: No facility consumption
- **WHEN** a block states no facility consumption
- **THEN** no balance is checked and no warning is shown

### Requirement: A category move that removes a stored block says so before the save
In Edit mode, when the record on the form holds a stored self-generation block and its category is changed away from Electricity, Data Entry SHALL say, before the save, that saving removes the record's self-generation details. The notice SHALL go when the category returns to Electricity.

#### Scenario: An Electricity draft with a block re-filed
- **WHEN** the author changes an Electricity draft that holds a block to Natural Gas in Edit mode
- **THEN** the form says that saving will remove the record's self-generation details

#### Scenario: The move is undone
- **WHEN** the author then changes the category back to Electricity
- **THEN** the notice is gone and the section shows the block

#### Scenario: A record without a block
- **WHEN** the author changes a plain Electricity draft to Natural Gas in Edit mode
- **THEN** no such notice is shown

### Requirement: A save refused for an older version says what happened
When an edit on Data Entry is refused as `record_changed`, the form SHALL say that the record was changed after the form opened it, that the changes on the form were not saved, and that the form is reading the record again. It SHALL NOT say that the record changed while the request was in progress.

#### Scenario: The user's own second tab
- **WHEN** a user saves a draft in one tab, then saves an older view of it in another tab
- **THEN** the second save is refused, and its message says the record was changed after it was opened and that the form's changes were not saved

#### Scenario: The message in Turkish
- **WHEN** a user whose language is Turkish gets that refusal
- **THEN** the message is shown in Turkish

#### Scenario: A submit refused after its save
- **WHEN** Submit for review saves the draft and the submit that follows is refused as `record_changed`
- **THEN** the message is the submit's, never that the changes were not saved, the draft stays saved, and the form reads it again

#### Scenario: A submit answered after another record was opened
- **WHEN** the submit of one draft is answered after the user opened another record
- **THEN** the outcome is shown naming the first record, and the record now open keeps what the user typed

#### Scenario: A submit answered after the form moved to another period
- **WHEN** the submit of one draft is answered after the user moved the form to another period, starting a new record
- **THEN** the outcome is shown naming the first record with its company, and the new record keeps what the user typed
