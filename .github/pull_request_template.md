## Summary

<!-- What does this PR change, and why? -->

## Changes

-

## Testing

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] Manual / e2e check (describe below) — the suite runs nightly, not per PR; run `gh workflow run e2e.yml` for a change that touches a user flow

## Checklist

- [ ] Shared types added to `@tonyai/shared-types` (no duplicates)
- [ ] Tenant isolation + RBAC respected; RLS added for any new table
- [ ] `audit_log` written on mutations
- [ ] No secrets committed (`.env*` stays ignored)
- [ ] `README.md` updated if this change affects it
