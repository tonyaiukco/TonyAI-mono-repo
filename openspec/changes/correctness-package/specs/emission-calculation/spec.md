# Spec Delta

## ADDED Requirements

### Requirement: Typed natural gas inputs are bounded

A typed NCV on a TR natural gas record SHALL lie within the release's `billed_gcv_min` and `billed_gcv_max` scaled by its `reference_ncv ÷ reference_gcv`, about 7,299–9,396 kcal/Sm³ on the loaded releases, or it SHALL be refused with `ncv_out_of_range`. A `volumeCorrectionFactor` SHALL lie within 0.75–30, or it SHALL be refused with `volume_correction_out_of_range`. A release that lacks a row the range needs SHALL answer `parameter_missing`. Both bounds are plausibility limits, not factor values, and are provisional until the external review.

#### Scenario: A CSV decimal read as a small value

- **WHEN** a TR natural gas row carries the typed NCV `8.250`, read as 8.25
- **THEN** the dry run refuses that row as invalid, its message names the accepted range, and nothing is priced from it

#### Scenario: Values on the path today

- **WHEN** a record carries the default NCV, or a typed NCV of 8,080
- **THEN** it is priced as before, with the same snapshot inputs

#### Scenario: A valid bill whose effective NCV falls below the typed range

- **WHEN** a record carries a billed GCV of 10,427 kcal/Sm³, which derives an effective NCV near 7,244
- **THEN** it is priced as before, because the billed GCV has its own range

#### Scenario: A volume factor typed without its decimal point

- **WHEN** a record in m³ carries the factor 97
- **THEN** it is refused with `volume_correction_out_of_range`

#### Scenario: A stored figure

- **WHEN** an approved or locked record holds a value outside either bound
- **THEN** its snapshot stays as stored and readable

#### Scenario: An open draft outside the bound

- **WHEN** a draft holding an out-of-range value is submitted
- **THEN** the submit is refused, and saving it again names the bound it breaks
