# Technical Spec: Permissions and Role Based Access Control
**Document ID:** `TONY-TECH-001`  
**Application Area:** Global UI Logic, API Authorisation, Data Visibility

## 1. Purpose
This document defines role based access control for TonyAI Enterprise. It governs:
- UI visibility
- action permissions
- API access enforcement
- data perimeter rules
- audit responsibilities

This document must be used as the single source of truth for permission logic across frontend and backend workflows.

---

## 2. Role Definitions

TonyAI uses four primary roles.

| Role | Responsibility | Data Scope |
| :--- | :--- | :--- |
| `super_admin` | System governance, factor management, approvals, and configuration | All organisations |
| `consultant` | Review, anomaly flagging, advisory support | Assigned organisations only |
| `data_entry` | Activity logging, evidence upload, draft and submission workflows | Assigned subsidiaries and permitted parent organisation context |
| `executive_viewer` | Dashboard monitoring, report viewing, high level visibility | Assigned organisations only |

---

## 3. Functional Permissions Matrix

This matrix defines action permissions for UI rendering and backend enforcement.

| Feature / Action | super_admin | consultant | data_entry | executive_viewer |
| :--- | :---: | :---: | :---: | :---: |
| View dashboard and analytics | ✅ | ✅ | ✅ | ✅ |
| Enter or edit activity data | ✅ | ❌ | ✅ | ❌ |
| Upload evidence files | ✅ | ❌ | ✅ | ❌ |
| Save draft records | ✅ | ❌ | ✅ | ❌ |
| Submit records for review | ✅ | ❌ | ✅ | ❌ |
| Approve records | ✅ | ❌ | ❌ | ❌ |
| Reject records / flag for revision | ✅ | ✅ | ❌ | ❌ |
| Lock records | ✅ | ❌ | ❌ | ❌ |
| Manage subsidiaries | ✅ | ❌ | ❌ | ❌ |
| Manage suppliers | ✅ | ❌ | ❌ | ❌ |
| Override calculation factors | ✅ | ❌ | ❌ | ❌ |
| Generate and export reports | ✅ | ✅ | ❌ | ✅ |
| Manage users and roles | ✅ | ❌ | ❌ | ❌ |
| View audit trail | ✅ | ❌ ¹ | ❌ ¹ | ❌ ¹ |

### Limited Audit Visibility
- `data_entry` may view audit history for records they created or are assigned to
- `executive_viewer` may view report level or approved record level history only if enabled

---

## 4. UI Logic and Behaviour Rules

## 4.1 Conditional Rendering Rules
The UI must show or hide navigation, pages, buttons, and actions based on role.

### Sidebar Rules
- `User Management` must only render for `super_admin`
- `Audit and Approvals` must render for `super_admin`
- `Audit and Approvals` may render for `consultant` in review mode if enabled
- `data_entry` and `executive_viewer` must not see admin only navigation items

### Action Button Rules
- `Add Supplier` renders only for `super_admin`
- `Add Subsidiary` renders only for `super_admin`
- `Approve` and `Lock` actions render only for `super_admin`
- `Flag for Revision` renders for `super_admin` and `consultant`
- `Save Draft` and `Submit for Review` render for `data_entry` and `super_admin`

### Form Rules
If record status is `submitted`, `approved`, or `locked`:
- `data_entry` fields must switch to read only mode
- file upload controls must be disabled
- audit visibility remains available

---

## 5. Action Protection Rules

## 5.1 Submit Button
The Submit button must be disabled when:
- required fields are incomplete
- required evidence is missing
- anomaly comment is required but empty
- record is locked
- user lacks permission

## 5.2 Approval Button
The Approve button must only be enabled for `super_admin` when record status is:
- `submitted`
- `under_review`

## 5.3 Lock Rule
Only `super_admin` can lock records or close reporting periods.

---

## 6. Data Visibility and Access Perimeter

## 6.1 Server Side Authorisation Rule
All requests must be authorised using the authenticated user session or token.

The backend must enforce:
- user identity
- role
- organisation access
- subsidiary access
- record level constraints where relevant

Frontend visibility rules alone are not sufficient for security.

## 6.2 Access Scope Rule
A user may only retrieve or mutate data that belongs to their assigned scope.

### Example
If a `data_entry` user attempts to access a record for a `subsidiaryId` outside their assigned list:
- the backend must return **`404 Not Found`**

**Decision 2026-07-30 — 404 for tenancy, 403 for role.** An earlier draft of this
document said `403 Forbidden` here, but a 403 confirms that the row exists, which
hands an attacker a tenant-enumeration oracle. The implemented rule is:

| Situation | Status |
| --- | --- |
| Resource belongs to another tenant (outside `accessibleSubsidiaryIds`) | `404 Not Found` — indistinguishable from "does not exist" |
| Resource is visible to you, but your **role** may not perform the action | `403 Forbidden` |
| Resource is visible and you may act, but its **state** forbids it (locked period, wrong status) | `400` / `409` |

List endpoints never 404: they return only the rows in scope.

¹ **Narrowed 2026-07-30 (WP7).** The shipped `audit_log` RLS policy is
`super_admin` **and same-organisation** only. The earlier "consultant ✅ /
data_entry limited / executive_viewer limited" promise was never implemented and
the per-record scoping it implied has no column to hang on — audit rows are
scoped by organisation, not by subsidiary. Widening it later is a policy change
plus a scoping decision (which subsidiary does a `report` row with a null
`entityId` belong to?), so it is deliberately out of scope for the WP7 viewer.

## 6.3 Context Filtering Rule
All list and search results must be filtered by the user’s authorised organisation and subsidiary scope before being returned to the frontend.

---

## 7. Audit Trail Requirements

Every significant action must be logged.

### Required Audit Fields
- `userId`
- `role`
- `actionType`
- `resourceType`
- `resourceId`
- `timestamp`
- `comment` where applicable

### Example actionType values
- `create`
- `edit`
- `submit`
- `approve`
- `reject`
- `lock`
- `delete`
- `login`
- `request_unlock`

### Example JSON shape
```json
{
  "userId": "user_001",
  "role": "data_entry",
  "actionType": "submit",
  "resourceType": "activity_record",
  "resourceId": "record_001",
  "timestamp": "2026-04-14T10:12:00Z",
  "comment": "Submitted for review"
}