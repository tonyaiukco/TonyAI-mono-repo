# TonyAI — UAT & Launch Bug & Finding Report (v4)
**Date:** November 24, 2026 — **Rev.3 (go-live pack)** · Go-live **1 December 2026, full scope**
**Tested By:** Arda Gökceviz (`super_admin` / CEO, handover) & Emre Kapusuz (COO)
**Environment:** TonyAI Web Application (Prototype / Staging → Çorum Soft-Launch)
**Overall Status:** **UNBLOCKED.** All UAT Round-1 P1 calculation blockers (BUG-01–04) are **resolved** — factors seeded, units split, `Sm³` active. New items from the Çorum soft-launch are tracked below as **BUG-11–16**, plus **BUG-17** (refill rule) from the Go-Live Readiness Review. **Every open item ships on 1 December** (full-scope decision, 24 Nov) — BUG-09–17, including the P3 polish; only BUG-05 (geolocation) stays deferred. Structural items (roles, bulk, proof-reading) are issued as separate markdowns and cross-referenced in §3.

---

## 1. Executive Summary — Status Since Round 1
1. **Emission Factor Deadlock — RESOLVED.** `TR` Electricity (2024 `0.442`, 2025 `0.434`) and Natural Gas (IPCC 2006 Net-CV) factors seeded and year-keyed; the hardcoded "prototype covers 2026" warning removed.
2. **Combined `kWh` Unit Ambiguity — RESOLVED.** Split into `kWh (elektrik)` and `kWh (doğal gaz)`, filtered by category.
3. **`Sm³` Phase-4 Block — RESOLVED.** `Sm³` active via Net-CV chain, default NCV `8,250 kcal/Sm³` (manually editable).
4. **Geolocation / Map Services — OPEN (deferred).** Still static `TR/UK`; map integration is fast-follow, not active in the current version.
5. **New at Çorum soft-launch — ADDED (BUG-11–16):** Natural Gas `kWh` input unit, fire-suppression Scope 1 dropdown, session/auto-login, super_admin company selection, data-entry edit visibility UX, and optional invoice-no + supplier fields.

---

## 2. Detailed Findings & Bug List

