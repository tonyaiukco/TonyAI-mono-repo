import { IntlMessageFormat } from 'intl-messageformat';
import { LOCALE_FORMAT_TAGS, type Locale } from '@tonyai/shared-types';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/**
 * The two emails the pilot sends (decision 2026-09-27): an invitation and a
 * password reset — TR/EN, rendered on the server from this module's own
 * catalogue (D16, README "Localisation and error codes"). The recipient's
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
  /** The inviting administrator's name; null when the operator provisioned. */
  inviter: string | null;
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
  // The operator's invitation goes to an organisation's first administrator:
  // there is no administrator yet to ask for a new link.
  const provisioned = content.kind === 'invitation' && !content.inviter;
  const bodyMessage = provisioned ? catalogue.invitation.bodyProvisioned : section.body;
  const expiryMessage = provisioned ? catalogue.invitation.expiryProvisioned : section.expiry;
  const parts = (values: Record<string, string | number>) => ({
    greeting: format(content.language, section.greeting, values),
    body: format(content.language, bodyMessage, values),
    action: format(content.language, section.action, values),
    expiry: format(content.language, expiryMessage, values),
    ignore: format(content.language, section.ignore, values),
  });
  const t = parts(plain);
  const h = parts(escaped);
  const link = content.link;

  const subject = oneLine(format(content.language, section.subject, plain));
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
