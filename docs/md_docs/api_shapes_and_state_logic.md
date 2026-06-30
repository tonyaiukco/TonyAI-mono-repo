# Technical Spec: API Shapes and State Logic
**Document ID:** `TONY-TECH-002`  
**Application Area:** Frontend Backend Communication, JSON Schema, Global Context

## 1. Purpose
This document defines the JSON payload structures and client state rules used by the TonyAI platform.

It ensures that the frontend and backend use consistent naming, object structure, and refresh logic across:
- Overview
- Emissions
- Data Entry
- Reports
- Supporting drawers and filters

This document should align with the locked platform naming conventions.

---

## 2. Global Context Shape

When the application loads, the frontend should fetch the authenticated user context. This determines:
- visible organisations
- visible subsidiaries
- available reporting years
- active global filter context
- role based UI rendering

### Example JSON Shape
```json
{
  "user": {
    "id": "user_9921",
    "fullName": "Tony Stark",
    "role": "super_admin"
  },
  "accessibleOrganisations": [
    {
      "organisationId": "organisation_771",
      "name": "Global Holding Group",
      "subsidiaries": [
        {
          "subsidiaryId": "subsidiary_01",
          "name": "ECA - Energy Co A",
          "geographyCode": "UK"
        },
        {
          "subsidiaryId": "subsidiary_02",
          "name": "GDCB - Utilities",
          "geographyCode": "TR"
        }
      ]
    }
  ],
  "availableReportingYears": [2024, 2025, 2026],
  "activeContext": {
    "reportingYear": 2026,
    "reportingPeriod": "first_quarter",
    "organisationId": "organisation_771"
  }
}