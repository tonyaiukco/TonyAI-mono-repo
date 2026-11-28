import { ConflictException, type HttpException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import {
  SINGLE_ENTRY_SIDES,
  type ApiErrorBody,
  type Category,
  type SingleEntryConflictDTO,
  type SingleEntrySide,
} from '@tonyai/shared-types';
import { errorBody } from '../common/api-error';

/**
 * Central reporting's refusals (inc26-central-reporter-onboarding, design
 * "Error codes"). One factory per code, so the services, the database-refusal
 * mapping and the registry spec (`api-error.spec.ts`) build the same body.
 */

/** B2: a grant holder keeps exactly one main company outside the grant. */
export class CentralReporterNeedsMainEntityError extends ConflictException {
  constructor() {
    super(
      errorBody(
        'central_reporter_needs_main_entity',
        'A central reporter keeps exactly one main company outside the grant; this change would leave none, or several. Nothing was changed.',
      ),
    );
  }
}

const SIDE_WORDS: Readonly<Record<SingleEntrySide, string>> = {
  company_users: "the company's own standard users",
  central_reporter: 'a central reporter',
};

/**
 * §4.2: a category at a company would be opened to both parties. `side` is the
 * party that already holds it; `conflicts` the companies in conflict the
 * reader may read, as identifiers (the screen words them) — empty for a
 * refusal the database raised in a race. Never an account.
 */
export class SingleEntryConflictError extends ConflictException {
  constructor(side: SingleEntrySide, conflicts: readonly SingleEntryConflictDTO[]) {
    const body: ApiErrorBody = {
      ...errorBody(
        'single_entry_conflict',
        `These categories are already open to ${SIDE_WORDS[side]} at this company, so they cannot also be opened to ${
          side === 'company_users' ? 'a central reporter' : "the company's own standard users"
        }. Nothing was changed.`,
        { side },
      ),
      conflicts: conflicts.map((c) => ({ subsidiaryId: c.subsidiaryId, categories: [...c.categories] })),
    };
    super(body);
  }
}

/** The canonical period a record names, as a refusal's params carry it. */
export interface SingleEntryPeriod {
  category: Category;
  reportingYear: number;
  periodValue: string;
}

/**
 * §4.2, §5.3: the other party already entered this category for this company
 * and period. `side` is the party that entered it.
 */
export class SingleEntryPeriodConflictError extends ConflictException {
  constructor(side: SingleEntrySide, period: SingleEntryPeriod) {
    super(
      errorBody(
        'single_entry_period_conflict',
        `${side === 'company_users' ? "The company's own users" : 'A central reporter'} already entered ${period.category} for ${period.periodValue} ${period.reportingYear}, or a period overlapping it, at this company, so ${
          side === 'company_users' ? 'a central reporter' : 'its own users'
        } cannot enter it in that period.`,
        { side, category: period.category, year: period.reportingYear, period: period.periodValue },
      ),
    );
  }
}

/** A trigger's SQLSTATE and message, from either framing Prisma 6 gives a RAISE. */
function triggerRaise(e: unknown, codes: readonly string[]): { sqlstate: string; message: string } | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') {
    const meta = e.meta as { code?: unknown; message?: unknown } | undefined;
    if (typeof meta?.code === 'string' && codes.includes(meta.code) && typeof meta.message === 'string') {
      return { sqlstate: meta.code, message: meta.message };
    }
    return null;
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    // Anchored on the engine's own framing, so text elsewhere in the message
    // cannot be read as a code.
    const match = /PostgresError \{ code: "(TA02[4-7])", message: "([^"]*)"/.exec(e.message);
    if (match && codes.includes(match[1]!)) return { sqlstate: match[1]!, message: match[2]! };
  }
  return null;
}

/** The `side=` a single-entry trigger names, when it is one the contract knows. */
function sideIn(message: string): SingleEntrySide | null {
  const side = /side=([a-z_]+)/.exec(message)?.[1];
  return side && (SINGLE_ENTRY_SIDES as readonly string[]).includes(side) ? (side as SingleEntrySide) : null;
}

/**
 * The refusal an access trigger raised (TA024 single entry, TA025's missing
 * main company on a record never reaches here), as the API's own exception,
 * or null for any other error. The API checks first; this answers the same
 * code when a concurrent request got there first and only the database saw
 * it — with its side and an empty list (design D4).
 */
export function accessTriggerRefusal(e: unknown): HttpException | null {
  const raised = triggerRaise(e, ['TA024']);
  if (!raised || !raised.message.startsWith('single_entry_conflict:')) return null;
  const side = sideIn(raised.message);
  return side ? new SingleEntryConflictError(side, []) : null;
}

/**
 * The refusal a record trigger raised for central reporting (TA025's missing
 * main company, TA026's period rule) as the API's own exception, or null. The
 * period's params come from the record the caller was writing.
 */
export function recordCentralReportingRefusal(e: unknown, period: SingleEntryPeriod): HttpException | null {
  const raised = triggerRaise(e, ['TA025', 'TA026']);
  if (!raised) return null;
  if (raised.sqlstate === 'TA026' && raised.message.startsWith('single_entry_period_conflict:')) {
    const side = sideIn(raised.message);
    return side ? new SingleEntryPeriodConflictError(side, period) : null;
  }
  if (raised.sqlstate === 'TA025' && raised.message.startsWith('central_reporter_needs_main_entity:')) {
    return new CentralReporterNeedsMainEntityError();
  }
  return null;
}
