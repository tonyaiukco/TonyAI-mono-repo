# Spec Delta

## MODIFIED Requirements

### Requirement: Refrigerant capacity method
A refrigerant record SHALL be one gas on an annual period, with one line per equipment type, each carrying an installed capacity and a refilled mass in kg (zero allowed). Its activity value SHALL equal the sum of the capacities. Each line SHALL be priced on its refill when the refill is above zero, and otherwise on `capacity × leak rate`, never on both. The record SHALL be priced as the sum of its lines' masses × GWP. A record on another period, or with no equipment line, SHALL be refused. The leak rate is the equipment type's default parameter. The user may select the release's alternative instead: 10% for split air conditioners and 8% for chillers. The chosen rate and whether it is the default SHALL be in the snapshot. R-22 SHALL be priced in Scope 1 like the other gases (owner decision 2026-11-05).

#### Scenario: Golden value 9 (FM200)
- **WHEN** a fire-suppression system holding 40 kg of HFC-227ea with no refill is calculated for 2025
- **THEN** the result is 2,880.00 kgCO2e (±0.5%) and the snapshot records leak rate 0.02 as the default

#### Scenario: A refill replaces the estimate (FM200, BUG-17)
- **WHEN** a fire-suppression system holding 50 kg of HFC-227ea with a refill of 35 kg is calculated for 2025
- **THEN** the result is 126,000.00 kgCO2e (±0.5%), not 129,600, and the snapshot records that the line was priced on its refill

#### Scenario: Two equipment types, one gas
- **WHEN** an annual R-410A record has a split air conditioner line and a chiller line
- **THEN** each line uses its own rate, the result is their sum, and the snapshot records both terms

#### Scenario: A line with a refill beside a line without
- **WHEN** an annual record has one line with a capacity and a refill, and another line with a capacity and no refill
- **THEN** the first line is priced on its refill alone, the second on its capacity × its leak rate, and the result is their sum

#### Scenario: A line with a refill and no capacity
- **WHEN** an annual record has a line of 0 kg capacity with a refill of 2 kg
- **THEN** the line is priced on 2 kg, as before this rule

#### Scenario: A monthly refrigerant record
- **WHEN** a TR refrigerant record names a monthly period
- **THEN** it is refused, because the document's leak rates are yearly

#### Scenario: Alternative leak rate
- **WHEN** a split air conditioner record with no refill selects the 10% alternative
- **THEN** the calculation uses 0.10 and the snapshot marks the rate as the user's alternative

#### Scenario: Alternative leak rate on a line with a refill
- **WHEN** a split air conditioner line with a capacity and a refill selects the 10% alternative
- **THEN** the line is priced on its refill alone, and the snapshot still records the chosen rate and that it is the user's alternative

## ADDED Requirements

### Requirement: A refrigerant figure keeps the rule it was priced under
A refrigerant snapshot written under the earlier sum rule SHALL keep its figure and SHALL be read as the sum of the estimate and the refill. A new snapshot SHALL mark every line with positive capacity and refill as refill-priced and leave other lines unmarked. A record with no such line SHALL have the same snapshot under both rules and SHALL NOT read as stale because of this rule.

#### Scenario: An approved record from before the rule
- **WHEN** a record approved under the sum rule, with a line of 50 kg capacity and 35 kg refill, is read after the rule changed
- **THEN** its snapshot and its figure are byte-identical to before, and its line's mass is read as the estimate plus the refill

#### Scenario: A draft with no refill is submitted after the rule changed
- **WHEN** a draft priced before the rule, whose lines have no refill, is submitted after it
- **THEN** it is not refused as stale

#### Scenario: A draft with a refill and no capacity is submitted after the rule changed
- **WHEN** a draft priced before the rule, whose only line has 0 kg capacity and a refill, is submitted after it
- **THEN** the line needs no marker, its snapshot is identical under both rules, and submission is not refused as stale because of the rule change

#### Scenario: A submitted record with both masses is approved after the rule changed
- **WHEN** a reviewer approves a record submitted before the rule, with a line holding both a capacity and a refill
- **THEN** it is refused with `calculation_stale` and nothing changes; after it returns to its author and is saved again, it is priced on the refill alone

### Requirement: A report states how a refrigerant line was priced
For a marked line, live and issued reports SHALL identify the refill as the released mass and say the capacity estimate was excluded. Unmarked lines SHALL retain the estimate-plus-refill wording. PDF and XLSX SHALL use the Turkish or English report locale. CSV SHALL use English and preserve its columns. A stored issued PDF SHALL keep its original bytes. Issued XLSX SHALL identify the tables renderer on its Summary sheet.

#### Scenario: A refill-priced line in a report
- **WHEN** a report lists a record with a line of 50 kg capacity and 35 kg refill priced under the new rule
- **THEN** its calculation inputs give 35 kg as the released mass, name the 50 kg capacity and the rate, and say the estimate was not added

#### Scenario: A sum-rule line in the same report
- **WHEN** the same report lists a record approved under the sum rule with a line of 10 kg capacity at 10% and 0.5 kg refill
- **THEN** its calculation inputs still read 10 kg × 10% + 0.5 kg refilled = 1.5 kg released

#### Scenario: A line with no refill
- **WHEN** a report lists a record with a line of 40 kg capacity at 2% and no refill
- **THEN** its calculation inputs read as before this rule, with 0.8 kg released

#### Scenario: A line with a refill and zero capacity
- **WHEN** a report lists an unmarked line with 0 kg capacity and a 2 kg refill
- **THEN** it uses the existing estimate-plus-refill wording and gives 2 kg as the released mass

#### Scenario: Exports identify the wording and renderer
- **WHEN** live and issued PDF, XLSX and CSV exports are generated for a report with a marked line
- **THEN** PDF and XLSX use the report locale, CSV uses English with the same columns, and the issued workbook's Summary names `tonyai-issuance-tables-v6`
