# Spec Delta

## Purpose
Activity data entry is how users supply the quantities and per-record inputs a calculation needs, on the Data Entry form and through bulk upload, in Turkish and English.

## ADDED Requirements

### Requirement: Catalogue for the pilot's Scope 1 sources
The Data Entry form and the bulk template SHALL offer the following:
- Fuel types petrol, coal and LNG.
- The `kg` unit for Fuel.
- The five Mobile Combustion vehicle modes.
- The gases HFC-227ea, SF6 and R-22.
- A Fugitive Gas category with the Sm³ unit.

Labels SHALL exist in both the TR and EN catalogues. Existing activity types SHALL stay valid for existing records.

#### Scenario: A mobile record names its mode
- **WHEN** a user picks Mobile Combustion
- **THEN** the form asks for one of the five vehicle modes, and the unit is litres

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
