/**
 * `pnpm onboarding <command>` — the operator's boundary for tenants (D18, K3,
 * K6; LP4-01 PR B). There is no HTTP surface for any of this: a tenant's own
 * `super_admin` invites everyone else from the users screen.
 *
 * Usage (from the repository root; arguments after the script name):
 *
 *   pnpm onboarding provision --operator=<email> --legal-name=<name> --country=GB \
 *     --geography-code=UK [--currency=GBP] [--trading-name=<name>] [--sector=<text>] \
 *     --admin-email=<email> --admin-name=<name> --language=en|tr [--apply]
 *   pnpm onboarding provision --operator=<email> --organisation-id=<uuid> \
 *     --admin-email=<email> --admin-name=<name> --language=en|tr [--apply]
 *   pnpm onboarding offboard  --operator=<email> --organisation-id=<uuid> [--apply]
 *   pnpm onboarding reconcile --operator=<email> [--organisation-id=<uuid>] [--apply]
 *
 *   --apply          write; without it every command is a dry run that prints its plan
 *   --allow-remote   required for --apply off a loopback database or Supabase — a guard
 *                    against a typo, not a control (a tunnel to production is "localhost" too)
 *
 * `provision` creates the organisation (or uses --organisation-id's) and its
 * first `super_admin`, and sends the invitation (TR/EN by --language). Re-run
 * with the same arguments, it completes a provisioning a failure left half
 * done — the invitation's Auth step or email — and re-sends an invitation that
 * went out but was not accepted (a fresh link: the old one stops working; the
 * first administrator's email tells them to ask TonyAI for one). An accepted
 * invitation is left alone.
 * `offboard` marks the organisation offboarded (the start of D21's 90-day
 * retention clock; nothing is deleted), disables every member and bans them
 * in Supabase Auth. `reconcile` retries Auth bans and unbans left pending
 * (K4) and lists invitations not delivered; re-sending is an administrator's.
 *
 * Connects with DIRECT_URL — the tables' owner — and refuses any other login
 * (the database's guards admit the owner by `session_user`). Needs
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and for `provision`'s email
 * SMTP_HOST, MAIL_FROM and APP_URL; locally `set -a; source apps/api/.env;
 * set +a` first. Every change is audited with a null `userId` and the
 * operator in `diff.operator`.
 *
 * Prints one JSON report. Exit code 0 when done; 1 when something still needs
 * a person (an undelivered invitation, an Auth step pending); 2 on a usage
 * error, a refusal or a failure.
 *
 * In the API image: `node dist/onboarding/onboarding.cli.js <command> [flags]`.
 */
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@tonyai/db';
import { isLocale, type Locale } from '@tonyai/shared-types';
import { UUID_SHAPE } from '../common/parse-uuid-param.pipe';
import { MailService } from '../mail/mail.service';
import { AuthAdminService } from '../users/auth-admin.service';
import { AuthSyncService } from '../users/auth-sync.service';
import { InvitationDeliveryService } from '../users/invitation-delivery.service';
import { OnboardingOperator, OperatorRefusal, type ProvisionInput } from './onboarding-operator';

export class UsageError extends Error {}

export type Command = 'provision' | 'offboard' | 'reconcile';

