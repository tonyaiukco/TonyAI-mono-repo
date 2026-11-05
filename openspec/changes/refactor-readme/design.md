# Design

## Context

See proposal.md (Why). State at `1a6c957`:

- **README size.** `README.md` is 2,592 lines. Its H2/H3 outline, with line ranges, is the source map for the move. The ranges are re-derived at implementation time because Codex edits the README between now and then.
- **Contracts cited from elsewhere.** Some passages are cited by name from code and from migrations. Examples:
  - `"Fingerprint encoding"` and `"The issuance"` are bold paragraph labels inside *Inventory coverage and report datasets*.
  - `"Seed users"`, `"Localisation and error codes"` and `"Release and …"` are also cited.
  - There are 39 citing files outside migrations (`apps/api/src`, `apps/web`, `packages/db/prisma/schema.prisma`, `e2e/`). Five applied migrations under `packages/db/prisma/migrations/` also carry citations.
- **Readers of README.md.** No code or test reads the README's content. `infra/scripts/replacement_bundle.py` hashes the whole file. `infra/scripts/qa_autodeploy.py` treats root `*.md`, `docs/` and `infra/` as docs-only, and `apps/`, `packages/` and `e2e/`… as image-relevant: `e2e/` is a non-image prefix, while `apps/` and `packages/` are not.
- **Inbound links.** One anchor comes in from outside: `infra/runbooks/04-verify.md:498` → `README.md#account-lifecycle-lp4-01`. The README links into itself through more than 20 anchors.
- **Staging section.** *Staging deployment (LP2-01)* runs 644 lines with no subheadings. Only 6 of its 597 long lines also appear in `infra/README.md` or the runbooks. It is a distinct document, not a duplicate.

## Goals / Non-Goals

**Goals:**
- Every byte that leaves the README is either:
  - found verbatim in its new document, or
  - listed as a deliberate deletion (only *Project status* and *Roadmap*, which the status file owns).
- Every link and citation into moved text resolves to its new home.
- After the change, a contract or architecture edit has an obvious single home, so the README does not regrow.

**Non-Goals:**
- Editing the content of moved sections: no rewording, no fact updates, no removal of LP/D/K codes inside the moved documents.
- Restructuring `docs/md_docs`, `docs/tech_docs`, the status file, `infra/README.md` or the runbooks.
- Adding an OpenAPI or Swagger reference, a licence file, badges beyond CI, or screenshots. There is no evidence in the repo to base them on.

## Decisions

### D1. Three pull requests

| PR | Scope | Files |
| --- | --- | --- |
| A | Move, link and rule change (docs only) | `README.md`, new docs, `infra/README.md`, `infra/runbooks/04-verify.md`, `CLAUDE.md`, `AGENTS.md`, two skills |
| B | Comment repoint (no runtime change) | 39 code and spec files |
| C | README rewrite (docs only) | `README.md` |

The rule change ships in PR A, not in a later PR. Once the contracts live in `docs/api/`, the old "keep README current" rule would tell Codex to write contract text back into the README.

*Alternative considered:* one PR. It was rejected for two reasons. The verbatim-move proof only works on a diff that does nothing else. And PR B touches `apps/`, which triggers a QA image deploy that a docs PR should not.

### D2. Move verbatim; promote headings uniformly

Each moved block goes into its target file unchanged except for two things:
1. A new H1 title and a one-line provenance note ("Moved from README.md on <date>; content unchanged").
2. A uniform heading-level shift, so the file's top section becomes H2.

Heading text stays identical. This keeps the anchor slugs and the by-name citations ("Fingerprint encoding", "The issuance") valid inside the new file.

A one-off check, run in the PR and pasted into its description (not committed), compares each target's body to the removed README lines after normalising leading `#` characters. It must report zero differing lines.

*Alternative considered:* tidying while moving. Rejected, because a moved compliance contract that was also edited cannot be reviewed as "unchanged".

### D3. Some sections are copied in A and trimmed in C

The sections that stay in the README in a shorter form are copied in full to their development document in PR A and trimmed in PR C:
- *Getting started*, including Option B, the seed notes and *Running in containers*
- *Troubleshooting*
- *Scripts*
- *Environment variables*
- *How it works*

This keeps each PR self-consistent. In A, nothing is lost. In C, the README only shrinks toward text that already exists in `docs/development/`.

### D4. Target map

