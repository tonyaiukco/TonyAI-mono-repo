# Spec Delta

## ADDED Requirements

### Requirement: Refusal families answer with their own HTTP status
A calculation the factor library cannot cover (`no_factor`, `placeholder_refused`, `no_conversion`, `calorific_basis_mismatch`) SHALL be refused with HTTP 422 and keep its code, message and coverage. An input refusal SHALL answer 400, and a library that contradicts itself SHALL answer 409. A subsidiary, location or record the caller cannot reach SHALL still answer the plain 404, with nothing about the factor library.

#### Scenario: No factor covers the lookup
- **WHEN** a record is created for a category, geography and year that no factor covers
- **THEN** the API answers 422 with the code `no_factor` and the coverage key it looked up
- **AND** no record is written

#### Scenario: Gas energy on the wrong calorific basis
- **WHEN** a TR natural gas record is created in kWh, which today's TR rules refuse
- **THEN** the API answers 422 with the code `calorific_basis_mismatch`

#### Scenario: A malformed input stays a 400
- **WHEN** a record carries a unit its category does not accept
- **THEN** the API answers 400 with the code `unit_not_for_category`

#### Scenario: A self-contradicting library stays a 409
- **WHEN** two releases claim the same factor key at the same rank
- **THEN** the API answers 409 with the code `ambiguous_factor`

#### Scenario: A foreign subsidiary stays a plain 404
- **WHEN** a caller previews or creates a record for another tenant's subsidiary for which no factor exists
- **THEN** the API answers 404 with the entity's not-found code and nothing about the factor library

#### Scenario: Bulk upload still names the row's problem
- **WHEN** a bulk upload row cannot be priced because no factor covers it
- **THEN** the row's issue is `no_factor`, not `not_found`