export interface Options {
  command: Command;
  operator: string;
  apply: boolean;
  allowRemote: boolean;
  organisationId?: string;
  provision?: ProvisionInput;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FLAGS: Record<Command, { valued: string[]; required: string[] }> = {
  provision: {
    valued: [
      'operator', 'organisation-id', 'legal-name', 'trading-name', 'country', 'geography-code',
      'currency', 'sector', 'admin-email', 'admin-name', 'language',
    ],
    required: ['operator', 'admin-email', 'admin-name', 'language'],
  },
  offboard: { valued: ['operator', 'organisation-id'], required: ['operator', 'organisation-id'] },
  reconcile: { valued: ['operator', 'organisation-id'], required: ['operator'] },
};
const SWITCHES = ['apply', 'allow-remote'];

export function parseArgs(argv: string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const [command, ...rest] = args;
  if (command !== 'provision' && command !== 'offboard' && command !== 'reconcile') {
    throw new UsageError('Name a command: provision, offboard or reconcile');
  }
  const spec = FLAGS[command];
  const flags = new Map<string, string | true>();
  for (const arg of rest) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!match) throw new UsageError(`Unknown argument "${arg}"`);
    const [, name, value] = match;
    if (flags.has(name)) throw new UsageError(`--${name} is given twice`);
    if (SWITCHES.includes(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (spec.valued.includes(name)) {
      if (value === undefined || value.trim() === '') throw new UsageError(`--${name} needs a value: --${name}=<value>`);
      flags.set(name, value.trim());
    } else {
      throw new UsageError(`Unknown flag --${name} for ${command}`);
    }
  }
  for (const name of spec.required) if (!flags.has(name)) throw new UsageError(`${command} needs --${name}`);
  const text = (name: string) => flags.get(name) as string | undefined;

  const operator = text('operator')!;
  if (!EMAIL_SHAPE.test(operator)) throw new UsageError('--operator must be the operator\'s email address');
  const rawOrganisationId = text('organisation-id');
  if (rawOrganisationId !== undefined && !UUID_SHAPE.test(rawOrganisationId)) throw new UsageError('--organisation-id must be an id');
  // The database's spelling, so it compares equal to the ids it reads back.
  const organisationId = rawOrganisationId?.toLowerCase();
  const options: Options = { command, operator, apply: flags.has('apply'), allowRemote: flags.has('allow-remote'), organisationId };

  if (command === 'provision') {
    const adminEmail = text('admin-email')!;
    if (!EMAIL_SHAPE.test(adminEmail) || adminEmail.length > 254) throw new UsageError('--admin-email must be an email address');
    const language = text('language')!;
    if (!isLocale(language)) throw new UsageError('--language must be en or tr');
    const adminName = text('admin-name')!;
    if (adminName.length > 200) throw new UsageError('--admin-name is too long');
    const orgFlags = ['legal-name', 'trading-name', 'country', 'geography-code', 'currency', 'sector'];
    let organisation: ProvisionInput['organisation'];
    if (organisationId) {
      const stray = orgFlags.filter((f) => flags.has(f));
      if (stray.length) throw new UsageError(`--organisation-id names an existing organisation; drop --${stray.join(', --')}`);
    } else {
      for (const f of ['legal-name', 'country', 'geography-code']) if (!flags.has(f)) throw new UsageError(`provision needs --${f} (or --organisation-id)`);
      const country = text('country')!.toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new UsageError('--country must be a two-letter ISO 3166 code');
      const currency = (text('currency') ?? 'EUR').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new UsageError('--currency must be a three-letter ISO 4217 code');
      const geographyCode = text('geography-code')!.toUpperCase();
      if (!/^[A-Z0-9-]{2,16}$/.test(geographyCode)) throw new UsageError('--geography-code must be a code such as UK or TR');
      organisation = {
        legalName: text('legal-name')!,
        tradingName: text('trading-name'),
        country,
        geographyCode,
        reportingCurrency: currency,
        sector: text('sector'),
      };
    }
    options.provision = { organisationId, organisation, adminEmail, adminName, language: language as Locale };
  }
  return options;
}

/** A host that is plainly this machine — and no parameter that points elsewhere. */
export function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) || parsed.hostname.endsWith('.localhost');
    const redirects = ['host', 'hostaddr'].some((p) => parsed.searchParams.has(p));
    return local && !redirects;
  } catch {
    return false;
  }
}

/** The run's refusals that depend on where it points — testable alone. */
export function refuseUnsafe(options: Options, local: boolean): void {
  if (options.apply && !local && !options.allowRemote) {
    throw new UsageError(
      '--apply off a loopback database or Supabase needs --allow-remote: this writes as the tables\' owner and mails or bans real people.',
    );
  }
}

export async function run(options: Options): Promise<{ report: unknown; needsAPerson: boolean }> {
  const url = process.env.DIRECT_URL;
  if (!url) throw new UsageError('DIRECT_URL (the owner connection) is required');
  refuseUnsafe(options, isLoopback(url) && isLoopback(process.env.SUPABASE_URL));
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const authAdmin = new AuthAdminService();
    const operator = new OnboardingOperator(
      db,
      options.operator,
      new InvitationDeliveryService(authAdmin, new MailService()),
      new AuthSyncService(authAdmin),
    );
    if (options.command === 'provision') {
      const report = await operator.provision(options.provision!, options.apply);
      const delivery = report.delivery;
      return { report, needsAPerson: delivery !== null && !delivery.delivered };
    }
    if (options.command === 'offboard') {
      const report = await operator.offboard(options.organisationId!, options.apply);
      return { report, needsAPerson: options.apply && report.authPending.length > 0 };
    }
    const report = await operator.reconcile(options.organisationId, options.apply);
    return { report, needsAPerson: report.authPending.length > 0 || report.undeliveredInvitations.length > 0 };
  } finally {
    await db.$disconnect();
  }
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
  try {
    const { report, needsAPerson } = await run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(needsAPerson ? 1 : 0);
  } catch (error) {
    const known = error instanceof UsageError || error instanceof OperatorRefusal;
    new Logger('onboarding').error(
      error instanceof Error ? error.message : String(error),
      error instanceof Error && !known ? error.stack : undefined,
    );
    process.exit(2);
  }
}

if (require.main === module) void main();
