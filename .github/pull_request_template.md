## Summary

<!-- What does this PR change, and why? -->

## Changes

-

## Testing

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] Manual / e2e check (describe below)

## Checklist

- [ ] Shared types added to `@tonyai/shared-types` (no duplicates)
- [ ] Tenant isolation + RBAC respected; RLS added for any new table
- [ ] `audit_log` written on mutations
- [ ] No secrets committed (`.env*` stays ignored)
- [ ] `README.md` updated if this change affects it
