# Calculation Logic: TonyAI Enterprise

## 1. Purpose
This document defines the baseline calculation logic for the TonyAI Enterprise prototype. It covers input normalisation, factor application, emissions calculations, and anomaly detection.

This logic is suitable for prototype and mock backend use. It must not be treated as final assurance grade production methodology without further factor library governance and methodology controls.

---

## 2. Unit Conversion and Normalisation

Before an emission factor is applied, the activity value is normalised to the unit the factor is quoted per. Since LP3-03 this happens in **two steps, and only the first is code** (`normalize(value, unit, category, conversion)` in `apps/api/src/calculations/normalization.ts`):

1. **Definitional** — within a unit family, to that family's base unit (`DIMENSION_BASE_UNIT` in `@tonyai/shared-types`). These are exact by definition and need no source.
2. **Sourced** — between families (metered m³ of natural gas → kWh). That depends on the fuel, the country, the year and the calorific basis, so it is a `unit_conversions` row of a factor release, chosen by `resolveFactorPath` for the record's category, activity type, geography and year — never a code constant, and never borrowed from another country or year.

Every factor is quoted per **one base unit** of its family: kWh (energy), litres (liquid fuel), cubic metres (metered volume), standard cubic metres, kilometres, passenger-kilometres, kg (mass).

### 2.1 Natural Gas (base units `kWh` and `cubic_metres`)
Energy, base unit `kWh`:
- `kwh`: identity
- `therms` → `kwh`: × `29.30711` — the EC therm (Directive 80/181/EEC: 105,505,585.257 J) ÷ 3.6 MJ, to seven significant figures. Not the US therm (29.3001 kWh).
- `gj` → `kwh`: × `1000/3.6` (exact)

A fuel's energy quantity carries a **calorific basis**: billed kWh are on gross (higher) calorific value, so a factor applied directly to them must be a gross-CV factor (`directCalorificBasisFor`).

Metered volume, base unit `cubic_metres`: a meter reading stays a volume. It becomes kWh only through a **sourced conversion row** for natural gas in the record's country and year, on the same calorific basis as the factor it reaches; with none loaded the calculation is refused (`no_conversion`), never estimated.

> **Placeholder (owner decision K4, 2026-10-04).** The prototype's `11.36` kWh per m³ — carried over from the original demo spec, with **no citation and no stated reference conditions**; its gross calorific basis is a reconstruction (~40.0 MJ/m³ with the UK volume correction 1.02264), not a stated fact — is now a labelled **placeholder** `unit_conversions` row of the seed's demo release, one per seeded geography (UK, TR, EU) for 2026. It is used only where the API runs with `ALLOW_PLACEHOLDER_FACTORS=true` (local development, CI) and refused everywhere else. Each affected snapshot records it in `conversion` (with its release), `conversionFactor` and `conversionBasis`. A sourced conversion replaces it when LP4-02 loads authoritative releases.

> **Standard and normal cubic metres (`Sm3` / `Nm3`) are deliberately NOT converted.** They are different physical quantities from metered cubic metres (and from each other: 15 °C vs 0 °C), and this repository holds no sourced calorific value for them. The units are recognised and refused by name until a sourced conversion row exists.

### 2.2 Liquid fuel (base unit `litres`)
- `litres`: identity
- `uk_gallons` → `litres`: × `4.54609` (exact)
- `us_gallons` → `litres`: × `3.785411784` (exact)

### 2.3 Electricity (base unit `kWh`)
- `mwh` → `kwh`: × `1000` (exact)

### 2.4 Category specific rules
- Travel stays in `passenger_kilometres` or `kilometres` (identity).
- Mass is quoted per `kg`: `tonnes` → `kg` × `1000` (exact). Refrigerant leakage is entered in kg; waste may be entered in tonnes and is priced per kg.
- Water stays in `cubic_metres` and is recorded without a factor (no factor is loaded for it): the reading is kept exactly as entered and no figure is produced.

---

## 3. Regional Emission Factors

The system must retrieve factors based on the `geographyCode` of the selected reporting entity, normally inherited from the selected subsidiary or organisation.

### 3.1 Scope 1: Direct Combustion
Scope 1 fuel factors may use standard factor libraries unless organisation specific or country specific factors are configured.

#### Demo Factors
- **Natural Gas:** `0.1829 kgCo2e / kwh`
- **Diesel:** `2.6841 kgCo2e / litres`
- **Petrol:** `2.3111 kgCo2e / litres`

### 3.2 Scope 2: Purchased Electricity
Factors represent `kgCo2e per kwh` of electricity consumed.

