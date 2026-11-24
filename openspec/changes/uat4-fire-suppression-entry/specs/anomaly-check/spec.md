# Spec Delta

## ADDED Requirements

### Requirement: Fire suppression records are checked per equipment line
A first-period fire suppression record SHALL be checked as a first-period refrigerant record is: it SHALL be flagged when any one of its equipment lines has an installed capacity strictly above 500 kg, or a refill strictly above its refill ceiling (125% of the line's capacity, capped at 500 kg; 500 kg for a line with no capacity). The check SHALL read the stored kilogram figures, whatever unit the line was typed in. The record's totals SHALL NOT be compared.

#### Scenario: A gram figure saved as kilograms
- **WHEN** the first fire suppression record of a site holds an extinguisher line saved as 6,000 kg, a gram figure entered with the selector on kilograms
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: The same figure entered in grams
- **WHEN** the first fire suppression record of a site holds an extinguisher line entered as 6,000 g
- **THEN** the stored line is 6 kg and the record is not flagged

#### Scenario: A refill above 125% of capacity
- **WHEN** the first fire suppression record of a site holds a system line of 40 kg capacity with a refill of 51 kg
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: A dry powder or foam record
- **WHEN** the first fire suppression record of a site is of the dry powder or foam option, with a line of 650 kg
- **THEN** it is flagged as above the first-period ceiling, as a record of any other gas would be

#### Scenario: A refrigerant record is judged as before
- **WHEN** the first refrigerant record of a site holds lines of 120 kg and 650 kg
- **THEN** it is flagged as above the first-period ceiling, unchanged by this rule
