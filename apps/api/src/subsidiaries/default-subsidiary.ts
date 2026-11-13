import { Prisma, SubsidiaryStatus, TrackingGranularity } from '@tonyai/db';
import type { AuditService } from '../audit/audit.service';

/**
 * What a new organisation's default subsidiary is born with (UAT round 2, K1;
 * Decisions 2026-11-12). Written out rather than left to the column defaults,
 * so a change of default elsewhere cannot silently change what every new
 * customer starts with. Tracking at subsidiary level lets records be entered
 * before any facility exists.
 */
export const DEFAULT_SUBSIDIARY_SETTINGS = Object.freeze({
  reportingStatus: SubsidiaryStatus.pending,
  includedScopes: Object.freeze([1, 2]) as readonly number[],
  trackingGranularity: TrackingGranularity.subsidiary,
});

export interface DefaultSubsidiaryInput {
  organisationId: string;
  /** The organisation's legal name: the subsidiary represents the company itself. */
  legalName: string;
  tradingName?: string | null;
  sector?: string | null;
  /** The organisation's geography — one of `GEOGRAPHY_CODES`; callers check it. */
  geographyCode: string;
  /**
   * The caller's audit origin: registration's `{ source: 'auth:registration' }`
   * or the operator's `{ source: 'onboarding:provision', operator }`. Only these
   * two fields are copied into the row — named one by one, never spread — so
   * nothing else a caller passes can carry a name into the audit log (D20).
   */
  source: { source: string; operator?: string };
}

/**
 * Creates the one subsidiary every new organisation starts with, inside the
 * caller's transaction, and audits it as a system row (no acting user — there
 * is none: the public registration job or the operator CLI). The diff never
 * holds the legal name, trading name or sector: registration's audit rows keep
 * the company name out (D20), and the organisation's own provisioning row
 * omits it too. After this the subsidiary is an ordinary one — renamed,
 * edited, given facilities or deleted through the normal paths.
 */
export async function createDefaultSubsidiary(
  tx: Pick<Prisma.TransactionClient, 'subsidiary' | 'auditLog'>,
  audit: Pick<AuditService, 'recordSystem'>,
  input: DefaultSubsidiaryInput,
): Promise<{ id: string }> {
  const created = await tx.subsidiary.create({
    data: {
      organisationId: input.organisationId,
      legalName: input.legalName,
      tradingName: input.tradingName ?? null,
      sector: input.sector ?? null,
      geographyCode: input.geographyCode,
      reportingStatus: DEFAULT_SUBSIDIARY_SETTINGS.reportingStatus,
      includedScopes: [...DEFAULT_SUBSIDIARY_SETTINGS.includedScopes],
      trackingGranularity: DEFAULT_SUBSIDIARY_SETTINGS.trackingGranularity,
    },
    select: { id: true },
  });
  await audit.recordSystem(
    {
      organisationId: input.organisationId,
      action: 'create',
      entity: 'subsidiary',
      entityId: created.id,
      diff: {
        source: input.source.source,
        ...(input.source.operator !== undefined ? { operator: input.source.operator } : {}),
        default: true,
        geographyCode: input.geographyCode,
        includedScopes: [...DEFAULT_SUBSIDIARY_SETTINGS.includedScopes],
        trackingGranularity: DEFAULT_SUBSIDIARY_SETTINGS.trackingGranularity,
        reportingStatus: DEFAULT_SUBSIDIARY_SETTINGS.reportingStatus,
      },
    },
    tx,
  );
  return { id: created.id };
}
