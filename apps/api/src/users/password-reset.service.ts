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
/** Concurrent reset jobs one API instance runs before refusing with 429. */
const MAX_RESET_JOBS = 20;

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
 * nothing. The job is tracked by `RuntimeLimits`, so a shutdown waits for it.
 */
@Injectable()
export class PasswordResetService implements OnModuleInit {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly perIpPerMinute = readResetPerIpLimit();
  private limits!: RuntimeLimits;

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

  /** Admits the request (429 past the per-address quota) and schedules it. */
  async request(clientIp: string, email: string): Promise<void> {
    await this.limits.quota(`auth-email:ip:${clientIp}`, this.perIpPerMinute);
    const release = this.limits.acquire('auth-email:jobs', MAX_RESET_JOBS);
    setImmediate(() => {
      this.run(email)
        .catch((error: unknown) => this.logger.error(`Password reset job failed: ${(error as Error).name}`))
        .finally(release);
    });
  }

  /** The job itself; exported for the integration suite, which awaits it. */
  async run(rawEmail: string): Promise<'sent' | 'skipped' | 'failed'> {
    const email = normaliseEmail(rawEmail);
    const profile = await this.prisma.profile.findFirst({
      where: {
        email: { equals: email, mode: 'insensitive' },
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