| README section(s) | Target |
| --- | --- |
| API reference (current slice) | `docs/api/endpoints.md` |
| Reporting context contract (LP3-02) | `docs/api/reporting-context.md` |
| Bounded access contract (LP4-05) | `docs/api/bounded-access.md` |
| Inventory coverage and report datasets (LP3-04) | `docs/api/report-datasets.md` |
| Live reports and issued reports (LP4-03) | `docs/api/reports-and-issuance.md` |
| How it works, Security model, Account lifecycle | `docs/architecture/security.md` |
| Localisation and error codes | `docs/architecture/localisation.md` |
| Data model, Roles (RBAC) | `docs/architecture/data-model.md` |
| Observability | `docs/architecture/observability.md` |
| Getting started (full), Running in containers, Environment variables | `docs/development/local-setup.md` |
| Troubleshooting (full) | `docs/development/troubleshooting.md` |
| Scripts (full) | `docs/development/commands.md` |
| Testing | `docs/development/testing.md` |
| The AI subagent team, Skills | `docs/development/ai-workflow.md` |
| Staging deployment (LP2-01) | `infra/staging-deployment.md`, linked from `infra/README.md` |
| Project status, Roadmap | Deleted; the status file is the single source |
| Conventions, License, What is TonyAI, Architecture, Tech stack, Monorepo layout | Stay; reshaped in PR C |

`docs/api/`, `docs/architecture/` and `docs/development/` are new folders. They are named by reader intent. `docs/md_docs` (product specs) and `docs/tech_docs` (analysis) keep their current roles.

### D5. Citation repoint format

`README "X"` becomes `docs/api/report-datasets.md "X"`, and likewise for the other files. The quoted label is unchanged, so a reader can still search for it.

The five applied migrations are **left untouched**. Prisma checksums applied migration files, and editing one is drift. Their citations stay historically accurate: the text existed in the README at that commit.

`schema.prisma` comments are edited. Comments do not produce SQL, so `prisma migrate dev` must still report no change.

### D6. README shape (PR C)

The structure is the 14-section draft agreed in conversation on 2026-11-05.

The **top part**, presentable to customers, covers:
- title, pilot-scope note, What is TonyAI
- features table derived from the 18 API modules
- architecture and stack
- security and compliance
- environments

A ***For contributors*** part covers:
- getting started with the `/api/v1/health` success check
- the placeholder-factor warning
- commands
- configuration
- testing
- troubleshooting (top 4 rows)
- layout and contributing

A documentation index and the licence close the file.

Writing rules for the README:
- No LP/WP/D/K codes.
- No dated counts.
- No "Planned" stack row.
- The scope line reads Scope 1 & 2 (pilot), Scope 3 after the pilot.
- Target size is about 260 lines.

### D7. Narrowed rule text

`CLAUDE.md`, *Workflow* section, gets this text, mirrored in `AGENTS.md`:

> Keep docs current in the same change: `README.md` for setup, commands, configuration, environments and the feature list; `docs/api/` for API contracts; `docs/architecture/` for security, data model, localisation and observability; `docs/development/` for testing and tooling. Status lives only in the status file.

Two smaller edits go with it:
- `CLAUDE.md`'s project line becomes "Overview in `README.md`; contracts in `docs/api/`; specs in `docs/`".
- `localise-ui` and `workflow-gate` point at the new paths.

## Risks / Trade-offs

- [Codex edits README sections in flight; PR A conflicts] → PR A is cut from a freshly rebased `main` at a time agreed with the owner. Because the move is mechanical, a conflict is resolved by re-running the extraction on the new `main`, not by hand-merging.
- [A moved section is subtly altered] → The D2 check reports zero differing lines, and reviewers read the diff summary rather than 300 KB.
- [Stale anchors] → Run a link check over every changed `.md` file: every relative link and `#anchor` must resolve. Grep for `README.md#` and for `README "` across the repo, excluding migrations, and expect no hits for moved labels.
- [PR B deploys a new QA image for comment-only changes] → Accepted and stated in the PR. It runs the normal QA smoke.
- [The replacement-bundle digest changes] → Paused route. Stated in PR A and PR C; no action.
- [Customer-facing text overstates] → Every claim in the README's top part must trace to code or to an owner decision. The scope note names the pilot as a target, not as shipped.

## Migration Plan

1. Get the owner's go-ahead for a window in which Codex has no open README edits.
2. Open PR A, then PR B, then PR C, each after the previous one merges. The owner merges each.
3. Rollback is a revert of each PR. The PRs are independent of runtime, so a revert never needs a deploy beyond PR B's.

## Open Questions

- Whether the owner wants a ledger line in `project_status_roadmap_phases.md`. Codex is that file's only writer, so the entry goes through Codex or the owner, not this change.
