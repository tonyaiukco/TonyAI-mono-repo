# Spec Delta

## MODIFIED Requirements

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
