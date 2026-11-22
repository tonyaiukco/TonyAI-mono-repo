## MODIFIED Requirements

### Requirement: Natural gas per-record inputs
For a TR natural gas record in Sm³, the form SHALL show NCV prefilled with 8,250 kcal/Sm³ and editable. It SHALL show an optional billed GCV field, and the two are mutually exclusive. For a record in m³, the form SHALL require a volume correction factor. The form SHALL also offer TR natural gas in kWh and MWh, after the volume units, so that a new record still starts on the volume unit it starts on today. For a record in kWh or MWh, the form SHALL require a calorific basis, net or gross, chosen by the author, with no default, and SHALL show no NCV, billed GCV or volume correction field. Until a basis is chosen, the form SHALL NOT preview or save the record, and SHALL say that the bill's basis is missing. Changing the basis SHALL keep the quantity. Edits SHALL be saved with the record and audited like any other field. Bulk upload SHALL accept the same inputs as optional columns. It SHALL also accept a `cvBasis` column, `net` or `gross` in any letter case, which a TR natural gas row in kWh or MWh requires, and the dry run SHALL show the basis it read.

#### Scenario: The user edits the NCV
- **WHEN** a user changes NCV to 8,100 and saves
- **THEN** the record stores 8,100 as user-entered, and the preview's conversion note shows it

#### Scenario: A new TR gas record offers kWh and MWh
- **WHEN** a user starts a new TR natural gas record
- **THEN** the unit list offers m³, Sm³, kWh and MWh, and the form starts on m³ as before

#### Scenario: A bill in kWh needs its basis
- **WHEN** a user picks kWh on a new TR natural gas record and enters 1,000
- **THEN** a net / gross choice appears with neither option selected, no NCV, billed GCV or volume correction field is shown, nothing is previewed, the save buttons are disabled, and the form says the bill's calorific basis is missing (TR and EN)

#### Scenario: A net bill entered on the form
- **WHEN** the user then chooses net and saves
- **THEN** the record is created in kWh with `cvBasis` `net`, priced against the net factor, which on the TR 2025 release is 202.16 kgCO2e

#### Scenario: A bill in MWh
- **WHEN** a user enters 1 MWh on a TR natural gas record and chooses gross
- **THEN** the record is created in MWh with `cvBasis` `gross`, and on the TR 2025 release it is priced at 182.17 kgCO2e

#### Scenario: The basis is corrected before save
- **WHEN** a user has entered 1,000 kWh with net chosen and switches to gross
- **THEN** the quantity stays 1,000, and the preview and the save send `cvBasis` `gross`

#### Scenario: A bulk kWh row with its basis
- **WHEN** a bulk file's TR natural gas row states 1,000 kWh and `cvBasis` `GROSS`
- **THEN** the dry run accepts it at 182.17 kgCO2e and shows its basis as gross (TR: brüt), and the import stores `cvBasis` `gross` on the record

#### Scenario: A bulk kWh row without its basis
- **WHEN** a bulk file's TR natural gas row states kWh and leaves `cvBasis` empty
- **THEN** the row is refused as invalid, and its message asks for net or gross rather than reporting a missing factor

#### Scenario: A bulk basis that is not net or gross
- **WHEN** a bulk row carries `cvBasis` `brut`
- **THEN** the row is refused as invalid, and its message names the two accepted values

#### Scenario: A basis on a row of another category
- **WHEN** a bulk Electricity row, or a refrigerant equipment line, carries a `cvBasis`
- **THEN** the row is refused as invalid, as for any gas column on another category, and the basis is never silently dropped

#### Scenario: The template documents the column
- **WHEN** a user downloads the bulk template
- **THEN** its calculation-inputs reference names `cvBasis`, its two values, and that a TR natural gas row in kWh or MWh requires it

### Requirement: Data Entry carries a stored calorific basis
When Data Entry opens, or copies, a TR natural gas record in kWh or MWh, it SHALL keep the record's unit, quantity and `cvBasis` while the record stays under the geography it was priced in. It SHALL show the stored basis selected in the net / gross choice, which the author MAY change. It SHALL send the chosen basis with every preview and save while the record stays under the TR rules in an energy unit. A gross bill's preview SHALL name the gross-to-net ratio.

#### Scenario: An imported kWh draft edited on Data Entry
- **WHEN** a user opens an imported TR natural gas draft in kWh with `cvBasis` `gross`, changes an ordinary field, attaches its evidence file, saves, and submits it
- **THEN** the form shows gross (TR: brüt) selected, the preview and the save send `cvBasis` `gross`, the figure equals the one calculated at import, and the submit is accepted

#### Scenario: A stored basis corrected on Data Entry
- **WHEN** a user opens an imported TR natural gas draft of 1,000 kWh with `cvBasis` `net`, chooses gross and saves
- **THEN** the record keeps 1,000 kWh, stores `cvBasis` `gross`, and is priced as a gross bill

