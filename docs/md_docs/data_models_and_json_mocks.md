# Data Models and JSON Mocks
**Document ID:** `TONY-TECH-003`  
**Application Area:** Frontend Seed Data, Mock API Responses, UI Development, Testing

## 1. Purpose
This document defines the baseline data models and example JSON payloads used by the TonyAI Enterprise prototype.

It supports:
- realistic frontend rendering
- mock API development
- component testing
- state management testing
- believable Vercel prototype generation

This file is for example objects and mock datasets.  
It complements:
- `api_shapes_and_state_logic.md`
- `calculation_logic.md`
- page level `.md` specifications

---

## 2. Locked Naming Conventions

Use these field names consistently across all models:

### Identity Fields
- `id`
- `organisationId`
- `subsidiaryId`
- `userId`
- `recordId`
- `supplierId`
- `reportId`
- `scenarioId`

### Time Fields
- `reportingYear`
- `reportingPeriod`
- `createdAt`
- `updatedAt`

### Emissions Fields
- `kgCo2e`
- `tCo2e`
- `factorValue`
- `factorUnit`
- `methodology`
- `geographyCode`

### Classification Fields
- `scope`
- `categoryKey`
- `subCategoryKey`
- `unit`
- `status`
- `completionStatus`

---

## 3. Controlled Values

