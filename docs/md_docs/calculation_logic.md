# Calculation Logic: TonyAI Enterprise

## 1. Purpose
This document defines the baseline calculation logic for the TonyAI Enterprise prototype. It covers input normalisation, factor application, emissions calculations, and anomaly detection.

This logic is suitable for prototype and mock backend use. It must not be treated as final assurance grade production methodology without further factor library governance and methodology controls.

---

## 2. Unit Conversion and Normalisation

Before emission factors are applied, raw activity data must be normalised to the required calculation unit for the selected category.

### 2.1 Natural Gas Normalisation
- **Base Unit:** `kwh`
- **Conversion Factors:**
  - `cubic_metres` to `kwh`: multiply by `11.36`
  - `therms` to `kwh`: multiply by `29.3`
  - `gj` to `kwh`: multiply by `277.78`

### 2.2 Liquid Fuel Normalisation
- **Base Unit:** `litres`
- **Conversion Factors:**
  - `uk_gallons` to `litres`: multiply by `4.546`
  - `us_gallons` to `litres`: multiply by `3.785`

### 2.3 Electricity Normalisation
- **Base Unit:** `kwh`
- **Conversion Factors:**
  - `mwh` to `kwh`: multiply by `1000`

### 2.4 Category Specific Rule
Not all categories should be converted to energy units.

Examples:
- electricity and natural gas may normalise to `kwh`
- liquid fuels may normalise to `litres`
- travel should remain in `passenger_kilometres` or `kilometres`
- waste should remain in `tonnes`
- water should remain in `cubic_metres`

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
1. Identify the activity category
2. Identify the geography code
3. Normalize the input value to the required unit
4. Fetch the matching emission factor
5. Apply the emissions formula
6. Convert the result to `tCo2e`
7. Store factor traceability metadata with the result

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
- `conversionApplied` if relevant

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

The system must flag a record when the calculated result differs by more than `50%` from the rolling average of the previous `3` comparable periods for the same:

- `organisationId`
- `subsidiaryId`
- `categoryKey`
- `subCategoryKey` where relevant

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