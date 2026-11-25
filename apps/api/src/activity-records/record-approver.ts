import { ForbiddenException } from '@nestjs/common';
import { InvitationStatus, Prisma } from '@tonyai/db';
import {
  ROLE_CAPABILITIES,
  can,
  mayDecideRecord,
  recordApprover,
  type RecordApprover,
} from '@tonyai/shared-types';
import { AccountDisabledError } from '../auth/access-errors';
import type { RequestUser } from '../auth/auth.types';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { SelfApprovalRefusedError, SelfReviewRefusedError } from './errors';

/**
 * Who decides a pending record (INC-2.6 §1.1; inc26-roles-approval-chain,
 * design Decision 7). Never stored: worked out from the author's CURRENT role
 * and the company's active super_admins each time it is needed, by the one
 * pure rule in `@tonyai/shared-types` (`recordApprover`).
 */

type Db = Prisma.TransactionClient;

/** The statuses a record waits for a decision in. */
export const PENDING_STATUSES = ['submitted', 'under_review'] as const;
export function isPending(status: string): boolean {
  return (PENDING_STATUSES as readonly string[]).includes(status);
}

const ROLE_WORD: Record<RecordApprover, string> = {
  super_admin: 'a super_admin of its company',
  masterkey: 'a masterkey',
  author: 'its author, a masterkey',
};

/** 403 `not_record_approver`: a decider who is not this record's approver. */
export class NotRecordApproverError extends ForbiddenException {
  constructor(approver: RecordApprover) {
    super(
      errorBody(
        'not_record_approver',
        `This record is decided by ${ROLE_WORD[approver]}.`,
        { approver },
      ),
    );
  }
}

/**
 * "An active super_admin" of a company (ruling R3): the role, a grant for the
 * company, not disabled, and an accepted invitation — or none, for an account
 * that was never invited (seeded or provisioned). Exported so the review
 * queue's "awaiting my decision" filter reads the same rule.
 */
export const ACTIVE_SUPER_ADMIN_PROFILE: Prisma.ProfileWhereInput = {
  role: 'super_admin',
  disabledAt: null,
  OR: [{ invitation: null }, { invitation: { status: InvitationStatus.accepted } }],
};

/** The companies among `subsidiaryIds` that have an active super_admin — one query. */
export async function companiesWithActiveSuperAdmin(db: Db, subsidiaryIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(subsidiaryIds)];
  if (!ids.length) return new Set();
  const rows = await db.userSubsidiaryAccess.findMany({
    where: { subsidiaryId: { in: ids }, profile: ACTIVE_SUPER_ADMIN_PROFILE },
    select: { subsidiaryId: true },
    distinct: ['subsidiaryId'],
  });
  return new Set(rows.map((r) => r.subsidiaryId));
}

interface PendingRef {
  id: string;
  status: string;
  createdBy: string | null;
  subsidiaryId: string;
}

/**
 * Each pending record's approver, for a page of records: one query for the
 * page's authors and one for its companies, never one per row. A record in
 * any other status maps to null.
 */
export async function approversFor(db: Db, records: readonly PendingRef[]): Promise<Map<string, RecordApprover | null>> {
  const out = new Map<string, RecordApprover | null>();
  const pending = records.filter((r) => isPending(r.status));
  for (const r of records) if (!isPending(r.status)) out.set(r.id, null);
  if (!pending.length) return out;
  const authorIds = [...new Set(pending.map((r) => r.createdBy).filter((id): id is string => !!id))];
  const [authors, staffed] = await Promise.all([
    authorIds.length
      ? db.profile.findMany({ where: { id: { in: authorIds } }, select: { id: true, role: true, disabledAt: true } })
      : Promise.resolve([] as { id: string; role: string; disabledAt: Date | null }[]),
    companiesWithActiveSuperAdmin(db, pending.map((r) => r.subsidiaryId)),
  ]);
  const byId = new Map(authors.map((a) => [a.id, a]));
  for (const r of pending) {
    const author = r.createdBy ? byId.get(r.createdBy) : undefined;
    out.set(
      r.id,
      recordApprover({
        authorRole: author?.role ?? null,
        // A profile that is gone cannot sign in: it routes like a disabled one.
        authorDisabled: author ? author.disabledAt !== null : true,
        companyHasActiveSuperAdmin: staffed.has(r.subsidiaryId),
      }),
    );
  }
  return out;
}

export type DecisionKind = 'review' | 'reject' | 'approve';

