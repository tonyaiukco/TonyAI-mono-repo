# Proposal

## Why

Self-service registration is open on hosted QA (`/register`, release `reg1-1`), but nothing on the sign-in page leads to it: a holding's first administrator who has the registration code and no account yet lands on `/login` and finds only "Forgot your password?". The registration page already links back to sign-in; the way there is missing (owner request, 2026-11-14).

## What Changes

- The sign-in page shows a line under its form, "No account yet? Register your company", linking to the registration page.
- The link is shown only while the environment's registration is open: the page asks the existing public `GET /auth/registration`. Where registration is off (404 `registration_unavailable`), or the answer cannot be read, the sign-in page shows no link and says nothing about it, so no visitor is sent to "Registration is not available". Sign-in itself never waits on that answer.
- The link is a path on the same web app (`/register`), never a hostname: on QA it resolves to `qa.tonyai.io/register`, and each later environment gets its own.
- Turkish and English copy in the `auth` catalogue.
- Unchanged: the registration code is still required, and every rule of the registration endpoint and page stands. The link shortens the way for an invited company; it opens nothing new.

Decisions taken with the owner (2026-11-14): conditional display over an unconditional link (an environment with registration off, the pilot before the reviewed KVKK notice included, shows nothing); a relative link over `qa.tonyai.io` written into the code.

No design document: one page, one existing public endpoint, no new pattern, dependency or data.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `self-service-registration`: adds a requirement that the sign-in page links to the registration page while registration is open, and shows no link otherwise.

## Impact

- **Web:** `apps/web/app/login/page.tsx`; `apps/web/messages/{en,tr}/auth.json`.
- **Tests:** `e2e/registration.spec.ts` (link shown and followed; hidden when off; hidden when unreachable, with sign-in still usable).
- **Docs:** the registration paragraph in `docs/architecture/security.md`; the planning file's status entry.
- **Not touched:** API, Prisma schema, RLS, `@tonyai/shared-types`, hosted configuration. One more unauthenticated `GET /auth/registration` per sign-in page view; the endpoint is public already and returns only the notice version.
- **Visibility:** the sign-in page of an environment with registration open now tells any visitor that it is open. The public status endpoint already did; the open questions filed under "Self-service registration follow-ups" (address squatting, quota bounds) are neither closed nor widened in kind, but the page is easier to find, which is one more reason to settle them before the pilot opens registration.
