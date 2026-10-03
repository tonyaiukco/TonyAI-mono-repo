---
name: azure-deploy
description: Prepare or review TonyAI Azure Container Apps staging configuration and owner-run deployment evidence. Use for this repository's infra foundation and cloud recreation, not local Supabase setup.
---

Read the repository AGENTS.md, task reservation and roadmap card before acting.
The task's cloud authorization controls execution; this recipe grants none.

Use [infra/README.md](../README.md) to choose the relevant numbered runbook.
Backend bootstrap, foundation Terraform, secret transfer and application Terraform have separate writers: first discover
stable origins, then configure Supabase/Key Vault, then build and deploy images.

Preserve these project-specific traps:

- Never run the full seed or local RLS/E2E helpers in cloud: they assume demo users
  and mutate fixtures. Empty staging is intentional until controlled onboarding.
- Browser config is compiled into the web image. Rebuild for the target project
  and origins; promote API only with qualified immutable digests.
- Use Supavisor transaction mode for runtime, session mode for migrations. Cloud
  JWT scheme is `jwks`; omit the legacy secret and insecure-local bypass.
- API and web identities are separate. Only API's two named secrets get data-plane
  read grants; migration credentials stay owner-only. A GitHub deployer can replace
  API code and therefore access runtime secrets. Enforced staging environment and
  branch protections are the trust boundary. Never inspect/print values.
- GitHub's environment OIDC subject does not constrain the branch by itself.
  Verify enforced environment restrictions before establishing federation.
- Current API health is liveness, not DB readiness. Image rollback is not schema
  rollback; Supabase database backups do not restore Storage object bytes.

Validate both Terraform roots and their mock-provider tests locally, run the credential-free Python
tests and required repository checks, then request the required independent
reviews. Report actual SHA/environment/results and unexecuted cloud steps in the
PR's B9 handoff. Leave roadmap edits to the Claude Code lane. Local mocks and
compiled templates never establish LP2-01 cloud acceptance.
