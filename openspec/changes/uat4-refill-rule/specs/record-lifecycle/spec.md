# Spec Delta

## ADDED Requirements

### Requirement: An operator re-prices open refrigerant drafts under the refill rule
An operator command SHALL re-price Türkiye refrigerant records in `draft` or `rejected` with a line whose capacity and refill are positive, outside locked periods. It SHALL write only in apply mode. A re-priced record SHALL keep its status, author and inputs, carry the recalculated snapshot and anomaly verdict, and get one `reprice` audit row with no user and both figures. Concurrent runs SHALL record that re-pricing once.

#### Scenario: A dry run
- **WHEN** the command runs without the apply switch over a database holding an affected draft
- **THEN** it reports the record and its figure before and after, and no record and no audit row is written

#### Scenario: A draft is re-priced
- **WHEN** the command applies to a draft with a line of 50 kg capacity and 35 kg refill of HFC-227ea priced under the sum rule
- **THEN** the draft's figure becomes 126.00 tCO2e, its status, author and inputs are unchanged, and one `reprice` audit row with no user names 129.60 and 126.00

#### Scenario: A rejected record is re-priced
- **WHEN** the command applies to a rejected record with a line holding both masses
- **THEN** it is re-priced as a draft is, and stays `rejected`

#### Scenario: A second run
- **WHEN** the command applies again after every affected draft was re-priced
- **THEN** it re-prices nothing and writes no audit row

#### Scenario: Two runs read the same draft
- **WHEN** two apply runs read the same old snapshot before either writes
- **THEN** one run replaces the snapshot and writes one `reprice` audit row, and the other reports the record as already up to date

#### Scenario: Another writer saves a different snapshot
- **WHEN** the snapshot changes to a figure or provenance different from the one an apply run computed, while the record remains open with the same inputs
- **THEN** the command reports the conflict and leaves the newer snapshot and audit trail intact

#### Scenario: A draft in a locked period
- **WHEN** an affected draft sits in a locked period
- **THEN** it is reported as skipped and is not written

#### Scenario: A draft the engine refuses
- **WHEN** an affected draft can no longer be calculated
- **THEN** it is reported with the refusal and is not written

#### Scenario: A re-priced draft is submitted
- **WHEN** the author submits a draft the command re-priced
- **THEN** it is not refused as stale

### Requirement: Re-pricing never writes a committed record
The command SHALL NOT change a `submitted`, `under_review`, `approved`, `locked` or `voided` record. It SHALL list `submitted` and `under_review` records with a positive-capacity, positive-refill line priced under the sum rule, and report candidates whose rule cannot be identified separately. A record that leaves an open status or whose inputs change before the command acquires its lock SHALL remain as the other writer left it.

#### Scenario: Approved and locked records
- **WHEN** the command applies over a database holding approved and locked records with lines holding both masses
- **THEN** every such record's snapshot, figure and anomaly verdict are byte-identical to before, and no audit row names them

#### Scenario: A submitted record
- **WHEN** the command finds `submitted` or `under_review` records with both masses priced under the sum rule and others priced under the refill rule
- **THEN** it lists only the sum-rule records as affected and writes nothing to those records or the new-rule records

#### Scenario: The rule cannot be read from a review-queue snapshot
- **WHEN** the command finds a review-queue candidate with both masses and a snapshot that lacks the terms needed to identify its rule
- **THEN** it reports the record as unclassified and writes nothing

#### Scenario: A draft submitted while the command runs
- **WHEN** a draft is submitted after the command read it and before the command writes it
- **THEN** the command leaves it unchanged and reports it as no longer open
