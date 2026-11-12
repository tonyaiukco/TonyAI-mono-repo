# organisation-hierarchy Specification

## Purpose
Organisation hierarchy defines the three tiers a tenant's data sits in: the parent company (the organisation), its subsidiaries, and their facilities. It also fixes the names every screen, report and template uses for those tiers, so that users never confuse a legal entity with a physical site.

## Requirements

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

### Requirement: Only a Data Entry user's access depends on subsidiary grants
A Data Entry user SHALL work only in the subsidiaries of its parent company it is granted, and MAY hold grants for any number of them. A Consultant, an Executive Viewer and a Super Admin SHALL see every subsidiary of their parent company and SHALL hold no grants. A grant SHALL never name another parent company's subsidiary.

#### Scenario: A Data Entry user granted two subsidiaries
- **WHEN** a Data Entry user holds grants for subsidiaries A and B of its parent company, which also has subsidiary C
- **THEN** the user can read and enter data for A and B, and cannot read C's data

#### Scenario: A consultant needs no grant
- **WHEN** a Super Admin invites a Consultant
- **THEN** the invitation carries no subsidiary, and the Consultant sees every subsidiary of the parent company once the invitation is accepted

#### Scenario: Grants refused for another role
- **WHEN** a request grants subsidiaries to a user whose role is not Data Entry
- **THEN** the system refuses it with the error code `access_role_mismatch` and changes nothing

### Requirement: The users list names a Data Entry user's subsidiaries
The users list SHALL show, for a Data Entry user, the names of its granted subsidiaries in name order. It SHALL show at most three names and SHALL replace the rest with "+N daha" in Turkish or "+N more" in English, and it SHALL make the full list available on the row. It SHALL NOT show only a count of the grants.

#### Scenario: Two grants
- **WHEN** a Data Entry user holds grants for "Beta Dağıtım" and "Alfa Dağıtım"
- **THEN** the access column reads "Alfa Dağıtım, Beta Dağıtım"

#### Scenario: Five grants
- **WHEN** a Data Entry user holds grants for five subsidiaries
- **THEN** the access column shows the first three names in name order followed by "+2 daha" (EN "+2 more"), and the full list of five is available on the row

#### Scenario: Another role
- **WHEN** the row is a Consultant, an Executive Viewer or a Super Admin
- **THEN** the access column reads "Ana şirketin tamamı" (EN "Whole parent company")

### Requirement: A Data Entry user with no grant is marked
The users list SHALL mark a Data Entry user that holds no grant as having no access, as a warning, reading "Erişim verilmedi" in Turkish and "None granted" in English.

#### Scenario: Invited with no subsidiary
- **WHEN** a Data Entry user holds no grant
- **THEN** the access column reads "Erişim verilmedi" (EN "None granted") with a warning style, beside the edit access action

### Requirement: Editing a Data Entry user's access is a visible action
Each Data Entry row of the users list SHALL show an "Erişimi düzenle" (EN "Edit access") action in its access cell that opens that user's subsidiary access for editing. The row's action menu SHALL NOT be the only way to reach it. Rows of other roles SHALL NOT show the action.

#### Scenario: Editing from the row
- **WHEN** a Super Admin selects "Erişimi düzenle" on a Data Entry row, ticks a further subsidiary and saves
- **THEN** the user's grants include the further subsidiary, the access column names it, and one audit row records the added grant

#### Scenario: No action on a consultant row
- **WHEN** the row is a Consultant
- **THEN** the access cell shows no edit access action

### Requirement: The subsidiary picker shows and changes the whole selection
Wherever a Super Admin chooses a Data Entry user's subsidiaries, the picker SHALL show how many of the parent company's subsidiaries are selected, as "n / m seçili" in Turkish or "n of m selected" in English. It SHALL offer to select all and to clear the selection.

#### Scenario: Select all
- **WHEN** the parent company has ten subsidiaries and the Super Admin selects "Tümünü seç" (EN "Select all")
- **THEN** all ten are ticked and the picker reads "10 / 10 seçili" (EN "10 of 10 selected")

#### Scenario: Clear
- **WHEN** three subsidiaries are ticked and the Super Admin selects "Temizle" (EN "Clear")
- **THEN** none is ticked and the picker reads "0 / 10 seçili" (EN "0 of 10 selected")

### Requirement: An empty selection is warned, not refused
When no subsidiary is selected for a Data Entry user, the picker SHALL warn that the user cannot enter data until one is. Saving or inviting SHALL still be allowed.

#### Scenario: Inviting with none ticked
- **WHEN** a Super Admin invites a Data Entry user with no subsidiary ticked
- **THEN** the picker shows the warning, the invitation is sent, and the users list marks the user as having no access

#### Scenario: No subsidiary exists yet
- **WHEN** a Super Admin invites a Data Entry user, or makes a user Data Entry, in a parent company with no subsidiary
- **THEN** the picker says there are no subsidiaries yet, reads "0 / 0 seçili" (EN "0 of 0 selected"), shows the warning, and still allows inviting or saving

### Requirement: The invitation states each role's access
The invite dialog SHALL state, for a role other than Data Entry, that the role sees every subsidiary of the parent company and needs no subsidiary choice. For Data Entry it SHALL show the subsidiary picker.

#### Scenario: Choosing Consultant
- **WHEN** a Super Admin chooses Consultant in the invite dialog
- **THEN** the dialog shows the whole-parent-company note in place of the picker

#### Scenario: Back to Data Entry
- **WHEN** the Super Admin then chooses Data Entry again
- **THEN** the picker reappears with the selection made before

### Requirement: A role change to Data Entry leads to the access choice
After a Super Admin changes a user's role to Data Entry, the system SHALL open that user's subsidiary access for editing.

#### Scenario: Consultant becomes Data Entry
- **WHEN** a Super Admin changes a Consultant's role to Data Entry and the change succeeds
- **THEN** the access editor opens for that user with no subsidiary ticked and the empty-selection warning shown

#### Scenario: Closing without choosing
- **WHEN** the Super Admin closes the access editor without saving
- **THEN** the role stays Data Entry and the users list marks the user as having no access
