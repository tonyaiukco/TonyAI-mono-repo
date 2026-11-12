# Spec Delta

## Purpose

Organisation hierarchy defines the three tiers a tenant's data sits in: the parent company (the organisation), its subsidiaries, and their facilities. It also fixes the names every screen, report and template uses for those tiers, so that users never confuse a legal entity with a physical site.

## ADDED Requirements

### Requirement: Each independent customer is its own parent company
Each independent customer SHALL be one organisation, whether it is a holding or a standalone company. Its data SHALL never be held in the same organisation as another customer's. Emissions of two organisations SHALL never be summed into one report.

#### Scenario: Two unrelated customers
- **WHEN** a holding and an unrelated standalone company are both customers
- **THEN** each is its own organisation, and no screen, report or export of one shows the other's subsidiaries, facilities or emissions

### Requirement: The parent company and the subsidiary have fixed names
Every screen SHALL call the organisation "Ana Şirket" in Turkish and "Parent company" in English, and SHALL NOT call it "Kuruluş" or "Organisation". A subsidiary SHALL be called "Bağlı Şirket" in Turkish and "Subsidiary" in English.

#### Scenario: User access in English
- **WHEN** a super_admin views a consultant in User Management in English
- **THEN** the access column names the whole parent company, never "Whole organisation"

### Requirement: A facility has a fixed name
Every screen SHALL call a location "İşletme / Tesis" in Turkish headings, column headers and field labels, "tesis" in Turkish running text, and "Facility" in English. It SHALL NOT call a location "Lokasyon", "Saha", "Konum" or "Site".

#### Scenario: Managing a subsidiary's facilities
- **WHEN** a super_admin opens a subsidiary's facilities in Turkish
- **THEN** the list, its column header and its add, edit and delete controls say "İşletme / Tesis" or "tesis", never "Lokasyon"

### Requirement: Reports and the bulk template use the same names
Every report and issuance generated from now on, and the bulk upload template, SHALL use the tier names the screens use. An issued PDF already stored SHALL stay as issued. Tables written on request for an older issuance SHALL use the current names and SHALL name their renderer version, which changes with the names.

#### Scenario: Bulk template headers
- **WHEN** a user downloads the bulk upload template
- **THEN** its reporting-entities table heads the location column "Facility", and the upload columns keep their keys

### Requirement: A subsidiary as a whole is named as a subsidiary
A record, slot or figure that belongs to a subsidiary without naming a facility SHALL be described as "Bağlı şirketin tamamı" in Turkish and "Whole subsidiary" in English. It SHALL NOT be described as "Şirket bütünü", "Şirketin tamamı" or "Whole company", because those can be read as the parent company.

#### Scenario: A record with no facility
- **WHEN** Data Entry lists a record entered for a subsidiary with no facility selected
- **THEN** its facility column says "Bağlı şirketin tamamı" in Turkish and "Whole subsidiary" in English

### Requirement: A subsidiary's place field is an address
The subsidiary's free-text place field SHALL be labelled "Adres / Konum" in Turkish and "Address" in English. It SHALL NOT be labelled as a facility.

#### Scenario: Creating a subsidiary
- **WHEN** a super_admin creates a subsidiary
- **THEN** the free-text place field is labelled "Adres / Konum", and the facilities it declares are labelled "İşletme / Tesis"

### Requirement: Terms with another meaning keep it
The GHG Protocol term for location-based Scope 2 ("konum bazlı", EN "location-based") SHALL keep its wording. A sentence that uses "kuruluş" for the reporting company in the GHG Protocol sense, rather than the parent company, SHALL keep its meaning.

#### Scenario: Scope 2 label
- **WHEN** a report labels the Scope 2 figure
- **THEN** it still says "Kapsam 2 (konum bazlı)" in Turkish