#### Scenario: A voided kWh record copied to a new draft
- **WHEN** the author copies a voided TR natural gas record of 1,000 kWh with `cvBasis` `net`
- **THEN** the new form keeps kWh, 1,000 and net selected, and does not fall back to a volume unit or clear the quantity

#### Scenario: A gross bill's preview names the ratio
- **WHEN** an imported gross kWh draft is previewed
- **THEN** the preview says the figure was reduced to net by the factor release's ratio, and never that kWh was converted to kWh

#### Scenario: A UK kWh copy moved to a TR subsidiary
- **WHEN** a voided UK natural gas record in kWh is copied and moved to a TR subsidiary
- **THEN** the unit and the quantity are kept, the net / gross choice appears with neither option selected, and nothing is previewed or saved until a basis is chosen

#### Scenario: A copy moved across the TR rules is narrowed like a new record
- **WHEN** a voided UK natural gas record in therms is copied and moved to a TR subsidiary
- **THEN** the unit falls back to what the TR rules offer and the quantity is cleared, as for a new record

#### Scenario: A volume record never sends a basis
- **WHEN** a TR natural gas record in Sm³ or m³ is previewed or saved
- **THEN** no `cvBasis` is sent

### Requirement: A net energy figure leaving the TR rules is entered again
Whenever Data Entry holds a natural gas record in kWh or MWh with `cvBasis` `net` under a subsidiary or site outside the TR rules, however it got there (moved, opened after its site's geography changed, or copied there), it SHALL clear the quantity and its basis and ask for the quantity again, because those rules price an energy bill as gross. It SHALL NOT price a net figure as gross, nor a figure entered afterwards as net. A gross figure SHALL be kept. Outside the TR rules the form SHALL show no basis choice.

#### Scenario: A net draft moved to a UK site
- **WHEN** a user moves a TR natural gas draft of 1,000 kWh with `cvBasis` `net` to a UK site
- **THEN** the quantity is cleared, a notice asks for the bill's gross figure, and nothing is previewed or saved until it is entered

#### Scenario: A gross draft moved to a UK site
- **WHEN** the same draft holds `cvBasis` `gross`
- **THEN** the quantity is kept and priced as a gross kWh figure, and no basis is sent

#### Scenario: A draft opened after its site was re-classified
- **WHEN** a TR net kWh draft is opened after its site's geography was changed to UK
- **THEN** the quantity and the basis are cleared on opening, and a notice asks for the bill's gross figure

#### Scenario: A voided net bill copied into a UK subsidiary's form state
- **WHEN** a voided net kWh record is copied and the copy is placed under a UK subsidiary
- **THEN** the quantity and the basis are cleared, as for a move

#### Scenario: A site the page has not loaded
- **WHEN** a draft is opened whose site was created after the page loaded
- **THEN** nothing is previewed or saved until the site is read, so the record is never priced, or cleared, under its subsidiary's geography in place of its site's

#### Scenario: Back to Türkiye after the figure was entered again
- **WHEN** the user enters the gross figure on the UK site and moves the draft back to the TR subsidiary
- **THEN** the net / gross choice appears with neither option selected, nothing is sent as a basis, and the figure is not priced until a basis is chosen, never as net

## ADDED Requirements

### Requirement: A gross gas bill shows its net figure before save
When a TR natural gas record in kWh or MWh has gross chosen and a quantity entered, Data Entry SHALL show before save the net quantity it will be priced on, in the record's own unit, and the ratio that derives it, naming its release. The ratio SHALL be the one the calculation applies: `reference_ncv / reference_gcv` of the factor's release. Without such a ratio the form SHALL show no derived figure and SHALL NOT substitute a default.

#### Scenario: A gross kWh bill before save
- **WHEN** a user enters 1,000 kWh on a TR 2025 natural gas record and chooses gross
- **THEN** the form shows about 901.15 kWh net and the ratio 0.901147 (8,250 / 9,155) with the factor's release named, before anything is saved

#### Scenario: A gross MWh bill before save
- **WHEN** a user enters 2 MWh and chooses gross
- **THEN** the derived figure is shown in MWh, about 1.80 MWh net

#### Scenario: The shown ratio is the applied one
- **WHEN** the same record is previewed
- **THEN** the preview's ratio and the shown ratio are the same number, and the saved snapshot cites the same release rows

#### Scenario: A net bill shows no derived figure
- **WHEN** the user chooses net
- **THEN** no derived figure or ratio is shown, because the quantity is priced as entered

#### Scenario: A release without a reference GCV
- **WHEN** the factor's release holds no `reference_gcv`
- **THEN** the form shows no derived figure, invents no ratio, and the preview shows the calculation's `parameter_missing` refusal
