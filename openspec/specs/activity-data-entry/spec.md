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
On Submit, the Data Entry form SHALL save the record first. If its category is evidence-required and it has no file, the form SHALL stay open on the saved draft with the evidence vault visible, tell the user in TR or EN to attach a file, and not send the submit request. The API's refusal SHALL remain the final word.

#### Scenario: A new mobile record is submitted without a file
- **WHEN** a data_entry user fills a new Mobile Combustion record and clicks Submit
- **THEN** the record is saved as a draft, the form stays open with the evidence vault visible, a toast asks for a file, and the record is not submitted

#### Scenario: The user attaches a file and submits again
- **WHEN** the user then uploads a file in the vault and clicks Submit
- **THEN** the record is submitted and the form resets

#### Scenario: An exempt category submits in one click
- **WHEN** a user fills a new Waste record and clicks Submit
- **THEN** the record is saved and submitted without asking for a file

#### Scenario: The required note fits the category
- **WHEN** the vault of a Mobile Combustion, Refrigerants or Fugitive Gas record has no file
- **THEN** it shows the "required" badge and a note, in TR and EN, naming evidence such as a fuel receipt or card, a service record or a leak report
