import { can, CATEGORIES, holdsRecords, reportingEntityFor, type AuthUser, type Category, type ControlKind, type NodeType } from '@/lib/types';
import type { ViewCopy } from '@/lib/i18n/view-translator';

/**
 * Which categories Data Entry offers (inc26-roles-approval-chain, design
 * Decision 6; spec "Data Entry offers a standard user only granted
 * categories"). A standard user (`scope.categories`) is offered, for the
 * chosen company, only the categories ticked on their grant for it, in the
 * product's order; every other role every category, as before. The API
 * refuses the rest (`category_not_granted`); this decides what is offered.
 */
export type EntryUser = Pick<AuthUser, 'role' | 'access'>;

export type CategoryGate =
  /** The form is shown; its picker offers `categories`. */
  | { kind: 'open'; categories: readonly Category[] }
  /** Nothing is ticked for this company: the not-assigned message, no form. */
  | { kind: 'none' }
  /** The page was asked for a category not ticked for this company (a link):
   *  the not-assigned message for it, no form; the picker offers `categories`. */
  | { kind: 'not_granted'; category: Category; categories: readonly Category[] };

/** The categories `user` may enter for `subsidiaryId`, in the product's order. */
export function offeredCategories(user: EntryUser | null, subsidiaryId: string): readonly Category[] {
  if (!user || !can(user.role, 'scope.categories')) return CATEGORIES;
  const ticked = new Set<string>(
    (user.access ?? []).filter((grant) => grant.subsidiaryId === subsidiaryId).flatMap((grant) => grant.categories),
  );
  return CATEGORIES.filter((category) => ticked.has(category));
}

/**
 * What Data Entry shows for this user, company and requested category (the
 * category a link named, null for none). No company chosen yet decides
 * nothing: the form waits for one as before.
 */
export function categoryGate(
  user: EntryUser | null,
  subsidiaryId: string,
  requested: Category | null,
): CategoryGate {
  const categories = offeredCategories(user, subsidiaryId);
  if (!subsidiaryId) return { kind: 'open', categories };
  if (categories.length === 0) return { kind: 'none' };
  if (requested !== null && !categories.includes(requested)) return { kind: 'not_granted', category: requested, categories };
  return { kind: 'open', categories };
}

/**
 * The category the form moves to when the one it holds is not offered — the
 * first one offered — or null to keep it (it is offered, or the page shows
 * the not-assigned message instead of the form).
 */
export function fallbackCategory(gate: CategoryGate, current: Category): Category | null {
  if (gate.kind !== 'open' || gate.categories.length === 0 || gate.categories.includes(current)) return null;
  return gate.categories[0];
}

export type CategoryGateKey = 'categoryGate.none' | 'categoryGate.notGranted';

/**
 * The not-assigned message, naming the company and, for a link, the category
 * (already in the user's language); null while the form is shown.
 */
export function categoryGateMessage(
  gate: CategoryGate,
  names: { company: string; category: (value: Category) => string },
  { t }: Pick<ViewCopy<CategoryGateKey>, 't'>,
): string | null {
  if (gate.kind === 'none') return t('categoryGate.none', { company: names.company });
  if (gate.kind === 'not_granted') {
    return t('categoryGate.notGranted', { company: names.company, category: names.category(gate.category) });
  }
  return null;
}

/**
 * The companies Data Entry offers (inc26-group-tree): the user's nodes that can
 * hold records — never an associate (outside Scope 1 and 2) or a sector group
 * (a label). The API refuses a record for either with
 * `entity_closed_to_data_entry`; the picker does not offer them.
 */
export function entryCompanies<S extends { nodeType: NodeType; control: ControlKind }>(subsidiaries: readonly S[]): S[] {
  return subsidiaries.filter((s) => holdsRecords(s));
}

/**
 * The company a new record for `subsidiaryId` would report for, shown before
 * it is saved (inc26-central-reporter-onboarding §4; owner review of WP8,
 * P2): a central reporter's grant company answers its main company — the
 * value TA025 will store; `null` when the record reports for its own company,
 * and nothing needs saying.
 */
export function entryReportingEntity(user: EntryUser | null, subsidiaryId: string): string | null {
  if (!user || !subsidiaryId) return null;
  const entity = reportingEntityFor(user.access ?? [], subsidiaryId);
  return entity === subsidiaryId ? null : entity;
}
