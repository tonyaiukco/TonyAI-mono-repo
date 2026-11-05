# Tasks

## 1. Preparation

- [x] 1.1 Confirm with the owner a window with no open Codex README edits. Then rebase the branch on fresh `main`. Verify: `git log main..HEAD` shows only this change's commits, and `gh pr list --search README` shows no open PR touching `README.md`.
- [x] 1.2 Re-derive the README section map (H2–H3 line ranges, fence-aware) on the rebased `main`. Map each range to its D4 target. Verify: every line of `README.md` falls in exactly one range marked *move*, *copy*, *delete* or *stay*.

## 2. PR A — move sections out (docs only)

- [x] 2.1 Create `docs/api/endpoints.md`, `reporting-context.md`, `bounded-access.md`, `report-datasets.md` and `reports-and-issuance.md` from their README blocks:
  - each gets an H1, a provenance line and a uniform heading shift (D2)
  - the blocks are removed from the README

  Verify: the D2 check reports 0 differing lines for each file.
- [x] 2.2 Create `docs/architecture/security.md`, `localisation.md`, `data-model.md` and `observability.md` the same way. Verify: the D2 check reports 0 differing lines for each file.
- [x] 2.3 Create `docs/development/testing.md` and `ai-workflow.md`, both moved, and `local-setup.md`, `troubleshooting.md` and `commands.md`, all copied in full per D3. Verify: the D2 check reports 0 differing lines, and the copied README sections are still present unchanged.
- [x] 2.4 Create `infra/staging-deployment.md` from *Staging deployment (LP2-01)* and add a link to it in `infra/README.md`. Verify: the D2 check reports 0 differing lines, and the link resolves.
- [x] 2.5 Delete *Project status* and *Roadmap* from the README. Put a short paragraph linking to `docs/roadmap_docs/project_status_roadmap_phases.md` in their place. Verify: the PR description lists both deleted ranges, and the link resolves.
- [x] 2.6 Repoint links:
  - In the README, replace each moved section with a one-line pointer.
  - Rewrite internal `#anchor` links in the README and the new files.
  - Update `infra/runbooks/04-verify.md:498` to `docs/architecture/security.md#account-lifecycle-lp4-01`.

  Verify: a relative-link and anchor check over every changed `.md` file reports 0 broken links, and `git grep "README.md#"` returns no anchor into a moved section.
- [x] 2.7 Apply the D7 rule text:
  - in `CLAUDE.md` (*Workflow* and the project line)
  - in `AGENTS.md`
  - in `.claude/skills/localise-ui/SKILL.md` and `.claude/skills/workflow-gate/SKILL.md`, which repoint to the new paths

  Verify: `git grep -n -i "keep .README" CLAUDE.md AGENTS.md .claude` returns only the narrowed wording.
- [x] 2.8 Confirm the self-hosted anchors are intact. Verify: `infra/runbooks/11-qa-hosted.md` is unchanged, and the anchors cited by `deploy-qa.yml` and `rollback-qa.yml` still exist.
- [x] 2.9 Open PR A (`docs/refactor-big-md-files`). In the description, include the D2 check output, the link-check output and the replacement-bundle digest note. Verify: CI is green; the owner merges.

## 3. PR B — repoint code citations (comments only)

- [x] 3.1 After PR A merges, branch from `main`. Rewrite each `README "X"` / `README:` citation in the 39 non-migration files to the D5 form, quoting the new doc path. Leave `packages/db/prisma/migrations/**` untouched. Verify: `git grep -n "README" -- apps packages e2e ':!packages/db/prisma/migrations'` returns no citation of a moved section, and `git diff --stat -- packages/db/prisma/migrations` is empty.
- [x] 3.2 Prove the change is comment-only. Verify: `pnpm typecheck`, `pnpm lint` and `pnpm test` are green. With the local stack up, `pnpm --filter @tonyai/db exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL"` reports no change other than the known `activity_records` index note.
- [x] 3.3 Open PR B. State in the description that it is comment-only and triggers a QA image deploy. Verify: CI is green, the QA deploy smoke passes after merge, and the owner merges.

## 4. PR C — rewrite the README

- [x] 4.1 After PR B merges, branch from `main`. Replace `README.md` with the D6 structure, following the conversation draft of 2026-11-05 and updated to the current `main`. Verify:
  - About 260 lines.
  - `grep -nE "\b(LP[0-9]|WP[0-9]|D[0-9]{2}|K[0-9])\b" README.md` returns nothing.
  - No "Scope 1/2/3" claim remains.
- [x] 4.2 Check every fact in the README against the repo:
  - the commands table against root `package.json` scripts
  - the configuration keys against each `.env.example`
  - the features table against the `apps/api/src` modules
  - the environments table against the hosting decision in `CLAUDE.md`

  Verify: each row has a source, and nothing is listed that the repo lacks.
- [ ] 4.3 Run the quick start on a clean checkout: `pnpm setup`, `pnpm dev`, then `curl -i http://localhost:3001/api/v1/health`, then sign in as `admin@tonyai.local`. Verify: the health check returns 200 and the dashboard loads.
- [ ] 4.4 Check links and rendering. Verify: the link check over `README.md` reports 0 broken links and anchors, and the Mermaid diagram and the alerts render on GitHub's PR preview.
- [ ] 4.5 Open PR C. In the description, include a before/after size note and the replacement-bundle digest note. Verify: CI is green; the owner merges.

## Workflow follow-up

- Ask the owner whether a ledger line goes into `docs/roadmap_docs/project_status_roadmap_phases.md`. Codex is that file's only writer.
- Archive the change after PR C merges.
