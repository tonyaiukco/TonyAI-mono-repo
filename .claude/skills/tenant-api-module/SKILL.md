---
name: tenant-api-module
description: Scaffold a new tenant-scoped NestJS resource in apps/api (module + controller + service + DTOs) for TonyAI — reads filtered by accessibleSubsidiaryIds, role-gated writes (admin-managed or author-based workflow), audit-logged mutations, shared DTO types in @tonyai/shared-types, and a DB-free Vitest spec. Use when adding a new API entity/resource to the backend.
---

# tenant-api-module

Create a new backend resource that follows TonyAI's conventions. Two **canonical references** — pick the
one matching your resource type and mirror its structure:

- `apps/api/src/subsidiaries/` — **admin-managed** resource (org structure; `super_admin`-only writes)
- `apps/api/src/activity-records/` — **workflow** resource (user-generated rows with a status lifecycle)

## When to use
Adding any new tenant-owned entity to the API (e.g. locations, evidence, suppliers, targets).
For read-only rollups (totals, breakdowns, matrices, trends) use **`aggregation-endpoint`** instead.

## Rules (must hold)
- **Tenant scope every read.** The owning subsidiary id must be in `RequestUser.accessibleSubsidiaryIds`
  (set by `SupabaseAuthGuard`). For the subsidiary itself that's its own id; for a child entity use
  `where: { subsidiaryId: { in: user.accessibleSubsidiaryIds } }`. Ids outside the set → `NotFoundException`.
- **Gate writes by resource type** (both patterns throw `ForbiddenException` on failure):
  - *Admin-managed* (subsidiaries, locations): writes require `super_admin` via `assertCanWrite(user)`.
  - *Workflow* (activity records, evidence): writes allowed to a `WRITE_ROLES` set
    (`data_entry` / `consultant` / `super_admin`); rows carry `createdBy`; edits/deletes restricted to
    **author-or-`super_admin`** and to editable statuses only (e.g. `draft`/`rejected`) — mirror
    `assertCanMutate` in the activity-records service.
- **Audit every mutation** — create/update/delete each write one `audit_log` row through Prisma.
- **Validate input** with `class-validator` DTOs (the global `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`).
- **Response types live in `@tonyai/shared-types`** (a `XxxDTO` interface) — never inline a duplicate type.
- Persist only through Prisma (`@tonyai/db`). The route prefix `/api/v1` is global.

## Steps
1. **Types** — add `XxxDTO`, `CreateXxxInput`, `UpdateXxxInput` to `packages/shared-types/src/index.ts`,
   then `pnpm --filter @tonyai/shared-types build`.
2. **Prisma** — if a new table is needed, add the model (snake_case `@@map`, `organisation_id`/`subsidiary_id`
   FK, timestamps), run a migration, and apply the **`rls-for-table`** skill for the new tenant table.
3. **DTOs** — `apps/api/src/<res>/dto/create-<res>.dto.ts` and `update-<res>.dto.ts` (update = all optional).
4. **Service** — inject `PrismaService`; implement `list/get/create/update/remove` with the tenant filter,
   `assertCanWrite`, a `toDTO` mapper, and a private `audit(...)`.
5. **Controller** — `@Controller('<res>')`, use the `@CurrentUser()` param decorator, keep methods thin.
6. **Module** — register controller + service, and import the module in `apps/api/src/app.module.ts`.
7. **Test** — `apps/api/src/<res>/<res>.service.spec.ts` with a mocked Prisma (see `apps/api/test/helpers.ts`):
   assert tenant scoping, `NotFound` for an out-of-set id (without hitting the DB), `Forbidden` for non-`super_admin`
   writes, and that a successful mutation calls `auditLog.create`.

## Skeleton (service core)
```ts
async list(user: RequestUser) {
  const rows = await this.prisma.<res>.findMany({
    where: { subsidiaryId: { in: user.accessibleSubsidiaryIds } }, // or { id: { in: ... } } for subsidiaries
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => this.toDTO(r));
}

private assertCanWrite(user: RequestUser) {
  if (user.role !== 'super_admin') throw new ForbiddenException('Only super_admin may modify <res>');
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
