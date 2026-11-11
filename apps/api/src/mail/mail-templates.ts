import { IntlMessageFormat } from 'intl-messageformat';
import { LOCALE_FORMAT_TAGS, type Locale } from '@tonyai/shared-types';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/**
 * The two emails the pilot sends (decision 2026-09-27): an invitation (in
 * three wordings: invited by an administrator, provisioned by the operator,
 * self-registered) and a password reset — TR/EN, rendered on the server from this module's own
 * catalogue (D16, docs/architecture/localisation.md). The recipient's
 * language picks the catalogue: the inviter's choice for an invitation, the
 * account's `profiles.language` for a reset.
 */
export type MailCatalogue = typeof en;
export const MAIL_CATALOGUES: Readonly<Record<Locale, MailCatalogue>> = Object.freeze({ en, tr });

/**
 * How long a link works, in hours — mirrors Supabase Auth's `otp_expiry`
 * (3600 s, decision S4 of LP4-01; `supabase/config.toml` locally, Codex's
 * `supabase_auth.py` in the cloud). The email states it, so the two move
 * together.
 */
export const AUTH_LINK_TTL_HOURS = 1;

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export type InvitationMail = {
  kind: 'invitation';
  language: Locale;
  name: string;
  organisation: string;
  /** The inviting administrator's name; null for an organisation's first
   *  administrator, whom nobody in it invited. */
  inviter: string | null;
  /** With no inviter: the recipient registered the organisation themselves
   *  (self-service registration), rather than the operator provisioning it. */
  selfRegistered?: boolean;
  link: string;
};

export type PasswordResetMail = {
  kind: 'password_reset';
  language: Locale;
  name: string;
  link: string;
};

export type MailContent = InvitationMail | PasswordResetMail;

/** HTML-escapes a value an administrator or user typed (a name, an organisation). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A header carries one line: typed text never adds another (nodemailer
 *  encodes headers too; this keeps the subject readable as well). */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function format(language: Locale, message: string, values: Record<string, string | number>): string {
  return String(new IntlMessageFormat(message, LOCALE_FORMAT_TAGS[language]).format(values));
}

export function renderMail(content: MailContent): RenderedMail {
  const catalogue = MAIL_CATALOGUES[content.language];
  const section = content.kind === 'invitation' ? catalogue.invitation : catalogue.passwordReset;
  const plain: Record<string, string | number> = { name: content.name, hours: AUTH_LINK_TTL_HOURS };
  if (content.kind === 'invitation') {
    plain.organisation = content.organisation;
    if (content.inviter) plain.inviter = content.inviter;
  }
  const escaped = Object.fromEntries(
    Object.entries(plain).map(([key, value]) => [key, typeof value === 'string' ? escapeHtml(value) : value]),
  );
  // An organisation's first administrator has no administrator to ask for a
  // new link: one the operator provisioned asks TonyAI, one who registered
  // submits the form again — and was not invited by anyone, so the whole
  // wording is their own. That wording names nobody and no company: the
  // public form's typed text never rides in an email from this domain to an
  // address its typist may not own (security review, F3).
  const first = content.kind === 'invitation' && !content.inviter;
  const registered = first && content.kind === 'invitation' && content.selfRegistered === true;
  const provisioned = first && !registered;
  const invitation = catalogue.invitation;
  const wording = registered
    ? {
        subject: invitation.subjectRegistered,
        greeting: invitation.greetingRegistered,
        body: invitation.bodyRegistered,
        action: invitation.actionRegistered,
        expiry: invitation.expiryRegistered,
        ignore: invitation.ignoreRegistered,
      }
    : {
        subject: section.subject,
        greeting: section.greeting,
        body: provisioned ? invitation.bodyProvisioned : section.body,
        action: section.action,
        expiry: provisioned ? invitation.expiryProvisioned : section.expiry,
        ignore: section.ignore,
      };
  const parts = (values: Record<string, string | number>) => ({
    greeting: format(content.language, wording.greeting, values),
    body: format(content.language, wording.body, values),
    action: format(content.language, wording.action, values),
    expiry: format(content.language, wording.expiry, values),
    ignore: format(content.language, wording.ignore, values),
  });
  const t = parts(plain);
  const h = parts(escaped);
  const link = content.link;

  const subject = oneLine(format(content.language, wording.subject, plain));
  const text = [t.greeting, '', t.body, '', `${t.action}: ${link}`, '', t.expiry, '', t.ignore, '', '—', catalogue.footer].join('\n');
  const html = `<!doctype html>
<html lang="${content.language}">
<body style="margin:0;padding:24px;background:#f6f7f6;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
<tr><td>
<p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#047857;">TonyAI</p>
<p style="margin:0 0 12px;">${h.greeting}</p>
<p style="margin:0 0 24px;line-height:1.5;">${h.body}</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">${h.action}</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563;">${h.expiry}</p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#4b5563;">${h.ignore}</p>
<p style="margin:0 0 4px;font-size:12px;color:#6b7280;">${escapeHtml(catalogue.linkFallback)}</p>
<p style="margin:0 0 24px;font-size:12px;word-break:break-all;color:#6b7280;">${escapeHtml(link)}</p>
<p style="margin:0;font-size:12px;color:#9ca3af;">${escapeHtml(catalogue.footer)}</p>
</td></tr>
</table>
</body>
</html>`;
  return { subject, text, html };
}
