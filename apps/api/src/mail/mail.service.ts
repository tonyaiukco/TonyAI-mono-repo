import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { renderMail, type MailContent } from './mail-templates';

/**
 * What the mailer reads from the environment (`apps/api/.env.example`).
 * Locally the Supabase stack's mail catcher (mailpit, SMTP on 54325);
 * staging and production get LP2-04's SMTP credentials (Codex's handoff).
 */
export interface MailConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise STARTTLS, required off loopback. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  /** The web app's origin; every link is built on it, never on a request's Host. */
  appUrl: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class MailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailConfigError';
  }
}

/**
 * Reads the mail settings. Null when none are set — the API still boots (most
 * of it sends no mail) and an invitation or reset then fails observably with
 * `mail_not_configured`. A setting that is present but wrong throws.
 */
export function readMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const appUrl = env.APP_URL?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host && !appUrl && !from) return null;
  if (!host || !appUrl || !from) {
    throw new MailConfigError('SMTP_HOST, MAIL_FROM and APP_URL are set together or not at all');
  }
  let origin: string;
  try {
    const url = new URL(appUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
    origin = url.origin;
  } catch {
    throw new MailConfigError('APP_URL must be the web app origin, e.g. https://app.example.com');
  }
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MailConfigError('SMTP_PORT must be a port number');
  const secure = env.SMTP_SECURE === 'true';
  if (env.SMTP_SECURE && !['true', 'false'].includes(env.SMTP_SECURE)) {
    throw new MailConfigError("SMTP_SECURE must be 'true' or 'false'");
  }
  const user = env.SMTP_USER || undefined;
  const password = env.SMTP_PASSWORD || undefined;
  if (Boolean(user) !== Boolean(password)) throw new MailConfigError('SMTP_USER and SMTP_PASSWORD are set together');
  return { host, port, secure, user, password, from, appUrl: origin };
}

/** The outcome of one send, as the delivery state records it. */
export type MailOutcome = { ok: true } | { ok: false; code: 'mail_not_configured' | 'smtp_failed' };

/** The part of nodemailer the service uses — a test hands in its own. */
export type MailTransport = Pick<Transporter, 'sendMail'>;
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
/** Overrides the environment's settings (tests); null means "not configured". */
export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

export function smtpTransport(config: MailConfig): MailTransport {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Credentials never cross a network in clear: STARTTLS is mandatory off
    // loopback (mailpit on the developer's machine speaks plain SMTP).
    requireTLS: !config.secure && !LOOPBACK.has(config.host),
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Sends the pilot's two emails. Never throws for a delivery failure: the
 * caller records the outcome (an invitation's `last_error_*`), so a failed
 * email is visible and retried rather than an exception that loses the step.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  readonly config: MailConfig | null;
  private readonly transport: MailTransport | null;

  constructor(
    @Optional() @Inject(MAIL_TRANSPORT) transport?: MailTransport,
    @Optional() @Inject(MAIL_CONFIG) config?: MailConfig | null,
  ) {
    this.config = config === undefined ? readMailConfig() : config;
    this.transport = transport ?? (this.config ? smtpTransport(this.config) : null);
    if (!this.config) this.logger.warn('Mail is not configured (SMTP_HOST, MAIL_FROM, APP_URL): invitations and resets will not be delivered');
  }

  /** `${APP_URL}/auth/confirm?token_hash=…&type=…` — the page that runs `verifyOtp` (K5). */
  confirmLink(tokenHash: string, type: 'invite' | 'recovery'): string | null {
    if (!this.config) return null;
    const url = new URL('/auth/confirm', this.config.appUrl);
    url.searchParams.set('token_hash', tokenHash);
    url.searchParams.set('type', type);
    return url.toString();
  }

  async send(to: string, content: MailContent): Promise<MailOutcome> {
    if (!this.config || !this.transport) return { ok: false, code: 'mail_not_configured' };
    const mail = renderMail(content);
    try {
      await this.transport.sendMail({ from: this.config.from, to, subject: mail.subject, text: mail.text, html: mail.html });
      return { ok: true };
    } catch (error) {
      // The provider's message can echo the address; log the class of failure
      // and the SMTP code only.
      const code = (error as { responseCode?: number; code?: string }).responseCode ?? (error as { code?: string }).code;
      this.logger.error(`SMTP delivery failed (${content.kind}): ${code ?? 'unknown'}`);
      return { ok: false, code: 'smtp_failed' };
    }
  }
}
