import { ForbiddenException } from '@nestjs/common';
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
import { ActivityTypeSlotConflictError, CreateRoleRefusedError, DuplicateActivityRecordError } from '../activity-records/errors';
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
 * The author's standing as it is committed now, read inside the write's
 * transaction (C10), and locked until the write commits: a withdrawal, a role
 * change or a move of the main company either committed before this read —
 * and the write follows it — or waits for the write.
 *
 * - The author's profile, `FOR SHARE`: an account whose role, organisation or
 *   enabled state is no longer the request's writes nothing (owner's second
 *   review of WP8, P1 — a super_admin made a standard user mid-upload). A
 *   create answers `record_create_forbidden`, an edit the edit's 403.
 * - A `super_admin`'s and a `standard_user`'s access rows, `FOR SHARE`: the
 *   company no longer held answers as unknown; a standard user's category no
 *   longer ticked, `category_not_granted`. A masterkey's scope is its
 *   organisation, which the profile read already judged.
 *
 * Order — the profile, then companies `FOR KEY SHARE`, then the rows: every
 * access write to an existing account locks its profile before its rows
 * (`AccessAdminService`'s `findMember`), a company delete locks the company
 * before its rows and never a profile, so neither can hold a lock this write
 * waits for while waiting for one it holds; and the companies are read after
 * an access change that held the profile has committed, so a company its rows
 * newly name is locked too (owner's reviews of WP8, P2; security review).
 *
 * A move of the main company deletes one row and inserts another. A locking
 * read that waited on the deleted row skips it, and its snapshot predates the
 * new one: when a standard user's rows look short — the record's company
 * missing, or a central reporter without exactly one main company — the
 * companies and then the rows are taken once more, by statements that see what
 * committed while the first waited.
 *
 * Answers a standard user's rows; null for any other role.
 */
export async function lockAuthorAccess(
  tx: Db,
  user: RequestUser,
  subsidiaryId: string,
  category: string,
  action: 'create' | 'edit',
): Promise<UserAccessRowDTO[] | null> {
  if (!user.organisationId) throw authorRefusal(action);
  const [author] = await tx.$queryRaw<{ same: boolean }[]>`
    SELECT (p.role::text = ${user.role} AND p.organisation_id = ${user.organisationId}::uuid AND p.disabled_at IS NULL) AS same
      FROM profiles p
     WHERE p.id = ${user.id}::uuid
       FOR SHARE`;
  if (!author?.same) throw authorRefusal(action);
  // After the profile: an access change that held it has committed, so the
  // companies its rows now name are among those locked (security review).
  // The record's company must still be in the author's organisation, judged
  // under the lock, which a move to another organisation (a key change) waits
  // for — for every role, a masterkey's included (owner's third review, P1).
  if (!(await lockAuthorCompanies(tx, user.id, subsidiaryId, user.organisationId))) {
    throw new ResourceNotFoundError('subsidiary_not_found');
  }
  if (can(user.role, 'scope.organisation')) return null;
  let access = await readLockedAccess(tx, user.id, user.organisationId);
  if (can(user.role, 'scope.categories') && looksShort(access, subsidiaryId)) {
    // The same order again: a company the second read can name (the new main
    // company) is locked before its row, as on the first pass (security review).
    await lockAuthorCompanies(tx, user.id, subsidiaryId, user.organisationId);
    access = await readLockedAccess(tx, user.id, user.organisationId);
  }
  const row = access.find((r) => r.subsidiaryId === subsidiaryId);
  if (!row) throw new ResourceNotFoundError('subsidiary_not_found');
  if (!can(user.role, 'scope.categories')) return null;
  if (!(row.categories as readonly string[]).includes(category)) throw new CategoryNotGrantedError(category);
  return access;
}

/** The refusal for an author whose standing changed after the request was authorised. */
function authorRefusal(action: 'create' | 'edit'): Error {
  return action === 'create'
    ? new CreateRoleRefusedError()
    : new ForbiddenException('Your role may not modify activity records');
}

/**
 * The record's company and every company the author's access rows name,
 * `FOR KEY SHARE`, in id order. Answers whether the record's company, as
 * locked, is in `organisationId`.
 */
async function lockAuthorCompanies(tx: Db, userId: string, subsidiaryId: string, organisationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string; organisationId: string }[]>`
    SELECT s.id::text AS id, s.organisation_id::text AS "organisationId"
      FROM subsidiaries s
     WHERE s.id = ${subsidiaryId}::uuid
        OR s.id IN (SELECT u.subsidiary_id FROM user_subsidiary_access u WHERE u.user_id = ${userId}::uuid)
     ORDER BY s.id
       FOR KEY SHARE`;
  return rows.some((r) => r.id === subsidiaryId && r.organisationId === organisationId);
}

async function readLockedAccess(tx: Db, userId: string, organisationId: string): Promise<UserAccessRowDTO[]> {
  const rows = await tx.$queryRaw<{ subsidiaryId: string; kind: string; categories: string[] }[]>`
    SELECT subsidiary_id::text AS "subsidiaryId", kind, categories
      FROM user_subsidiary_access
     WHERE user_id = ${userId}::uuid AND organisation_id = ${organisationId}::uuid
     ORDER BY subsidiary_id
       FOR SHARE`;
  return rows.map((r) => ({
    subsidiaryId: r.subsidiaryId,
    categories: r.categories.filter(isCategory),
    kind: r.kind === 'central_reporter' ? 'central_reporter' : 'assigned',
  }));
}

/** The record's company missing, or a central reporter's row without exactly one main company. */
function looksShort(access: readonly UserAccessRowDTO[], subsidiaryId: string): boolean {
  const row = access.find((r) => r.subsidiaryId === subsidiaryId);
  if (!row) return true;
  return row.kind === 'central_reporter' && access.filter((r) => r.kind === 'assigned').length !== 1;
}

/** A record's full identity: the stored uniqueness key (company, facility, period, category, activity type). */
export interface RecordSlot extends PeriodSlot {
  locationId: string | null;
  activityType: string | null;
  /**
   * The fuel batch the record is (to be) in; absent or null for a manual
   * record (inc28-fuel-bulk D2). The exact repeat is looked for within the
   * same batch only — each batch holds one record per slot and type — while
   * the slot-kind look stays slot-wide, batches included.
   */
  fuelBatchId?: string | null;
}

/**
 * An exact repeat of a live record answers as the duplicate it is — and a slot
 * holding the other kind (typed / untyped) as TA002's conflict — before the
 * period half of single entry (owner review of WP8, P2; spec "an exact repeat
 * is a duplicate, whoever entered it"): the bulk upload answers
 * `duplicate_existing` for the same row, and the two paths must not classify
 * one record two ways. The same key the unique index holds, voided records
 * aside. `excludeId`: the record being edited.
 */
export async function assertNotExactDuplicate(db: Db, slot: RecordSlot, excludeId: string | null = null): Promise<void> {
  // The slot-kind rule too (TA002): a typed record where an untyped one stands,
  // or the reverse, answers the record service's own conflict — the bulk
  // upload's `duplicate_existing` for the same row (QA review).
  const fuelBatchId = slot.fuelBatchId ?? null;
  const rows = await db.$queryRaw<{ exact: boolean }[]>`
    SELECT (r.activity_type IS NOT DISTINCT FROM ${slot.activityType}::text
            AND r.fuel_batch_id IS NOT DISTINCT FROM ${fuelBatchId}::uuid) AS exact
      FROM activity_records r
     WHERE r.subsidiary_id = ${slot.subsidiaryId}::uuid
       AND r.location_id IS NOT DISTINCT FROM ${slot.locationId}::uuid
       AND r.reporting_year = ${slot.reportingYear}
       AND r.reporting_period = ${slot.reportingPeriod}
       AND r.period_value = ${slot.periodValue}
       AND r.category = ${slot.category}
       AND ((r.activity_type IS NOT DISTINCT FROM ${slot.activityType}::text
             AND r.fuel_batch_id IS NOT DISTINCT FROM ${fuelBatchId}::uuid)
            OR (r.activity_type IS NULL) <> (${slot.activityType}::text IS NULL))
       AND r.status::text <> 'voided'
       AND (${excludeId}::uuid IS NULL OR r.id <> ${excludeId}::uuid)
     ORDER BY 1 DESC
     LIMIT 1`;
  if (rows.length === 0) return;
  if (rows[0]!.exact) throw new DuplicateActivityRecordError();
  throw new ActivityTypeSlotConflictError(slot.activityType !== null);
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

/**
 * A record's company, locked `FOR KEY SHARE` — a move to another organisation
 * is a key update of `subsidiaries (id, organisation_id)`, so it waits for the
 * caller's write — and whether it is in `organisationId` (security review of
 * the owner's fourth round of WP8): every lifecycle step on a record asks it
 * under the record's row lock.
 */
export async function lockCompanyInOrganisation(tx: Db, subsidiaryId: string, organisationId: string | null): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string; organisationId: string }[]>`
    SELECT s.id::text AS id, s.organisation_id::text AS "organisationId"
      FROM subsidiaries s
     WHERE s.id = ${subsidiaryId}::uuid
       FOR KEY SHARE`;
  return rows.some((r) => r.id === subsidiaryId && r.organisationId === organisationId);
}
