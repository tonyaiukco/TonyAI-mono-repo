# Tasks

## 1. The border token and its guard

- [x] 1.1 In `apps/web/app/globals.css`, set `--input: #8E8E93;` in both `:root` and `.dark`, and correct the `:root` comment above it so it says that `--input` is the form-control border colour and gives its 3:1 floor. Verify with `grep -n -- '--input:' apps/web/app/globals.css`: it shows exactly two lines, both `#8E8E93`.
- [x] 1.2 Add `apps/web/lib/theme-contrast.spec.ts`. It reads `app/globals.css`, takes `--input`, `--card` and `--background` from each of `:root` and `.dark`, computes WCAG 2.1 contrast, and asserts at least 3:1 for `input/card` and `input/background` in each block, naming the block and pair on failure. Verify: it passes with `pnpm --filter @tonyai/web test`. Then, as a mutation check, set `:root` `--input` back to `#FFFFFF` locally, confirm the spec fails and names `:root` `input/card`, and restore the line (commit first; see the memory note on `git checkout --`).
- [x] 1.3 Check the screens against the running web app on capped built servers: on `/register`, every text field and the unticked consent checkbox show a grey border before focus; focus still shows the green ring; a malformed registration code still shows the red border. `/login` and one data-entry form show the same idle borders. Verify by screenshots kept in the scratchpad, not in the repo.

## 2. Integration checks and the record

- [x] 2.1 Run `pnpm typecheck`, `pnpm lint` (ignoring `.claude/worktrees`), `pnpm test` and `pnpm build`; all pass.
- [x] 2.2 Run `openspec validate input-border-contrast --strict`; it passes.
- [x] 2.3 Record the change in `docs/roadmap_docs/project_status_roadmap_phases.md` (a Current status entry: form-control borders made visible app-wide, reported on QA registration) and open the pull request from `fix/input-border-contrast`; verify CI is green on it.

## Workflow follow-up

- After the owner merges: confirm the QA deploy run and that `qa.tonyai.io/register` shows the field borders and the consent checkbox before focus.
- Archive the change (`/opsx:archive`) in a follow-up pull request and record the merge in the planning file.
