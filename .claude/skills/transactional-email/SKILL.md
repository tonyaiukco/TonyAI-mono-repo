---
name: transactional-email
description: Send one of TonyAI's emails from the NestJS API — TR/EN copy in a server catalogue rendered with intl-messageformat, escaped HTML beside plain text, links built on APP_URL (never a request's Host), the outcome recorded on durable state instead of thrown, the database written before any external step, and an in-memory transport in tests. Use when a feature must email someone (today the invitation and the password reset, LP4-01). Not for on-screen copy (localise-ui) or downloadable documents (report-generation).
---

# transactional-email

Email is the one product output that leaves through a third party and cannot be
taken back, so it follows the same discipline as Storage: **the database first,
the external step after, its outcome recorded where an operator and a screen can
see it.** The **canonical reference** is LP4-01's invitation and reset:
`apps/api/src/mail/` (transport, templates, catalogue) and
`apps/api/src/users/invitation-delivery.service.ts` / `password-reset.service.ts`.

## When to use
A feature must send an email — a new kind of notification, a new auth email. The
pilot sends exactly two (invitation, password reset; decision 2026-09-27); a third
kind is a product decision first (workflow notifications are LP7-05).

## Rules (must hold)
- **Language by D16.** The recipient's `profiles.language`; an invitation the
  language its inviter chose, stored on the invitation. Never a request header,
  never `user_metadata`.
- **Copy in the server catalogue**, `apps/api/src/mail/i18n/{en,tr}.json` — one
  section per email, ICU messages, the same arguments in both languages
  (`mail-templates.spec.ts` holds keys, arguments, translation and invisible
  characters). Rendered with `intl-messageformat` under `LOCALE_FORMAT_TAGS`. The
  product name stays a literal.
- **Escape what people typed.** Names and organisation names go through
  `escapeHtml` in the HTML part only; the text part is plain; the subject is one
  line (`oneLine`). Never interpolate caller text into a URL.
- **Links on `APP_URL` alone** (`MailService.confirmLink`) — the web origin from
  the environment, never a request's Host (host-header injection would mail an
  attacker's domain). Auth links go straight to `/auth/confirm?token_hash=…&type=…`
  (K5); the token comes from `auth.admin.generateLink` and is never stored.
- **The database before the email.** Commit the state change (and its audit
  row) first; then mint the link and send. Record the outcome on a durable row
  (an invitation's `last_error_step` / `last_error_code`, a cooldown column) —
  `MailService.send` never throws for a delivery failure, it answers
  `{ ok: false, code: 'smtp_failed' | 'mail_not_configured' }`. A short machine
  code only: a provider's message can echo the address.
- **Mint only when the email can carry it.** A re-minted Auth link voids the
  previous one; check `mail.config` before `generateLink`, so "mail not
  configured" never strands a person with a dead link. Auth users are created
  banned and unbanned by the Auth sync before the link is minted (a password
  change voids one-time tokens, so never mint first); a failed unban sends no
  link (LP4-01 Codex re-review, finding 2). Sync only a banned user: the
  unban replaces the password, and a re-send must not wipe the one a
  confirmed invitee chose.
- **Look an address up by exact equality** on `normaliseEmail()` (stored
  trimmed and lower-case, CHECK `profiles_email_normalised`) — never Prisma's
  `mode: 'insensitive'`, which is an unescaped ILIKE: `%` and `_` in a typed
  address would match other accounts (LP4-01 review P1).
- **No existence oracle on public endpoints.** A public trigger (reset) answers
  the same status and body for every address and does the work after the
  response — in a bounded queue drained by a fixed number of workers (each
  tracked with `RuntimeLimits.acquire`, so a shutdown's `settle()` waits for it).
  **Capacity is an oracle too:** a job for an existing account holds a worker
  longer, so a full queue drops and logs, still answering 202; only a quota that
  knows nothing of accounts may answer 429 (LP4-01 Codex review, finding 4).
  What a FIFO queue still shows is *when* the requester's own email arrives —
  eligible jobs ahead of it delay it: a noisy residual (one trial per address
  per cooldown, and it mails the target), accepted for the pilot. A
  per-address cooldown lives in the database (claimed in one conditional
  UPDATE), a per-client-address quota in `RuntimeLimits.quota`.
- **Audit what changed, not what was said.** The state change is audited; a diff
  never holds the address, the name or the token (the trail has no correction
  path, D20). A row no person performed carries a null `userId`
  (`AuditService.recordSystem`).
- **Transport.** nodemailer over SMTP (`readMailConfig`): `SMTP_HOST`, `MAIL_FROM`,
  `APP_URL` together or not at all; STARTTLS required off loopback. Locally the
  Supabase stack's mailpit (SMTP 54325, UI http://127.0.0.1:54324); staging and
  production get LP2-04's provider through the same variables.

## Steps
1. **Decide the trigger and its durable state** — which row records that the
   email is owed and whether it went out (add columns or a table in a migration;
   `rls-for-table` for a table, a runtime grant in the migration and in
   `runtime-role.mjs`).
2. **Copy** — add a section to both catalogues; extend `MailContent` and
   `renderMail` in `mail-templates.ts`; extend `mail-templates.spec.ts`.
3. **Send** — in the feature's service: commit the change, then (outside the
   transaction) mint any link, `mail.send(to, content)`, and write the outcome
   with a conditional update (`where: { …, status: <the state you expect> }`) so a
   concurrent change (a disable) is never overwritten.
4. **Retry path** — a screen action or an operator command that re-runs the
   steps from the recorded state; every step idempotent.
5. **Copy on screen** — the web words the recorded outcome through the catalogues
   (`localise-ui`).

## Skeleton
```ts
// after the transaction that changed the state committed:
const token = this.mail.config ? await this.authAdmin.inviteToken(profileId, email) : null;
const link = token ? this.mail.confirmLink(token, 'invite') : null;
if (!link) return this.fail(db, profileId, 'email', 'mail_not_configured');
const sent = await this.mail.send(email, { kind: 'invitation', language, name, organisation, inviter, link });
if (!sent.ok) return this.fail(db, profileId, 'email', sent.code);
await db.invitation.updateMany({ where: { profileId, status: 'pending' }, data: { status: 'sent', sentAt: new Date() } });
```

## Verify
```bash
pnpm --filter @tonyai/api exec vitest run src/mail          # catalogue parity, escaping, config
set -a; source apps/api/.env; set +a
pnpm --filter @tonyai/api test:int -t onboarding             # real DB + GoTrue, in-memory transport
curl -s 'http://127.0.0.1:54324/api/v1/messages?limit=5'      # the live run: what mailpit received
```
Prove a failure path too: a transport that throws must leave the state saying so,
and the retry must complete it.
