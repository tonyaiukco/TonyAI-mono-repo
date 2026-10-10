import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DEFAULT_LOCALE, isLocale } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { normaliseEmail } from '../auth/access-admin.service';
import { RuntimeLimits } from '../common/runtime-limits';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthAdminService } from './auth-admin.service';

/** The durable per-address cooldown (decision S5): one link per five minutes. */
export const RESET_COOLDOWN_SECONDS = 300;
/** Reset jobs one API instance runs at once. */
export const RESET_WORKERS = 4;
/** Requests one API instance holds waiting for a worker; past it they are dropped. */
export const RESET_QUEUE_MAX = 1_000;

/**
 * Requests per minute one client address may make (decision S6). Read here
 * rather than in `LIMIT_DEFAULTS`, which is LP4-05's — PR C may fold it in.
 */
export function readResetPerIpLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTH_EMAIL_PER_IP_PER_MINUTE;
  if (raw === undefined || raw === '') return 5;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error('AUTH_EMAIL_PER_IP_PER_MINUTE must be an integer between 1 and 10000');
  }
  return value;
}

/**
 * The public "forgot password" endpoint's work (K5, D16). The response is the
 * same 202 for every address, and it leaves before any of this runs — so
 * neither its body nor its timing says whether an account exists. Then, for
 * an enabled account of an active organisation outside its cooldown: one
 * audited claim of the cooldown, a fresh recovery link, and the email in the
 * account's own language. Unknown, disabled or cooling-down addresses get
 * nothing.
 *
 * Capacity never shows in the answer (Codex review, finding 4): requests wait
 * in a bounded queue for a fixed set of workers, and one past the queue's
 * bound is dropped and logged — still a 202. A refusal that depended on how
 * long the work ahead took would tell an outsider whether the accounts behind
 * it exist. Only the per-client-address quota, which knows nothing of
 * accounts, answers 429. A running job is tracked by `RuntimeLimits`, so a
 * shutdown waits for it; queued ones are dropped once it starts.
 */
@Injectable()
export class PasswordResetService implements OnModuleInit {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly perIpPerMinute = readResetPerIpLimit();
  private limits!: RuntimeLimits;
  private readonly queue: string[] = [];
  private workers = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authAdmin: AuthAdminService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The application's one `RuntimeLimits` (the root module's), whose quota
   *  maps and shutdown settling every request shares — never a second copy. */
  onModuleInit(): void {
    this.limits = this.moduleRef.get(RuntimeLimits, { strict: false });
  }

  /** Admits the request (429 past the per-client-address quota) and queues it. */
  async request(clientIp: string, email: string): Promise<void> {
    await this.limits.quota(`auth-email:ip:${clientIp}`, this.perIpPerMinute);
    if (this.queue.length >= RESET_QUEUE_MAX) {
      // Still a 202: whether the queue is full depends on the accounts ahead.
      this.logger.warn('Password reset dropped: the queue is full');
      return;
    }
    this.queue.push(email);
    this.pump();
  }

  /** Starts workers up to the fixed number; each drains the queue after the response has left. */
  private pump(): void {
    while (this.workers < RESET_WORKERS && this.queue.length > 0) {
      this.workers += 1;
      const release = this.limits.acquire('auth-email:jobs', RESET_WORKERS);
      setImmediate(() => {
        void this.drain().finally(() => {
          this.workers -= 1;
          release();
          // A request can arrive after this drain found the queue empty but
          // before it got here — `pump()` then saw every worker still busy and
          // started none. Look again now that a worker is free (Codex
          // re-review, finding 3).
          this.pump();
        });
      });
    }
  }

  private async drain(): Promise<void> {
    for (let email = this.queue.shift(); email !== undefined; email = this.queue.shift()) {
      if (this.limits.stopping) {
        this.logger.warn(`Password reset dropped at shutdown (${this.queue.length + 1} queued)`);
        this.queue.length = 0;
        return;
      }
      await this.run(email).catch((error: unknown) => this.logger.error(`Password reset job failed: ${(error as Error).name}`));
    }
  }

  /** The job itself; exported for the integration suite, which awaits it. */
  async run(rawEmail: string): Promise<'sent' | 'skipped' | 'failed'> {
    const email = normaliseEmail(rawEmail);
    const profile = await this.prisma.profile.findFirst({
      where: {
        // Exact equality on the stored spelling — never a pattern a caller's
        // `%` or `_` could widen to someone else's account.
        email,
        disabledAt: null,
        organisationId: { not: null },
        organisation: { offboardedAt: null },
      },
      select: { id: true, email: true, fullName: true, language: true, organisationId: true },
    });
    if (!profile) return 'skipped';

    // One statement claims the cooldown, so two requests at once send one email.
    const claimed = await this.prisma.$transaction(async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE profiles SET recovery_sent_at = now()
        WHERE id = ${profile.id}::uuid
          AND (recovery_sent_at IS NULL OR recovery_sent_at <= now() - make_interval(secs => ${RESET_COOLDOWN_SECONDS}))`;
      if (count !== 1) return false;
      await this.audit.recordSystem(
        {
          organisationId: profile.organisationId,
          action: 'password_reset',
          entity: 'profile',
          entityId: profile.id,
          diff: { source: 'auth:password-reset' },
        },
        tx,
      );
      return true;
    });
    if (!claimed) return 'skipped';

    if (!this.mail.config) {
      this.logger.warn('Password reset not sent: mail is not configured');
      return 'failed';
    }
    let token: string;
    try {
      token = await this.authAdmin.recoveryToken(profile.id, profile.email);
    } catch (error) {
      this.logger.warn(`Password reset Auth step failed: ${(error as Error).message}`);
      return 'failed';
    }
    const link = this.mail.confirmLink(token, 'recovery');
    if (!link) return 'failed';
    const sent = await this.mail.send(profile.email, {
      kind: 'password_reset',
      language: isLocale(profile.language) ? profile.language : DEFAULT_LOCALE,
      name: profile.fullName,
      link,
    });
    return sent.ok ? 'sent' : 'failed';
  }
}
