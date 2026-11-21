# Spec Delta

## ADDED Requirements

### Requirement: The review sheet shows a gas energy record's calorific basis
The review sheet SHALL show, read-only, the `cvBasis` a TR natural gas record in kWh or MWh carries, as net or gross in the reader's language, beside its quantity, so the reviewer can compare it with the bill. A record without a basis SHALL show no basis line.

#### Scenario: Reviewing a gross kWh record
- **WHEN** a reviewer opens the review sheet of a submitted TR natural gas record of 1,000 kWh with `cvBasis` `gross`
- **THEN** the sheet shows the calorific basis as "Gross" in English and "Brüt" in Turkish, beside 1,000 kWh

#### Scenario: Reviewing a volume record
- **WHEN** a reviewer opens the review sheet of a TR natural gas record in Sm³
- **THEN** the sheet shows no calorific-basis line
