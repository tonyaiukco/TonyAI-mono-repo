import {
  displayRole,
  isCalculated,
  type ActivityCalculationSnapshot,
  type RecordTrailChangeDTO,
  type RecordTrailEventDTO,
  type RecordTrailEventKind,
  type RecordTrailValue,
} from '@tonyai/shared-types';

/**
 * One activity record's audit rows as one history (WP5, `uat4-review-resubmit`,
 * design decision 6). Pure and DB-free: the service reads the rows and the
 * names, this turns them into events.
 *
 * The response is built from an ALLOW-LIST. Nothing of a row's stored `diff`
 * reaches the caller except the reason strings, the submission number and the
 * listed inputs' values: no snapshot, no calculation, no user id, no email.
 */

/** The audit row as the service reads it, oldest first. */
export interface TrailAuditRow {
  id: string;
  action: string;
  userId: string | null;
  role: string | null;
  diff: unknown;
  createdAt: Date;
}

export interface TrailLookups {
  /** Actor id → full name, confined to the reader's organisation. */
  names: ReadonlyMap<string, string>;
  /** Location id → name, confined to the record's subsidiary. */
  locations: ReadonlyMap<string, string>;
  /** The organisation's role-model cut-over (`role_model_changed_at`), null
   *  for an organisation created after it: a stored `super_admin` older than
   *  it is the earlier, organisation-wide role (`displayRole`). */
  cutOver: Date | null;
}

/**
 * The record's scalar inputs an edit is compared on, in the order they are
 * listed. `locationId` is reported as `location`, by name.
 */
const SCALAR_INPUTS = [
  'activityValue',
  'activityUnit',
  'activityType',
  'category',
  'reportingYear',
  'reportingPeriod',
  'periodValue',
  'locationId',
  'varianceReason',
] as const;

/** Every other key of a snapshot is ignored by construction: timestamps,
 *  status, review and void fields, anomaly columns, `submissionCount`,
 *  `evidenceCount` (the `before` snapshot is written without a count, so it
 *  would always read 0 → N), and `calculation` apart from its total. */

const KIND_BY_ACTION: Readonly<Record<string, RecordTrailEventKind>> = {
  create: 'created',
  update: 'edited',
  recall: 'recalled',
  review: 'review_started',
  reject: 'returned',
  approve: 'approved',
  // A masterkey's approval of their own record (inc26-roles-approval-chain).
  self_approve: 'self_approved',
  void: 'voided',
};

/** Before the audit taxonomy a transition was logged as `update` with
 *  `diff.transition`; its target status names what happened. */
const KIND_BY_TARGET: Readonly<Record<string, RecordTrailEventKind | 'submit'>> = {
  submitted: 'submit',
  draft: 'recalled',
  under_review: 'review_started',
  rejected: 'returned',
  approved: 'approved',
  voided: 'voided',
};

type Json = Record<string, unknown>;

/** A table's own entry only: `constructor` or `toString` is never a kind. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);


function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** A stored value as the trail returns it: primitives as stored, absent as null. */
function asValue(v: unknown): RecordTrailValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/**
 * One path segment, kept apart from the separator: a key holding a dot
 * (`{"meter.reading": 12}`) must not read as the nested `{"meter": {"reading": 12}}`.
 * JSON Pointer's escapes: `~` as `~0`, then `.` as `~1`.
 */
const segment = (key: string) => {
  const escaped = key.replace(/~/g, '~0').replace(/\./g, '~1');
  // An object key made of digits is marked (`~2`), so `{"0": 12}` is not the
  // array `[12]`, whose index is the bare number.
  return /^\d+$/.test(key) ? `~2${escaped}` : escaped;
};

/**
 * One leaf as it is compared and as it is shown. `key` keeps what the shown
 * value loses: its JSON type (the list `[]` is not the text "[]") and, inside
 * a list, an explicit `null` (`[1]` → `[1, null]` is a change). An object
 * property holding `null` is the same as one absent (the record contract's
 * rule: a JSON null is an absent key).
 */
interface Leaf {
  shown: RecordTrailValue;
  key: string;
}

const ABSENT: Leaf = { shown: null, key: 'absent' };

function leaves(value: unknown, prefix: string, out: Map<string, Leaf>, inList = false): void {
  if (Array.isArray(value)) {
    // An empty list is a value of its own: adding or emptying one is a change.
    if (value.length === 0) out.set(prefix, { shown: '[]', key: '[]' });
    value.forEach((item, i) => leaves(item, `${prefix}.${i}`, out, true));
  } else if (isObject(value)) {
    const entries = Object.entries(value);
    // An empty object nested in an input likewise; the input itself absent or
    // empty reads as nothing, as before.
    if (entries.length === 0 && prefix.includes('.')) out.set(prefix, { shown: '{}', key: '{}' });
    for (const [key, item] of entries) leaves(item, `${prefix}.${segment(key)}`, out);
  } else if (value === null || value === undefined) {
    if (inList) out.set(prefix, { shown: 'null', key: 'null' });
  } else {
    out.set(prefix, { shown: asValue(value), key: JSON.stringify(value) });
  }
}

