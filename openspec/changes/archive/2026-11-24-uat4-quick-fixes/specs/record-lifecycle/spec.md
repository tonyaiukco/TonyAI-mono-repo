# Spec Delta

## ADDED Requirements

### Requirement: The review sheet shows a record's invoice number and supplier
When a record carries an invoice number or a supplier, the review sheet SHALL show each one that is present, labelled in TR and EN, so the reviewer can match the record to its evidence file. For an Electricity record the supplier shown SHALL be its utility provider. A record without either SHALL show neither row.

#### Scenario: A record with both
- **WHEN** a reviewer opens a submitted Mobile Combustion record holding invoice number `OZK2025000011923` and supplier `Petrol Ofisi`
- **THEN** the sheet shows an Invoice number row and a Supplier row with those values

#### Scenario: An Electricity record's utility provider
- **WHEN** a reviewer opens a submitted Electricity record whose utility provider is `Enerjisa`
- **THEN** the sheet shows `Enerjisa` in the Supplier row

#### Scenario: A record with neither
- **WHEN** a reviewer opens a record that holds no invoice number and no supplier
- **THEN** the sheet shows no Invoice number row and no Supplier row
