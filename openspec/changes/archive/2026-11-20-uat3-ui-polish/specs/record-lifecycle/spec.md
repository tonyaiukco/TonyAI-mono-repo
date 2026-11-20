# Spec Delta

## MODIFIED Requirements

### Requirement: A withdrawn record is described as not included in the calculation
Wherever the dashboard, Emissions, the void dialog or bulk upload describes how a withdrawn (voided) or draft record affects figures, the wording SHALL say that the record is not included in the calculation. In Turkish it SHALL read "hesaplamaya dahil edilmedi" or "hesaplamaya dahil edilmez", or say that it is not included ("dahil edilmez") in the named totals. Informal counting phrasing such as "hiçbir şeye sayılmaz", "hiçbir toplama sayılmaz" or "sayılmaz hale gelir" SHALL not be used.

#### Scenario: Dashboard cell with a withdrawn record
- **WHEN** a matrix cell holds one withdrawn record and the user reads its summary in Turkish
- **THEN** it reads "Geri çekilen kayıt (hesaplamaya dahil edilmedi)" with the count

#### Scenario: Emissions record with no figure
- **WHEN** a user opens a withdrawn record on Emissions in English
- **THEN** it reads "Withdrawn — the entry is not included in the calculation."

#### Scenario: The void dialog states the effect
- **WHEN** a user opens the void dialog for an approved record in Turkish
- **THEN** its effect line says the record is no longer included in totals, reports and invoice coverage ("artık dahil edilmez")
- **AND** it does not say "sayılmaz hale gelir"

#### Scenario: Bulk upload describes imported drafts
- **WHEN** a user reads a bulk upload dry-run summary or its apply confirmation in Turkish
- **THEN** it says the imported drafts are not included in the calculation until they are submitted ("hesaplamaya dahil edilmez")
- **AND** it does not say "hiçbir toplama sayılmaz"
