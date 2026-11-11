# Spec Delta

## ADDED Requirements

### Requirement: A withdrawn record is described as not included in the calculation
Wherever the dashboard or Emissions describes a withdrawn (voided) record's effect on figures, the wording SHALL say that the record is not included in the calculation. In Turkish it SHALL read "hesaplamaya dahil edilmedi" or "hesaplamaya dahil edilmez". Informal phrasing such as "hiçbir şeye sayılmaz" SHALL not be used.

#### Scenario: Dashboard cell with a withdrawn record
- **WHEN** a matrix cell holds one withdrawn record and the user reads its summary in Turkish
- **THEN** it reads "Geri çekilen kayıt (hesaplamaya dahil edilmedi)" with the count

#### Scenario: Emissions record with no figure
- **WHEN** a user opens a withdrawn record on Emissions in English
- **THEN** it reads "Withdrawn — the entry is not included in the calculation."
