import type { Prisma } from '@tonyai/db';
import {
  can,
  isCategory,
  reportingEntityFor,
  type Category,
  type RecordParty,
  type SingleEntrySide,
  type UserAccessRowDTO,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { ResourceNotFoundError } from '../common/api-error';
import { CategoryNotGrantedError } from '../activity-records/record-scope';
import { CentralReporterNeedsMainEntityError, SingleEntryPeriodConflictError } from './central-reporting-errors';

type Db = Prisma.TransactionClient;

/**
 * A record's owning and reporting entity on the API's record paths
 * (inc26-central-reporter-onboarding D1, D2, D5). The database works the
 * reporting entity out and freezes it (TA025) and holds the period rule
 * (TA026); these helpers give the preview and the write the same answers
 * first, and re-read a standard user's access inside the write (C10).
 */

/** The caller's access rows as the guard read them, with their kinds. */
export function accessRowsOf(user: RequestUser): UserAccessRowDTO[] {
  if (!can(user.role, 'scope.granted')) return [];
  return user.accessibleSubsidiaryIds.map((subsidiaryId) => ({
    subsidiaryId,
    categories: [...(user.categoryGrants?.[subsidiaryId] ?? [])],
    kind: user.grantKinds?.[subsidiaryId] ?? 'assigned',
  }));
}

/**
 * The reporting entity a record by `rows`' holder for `subsidiaryId` gets
 * (`reportingEntityFor`). A grant company with no single main company is the
 * refusal the database gives such a write (TA025; B2 keeps it from arising).
 */
export function reportingEntityOf(rows: readonly UserAccessRowDTO[], subsidiaryId: string): string {
  const entity = reportingEntityFor(rows, subsidiaryId);
  if (entity === null) throw new CentralReporterNeedsMainEntityError();
  return entity;
}

/**
 * The single-entry party a new record of `authorRole` belongs to (C3): a
 * central reporter's when it reports for another company; the company's own
 * user's when its author is a standard user; neither otherwise.
 */
export function partyOf(authorRole: string, subsidiaryId: string, reportingEntity: string | null): RecordParty | null {
  if (reportingEntity !== null && reportingEntity !== subsidiaryId) return 'central_reporter';
  return authorRole === 'standard_user' ? 'company_user' : null;
}

/** The refusal's side: the party that already entered. */
const otherSideOf = (party: RecordParty): SingleEntrySide => (party === 'central_reporter' ? 'company_users' : 'central_reporter');

export interface PeriodSlot {
  subsidiaryId: string;
  category: string;
  reportingYear: number;
  reportingPeriod: string;
  periodValue: string;
}

/**
 * Single entry, what is entered (§4.2, §5.3; design D5): refuses a record of
 * `party` when a record of the other party, not voided, exists for the same
 * company, category and period — whatever its facility or activity type, and
 * whoever may read it (the answer names only the side and the request's own
 * values). `excludeId`: the record being edited. TA026 holds the same rule,
 * under its own lock, for every writer and for two writes racing.
 */
export async function assertSingleEntryPeriod(
  db: Db,
  party: RecordParty | null,
  slot: PeriodSlot,
  excludeId: string | null = null,
): Promise<void> {
  if (party === null) return;
  const rows = await db.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found
      FROM activity_records r
      LEFT JOIN profiles p ON p.id = r.created_by
     WHERE r.subsidiary_id = ${slot.subsidiaryId}::uuid
       AND r.category = ${slot.category}
       AND r.reporting_year = ${slot.reportingYear}
       AND r.reporting_period = ${slot.reportingPeriod}
       AND r.period_value = ${slot.periodValue}
       AND r.status::text <> 'voided'
       AND (${excludeId}::uuid IS NULL OR r.id <> ${excludeId}::uuid)
       AND CASE ${party}::text
             WHEN 'central_reporter' THEN
               (r.reported_by_subsidiary_id IS NULL OR r.reported_by_subsidiary_id = r.subsidiary_id)
               AND p.role::text = 'standard_user'
             ELSE
               r.reported_by_subsidiary_id IS NOT NULL AND r.reported_by_subsidiary_id <> r.subsidiary_id
           END
     LIMIT 1`;
  if (rows.length > 0) {
    throw new SingleEntryPeriodConflictError(otherSideOf(party), {
      category: slot.category as Category,
      reportingYear: slot.reportingYear,
      periodValue: slot.periodValue,
    });
  }
}

/**
 * A standard-user author's access rows, read `FOR SHARE` inside the write's
 * transaction (C10): a grant's withdrawal or a move of the main company either
 * committed before this read — and the write follows it — or waits for the
 * write. The company and the category are judged again from these rows: a
 * company no longer held answers as unknown, a category no longer ticked as
 * `category_not_granted`. Answers the rows; nothing for another role.
 */
export async function lockAuthorAccess(
  tx: Db,
  user: RequestUser,
  subsidiaryId: string,
  category: string,
): Promise<UserAccessRowDTO[] | null> {
  if (!can(user.role, 'scope.categories') || !user.organisationId) return null;
  const rows = await tx.$queryRaw<{ subsidiaryId: string; kind: string; categories: string[] }[]>`
    SELECT subsidiary_id::text AS "subsidiaryId", kind, categories
      FROM user_subsidiary_access
     WHERE user_id = ${user.id}::uuid AND organisation_id = ${user.organisationId}::uuid
     ORDER BY subsidiary_id
       FOR SHARE`;
  const access: UserAccessRowDTO[] = rows.map((r) => ({
    subsidiaryId: r.subsidiaryId,
    categories: r.categories.filter(isCategory),
    kind: r.kind === 'central_reporter' ? 'central_reporter' : 'assigned',
  }));
  const row = access.find((r) => r.subsidiaryId === subsidiaryId);
  if (!row) throw new ResourceNotFoundError('subsidiary_not_found');
  if (!(row.categories as readonly string[]).includes(category)) throw new CategoryNotGrantedError(category);
  return access;
}

/**
 * The name of each record's reporting entity, resolved by id within the
 * reader's organisation — not through the reader's company scope (C4): the
 * owning company's approver reads the trace of a company it is not granted.
 * One query per page.
 */
export async function reportingNamesFor(
  db: Db,
  organisationId: string | null,
  records: readonly { subsidiaryId: string; reportedBySubsidiaryId: string | null }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(records.map((r) => r.reportedBySubsidiaryId ?? r.subsidiaryId))];
  if (ids.length === 0 || !organisationId) return new Map();
  const rows = await db.subsidiary.findMany({
    where: { id: { in: ids }, organisationId },
    select: { id: true, tradingName: true, legalName: true },
  });
  return new Map(rows.map((s) => [s.id, s.tradingName || s.legalName]));
}