#### Demo Factors
- **United Kingdom (`UK`)**: `0.2071`
- **Turkey (`TR`)**: `0.4400`
- **European Union Residual Mix Demo (`EU`)**: `0.2310`
- **United Kingdom, prior year (`UK`, 2025)**: `0.2123` — a versioning-demo placeholder, not from any publication: it exists only so the factor library holds a second reporting year to resolve against.

> These are the prototype's **placeholder** values (the seed's `TonyAI prototype` release). The EU residual-mix figure is a market-based quantity; it is resolved as location-based until LP4-02 relabels or replaces it (owner decision K-a, 2026-10-04). The Diesel value prices both records written before fuels were typed (`unspecified`) and new `diesel` records (owner decision K-b).

### 3.3 Scope 3: Travel and Logistics
#### Demo Factors
- **Short-haul Flight (`flight_shorthaul`)**: `0.151 kgCo2e / passenger_kilometres`
- **Long-haul Flight (`flight_longhaul`)**: `0.193 kgCo2e / passenger_kilometres`
- **Rail National (`rail_national`)**: `0.035 kgCo2e / passenger_kilometres`

---

## 4. Calculation Algorithm

### 4.1 Core Formula
`kgCo2e = normalizedValue × factorValue`

`tCo2e = kgCo2e / 1000`

### 4.2 Step by Step Execution
1. Identify the activity category and, for a typed category (Fuel, Mobile Combustion, Refrigerants), the record's activity type
2. Identify the geography code and the reporting year
3. Find the factor path (`resolveFactorPath`): the CO2e factor of the exact category, activity type, geography and year — of the category's own Scope 2 method — directly, or through one sourced conversion; authoritative releases outrank placeholders; a conflict or a gap is refused with a code, never guessed
4. Normalise the input value: the definitional step, then the chosen conversion (§2)
5. Apply the emissions formula
6. Convert the result to `tCo2e`
7. Store the snapshot (§5) with the result

### 4.3 Example Calculation
**Input:** `5 mwh` purchased electricity  
**Geography:** `TR`  
**Normalization:** `5 mwh = 5000 kwh`  
**Factor:** `0.4400 kgCo2e / kwh`  
**Calculation:** `5000 × 0.4400 = 2200 kgCo2e`  
**Final Output:** `2.20 tCo2e`

---

## 5. Factor Traceability

Each calculation result must store:
- `factorId`
- `factorValue`
- `factorUnit`
- `methodology`
- `geographyCode`
- `normalizedValue`
- `normalizedUnit`
- `conversionApplied`, and `conversionFactor` + `conversionBasis` when something was converted

Since LP3-03 the snapshot (`CalculationResultV2`, schema 2) also stores where every number came from: the factor's release (publisher, edition, ordinal, status, source URL, licence, GWP set), the activity type, gas and gas coverage, calorific basis, Scope 2 method, data year and year policy, and the sourced conversion with its own release. A figure is authoritative only when every link is (`isAuthoritativeSnapshot`); reports and screens ask that, never the factor's status alone.

This information must be viewable in the Emissions History detail panel.

---

## 6. Global Warming Potential Logic

The engine may use **IPCC AR6** global warming potential values where category level calculations require gas specific treatment.

### Example GWP Values
- `CO2 = 1`
- `CH4 = 27.9`
- `N2O = 273`

### Usage Note
These GWP values are most relevant for:
- refrigerants
- fugitive emissions
- process emissions
- gas specific calculations

They are not required for every standard electricity or fuel record where an aggregated `kgCo2e` factor is already used.

---

## 7. Anomaly Threshold Logic

The system must flag a record when the calculated result differs by more than `50%` from the rolling average of the previous `3` comparable periods for the same **reporting entity**:

- `subsidiaryId`
- `locationId` (including `NULL` — a whole-company series is its own pool)
- `categoryKey`
- `reportingPeriod` (granularity)

All three priors must carry a figure or the rule does not run — the record is
then *not evaluated*, not *clean*. **`validation_anomaly_rules.md` §4.1 is the
single normative statement of this rule**, including why the key deviates from
the original specification; this section is a pointer to it and must not be
edited independently. It was an independent copy until 2026-08-27, and the two
had drifted apart from the implementation in the same way.

### Trigger Behaviour
When anomaly is detected:
- show UI warning
- require `Reason for Variance` comment before submission
- set `anomalyFlag = true`
- route the record into review logic if configured

---

## 8. Prototype Limitation Note

These factors and rules are suitable for:
- prototype UI behaviour
- live calculation previews
- stakeholder demos
- mock backend intelligence

They are not yet sufficient for:
- audited reporting
- production assurance workflows
- full methodology governance
- country specific regulated disclosures without further validation