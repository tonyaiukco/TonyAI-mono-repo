# Spec Delta

## MODIFIED Requirements

### Requirement: Mobile combustion by vehicle mode
A TR mobile record for a road or off-road vehicle SHALL name one of the five vehicle modes and SHALL be priced per litre for that mode. The per-litre factor is `density × NCV × 4.184e-9 × (CO2 + CH4 × 27.0 + N2O × 273)`, computed from the document's formula, not taken from its combined column.

#### Scenario: Golden values 6–7
- **WHEN** 15,973.75 L on-road petrol and 3,784.51 L on-road diesel are calculated for 2025
- **THEN** the results are 36,864.62 and 10,090.24 kgCO2e (±0.5%)

#### Scenario: A vehicle mode entered by mass
- **WHEN** a TR on-road diesel record is entered in kg or tonnes
- **THEN** it is refused with `no_factor`, because the vehicle modes are priced per litre only

## ADDED Requirements

### Requirement: Marine gas oil by mass
A TR Mobile Combustion record of type marine gas oil SHALL be priced per kilogram from the MGO edition. The per-kilogram factor is `NCV (TJ/kg) × (CO2 + CH4 × 27.0 + N2O × 273)` with the IPCC water-borne navigation factors in kg/TJ. A record in tonnes SHALL first be converted to kilograms by definition. The record is Scope 1.

#### Scenario: Tonnes and kilograms agree
- **WHEN** one TR MGO record of 12.5 t and another of 12,500 kg are calculated for 2025
- **THEN** both give the same kgCO2e, equal to 12,500 × the edition's per-kilogram CO2e factor

#### Scenario: The snapshot cites the MGO edition
- **WHEN** a TR MGO record is calculated
- **THEN** its snapshot names the MGO edition, its factor rows' source and methodology, and the tonnes-to-kilograms conversion when one was applied

#### Scenario: MGO entered by volume
- **WHEN** a TR MGO record is entered in litres
- **THEN** it is refused with `no_factor`, because no density is held for MGO
