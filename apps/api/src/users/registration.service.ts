import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { RegistrationRequest, RegistrationStatus } from '@tonyai/shared-types';
import { AccessAdminService, normaliseEmail } from '../auth/access-admin.service';
import { EmailUnavailableError, RegistrationCodeInvalidError } from '../auth/access-errors';
import { ResourceNotFoundError } from '../common/api-error';
import { RuntimeLimits } from '../common/runtime-limits';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationDeliveryService } from './invitation-delivery.service';
import {
  readRegistrationConfig,
  REGISTRATION_CONFIG,
  registrationCodeMatches,
  type RegistrationConfig,
} from './registration-config';

/** One invitation email per address per five minutes — the reset's cooldown. */
export const REGISTRATION_COOLDOWN_SECONDS = 300;
/**
 * Invitation emails one registration ever sends: the first and four re-sends.
 * The form is public and the address may be someone else's, so re-sending is
 * bounded for good, not only per five minutes; past it the registrant uses
 * "forgot password" (a reset link opens an unaccepted account too) or asks
 * TonyAI.
 */
export const REGISTRATION_MAX_DELIVERIES = 5;
/** Registration jobs one API instance runs at once. */
export const REGISTRATION_WORKERS = 2;
/** Registrations one API instance holds waiting for a worker; past it they are dropped. */
export const REGISTRATION_QUEUE_MAX = 200;

/** What a queued registration carries: the request without its code. */
export type RegistrationJob = Omit<RegistrationRequest, 'registrationCode' | 'consent'>;

/**
 * Self-service registration's work (owner decisions 2026-11-11): behind the
 * environment's registration code, a public form creates an organisation and
 * its first `super_admin` and sends that person the invitation email; the
 * invitation flow takes over from there.
 *
 * The switch is the code itself: with none configured there is no
 * registration and both endpoints answer 404. A wrong code is refused in
 * words (403) — the code says nothing about any address — and counts against
 * the client address's quota, the public reset's own.
 *
 * Past the code, the answer is the same 202 for every address and leaves
 * before any of the work runs, as the password reset's does: neither body nor
 * timing says whether an address has an account. Then, for a new address, the
 * rows and the email; for a registered address whose invitation is not
 * accepted, that invitation again outside its cooldown, five emails at most;
 * for any other, nothing. Requests wait in a bounded queue for a fixed set of workers, and
 * one past the bound is dropped and logged — still a 202.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);
  private readonly config: RegistrationConfig | null;
  private readonly queue: RegistrationJob[] = [];
  private workers = 0;
  private wrongCodes = 0;

  /** `limits` is the application's one `RuntimeLimits` (RuntimeLimitsModule). */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessAdminService,
    private readonly delivery: InvitationDeliveryService,
    private readonly limits: RuntimeLimits,
    @Optional() @Inject(REGISTRATION_CONFIG) config?: RegistrationConfig | null,
  ) {
    this.config = config === undefined ? readRegistrationConfig() : config;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /** What the page needs to show the form; 404 while registration is off. */
  status(): RegistrationStatus {
    const config = this.requireConfig();
    return { consentVersion: config.consentVersion, consentIsPlaceholder: config.consentIsPlaceholder };
  }

  /** Admits the request (404 off, 429 past the quota, 403 on a wrong code) and queues it. */
  async request(clientIp: string, input: RegistrationRequest): Promise<void> {
    const config = this.requireConfig();
    // Before the code is looked at, so every guess spends the client address's quota.
    await this.limits.quota(`auth-email:ip:${clientIp}`, this.limits.config.AUTH_EMAIL_PER_IP_PER_MINUTE);
    if (!registrationCodeMatches(config, input.registrationCode)) {
      this.wrongCodes += 1;
      // The count makes a guessing run visible; never the code that was tried.
      this.logger.warn(`Registration refused: wrong code (${this.wrongCodes} since start)`);
      throw new RegistrationCodeInvalidError();
    }
    if (this.queue.length >= REGISTRATION_QUEUE_MAX) {
      // Still a 202: whether the queue is full depends on the work ahead.
      this.logger.warn('Registration dropped: the queue is full');
      return;
    }
    const { registrationCode: _code, consent: _consent, ...job } = input;
    this.queue.push(job);
    this.pump();
  }

  private requireConfig(): RegistrationConfig {
    if (!this.config) throw new ResourceNotFoundError('registration_unavailable');
    return this.config;
  }

  /** Starts workers up to the fixed number; each drains the queue after the response has left. */
  private pump(): void {
    while (this.workers < REGISTRATION_WORKERS && this.queue.length > 0) {
      this.workers += 1;
      const release = this.limits.acquire('registration:jobs', REGISTRATION_WORKERS);
      setImmediate(() => {
        void this.drain().finally(() => {
          this.workers -= 1;
          release();
          // A request that arrived while this drain was ending found every
          // worker busy and started none: look again (as the reset does).
          this.pump();
        });
      });
    }
  }

  private async drain(): Promise<void> {
    for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
      if (this.limits.stopping) {
        this.logger.warn(`Registration dropped at shutdown (${this.queue.length + 1} queued)`);
        this.queue.length = 0;
        return;
      }
      await this.run(job).catch((error: unknown) => this.logger.error(`Registration job failed: ${(error as Error).name}`));
    }
  }

  /** The job itself; exported for the integration suite, which awaits it. */
  async run(job: RegistrationJob): Promise<'sent' | 'skipped' | 'failed'> {
    const email = normaliseEmail(job.email);
    // Exact equality on the stored spelling, as everywhere an address is looked up.
    const existing = await this.prisma.profile.findUnique({ where: { email }, select: { id: true } });
    let profileId: string;
    if (existing) {
      // Submitted again: the unaccepted invitation of a registered account goes
      // out once more; an active, disabled, invited or provisioned account gets
      // nothing — and the typed company and job title are ignored either way.
      if (!(await this.access.reopenRegistration(existing.id, REGISTRATION_COOLDOWN_SECONDS, REGISTRATION_MAX_DELIVERIES))) return 'skipped';
      profileId = existing.id;
    } else {
      try {
        ({ profileId } = await this.access.registerOrganisation({
          email,
          fullName: `${job.firstName.trim()} ${job.lastName.trim()}`,
          jobTitle: job.jobTitle,
          companyName: job.companyName,
          language: job.language,
          consentVersion: job.consentVersion,
        }));
      } catch (error) {
        // Two submissions of one new address at once: the other one's rows
        // stand and its delivery is on its way.
        if (error instanceof EmailUnavailableError) return 'skipped';
        throw error;
      }
    }
    const outcome = await this.delivery.deliver(this.prisma, profileId);
    return outcome.delivered ? 'sent' : 'skipped' in outcome ? 'skipped' : 'failed';
  }
}
