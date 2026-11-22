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

### Requirement: A net energy bill's quantity is sent again when an update moves it
An update to a natural gas record stored in kWh or MWh that changes its unit or category, on either basis, or, stored with `cvBasis` `net`, its site or basis, SHALL carry the quantity, or be refused with `activity_value_reentry_required` (400) and change nothing. The inherited figure would otherwise be read at another scale or meaning, or as gross. The refusal comes after the record's scope, period-lock and calculation checks, which keep their answers.

#### Scenario: A net bill moved to another site without its quantity
- **WHEN** an update moves a stored net kWh bill to another site and sends no quantity
- **THEN** it is refused with `activity_value_reentry_required`, and the record keeps its site, unit, quantity and basis

#### Scenario: The quantity sent with the move
- **WHEN** the same update also sends the quantity
- **THEN** the record moves and is priced from the figure sent

#### Scenario: A gross bill moved
- **WHEN** an update moves a stored gross kWh bill to another site without its quantity
- **THEN** it moves, since a gross figure is what every geography prices

#### Scenario: A gross bill given another unit
- **WHEN** an update changes a stored gross 1,000 kWh bill to MWh without its quantity
- **THEN** it is refused with `activity_value_reentry_required`, and the record keeps 1,000 kWh

