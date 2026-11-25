---
name: tenant-api-module
description: Scaffold a new tenant-scoped NestJS resource in apps/api (module + controller + service + DTOs) for TonyAI — reads filtered by accessibleSubsidiaryIds, role-gated writes (admin-managed or author-based workflow), audit-logged mutations, shared DTO types in @tonyai/shared-types, and a DB-free Vitest spec. Use when adding a new API entity/resource to the backend.
---

# tenant-api-module

Create a new backend resource that follows TonyAI's conventions. Two **canonical references** — pick the
one matching your resource type and mirror its structure:

- `apps/api/src/subsidiaries/` — **admin-managed** resource (org structure; writes gated by `can(user.role, 'company.write')`, the `masterkey` alone)
- `apps/api/src/activity-records/` — **workflow** resource (user-generated rows with a status lifecycle)

## When to use
Adding any new tenant-owned entity to the API (e.g. locations, evidence, suppliers, targets).
For read-only rollups (totals, breakdowns, matrices, trends) use **`aggregation-endpoint`** instead.
For an endpoint that ingests MANY rows from an uploaded file into an existing resource, use
**`bulk-ingest`** — it owns no table and routes every row through this resource's own create service.

## Rules (must hold)
- **Tenant scope every read.** The owning subsidiary id must be in `RequestUser.accessibleSubsidiaryIds`
  (set by `SupabaseAuthGuard`: the whole organisation for a `masterkey` and an `auditor`, the granted
  companies for a `super_admin` and a `standard_user`). For the subsidiary itself that's its own id; for a
  child entity use `where: { subsidiaryId: { in: user.accessibleSubsidiaryIds } }`. Ids outside the set →
  `NotFoundException`. A resource that reads **activity records, or figures built from them**, takes its
  filter from `recordScopeWhere(user)` (`apps/api/src/activity-records/record-scope.ts`; `recordScopeSql`
  for raw SQL, `inRecordScope` in memory) — never `accessibleSubsidiaryIds` alone, which would show a
  standard user every category of its company.
- **Gate writes by capability, never by a role literal.** Every role-keyed power is a row of
  `ROLE_CAPABILITIES` in `@tonyai/shared-types`, asked as `can(user.role, '<capability>')`. **A new
  power is a new capability:** add its row to `ROLE_CAPABILITIES` (the roles that hold it, read from the
  access matrix, INC-2.6 §6; a power no document gives a `super_admin` stays with the `masterkey`) **and**
  its pinned row to `MATRIX` in `packages/shared-types/src/roles.spec.ts` (`M`/`S`/`U`/`A` per role), so a
  changed cell fails by name. Never write `user.role === '…'`, a per-module role set or a role list in a
  service or a page; reuse an existing capability when one already means the same power. Both
  patterns throw `ForbiddenException` on failure:
  - *Admin-managed* (subsidiaries, period locks, targets): `assertCanWrite(user)` asks the resource's
    capability (`company.write`, `period_lock.write`, `target.write`). A capability a scoped role holds
    (`location.write`: `masterkey`, and a `super_admin` in its granted companies) is confined by the
    tenant scope above — a company outside the set answers as unknown.
  - *Workflow* (activity records, evidence): authoring is `mayAuthorRecords(user)` (`record.author`:
    `masterkey`, `super_admin`, `standard_user`); a standard user also passes `assertCategoryGranted`
    (`category_not_granted`) on create, edit and submit; rows carry `createdBy`; edits are the
    author's only, deletes the author's or a `can(role, 'record.delete_any_draft')` holder's, and only in
    editable statuses (e.g. `draft`/`rejected`) — mirror `assertCanMutate` in the activity-records
    service. An `auditor` holds no write capability.
  - *A body that scales with rows* (lists in a DTO, a raised body cap): the global pipe builds and
    validates every element before a role check in the service runs, so also refuse the write in a
    guard — `@UseGuards(...)` runs before pipes — and bound each list by its length there
    (`apps/api/src/inventory-boundary/boundary-writer.guard.ts`; LP3-04's `security-rls` P1: a
    reader's 1 MB of empty rows held the API for seconds). Keep the service's own check too.
- **Audit every mutation** — create/update/delete each write one `audit_log` row through Prisma.
- **Validate input** with `class-validator` DTOs (the global `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`).
- **Response types live in `@tonyai/shared-types`** (a `XxxDTO` interface) — never inline a duplicate type.
- Persist only through Prisma (`@tonyai/db`). The route prefix `/api/v1` is global.

## Steps
1. **Types** — add `XxxDTO`, `CreateXxxInput`, `UpdateXxxInput` to `packages/shared-types/src/index.ts`,
   then `pnpm --filter @tonyai/shared-types build`.
2. **Prisma** — if a new table is needed, add the model (snake_case `@@map`, `organisation_id`/`subsidiary_id`
   FK, timestamps), run a migration, and apply the **`rls-for-table`** skill for the new tenant table —
   including its step 2c, the runtime role's grants (the API connects as `tonyai_runtime`, LP1-03). The
   service's `accessibleSubsidiaryIds` scoping is the only filter on the API's queries (RLS does not apply to
   the runtime role), so add the new routes to `apps/api/test/int/tenant-isolation.int.spec.ts`.
3. **DTOs** — `apps/api/src/<res>/dto/create-<res>.dto.ts` and `update-<res>.dto.ts` (update = all optional).
4. **Service** — inject `PrismaService`; implement `list/get/create/update/remove` with the tenant filter,
   `assertCanWrite`, a `toDTO` mapper, and a private `audit(...)`.
5. **Controller** — `@Controller('<res>')`, use the `@CurrentUser()` param decorator, keep methods thin.
6. **Module** — register controller + service, and import the module in `apps/api/src/app.module.ts`.
7. **Test** — `apps/api/src/<res>/<res>.service.spec.ts` with a mocked Prisma (see `apps/api/test/helpers.ts`):
   assert tenant scoping, `NotFound` for an out-of-set id (without hitting the DB), `Forbidden` for every
   role that does not hold the write capability (loop over `USER_ROLES` with `can(...)`, so a new role is
   covered), a `super_admin` confined to its granted companies, and that a successful mutation calls
   `auditLog.create`.

## Skeleton (service core)
```ts
async list(user: RequestUser) {
  const rows = await this.prisma.<res>.findMany({
    where: { subsidiaryId: { in: user.accessibleSubsidiaryIds } }, // or { id: { in: ... } } for subsidiaries
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => this.toDTO(r));
}

// `can` from '@tonyai/shared-types'; '<res>.write' is a row of ROLE_CAPABILITIES, pinned in roles.spec.ts.
private assertCanWrite(user: RequestUser) {
  if (!can(user.role, '<res>.write')) throw new ForbiddenException('Your role may not modify <res>');
}

private async audit(userId: string, action: 'create' | 'update' | 'delete', entityId: string, diff: Record<string, unknown>) {
  await this.prisma.auditLog.create({
    data: { userId, action, entity: '<res>', entityId, diff: diff as Prisma.InputJsonValue },
  });
}
```

## Verify
```bash
pnpm --filter @tonyai/api typecheck && pnpm --filter @tonyai/api build && pnpm --filter @tonyai/api test
```