/**
 * The approver check of a decision, inside `withLockedRecord` AFTER the
 * re-gate (so a stale submission answers `record_changed` first): re-reads,
 * in the decision's own transaction, the decider's role, disabled state and
 * grant for the company, the author's role and disabled state, and whether the
 * company has an active super_admin — so a role or grant changed since the
 * request was authenticated cannot be used. Refusals, in order:
 *  1. the decider's role no longer decides → forbidden (the role gate's answer);
 *  2. a scoped decider no longer granted the company → as an unknown record;
 *  3. the decider created the record and is not a masterkey →
 *     `self_review_forbidden` (review) or `self_approval_forbidden` (approve);
 *  4. not this record's approver → `not_record_approver`.
 * Returns the approver it worked out.
 */
export async function assertRecordApprover(
  tx: Db,
  user: RequestUser,
  record: { createdBy: string | null; subsidiaryId: string },
  kind: DecisionKind,
): Promise<RecordApprover> {
  const [decider, author, staffed] = await Promise.all([
    tx.profile.findUnique({
      where: { id: user.id },
      select: {
        role: true,
        disabledAt: true,
        subsidiaryAccess: { where: { subsidiaryId: record.subsidiaryId }, select: { subsidiaryId: true } },
      },
    }),
    record.createdBy
      ? tx.profile.findUnique({ where: { id: record.createdBy }, select: { role: true, disabledAt: true } })
      : Promise.resolve(null),
    companiesWithActiveSuperAdmin(tx, [record.subsidiaryId]),
  ]);
  if (!decider || decider.disabledAt) throw new AccountDisabledError();
  if (!can(decider.role, 'record.decide')) {
    throw new ForbiddenException('Only a masterkey or a super_admin may decide records');
  }
  if (can(decider.role, 'scope.granted') && decider.subsidiaryAccess.length === 0) {
    throw new ResourceNotFoundError('record_not_found');
  }
  const isAuthor = record.createdBy === user.id;
  if (isAuthor && decider.role !== 'masterkey') {
    if (kind === 'review') throw new SelfReviewRefusedError();
    if (kind === 'approve') throw new SelfApprovalRefusedError();
  }
  const approver = recordApprover({
    authorRole: author?.role ?? null,
    authorDisabled: author ? author.disabledAt !== null : true,
    companyHasActiveSuperAdmin: staffed.has(record.subsidiaryId),
  });
  if (!mayDecideRecord({ id: user.id, role: decider.role }, record, approver)) {
    throw new NotRecordApproverError(approver);
  }
  return approver;
}

/**
 * The review queue's "awaiting my decision" view as a filter the database
 * applies, so paging stays correct (design Decision 7): the pending records
 * whose approver is the caller, from the same facts `recordApprover` reads.
 * Null when the caller decides nothing (a standard user, an auditor).
 */
export async function awaitingDecisionWhere(db: Db, user: RequestUser): Promise<Prisma.ActivityRecordWhereInput | null> {
  if (!can(user.role, 'record.decide') || !user.organisationId) return null;
  const [deciders, staffed] = await Promise.all([
    // The organisation's active masterkeys and super_admins: their records
    // route to `author` and `masterkey`; everyone else's to the company.
    db.profile.findMany({
      where: { organisationId: user.organisationId, disabledAt: null, role: { in: [...ROLE_CAPABILITIES['record.decide']] } },
      select: { id: true, role: true },
    }),
    companiesWithActiveSuperAdmin(db, user.accessibleSubsidiaryIds),
  ]);
  const activeSuperAdmins = deciders.filter((d) => d.role === 'super_admin').map((d) => d.id);
  const routedElsewhere = deciders.map((d) => d.id);
  // Authored by neither an active masterkey nor an active super_admin (a
  // standard user, an auditor, a disabled account, a profile that is gone).
  const companyRecord: Prisma.ActivityRecordWhereInput = { createdBy: { notIn: routedElsewhere } };
  const pending: Prisma.ActivityRecordWhereInput = { status: { in: [...PENDING_STATUSES] } };
  if (user.role === 'masterkey') {
    return {
      ...pending,
      OR: [
        { createdBy: user.id },
        ...(activeSuperAdmins.length ? [{ createdBy: { in: activeSuperAdmins } }] : []),
        { AND: [companyRecord, { subsidiaryId: { notIn: [...staffed] } }] },
      ],
    };
  }
  // A super_admin: company records of its companies (which it staffs).
  return { ...pending, AND: [companyRecord, { subsidiaryId: { in: [...staffed] } }] };
}
