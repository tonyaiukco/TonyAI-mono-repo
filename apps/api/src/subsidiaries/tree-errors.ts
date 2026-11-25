import {
  BadRequestException,
  ConflictException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import type { ControlChangeBlockerKind } from '@tonyai/shared-types';
import { errorBody } from '../common/api-error';
import { EntityClosedToDataEntryError } from '../activity-records/errors';

/**
 * The group tree's refusals (inc26-group-tree, design "Error codes"). One
 * factory per code so the services, the database-refusal mapping and the
 * registry spec (`api-error.spec.ts`) build the same body.
 */

export function nodePlacementInvalid(
  message = 'That node type cannot be placed under this parent.',
): BadRequestException {
  return new BadRequestException(errorBody('node_placement_invalid', message));
}

export function nodeTypeFixed(): BadRequestException {
  return new BadRequestException(errorBody('node_type_fixed', "A company node's type cannot be changed."));
}

export function treeCycle(): ConflictException {
  return new ConflictException(
    errorBody('tree_cycle', 'A company cannot be moved under itself or a node beneath it.'),
  );
}

export function nodeMoveBlocked(): ConflictException {
  return new ConflictException(
    errorBody(
      'node_move_blocked',
      'This company cannot be moved: it, a node beneath it, or one of their facilities holds activity records.',
    ),
  );
}

const CONTROL_BLOCKER_WORDS: Readonly<Record<ControlChangeBlockerKind, string>> = {
  records: 'activity records (in any status)',
  assignments: 'user assignments',
  children: 'child companies',
  boundaryDeclarations: 'inventory boundary declarations',
};

/** Names each kind of blocker in the English message, as `subsidiary_in_use` does. */
export function controlChangeBlocked(kinds: readonly ControlChangeBlockerKind[]): ConflictException {
  const named = kinds.map((k) => CONTROL_BLOCKER_WORDS[k]).join(', ');
  return new ConflictException(
    errorBody(
      'control_change_blocked',
      `This company cannot become an associate while it has ${named}. Nothing was changed.`,
    ),
  );
}

export function entityClosedToDataEntry(): ConflictException {
  return new EntityClosedToDataEntryError();
}

export function subsidiaryNotAssignable(): ConflictException {
  return new ConflictException(
    errorBody(
      'subsidiary_not_assignable',
      'An associate or a sector group cannot be assigned to a user.',
    ),
  );
}

export function boundarySubsidiaryNotReportable(): ConflictException {
  return new ConflictException(
    errorBody(
      'boundary_subsidiary_not_reportable',
      'An associate or a sector group is outside the inventory boundary and cannot be declared in it.',
    ),
  );
}

export function geographyWithoutFactors(geography: string): UnprocessableEntityException {
  return new UnprocessableEntityException(
    errorBody(
      'geography_without_factors',
      `No emission factor set in this environment can price geography ${geography}.`,
      { geography },
    ),
  );
}

/** What a tree trigger's message starts with (`20261126120000_inc26_group_tree`). */
const TRIGGER_REFUSALS = {
  node_placement_invalid: () => nodePlacementInvalid(),
  node_type_fixed: nodeTypeFixed,
  tree_cycle: treeCycle,
  node_move_blocked: nodeMoveBlocked,
  control_change_blocked: () => controlChangeBlocked(['records', 'assignments', 'children']),
  entity_closed_to_data_entry: entityClosedToDataEntry,
  subsidiary_not_assignable: subsidiaryNotAssignable,
  boundary_subsidiary_not_reportable: boundarySubsidiaryNotReportable,
} as const;
type TriggerRefusal = keyof typeof TRIGGER_REFUSALS;

/** The codes each trigger may raise: a message read under the wrong SQLSTATE
 *  is not trusted. */
const BY_SQLSTATE: Readonly<Record<string, readonly TriggerRefusal[]>> = {
  TA018: ['node_placement_invalid', 'node_type_fixed', 'tree_cycle', 'node_move_blocked', 'control_change_blocked'],
  TA019: ['entity_closed_to_data_entry'],
  TA020: ['subsidiary_not_assignable'],
  TA021: ['node_placement_invalid'],
  TA022: ['boundary_subsidiary_not_reportable'],
};

/**
 * The refusal a tree trigger (TA018–TA022) raised, as the API's own exception,
 * or null for any other error. The API checks every rule before it writes;
 * this answers the same code when a concurrent request got there first and
 * only the database saw it (design "Error codes"). Prisma 6 reports a
 * trigger's RAISE on a model query as an unknown request error whose message
 * carries the PostgreSQL code and message (`recordTriggerCode`'s reading), and
 * on a raw query as P2010 with both in `meta`; `tree-errors.spec.ts` pins both
 * framings, `group-tree.int.spec.ts` the model-query one against the triggers.
 */
export function treeTriggerRefusal(e: unknown): HttpException | null {
  let sqlstate: string | undefined;
  let message: string | undefined;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') {
    const meta = e.meta as { code?: unknown; message?: unknown } | undefined;
    sqlstate = typeof meta?.code === 'string' ? meta.code : undefined;
    message = typeof meta?.message === 'string' ? meta.message : undefined;
  } else if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    // Anchored on the engine's own framing, so text elsewhere in the message
    // cannot be read as a code.
    const match = /PostgresError \{ code: "(TA0(?:18|19|20|21|22))", message: "([a-z_]+):/.exec(e.message);
    if (match) {
      sqlstate = match[1];
      message = `${match[2]}:`;
    }
  }
  if (!sqlstate || !message) return null;
  const allowed = BY_SQLSTATE[sqlstate];
  if (!allowed) return null;
  const code = /^([a-z_]+):/.exec(message)?.[1] as TriggerRefusal | undefined;
  if (!code || !allowed.includes(code)) return null;
  return TRIGGER_REFUSALS[code]();
}