function leafChanges(before: unknown, after: unknown, prefix: string): RecordTrailChangeDTO[] {
  const b = new Map<string, Leaf>();
  const a = new Map<string, Leaf>();
  leaves(before, prefix, b);
  leaves(after, prefix, a);
  const paths = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) =>
    x.localeCompare(y, 'en', { numeric: true }),
  );
  const changes: RecordTrailChangeDTO[] = [];
  for (const path of paths) {
    const was = b.get(path) ?? ABSENT;
    const now = a.get(path) ?? ABSENT;
    if (was.key !== now.key) changes.push({ field: path, before: was.shown, after: now.shown });
  }
  return changes;
}

function figureOf(snapshot: unknown): number | null {
  const calc = isObject(snapshot) ? (snapshot.calculation as ActivityCalculationSnapshot | null) : null;
  return isCalculated(calc) ? calc.tCo2e : null;
}

/**
 * What one edit changed: each listed input that differs, before and after,
 * then the figure when it moved. Empty when nothing listed changed.
 */
export function editChanges(before: Json, after: Json, lookups: TrailLookups): RecordTrailChangeDTO[] {
  const changes: RecordTrailChangeDTO[] = [];
  for (const key of SCALAR_INPUTS) {
    const was = asValue(before[key]);
    const now = asValue(after[key]);
    if (was === now) continue;
    if (key === 'locationId') {
      // By name only: a location the lookup cannot name (not in the record's
      // subsidiary any more) reads as empty, never as its id.
      const name = (id: RecordTrailValue) =>
        typeof id === 'string' ? (lookups.locations.get(id) ?? null) : null;
      changes.push({ field: 'location', before: name(was), after: name(now) });
    } else {
      changes.push({ field: key, before: was, after: now });
    }
  }
  changes.push(...leafChanges(before.parameters, after.parameters, 'parameters'));
  changes.push(...leafChanges(before.input, after.input, 'input'));
  const figureBefore = figureOf(before);
  const figureAfter = figureOf(after);
  if (figureBefore !== figureAfter) {
    changes.push({ field: 'figure', before: figureBefore, after: figureAfter });
  }
  return changes;
}

/**
 * An operator's re-pricing (`draft-reprice`) stores the figure before and after
 * as `{ before: { tCo2e }, after: { tCo2e } }`: shown as the figure's change.
 */
function repriceChanges(diff: Json): RecordTrailChangeDTO[] {
  const tonnes = (side: unknown) =>
    isObject(side) && typeof side.tCo2e === 'number' && Number.isFinite(side.tCo2e) ? side.tCo2e : null;
  const before = tonnes(diff.before);
  const after = tonnes(diff.after);
  return before === null && after === null ? [] : [{ field: 'figure', before, after }];
}

export function buildRecordTrail(
  rows: readonly TrailAuditRow[],
  lookups: TrailLookups,
): RecordTrailEventDTO[] {
  let submissions = 0;
  // The record's variance reason as its last saved snapshot held it: a submit
  // row written before submits carried the reason (WP5) is given it from there,
  // since a submit itself never changes it.
  let savedVarianceReason: string | null = null;
  return rows.map((row) => {
    const diff = isObject(row.diff) ? row.diff : {};
    const saved = isObject(diff.after) ? diff.after : null;
    if (saved && (row.action === 'create' || row.action === 'update')) {
      savedVarianceReason = text(saved.varianceReason);
    }
    const transition = isObject(diff.transition) ? diff.transition : null;
    const target = transition && typeof transition.to === 'string' ? transition.to : null;

    let kind: RecordTrailEventKind | 'submit' =
      row.action === 'submit'
        ? 'submit'
        : row.action === 'update' && target
          ? (own(KIND_BY_TARGET, target) ?? 'edited')
          : (own(KIND_BY_ACTION, row.action) ?? 'other');

    let submission: number | null = null;
    if (kind === 'submit') {
      // Never lower than the order says: a row that names a number already
      // given (a submit around the release's deploy window) reads as the next.
      submission =
        typeof diff.submission === 'number' && Number.isInteger(diff.submission) && diff.submission > 0
          ? Math.max(diff.submission, submissions + 1)
          : submissions + 1;
      submissions = submission;
      kind = submission > 1 ? 'resubmitted' : 'submitted';
    }

    // A return before `reviewNote` existed stored its note as `varianceReason`.
    const reason =
      kind === 'returned'
        ? (text(diff.reviewNote) ?? text(diff.varianceReason))
        : kind === 'voided'
          ? text(diff.voidReason)
          : kind === 'submitted' || kind === 'resubmitted'
            ? (text(diff.varianceReason) ?? savedVarianceReason)
            : null;

    const changes =
      kind === 'edited' && isObject(diff.before) && isObject(diff.after)
        ? editChanges(diff.before, diff.after, lookups)
        : row.action === 'reprice'
          ? repriceChanges(diff)
          : [];

    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      kind,
      action: row.action,
      actor: row.userId
        ? { name: lookups.names.get(row.userId) ?? null, role: displayRole(row.role, row.createdAt, lookups.cutOver) }
        : null,
      submission,
      reason,
      changes,
    };
  });
}
