# Spec Delta

## ADDED Requirements

### Requirement: Data Entry keeps a stored self-generation block
Data Entry SHALL never erase or revert a stored self-generation block it does not show. An edit of an Electricity record saved as Electricity SHALL send no parameters, so the server keeps the block it holds at the moment of the save. A preview or a copy SHALL send the opened or copied record's block, and a move to another category SHALL send no block.

#### Scenario: A draft with a block edited on Data Entry
- **WHEN** a user opens an Electricity draft that holds a self-generation block, changes its quantity and saves
- **THEN** the save sends no parameters, and the record keeps every field of the block

#### Scenario: A block corrected elsewhere while the form is open
- **WHEN** a user opens an Electricity draft whose block states 4,000 generated kWh, another client corrects it to 5,000 kWh, and the user changes the quantity and saves
- **THEN** the record keeps the 5,000 kWh block

#### Scenario: A block added elsewhere while the form is open
- **WHEN** a user opens an Electricity draft without a block, another client adds one, and the user changes the quantity and saves
- **THEN** the record keeps the added block

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
