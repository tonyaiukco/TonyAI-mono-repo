# Spec Delta

## MODIFIED Requirements

### Requirement: Natural gas per-record inputs
For a TR natural gas record in Sm³, the form SHALL show NCV prefilled with 8,250 kcal/Sm³ and editable. It SHALL show an optional billed GCV field, and the two are mutually exclusive. For a record in m³, the form SHALL require a volume correction factor. Edits SHALL be saved with the record and audited like any other field. Bulk upload SHALL accept the same inputs as optional columns. It SHALL also accept a `cvBasis` column, `net` or `gross` in any letter case, which a TR natural gas row in kWh or MWh requires, and the dry run SHALL show the basis it read.

#### Scenario: The user edits the NCV
- **WHEN** a user changes NCV to 8,100 and saves
- **THEN** the record stores 8,100 as user-entered, and the preview's conversion note shows it

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

## ADDED Requirements

### Requirement: Data Entry carries a stored calorific basis
When Data Entry opens, or copies, a TR natural gas record in kWh or MWh, it SHALL keep the record's unit, quantity and `cvBasis` while the record stays under the geography it was priced in. It SHALL show the basis read-only, and send it with every preview and save while the record stays under the TR rules in an energy unit. A gross bill's preview SHALL name the gross-to-net ratio.

#### Scenario: An imported kWh draft edited on Data Entry
- **WHEN** a user opens an imported TR natural gas draft in kWh with `cvBasis` `gross`, changes an ordinary field, attaches its evidence file, saves, and submits it
- **THEN** the form shows the basis as gross (TR: brüt), the preview and the save send `cvBasis` `gross`, the figure equals the one calculated at import, and the submit is accepted

#### Scenario: A voided kWh record copied to a new draft
- **WHEN** the author copies a voided TR natural gas record of 1,000 kWh with `cvBasis` `net`
- **THEN** the new form keeps kWh, 1,000 and the net basis, and does not fall back to Sm³ or clear the quantity

#### Scenario: A gross bill's preview names the ratio
- **WHEN** an imported gross kWh draft is previewed
- **THEN** the preview says the figure was reduced to net by the factor release's ratio, and never that kWh was converted to kWh

#### Scenario: A copy moved across the TR rules is narrowed like a new record
- **WHEN** a voided UK natural gas record in kWh is copied and moved to a TR subsidiary
- **THEN** the unit falls back to what the TR rules offer and the quantity is cleared, as for a new record

#### Scenario: A volume record never sends a basis
- **WHEN** a TR natural gas record in Sm³ or m³ is previewed or saved
- **THEN** no `cvBasis` is sent

### Requirement: A net energy figure leaving the TR rules is entered again
When a TR natural gas record in kWh or MWh with `cvBasis` `net` moves to a subsidiary or site outside the TR rules, Data Entry SHALL clear the quantity and its basis and ask for the quantity again, because those rules price an energy bill as gross. It SHALL NOT send the net quantity for pricing as gross, nor price a figure entered afterwards as net. A gross figure SHALL be kept.

#### Scenario: A net draft moved to a UK site
- **WHEN** a user moves a TR natural gas draft of 1,000 kWh with `cvBasis` `net` to a UK site
- **THEN** the quantity is cleared, a notice asks for the bill's gross figure, and nothing is previewed or saved until it is entered

#### Scenario: A gross draft moved to a UK site
- **WHEN** the same draft holds `cvBasis` `gross`
- **THEN** the quantity is kept and priced as a gross kWh figure, and no basis is sent

#### Scenario: Back to Türkiye after the figure was entered again
- **WHEN** the user enters the gross figure on the UK site and moves the draft back to the TR subsidiary
- **THEN** no basis is shown or sent, and the figure is not priced until a basis is stated, never as net
