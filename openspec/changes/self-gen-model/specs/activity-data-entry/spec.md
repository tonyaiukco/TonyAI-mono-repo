# Spec Delta

## ADDED Requirements

### Requirement: Data Entry carries a stored self-generation block
When Data Entry opens or copies an Electricity record that holds a self-generation block, it SHALL send the stored block unchanged with every preview and save while the record's category stays Electricity. When the category changes, it SHALL send no block. An Electricity record without a block SHALL be previewed and saved with no parameters, as before.

#### Scenario: A draft with a block edited on Data Entry
- **WHEN** a user opens an Electricity draft that holds a self-generation block, changes its quantity and saves
- **THEN** the save sends the stored block, and the record keeps every field of it

#### Scenario: The unit changes
- **WHEN** a user changes such a draft from kWh to MWh, enters the quantity again and saves
- **THEN** the record keeps the block unchanged

#### Scenario: The record becomes another category
- **WHEN** a user changes such a draft to Natural Gas in Edit mode and saves
- **THEN** the save sends no self-generation block, and the record is saved as a Natural Gas record

#### Scenario: A category changed by mistake and undone
- **WHEN** a user changes such a draft to Natural Gas, then back to Electricity, enters the quantity again and saves
- **THEN** the save sends the stored block, and the record keeps it

#### Scenario: A voided record copied to a new draft
- **WHEN** the author copies a voided Electricity record that holds a self-generation block and saves the copy
- **THEN** the new draft holds the same block

#### Scenario: A plain grid record
- **WHEN** a user saves an Electricity record that never held a block
- **THEN** no parameters are sent
