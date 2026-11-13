# Tasks

## 1. The link on the sign-in page

- [x] 1.1 Add `signIn.noAccount` and `signIn.register` to `apps/web/messages/en/auth.json` and `apps/web/messages/tr/auth.json` ("No account yet?" / "Register your company"; "Hesabınız yok mu?" / "Şirketinizi kaydedin"); verify `messages.spec.ts` passes (both locales hold the same keys).
- [x] 1.2 In `apps/web/app/login/page.tsx`, read `api.getRegistrationStatus()` once after mount and render the line under the form, styled as the registration page's "Already registered? Sign in", only when it returns a status; `null` (registration off) and any thrown error both leave the link out, with no toast. The link is `<Link href="/register">`. Verify by `pnpm typecheck` and by task 1.3.
- [ ] 1.3 Extend `e2e/registration.spec.ts`: (a) with registration open (the suite's `REGISTRATION_CODE=local`), `/login` shows the link and clicking it lands on `/register` with the form; (b) with `GET /auth/registration` stubbed to 404 `registration_unavailable`, `/login` shows the form and no link; (c) with the request aborted, no link, no error toast, and a seed user still signs in; (d) a Turkish visitor sees "Şirketinizi kaydedin". Verify the spec passes on built, capped servers with CI's `RATE_*_PER_MINUTE` (it must not add `POST /auth/registration` calls: the spec already spends four of the five a minute).
- [x] 1.4 Add one sentence to the self-service registration paragraph of `docs/architecture/security.md`: the sign-in page links to `/register` only while `GET /auth/registration` answers, and shows nothing otherwise. Verify the paragraph still reads true against the code.

## 2. Integration checks and the record

- [ ] 2.1 Run `pnpm typecheck`, `pnpm lint` (ignoring `.claude/worktrees`), `pnpm test` and `pnpm build`; all pass.
- [ ] 2.2 Run `openspec validate login-register-link --strict`; it passes.
- [ ] 2.3 Record the change in `docs/roadmap_docs/project_status_roadmap_phases.md` (Current status entry; the "Self-service registration" line notes that the sign-in page now advertises the page where registration is open) and open the pull request; verify CI is green on it.

## Workflow follow-up

- After the owner merges: confirm the QA deploy run and that `qa.tonyai.io/login` shows the link and it opens `qa.tonyai.io/register`.
- Archive the change (`/opsx:archive`) in a follow-up pull request and record the merge in the planning file.