| ID | Priority | Module / Screen | Issue (Observed) | Expected (Acceptance Criteria) | Status (latest) | Ref |
| :-- | :---: | :-- | :-- | :-- | :-- | :---: |
| **BUG-01** | P1 | Data Entry — Electricity | `TR` 2024/2025/2026 all fail `"No emission factor found"`. | Seed TR grid EF: 2024 `0.442`, 2025 `0.434`; remove "covers 2026" warning. | **[RESOLVED]** factors seeded, year-keyed | 5–8 |
| **BUG-02** | P1 | Data Entry — Natural Gas | `TR` 2025 gas → `"No emission factor found"`. | Seed IPCC 2006 Net-CV (`CO2 56,100 / CH4 1 / N2O 0.1 kg/TJ`), AR6 combustion GWP (27.0). | **[RESOLVED]** | 5 |
| **BUG-03** | P1 | Data Entry — Gas (`Sm³`) | `Sm³` shows "Phase 4" placeholder banner. | Remove banner; `Sm³ → kcal → kJ → TJ (Net CV)`, default NCV `8,250` editable. | **[RESOLVED]** | 3 |
| **BUG-04** | P1 | Data Entry — Unit Dropdown | Merged `"kWh (elektrik / gaz)"` causes routing conflict. | Split into `kWh (elektrik)` / `kWh (doğal gaz)`; filter units by category. | **[RESOLVED]** | 9 |
| **BUG-05** | P2 | Subsidiaries / Locations — Geolocation | Operational geography only static `TR`/`UK`. | Map/Geolocation service (lat/lng, auto country/region for factor routing). | **[OPEN — deferred]** location services pending, not active this version | Finding |
| **BUG-06** | P2 | Data Entry — Activity Value | Typing `178,` immediately errors before decimals. | Allow trailing `,`/`.`; validate on blur / after 300ms. | **[RESOLVED]** comma accepted, onBlur | 4 |
| **BUG-07** | P2 | Subsidiaries — Add Sub-location Modal | Modal has no vertical scroll; lower fields unreachable. | `overflow-y: auto` + `max-height`. | **[RESOLVED]** | 1 |
| **BUG-08** | P2 | Data Entry — Reporting Year | Year dropdown runs to 2074. | Restrict to active years 2024–2026. | **[RESOLVED]** | 2 |
| **BUG-09** | P3 | Auth — Login/Password | No show/hide password toggle. | Add eye-icon visibility toggle. | **[TO FIX — go-live]** | Note |
| **BUG-10** | P3 | Global UI — Tab Title & Favicon | `<title>`/favicon not TonyAI-branded. | Set TonyAI title + favicon. | **[TO FIX — go-live]** | Note |
| **BUG-11** | P1 | Data Entry — Natural Gas (`kWh` input) | Gas can only be entered as `m³`/`Sm³`; `kWh` not available as an input unit. | Add **`kWh (doğal gaz)`** as a selectable gas input → engine goes **kWh → TJ directly** (`× 3.6×10⁻⁶`), **no conversion back to volume**. Mandatory basis choice in plain words with **"Faturadaki kWh (üst ısıl değer)" pre-selected** (Turkish gas invoices are gross); gross is converted with the **fixed ratio 0.9011** (8,250 / 9,155) and the correction is shown to the user — no invoice-GCV branch, no dead `HTTP 422` wall. Golden vector: 1,000 kWh gross → **0.1822 tCO₂e**. *(Engine ready — INC-2.5 Rev.2.)* | **[TO FIX — this MD]** | Çorum |
| **BUG-12** | P2 | Data Entry — Fire Suppression (Scope 1) | No screen to enter fire-suppression equipment data. | Add a Scope 1 fire-suppression entry (like mobile combustion / natural gas) with **two separate dropdowns**, as in the Veri Talep Formu: **Cihaz** (`Yangın Söndürme Tüpü / Yangın Söndürme Sistemi / Transformatör Kesici Gazı` → leak rate) × **Gaz Tipi** (`CO₂ / FM200 / SF6 / diğer` → AR6 GWP), plus **"Kuru kimyevi toz / köpük — sera gazı yok"** (most extinguishers are dry powder → 0 emissions). Capacity and refill with an explicit **g / kg selector, default gram** — the form collects grams and the engine works in kg, so a gram figure typed as kg is a **1,000× error**. Engine already computes this (v2.4); refill rule per BUG-17. | **[TO FIX — this MD]** | Çorum |
| **BUG-13** | P1 | Auth — Session / Auto-Login | Register and Login behave the same; after logout the register screen shows; a saved session auto-logs into the last user even 4 days later — no credential prompt. | Separate Register vs Login screens; **idle timeout = 1 hour** → require username + password again; never silently resume a stale session; no auto-login to the last user. | **[IN PROGRESS]** dev aware & working; requirement = re-login after **1 hour** | Çorum |
| **BUG-14** | P2 | Users & RBAC — Assignment | A registered email can be set as **standard_user** for another company, but when assigning **super_admin** no company can be selected. | super_admin assignment must allow company selection (multi-entity). | **[ADDRESSED — INC-2.6]** solved by user-segmentation / company-tree spec; verify on build | Çorum |
| **BUG-15** | P2 | Data Entry / Review — Edit Visibility & Resubmit | First data-enterer can't clearly see entered data; the entered-records panel is stranded at the bottom of the page; edit function not tidy. Also: edit→recall→resubmit behaviour in the review queue. | Tidier edit for the first enterer; add a top/anchored **"girdiğiniz verileri görüntüleyin / düzenleyin"** control that scrolls to the entries list; surface and alert entered data. **Edit→recall→resubmit workflow** (recall own record while not yet picked up; queue shows current + "Revize" badge; before→after diff in denetim izi only) specced in **INC-2.6 §1.2**. | **[UX → this MD; workflow → INC-2.6 §1.2]** | Çorum |
| **BUG-16** | P3 | Data Entry — Optional Fields | No fields for invoice number / supplier. | Add **`fatura no`** and **`tedarikçi`** as **optional** fields on the data-entry screen. | **[TO ISSUE — this MD]** | Çorum |
| **BUG-17** | P2 | Calculation — Refrigerant & Fire Suppression (refill) | v2.4 adds the capacity-based leak estimate **and** the annual refill: `Kaçak = (Kapasite × Oran) + Dolum`. A refill replaces gas that leaked, so when both exist the same leak is counted twice — and the Veri Talep Formu collects refill amounts. | **Refill if known, else estimate — never both:** `Kaçak = Dolum` when a refill was made in the year, otherwise `Kapasite × Oran`. Golden vector: FM200 system, 50 kg capacity, 35 kg refill → **126.00 tCO₂e** (old sum rule: 129.60). GV-8 (no refill) unchanged: **2.8800 tCO₂e**. | **[TO FIX — this MD]** decided 24 Nov | Readiness Review |

