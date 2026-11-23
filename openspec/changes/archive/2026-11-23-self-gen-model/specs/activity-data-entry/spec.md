# Spec Delta

## ADDED Requirements

### Requirement: Data Entry keeps a stored self-generation block
Data Entry SHALL never erase or revert a stored self-generation block it does not show. Every edit SHALL name the version of the record the form read, an edit saved as Electricity SHALL send no parameters, and a save refused as `record_changed` SHALL read the record again. A preview or a copy SHALL send the opened or copied record's block, and a move to another category SHALL send no block.

#### Scenario: A draft with a block edited on Data Entry
- **WHEN** a user opens an Electricity draft that holds a self-generation block, changes its quantity and saves
- **THEN** the save sends no parameters, and the record keeps every field of the block

#### Scenario: A block corrected elsewhere while the form is open
- **WHEN** a user opens an Electricity draft whose block states 4,000 generated kWh, another client corrects it to 5,000 kWh, and the user changes the quantity and saves
- **THEN** the save is refused with `record_changed`, the record keeps the 5,000 kWh block, and the form shows the record as stored, so the next save is made on it

#### Scenario: A block added elsewhere while the form is open
- **WHEN** a user opens an Electricity draft without a block, another client adds one, and the user changes the quantity and saves
- **THEN** the save is refused with `record_changed`, and the record keeps the added block

#### Scenario: A draft turned into Electricity elsewhere
- **WHEN** a user opens a Natural Gas draft, another client changes it to Electricity with a block, and the user also picks Electricity and saves
- **THEN** the save is refused with `record_changed`, and the record keeps the block

#### Scenario: A preview of a draft with a block
- **WHEN** a user opens an Electricity draft that holds a self-generation block and the form previews its figure
- **THEN** the preview sends the opened record's block

#### Scenario: The unit changes
- **WHEN** a user changes such a draft from kWh to MWh, enters the quantity again and saves
- **THEN** the record keeps the block unchanged

#### Scenario: The record becomes another category
- **WHEN** a user changes such a draft to Natural Gas in Edit mode and saves
- **THEN** the save sends no self-generation block, and the record is saved as a Natural Gas record

#### Scenario: A category changed by mistake and undone
- **WHEN** a user changes such a draft to Natural Gas, then back to Electricity, enters the quantity again and saves
- **THEN** the save sends no parameters, and the record keeps its block

#### Scenario: A voided record copied to a new draft
- **WHEN** the author copies a voided Electricity record that holds a self-generation block and saves the copy
- **THEN** the new draft holds the same block

#### Scenario: A plain grid record
- **WHEN** a user saves a new Electricity record
- **THEN** no parameters are sent
