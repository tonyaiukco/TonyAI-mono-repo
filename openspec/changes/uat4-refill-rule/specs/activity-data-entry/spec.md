# Spec Delta

## MODIFIED Requirements

### Requirement: Refrigerant equipment inputs
For a refrigerant record, the form SHALL be annual and SHALL ask, per equipment line, for equipment type, installed capacity (kg) and refilled mass (kg), showing their total as the record's quantity. A line with zero capacity and a refill SHALL be accepted. It SHALL show the equipment type's default leak rate. Only for split air conditioners and chillers, it SHALL offer the release's alternative rate as a choice. The form SHALL say, in Turkish and English, that a line with a refill is priced on the refill alone and that the estimate from the capacity is used only when there was no refill.

#### Scenario: Alternative offered only where defined
- **WHEN** a user picks equipment type `refrigerator`
- **THEN** no alternative leak rate is offered

#### Scenario: The form says how a refill is priced
- **WHEN** a user opens the equipment lines of a refrigerant record in Turkish or in English
- **THEN** the help text says a refill, when there was one, is the line's leak, and the capacity estimate applies only without a refill

#### Scenario: The preview follows the refill
- **WHEN** a user enters a line with a capacity of 10 kg and a refill of 1 kg
- **THEN** the previewed figure is the one for 1 kg of the gas, whichever leak rate is chosen