### 3.1 Roles
```json
[
  "super_admin",
  "consultant",
  "data_entry",
  "executive_viewer"
]
3.2 Workflow Status
[
  "draft",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "locked"
]
3.3 Completion Status
[
  "complete",
  "incomplete",
  "missing",
  "not_applicable"
]
3.4 Reporting Period Values
[
  "all_year",
  "first_half",
  "second_half",
  "first_quarter",
  "second_quarter",
  "third_quarter",
  "fourth_quarter",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
]
3.5 Scope Values
[
  "scope_1",
  "scope_2",
  "scope_3"
]
3.6 Scope 1 Category Values
[
  "stationary_combustion",
  "mobile_combustion",
  "process_emissions",
  "fugitive_emissions"
]
3.7 Scope 2 Category Values
[
  "purchased_electricity",
  "purchased_heating",
  "purchased_cooling",
  "purchased_steam"
]
3.8 Scope 3 Category Values
[
  "purchased_goods_and_services",
  "capital_goods",
  "fuel_and_energy_related_activities",
  "upstream_transportation_and_distribution",
  "waste_generated_in_operations",
  "business_travel",
  "employee_commuting",
  "upstream_leased_assets",
  "downstream_transportation_and_distribution",
  "processing_of_sold_products",
  "use_of_sold_products",
  "end_of_life_treatment_of_sold_products",
  "downstream_leased_assets",
  "franchises",
  "investments"
]
3.9 Common Unit Values
[
  "kwh",
  "mwh",
  "litres",
  "tonnes",
  "kg",
  "cubic_metres",
  "kilometres",
  "miles",
  "passenger_kilometres",
  "gbp",
  "usd",
  "eur"
]
3.10 Geography Values
[
  "UK",
  "TR",
  "EU",
  "GLOBAL"
]
4. User Model
4.1 Shape
{
  "id": "user_001",
  "fullName": "Lina Kaya",
  "email": "lina.kaya@example.com",
  "role": "data_entry",
  "accessibleOrganisationIds": ["organisation_001"],
  "accessibleSubsidiaryIds": ["subsidiary_001", "subsidiary_002"],
  "settings": {
    "theme": "light",
    "language": "en",
    "unitPreference": "standard"
  },
  "isActive": true,
  "lastLoginAt": "2026-04-14T08:45:00Z",
  "createdAt": "2025-11-20T12:00:00Z",
  "updatedAt": "2026-04-12T10:30:00Z"
}
4.2 Mock Users
[
  {
    "id": "user_001",
    "fullName": "Nadia Rahman",
    "email": "nadia.rahman@example.com",
    "role": "super_admin",
    "accessibleOrganisationIds": ["organisation_001", "organisation_002", "organisation_003"],
    "accessibleSubsidiaryIds": [],
    "isActive": true
  },
  {
    "id": "user_002",
    "fullName": "Tom Bell",
    "email": "tom.bell@example.com",
    "role": "consultant",
    "accessibleOrganisationIds": ["organisation_001", "organisation_003"],
    "accessibleSubsidiaryIds": [],
    "isActive": true
  },
  {
    "id": "user_003",
    "fullName": "Lina Kaya",
    "email": "lina.kaya@example.com",
    "role": "data_entry",
    "accessibleOrganisationIds": ["organisation_001"],
    "accessibleSubsidiaryIds": ["subsidiary_001", "subsidiary_002"],
    "isActive": true
  },
  {
    "id": "user_004",
    "fullName": "James Harlow",
    "email": "james.harlow@example.com",
    "role": "executive_viewer",
    "accessibleOrganisationIds": ["organisation_001"],
    "accessibleSubsidiaryIds": [],
    "isActive": true
  }
]
5. Organisation Model
5.1 Shape
{
  "id": "organisation_001",
  "legalName": "Emerald Climate Analytics Ltd",
  "tradingName": "ECA Group",
  "country": "United Kingdom",
  "geographyCode": "UK",
  "sector": "Professional Services",
  "reportingCurrency": "GBP",
  "contactEmail": "sustainability@eca.example.com",
  "contactPhone": "+44 20 7000 1000",
  "activeReportingYears": [2024, 2025, 2026],
  "createdAt": "2025-01-10T09:00:00Z",
  "updatedAt": "2026-04-10T09:00:00Z"
}
5.2 Mock Organisations
[
  {
    "id": "organisation_001",
    "legalName": "Emerald Climate Analytics Ltd",
    "tradingName": "ECA Group",
    "country": "United Kingdom",
    "geographyCode": "UK",
    "sector": "Professional Services",
    "reportingCurrency": "GBP"
  },
  {
    "id": "organisation_002",
    "legalName": "Green Delta Carbon BV",
    "tradingName": "GDCB",
    "country": "Netherlands",
    "geographyCode": "EU",
    "sector": "Manufacturing",
    "reportingCurrency": "EUR"
  },
  {
    "id": "organisation_003",
    "legalName": "Transit Carbon Solutions A.Ş.",
    "tradingName": "TCS TR",
    "country": "Türkiye",
    "geographyCode": "TR",
    "sector": "Transport",
    "reportingCurrency": "TRY"
  }
]
6. Subsidiary Model
6.1 Shape
{
  "id": "subsidiary_001",
  "organisationId": "organisation_001",
  "legalName": "Emerald Analytics Birmingham Ltd",
  "tradingName": "ECA Birmingham",
  "location": "Birmingham, United Kingdom",
  "geographyCode": "UK",
  "businessArea": "Consulting",
  "sector": "Professional Services",
  "capacityReport": "Headcount 85",
  "designatedPerson": "Lina Kaya",
  "designatedEmail": "lina.kaya@example.com",
  "contactPhone": "+44 121 700 1000",
  "reportingStatus": "active",
  "includedScopes": ["scope_1", "scope_2", "scope_3"],
  "createdAt": "2025-04-10T09:00:00Z",
  "updatedAt": "2026-04-01T11:00:00Z"
}
6.2 Mock Subsidiaries
[
  {
    "id": "subsidiary_001",
    "organisationId": "organisation_001",
    "legalName": "Emerald Analytics Birmingham Ltd",
    "tradingName": "ECA Birmingham",
    "location": "Birmingham, United Kingdom",
    "geographyCode": "UK",
    "businessArea": "Consulting",
    "sector": "Professional Services",
    "designatedPerson": "Lina Kaya",
    "reportingStatus": "active"
  },
  {
    "id": "subsidiary_002",
    "organisationId": "organisation_001",
    "legalName": "Emerald Analytics Manchester Ltd",
    "tradingName": "ECA Manchester",
    "location": "Manchester, United Kingdom",
    "geographyCode": "UK",
    "businessArea": "Consulting",
    "sector": "Professional Services",
    "designatedPerson": "Tom Bell",
    "reportingStatus": "active"
  },
  {
    "id": "subsidiary_003",
    "organisationId": "organisation_003",
    "legalName": "Transit Carbon Izmir A.Ş.",
    "tradingName": "TCS Izmir",
    "location": "Izmir, Türkiye",
    "geographyCode": "TR",
    "businessArea": "Operations",
    "sector": "Transport",
    "designatedPerson": "Ayşe Demir",
    "reportingStatus": "active"
  }
]
7. Supplier Model
7.1 Shape
{
  "id": "supplier_001",
  "organisationId": "organisation_001",
  "companyName": "NorthRiver Logistics Ltd",
  "legalName": "NorthRiver Logistics Limited",
  "score": 78,
  "cdpWaterScore": "B",
  "cdpClimateScore": "A-",
  "sbtiAlignment": "Committed",
  "country": "United Kingdom",
  "sector": "Logistics",
  "nearTermStatus": "Active",
  "nearTermTargetYear": 2030,
  "netZeroStatus": "Committed",
  "netZeroYear": 2045,
  "explanation": "Supplier has published near term and net zero targets.",
  "contactName": "Hannah Price",
  "contactEmail": "hannah.price@northriver.example.com",
  "contactPhone": "+44 161 700 2000",
  "website": "https://northriver.example.com",
  "createdAt": "2026-01-14T09:30:00Z",
  "updatedAt": "2026-04-08T13:10:00Z"
}
7.2 Mock Suppliers
[
  {
    "id": "supplier_001",
    "organisationId": "organisation_001",
    "companyName": "NorthRiver Logistics Ltd",
    "legalName": "NorthRiver Logistics Limited",
    "score": 78,
    "cdpWaterScore": "B",
    "cdpClimateScore": "A-",
    "sbtiAlignment": "Committed",
    "country": "United Kingdom",
    "sector": "Logistics",
    "nearTermStatus": "Active",
    "nearTermTargetYear": 2030,
    "netZeroStatus": "Committed",
    "netZeroYear": 2045,
    "contactName": "Hannah Price"
  },
  {
    "id": "supplier_002",
    "organisationId": "organisation_001",
    "companyName": "BlueForge Manufacturing Plc",
    "legalName": "BlueForge Manufacturing PLC",
    "score": 64,
    "cdpWaterScore": "C",
    "cdpClimateScore": "B-",
    "sbtiAlignment": "None",
    "country": "Germany",
    "sector": "Manufacturing",
    "nearTermStatus": "Not Set",
    "nearTermTargetYear": null,
    "netZeroStatus": "Not Set",
    "netZeroYear": null,
    "contactName": "Markus Stein"
  },
  {
    "id": "supplier_003",
    "organisationId": "organisation_003",
    "companyName": "Anadolu Fleet Services",
    "legalName": "Anadolu Fleet Services A.Ş.",
    "score": 52,
    "cdpWaterScore": "D",
    "cdpClimateScore": "C",
    "sbtiAlignment": "Near-term Target",
    "country": "Türkiye",
    "sector": "Transport Services",
    "nearTermStatus": "Active",
    "nearTermTargetYear": 2032,
    "netZeroStatus": "Committed",
    "netZeroYear": 2050,
    "contactName": "Selin Yıldız"
  }
]
8. Emissions Summary Model
8.1 Shape
{
  "organisationId": "organisation_001",
  "reportingYear": 2025,
  "reportingPeriod": "all_year",
  "totalTCo2e": 4821.44,
  "scope1TCo2e": 612.32,
  "scope2TCo2e": 1088.11,
  "scope3TCo2e": 3121.01,
  "completeCategories": 18,
  "incompleteCategories": 5,
  "missingCategories": 2,
  "subsidiaryCount": 6,
  "calculationRate": 78,
  "complianceStatus": {
    "green": 18,
    "yellow": 5,
    "red": 2
  }
}
8.2 Mock Summary
{
  "organisationId": "organisation_001",
  "reportingYear": 2025,
  "reportingPeriod": "all_year",
  "totalTCo2e": 4821.44,
  "scope1TCo2e": 612.32,
  "scope2TCo2e": 1088.11,
  "scope3TCo2e": 3121.01,
  "completeCategories": 18,
  "incompleteCategories": 5,
  "missingCategories": 2,
  "subsidiaryCount": 6,
  "calculationRate": 78,
  "complianceStatus": {
    "green": 18,
    "yellow": 5,
    "red": 2
  }
}
9. Category Summary Model
9.1 Shape
{
  "id": "category_summary_001",
  "organisationId": "organisation_001",
  "subsidiaryId": "subsidiary_001",
  "reportingYear": 2025,
  "reportingPeriod": "all_year",
  "scope": "scope_2",
  "categoryKey": "purchased_electricity",
  "subCategoryKey": "grid_electricity",
  "activityValue": 125000,
  "unit": "kwh",
  "tCo2e": 28.75,
  "completionStatus": "complete",
  "recordCount": 12,
  "lastUpdatedAt": "2026-04-10T14:00:00Z"
}
9.2 Mock Category Summaries
[
  {
    "id": "category_summary_001",
    "organisationId": "organisation_001",
    "subsidiaryId": "subsidiary_001",
    "reportingYear": 2025,
    "reportingPeriod": "all_year",
    "scope": "scope_2",
    "categoryKey": "purchased_electricity",
    "subCategoryKey": "grid_electricity",
    "activityValue": 125000,
    "unit": "kwh",
    "tCo2e": 28.75,
    "completionStatus": "complete",
    "recordCount": 12
  },
  {
    "id": "category_summary_002",
    "organisationId": "organisation_001",
    "subsidiaryId": "subsidiary_001",
    "reportingYear": 2025,
    "reportingPeriod": "all_year",
    "scope": "scope_1",
    "categoryKey": "stationary_combustion",
    "subCategoryKey": "natural_gas",
    "activityValue": 9800,
    "unit": "cubic_metres",
    "tCo2e": 18.40,
    "completionStatus": "complete",
    "recordCount": 12
  },
  {
    "id": "category_summary_003",
    "organisationId": "organisation_001",
    "subsidiaryId": "subsidiary_002",
    "reportingYear": 2025,
    "reportingPeriod": "all_year",
    "scope": "scope_3",
    "categoryKey": "business_travel",
    "subCategoryKey": "flight_shorthaul",
    "activityValue": 245000,
    "unit": "passenger_kilometres",
    "tCo2e": 61.90,
    "completionStatus": "incomplete",
    "recordCount": 8
  }
]
10. Activity Record Model
10.1 Shape
{
  "id": "record_001",
  "organisationId": "organisation_001",
  "subsidiaryId": "subsidiary_001",
  "reportingYear": 2025,
  "reportingPeriod": "january",
  "scope": "scope_2",
  "categoryKey": "purchased_electricity",
  "subCategoryKey": "grid_electricity",
  "status": "submitted",
  "input": {
    "activityValue": 10450.75,
    "unit": "kwh",
    "startDate": "2025-01-01",
    "endDate": "2025-01-31"
  },
  "calculation": {
    "normalizedValue": 10450.75,
    "normalizedUnit": "kwh",
    "factorId": "factor_uk_electricity_2024_demo",
    "factorValue": 0.2071,
    "factorUnit": "kwh",
    "kgCo2e": 2164.30,
    "tCo2e": 2.1643,
    "geographyCode": "UK",
    "methodology": "DEFRA 2024",
    "conversionApplied": false,
    "demoFactor": true
  },
  "evidence": [
    {
      "fileId": "file_001",
      "fileName": "january_electricity_invoice.pdf",
      "fileType": "application/pdf",
      "url": "https://example.com/files/january_electricity_invoice.pdf"
    }
  ],
  "audit": {
    "createdBy": "user_003",
    "createdAt": "2026-02-03T10:10:00Z",
    "updatedAt": "2026-02-03T10:30:00Z",
    "anomalyFlag": false,
    "varianceComment": null
  }
}
10.2 Mock Activity Records
[
  {
    "id": "record_001",
    "organisationId": "organisation_001",
    "subsidiaryId": "subsidiary_001",
    "reportingYear": 2025,
    "reportingPeriod": "january",
    "scope": "scope_2",
    "categoryKey": "purchased_electricity",
    "subCategoryKey": "grid_electricity",
    "status": "submitted",
    "input": {
      "activityValue": 10450.75,
      "unit": "kwh",
      "startDate": "2025-01-01",
      "endDate": "2025-01-31"
    },
    "calculation": {
      "normalizedValue": 10450.75,
      "normalizedUnit": "kwh",
      "factorId": "factor_uk_electricity_2024_demo",
      "factorValue": 0.2071,
      "factorUnit": "kwh",
      "kgCo2e": 2164.30,
      "tCo2e": 2.1643,
      "geographyCode": "UK",
      "methodology": "DEFRA 2024",
      "conversionApplied": false,
      "demoFactor": true
    },
    "audit": {
      "createdBy": "user_003",
      "createdAt": "2026-02-03T10:10:00Z",
      "updatedAt": "2026-02-03T10:30:00Z",
      "anomalyFlag": false,
      "varianceComment": null
    }
  },
  {
    "id": "record_002",
    "organisationId": "organisation_001",
    "subsidiaryId": "subsidiary_001",
    "reportingYear": 2025,
    "reportingPeriod": "february",
    "scope": "scope_1",
    "categoryKey": "stationary_combustion",
    "subCategoryKey": "natural_gas",
    "status": "approved",
    "input": {
      "activityValue": 810.5,
      "unit": "cubic_metres",
      "startDate": "2025-02-01",
      "endDate": "2025-02-28"
    },
    "calculation": {
      "normalizedValue": 9208.28,
      "normalizedUnit": "kwh",
      "factorId": "factor_uk_natgas_kwh_demo",
      "factorValue": 0.183,
      "factorUnit": "kwh",
      "kgCo2e": 1685.12,
      "tCo2e": 1.6851,
      "geographyCode": "UK",
      "methodology": "DEFRA 2025",
      "conversionApplied": true,
      "demoFactor": true
    },
    "audit": {
      "createdBy": "user_003",
      "createdAt": "2026-03-02T09:12:00Z",
      "updatedAt": "2026-03-05T15:21:00Z",
      "anomalyFlag": false,
      "varianceComment": null
    }
  },
  {
    "id": "record_003",
    "organisationId": "organisation_001",
    "subsidiaryId": "subsidiary_002",
    "reportingYear": 2025,
    "reportingPeriod": "march",
    "scope": "scope_3",
    "categoryKey": "business_travel",
    "subCategoryKey": "flight_shorthaul",
    "status": "under_review",
    "input": {
      "activityValue": 42000,
      "unit": "passenger_kilometres",
      "startDate": "2025-03-01",
      "endDate": "2025-03-31"
    },
    "calculation": {
      "normalizedValue": 42000,
      "normalizedUnit": "passenger_kilometres",
      "factorId": "factor_flight_shorthaul_demo",
      "factorValue": 0.151,
      "factorUnit": "passenger_kilometres",
      "kgCo2e": 6342.00,
      "tCo2e": 6.3420,
      "geographyCode": "GLOBAL",
      "methodology": "DEFRA style demo",
      "conversionApplied": false,
      "demoFactor": true
    },
    "audit": {
      "createdBy": "user_002",
      "createdAt": "2026-03-14T15:45:00Z",
      "updatedAt": "2026-03-14T15:50:00Z",
      "anomalyFlag": true,
      "varianceComment": "Higher than usual due to conference season."
    }
  }
]
11. Evidence File Model
11.1 Shape
{
  "id": "file_001",
  "recordId": "record_001",
  "fileName": "january_electricity_invoice.pdf",
  "fileType": "application/pdf",
  "fileSizeKb": 842,
  "uploadedBy": "user_003",
  "uploadedAt": "2026-02-03T10:15:00Z",
  "downloadUrl": "https://example.com/files/january_electricity_invoice.pdf"
}
11.2 Mock Evidence Files
[
  {
    "id": "file_001",
    "recordId": "record_001",
    "fileName": "january_electricity_invoice.pdf",
    "fileType": "application/pdf",
    "fileSizeKb": 842,
    "uploadedBy": "user_003",
    "uploadedAt": "2026-02-03T10:15:00Z",
    "downloadUrl": "https://example.com/files/january_electricity_invoice.pdf"
  },
  {
    "id": "file_002",
    "recordId": "record_001",
    "fileName": "meter_reading_photo.jpg",
    "fileType": "image/jpeg",
    "fileSizeKb": 512,
    "uploadedBy": "user_003",
    "uploadedAt": "2026-02-03T10:17:00Z",
    "downloadUrl": "https://example.com/files/meter_reading_photo.jpg"
  }
]
12. Audit Log Model
12.1 Shape
{
  "id": "audit_001",
  "recordId": "record_001",
  "userId": "user_003",
  "role": "data_entry",
  "actionType": "submit",
  "resourceType": "activity_record",
  "resourceId": "record_001",
  "timestamp": "2026-02-03T10:30:00Z",
  "comment": "Record submitted for review."
}
12.2 Mock Audit Logs
[
  {
    "id": "audit_001",
    "recordId": "record_001",
    "userId": "user_003",
    "role": "data_entry",
    "actionType": "create",
    "resourceType": "activity_record",
    "resourceId": "record_001",
    "timestamp": "2026-02-03T10:10:00Z",
    "comment": "Initial draft saved."
  },
  {
    "id": "audit_002",
    "recordId": "record_001",
    "userId": "user_003",
    "role": "data_entry",
    "actionType": "submit",
    "resourceType": "activity_record",
    "resourceId": "record_001",
    "timestamp": "2026-02-03T10:30:00Z",
    "comment": "Record submitted for review."
  },
  {
    "id": "audit_003",
    "recordId": "record_003",
    "userId": "system",
    "role": "system",
    "actionType": "flag_anomaly",
    "resourceType": "activity_record",
    "resourceId": "record_003",
    "timestamp": "2026-03-14T15:45:30Z",
    "comment": "Value exceeds 50 percent of rolling average."
  }
]
13. Notification Model
13.1 Shape
{
  "id": "notification_001",
  "organisationId": "organisation_001",
  "type": "submission",
  "title": "New record submitted",
  "message": "Lina Kaya submitted Purchased Electricity for January 2025.",
  "isRead": false,
  "link": "/dashboard/emissions?tab=history&recordId=record_001",
  "createdAt": "2026-02-03T10:31:00Z"
}
13.2 Mock Notifications
[
  {
    "id": "notification_001",
    "organisationId": "organisation_001",
    "type": "submission",
    "title": "New record submitted",
    "message": "Lina Kaya submitted Purchased Electricity for January 2025.",
    "isRead": false,
    "link": "/dashboard/emissions?tab=history&recordId=record_001",
    "createdAt": "2026-02-03T10:31:00Z"
  },
  {
    "id": "notification_002",
    "organisationId": "organisation_001",
    "type": "warning",
    "title": "Anomaly detected",
    "message": "Business travel entry for March 2025 requires review.",
    "isRead": true,
    "link": "/dashboard/emissions?tab=history&recordId=record_003",
    "createdAt": "2026-03-14T15:46:00Z"
  }
]
14. Tracking Matrix Model
14.1 Shape
{
  "subsidiaryId": "subsidiary_001",
  "subsidiaryName": "ECA Birmingham",
  "completionRate": 78,
  "categories": {
    "electricity": {
      "completionStatus": "complete",
      "value": 28.75,
      "unit": "tCo2e",
      "recordCount": 12
    },
    "gas": {
      "completionStatus": "incomplete",
      "value": 1.68,
      "unit": "tCo2e",
      "recordCount": 8
    },
    "travel": {
      "completionStatus": "missing",
      "value": null,
      "unit": null,
      "recordCount": 0
    }
  }
}
14.2 Mock Matrix Rows
[
  {
    "subsidiaryId": "subsidiary_001",
    "subsidiaryName": "ECA Birmingham",
    "completionRate": 78,
    "categories": {
      "electricity": {
        "completionStatus": "complete",
        "value": 28.75,
        "unit": "tCo2e",
        "recordCount": 12
      },
      "gas": {
        "completionStatus": "incomplete",
        "value": 1.68,
        "unit": "tCo2e",
        "recordCount": 8
      },
      "travel": {
        "completionStatus": "missing",
        "value": null,
        "unit": null,
        "recordCount": 0
      }
    }
  },
  {
    "subsidiaryId": "subsidiary_002",
    "subsidiaryName": "ECA Manchester",
    "completionRate": 83,
    "categories": {
      "electricity": {
        "completionStatus": "complete",
        "value": 25.40,
        "unit": "tCo2e",
        "recordCount": 12
      },
      "gas": {
        "completionStatus": "complete",
        "value": 1.71,
        "unit": "tCo2e",
        "recordCount": 12
      },
      "travel": {
        "completionStatus": "incomplete",
        "value": 6.34,
        "unit": "tCo2e",
        "recordCount": 4
      }
    }
  }
]
15. Report Model
15.1 Shape
{
  "id": "report_001",
  "organisationId": "organisation_001",
  "title": "Annual Carbon Disclosure 2025",
  "reportingYear": 2025,
  "reportingPeriod": "all_year",
  "status": "ready",
  "generatedAt": "2026-04-14T09:15:00Z",
  "generatedBy": "user_001",
  "downloadUrl": "https://example.com/reports/annual-carbon-disclosure-2025.pdf",
  "sections": [
    "organisation_summary",
    "reporting_boundary",
    "scope_summary",
    "category_breakdown",
    "methodology_notes",
    "data_completeness"
  ]
}
15.2 Mock Reports
[
  {
    "id": "report_001",
    "organisationId": "organisation_001",
    "title": "Annual Carbon Disclosure 2025",
    "reportingYear": 2025,
    "reportingPeriod": "all_year",
    "status": "ready",
    "generatedAt": "2026-04-14T09:15:00Z",
    "generatedBy": "user_001",
    "downloadUrl": "https://example.com/reports/annual-carbon-disclosure-2025.pdf"
  },
  {
    "id": "report_002",
    "organisationId": "organisation_001",
    "title": "Quarter 1 Carbon Summary 2025",
    "reportingYear": 2025,
    "reportingPeriod": "first_quarter",
    "status": "ready",
    "generatedAt": "2026-04-10T11:40:00Z",
    "generatedBy": "user_001",
    "downloadUrl": "https://example.com/reports/q1-carbon-summary-2025.pdf"
  }
]
16. Projection Scenario Model
16.1 Shape
{
  "id": "scenario_001",
  "organisationId": "organisation_001",
  "name": "Renewable Electricity Transition",
  "baselineYear": 2025,
  "targetYear": 2030,
  "scenarioType": "renewable_electricity_transition",
  "assumptions": {
    "renewableElectricityShare": 80,
    "fleetElectrificationShare": 20,
    "travelReductionPercent": 10
  },
  "baselineTCo2e": 4821.44,
  "projectedTCo2e": [
    { "year": 2026, "value": 4510.10 },
    { "year": 2027, "value": 4204.80 },
    { "year": 2028, "value": 3912.20 },
    { "year": 2029, "value": 3654.30 },
    { "year": 2030, "value": 3410.70 }
  ],
  "createdBy": "user_001",
  "createdAt": "2026-04-14T10:10:00Z"
}
16.2 Mock Scenario
{
  "id": "scenario_001",
  "organisationId": "organisation_001",
  "name": "Renewable Electricity Transition",
  "baselineYear": 2025,
  "targetYear": 2030,
  "scenarioType": "renewable_electricity_transition",
  "assumptions": {
    "renewableElectricityShare": 80,
    "fleetElectrificationShare": 20,
    "travelReductionPercent": 10
  },
  "baselineTCo2e": 4821.44,
  "projectedTCo2e": [
    { "year": 2026, "value": 4510.10 },
    { "year": 2027, "value": 4204.80 },
    { "year": 2028, "value": 3912.20 },
    { "year": 2029, "value": 3654.30 },
    { "year": 2030, "value": 3410.70 }
  ],
  "createdBy": "user_001",
  "createdAt": "2026-04-14T10:10:00Z"
}
17. Example Dashboard Response
{
  "summary": {
    "organisationId": "organisation_001",
    "reportingYear": 2025,
    "reportingPeriod": "all_year",
    "totalTCo2e": 4821.44,
    "scope1TCo2e": 612.32,
    "scope2TCo2e": 1088.11,
    "scope3TCo2e": 3121.01,
    "completeCategories": 18,
    "incompleteCategories": 5,
    "missingCategories": 2,
    "subsidiaryCount": 6,
    "calculationRate": 78
  },
  "matrix": [
    {
      "subsidiaryId": "subsidiary_001",
      "subsidiaryName": "ECA Birmingham",
      "completionRate": 78,
      "categories": {
        "electricity": {
          "completionStatus": "complete",
          "value": 28.75,
          "unit": "tCo2e",
          "recordCount": 12
        },
        "gas": {
          "completionStatus": "incomplete",
          "value": 1.68,
          "unit": "tCo2e",
          "recordCount": 8
        }
      }
    }
  ],
  "notifications": [
    {
      "id": "notification_001",
      "title": "New record submitted",
      "message": "Lina Kaya submitted Purchased Electricity for January 2025.",
      "isRead": false,
      "createdAt": "2026-02-03T10:31:00Z"
    }
  ]
}
18. Example Emissions Page Response
{
  "summaryCards": {
    "totalTCo2e": 4821.44,
    "scope1TCo2e": 612.32,
    "scope2TCo2e": 1088.11,
    "scope3TCo2e": 3121.01
  },
  "scopeSplit": [
    { "label": "Scope 1", "value": 612.32 },
    { "label": "Scope 2", "value": 1088.11 },
    { "label": "Scope 3", "value": 3121.01 }
  ],
  "categoryBreakdown": [
    {
      "categoryKey": "purchased_electricity",
      "scope": "scope_2",
      "tCo2e": 1088.11,
      "sharePercent": 22.57
    },
    {
      "categoryKey": "business_travel",
      "scope": "scope_3",
      "tCo2e": 680.44,
      "sharePercent": 14.11
    }
  ],
  "history": [
    {
      "recordId": "record_001",
      "timestamp": "2026-02-03T10:30:00Z",
      "subsidiaryId": "subsidiary_001",
      "categoryKey": "purchased_electricity",
      "subCategoryKey": "grid_electricity",
      "activityValue": 10450.75,
      "unit": "kwh",
      "tCo2e": 2.1643,
      "userId": "user_003",
      "evidenceCount": 2,
      "status": "submitted"
    }
  ],
  "trends": [
    { "period": "Q1 2025", "scope1": 122.10, "scope2": 275.40, "scope3": 812.60 },
    { "period": "Q2 2025", "scope1": 148.80, "scope2": 265.20, "scope3": 770.30 }
  ]
}
19. Example Data Entry Form Config
{
  "categoryKey": "purchased_electricity",
  "scope": "scope_2",
  "title": "Purchased Electricity",
  "description": "Enter purchased electricity usage for the selected subsidiary or operational location.",
  "allowedUnits": ["kwh", "mwh"],
  "requiresEvidence": true,
  "supportsDateRange": true,
  "supportsReportingPeriod": true,
  "fields": [
    {
      "name": "activityValue",
      "label": "Activity Value",
      "type": "number",
      "required": true
    },
    {
      "name": "unit",
      "label": "Unit",
      "type": "select",
      "required": true
    },
    {
      "name": "reportingPeriod",
      "label": "Reporting Period",
      "type": "select",
      "required": true
    },
    {
      "name": "comment",
      "label": "Comment",
      "type": "textarea",
      "required": false
    }
  ]
}
20. Frontend Seed Recommendation

Use the following baseline mock volumes to make the prototype feel realistic:

4 users
3 organisations
3 subsidiaries
6 suppliers
20 activity records
10 evidence files
20 audit logs
6 notifications
2 reports
1 scenario

This is enough to populate:

Overview
Emissions
Data Entry
Reports
Subsidiaries
Suppliers
Drawers
Charts
Audit history
21. Notes for Development
keep this file for mock objects and example payloads only
do not use this file as the source of truth for permission logic
use locked field names exactly
prefer realistic fictional company names over placeholders
align mock values with page level filters and chart behaviour
keep demoFactor visible in mock calculations where applicable

## Verdict

```md id="41238"
## Verdict
Accepted.

### Use This File For
- realistic mock objects
- example API payloads
- frontend seed data
- drawer and chart population
- believable Vercel prototype rendering

### Do Not Use This File For
- permission rules
- final calculation methodology
- API security logic
- workflow governance