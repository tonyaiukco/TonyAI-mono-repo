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
| Attach one evidence file to several records (own editable records of one subsidiary; any author's for `super_admin`) | ✅ | ❌ | ✅ | ❌ |
| Save draft records | ✅ | ❌ | ✅ | ❌ |
| Submit records for review (own records only — decision D02, `super_admin` included) | ✅ | ❌ | ✅ | ❌ |
| Approve records (never a record you created — decision D01) | ✅ | ❌ | ❌ | ❌ |
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
- `Approve` and `Lock` actions render only for `super_admin`; `Approve` not on a record the viewer created (D01)
- `Flag for Revision` renders for `super_admin` and `consultant`
- `Save Draft` and `Submit for Review` render for `data_entry` and `super_admin`; `Submit for Review` only on the viewer's own record (D02)

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

and the record was created by someone else: the approver is neither the record's creator nor its submitter (decision D01, 2026-09-29; the API answers 403 otherwise). Only the author may submit (D02), so the creator and the submitter are the same person.

## 5.2a Concurrent changes
Two people acting on one record at once are serialised by the API (LP1-01): the second request runs after the first commits and is re-checked against the result. If it no longer holds — the record was approved while a reviewer was opening it, submitted while its author was still editing — the API answers 409 "This record was changed by someone else while your request was in progress. Reload it and try again." and changes nothing.

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

## 6.4 Personal Data in Tenant-Scoped Reads

**Decision 2026-08-16 — the reporting contact is visible to every role in the
tenant, deliberately.**

WP16 PR 2a added `contactEmail` and `contactPhone` to `Subsidiary` and returned
them through `toDTO`. `SubsidiariesService.list()` carries no role gate — it is
tenant-scoped only — so `GET /subsidiaries` now hands a named individual's work
email and phone to `data_entry`, `consultant` and `executive_viewer`, not just
`super_admin`. That was a side effect of adding fields to a shared serialiser
rather than a decision, and it is a wider surface than the audit-trail question
that PR did consider. Recorded here so it reads as intended rather than
accidental.

**Why it is intended.** The point of recording a reporting contact is that
people can reach them. A `data_entry` user preparing figures for a subsidiary
needs to know who owns them; an `executive_viewer` reading a dashboard needs to
know who to ask.

**The non-obvious part is `consultant`.** That seat is typically filled from
*outside* the holding company — it is why approval stays with the client's own
`super_admin` (§3, and the rationale in `activity-records.service.ts`). So this
decision does disclose a named employee's work contact to an external advisor.
It is still the right call: reviewing data and flagging anomalies is exactly the
work that requires asking the preparer a question. It is disclosure to an
engaged professional within the scope of that engagement, not publication.

**Scope of the disclosure.** Work contact details of an identified individual
acting in a professional capacity, within one tenant. Not private contact
details, not visible across organisations (RLS `subsidiaries_select_scoped` is
row-level and organisation-bounded — its explicit-grant branch too since LP1-03,
which also makes a cross-organisation grant impossible at the database; verified
by the containment probes in `scripts/rls-probes.mjs`).

**What follows from it:**
- UI labels must say **"work contact"**, and placeholder text should steer users
  toward a role mailbox (`esg@company.com`) rather than a personal mobile. These
  values also land in the append-only `audit_log`, where there is no erasure
  path once written.
- RLS is **not** the control here and never could be: the policy is row-level
  with no column list, so it contains cross-tenant exposure only. Narrowing this
  later means a projection change in `toDTO` — a partial DTO or a second
  serialiser, since `list()` and `get()` share it — not a policy change.
- `audit_log` retention and the lawful basis for keeping these values
  indefinitely are still unrecorded, and must be settled before staging holds
  real customer data.

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