---

## 3. Issued in Separate Markdowns (cross-reference, not bugs)

| Item | Where it's handled | Note |
| :-- | :-- | :-- |
| Roles / masterkey / super_admin / standard / auditor, data access, genealogy, onboarding | **INC-2.6** | Four-eyes locked; also resolves BUG-14. |
| Inventory borders (super_admin draws → assigns standard user by category) | **INC-2.6** | Location services still pending (BUG-05). |
| Bulk data spreadsheet ingestion (fuel; Tedarik cross-reporting) | **INC-2.8 Rev.3** | Three fuel adapters (Shell, Petrol Ofisi, tanker), batch review, fuel-card-account attribution; manual fuel screen warns against re-entering card fuel. |
| Go-Live Readiness Review findings (tanker flow, batch review unit, attribution, roll-up rule, fuel-name rules, parser guards, shared invoices, invoice buyer wording) | **INC-2.5 / 2.6 / 2.8 / 2.9 Rev.3** + Readiness Review Rev.3 | Spec fixes, not UAT bugs; applied 24 Nov (S1–S18). |
| Evidence proof-reading + review-queue **assistant** (AI reads invoice, shows value side-by-side, never blocks) + invoice-reading data entry | **INC-2.9 Rev.3** | **Confirmed:** assistant-not-verdict, colour states (🟢/🟠/⚪), non-blocking. **On at go-live** (its setting is an emergency off only); shared invoices compared at invoice level. |
| Dashboard AI reader + a more traceable, easier-to-navigate dashboard (the green colour doesn't work as intended today) | **Roadmap O7** | Open — Emre to elaborate; not in the 1 December scope. |

---

## 4. Deferred to Later Phases (not in this build)

| Item | Note |
| :-- | :-- |
| Electricity **self-generation** (own generation + grid top-up) | Design ready as **INC-2.5 Case A** when wanted; a real GES line already appears in the Çorum electricity invoice. Deferred per decision. |
| HR data / **GRI 2 + GRI 400** (social, no carbon calc) | Later phase; data model already mapped by the Veri Talep Formu sheets. |
| Geolocation / map services (BUG-05) | Fast-follow; geography stays manual for now. |

---

## 5. Golden Vector Verification Checklist (re-run on each build)
Tolerance ±0.5%.
* **Natural Gas (`TR`, 2025):** `73.953 Sm³`, manual NCV `8,080 kcal/Sm³` → **0.1404 tCO₂e**
* **Electricity (`TR`):** `4,180.56 kWh` → **1.814 tCO₂e** (2025 @ 0.434) / **1.848 tCO₂e** (2024 @ 0.442)
* **Gasoline On-Road (`TR`, 2025):** `15,973.75 L` → **36.8646 tCO₂e**
* **Grid Leakage / Fugitive (`TR`, 2025):** `84,783.36 std m³` (fixed density & CH4 fraction, GWP 29.8) → **1,632.47 tCO₂e**
* **Natural Gas kWh, invoice (gross):** `1,000 kWh` × 0.9011 → **0.1822 tCO₂e** (BUG-11)
* **Fire suppression with refill:** FM200 system, 50 kg capacity, 35 kg refill → **126.00 tCO₂e** (BUG-17); without refill → GV-8 unchanged
* **Fuel invoice regression set:** the 4 OZK + 23 Duman invoices must reconcile with their transactions as in the Readiness Review (36 / 40 lines exact; the 4 others = two posting-lag pairs)
* **Fuel upload acceptance tests (real files):** expected results in the handoff index §4 (A1–A15) — full run on 30 November

> Living document — new UAT/launch findings append as `BUG-n`; statuses update in the bracketed column.
