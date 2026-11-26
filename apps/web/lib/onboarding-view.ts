import { can, CATEGORIES, holdsRecords, mainCompanyOf, singleEntryConflicts, type AuthUser, type SingleEntryAccessRow, type UserSummaryDTO, type ConsolidationApproach, type ControlKind, type NodeType } from '@/lib/types';

/**
 * The masterkey's setup wizard (inc26-central-reporter-onboarding, INC-2.6
 * Rev.3 §7.1; design D9, D10), out of the screens so it is tested
 * (`onboarding-view.spec.ts`). Every step is a view over endpoints that
 * already exist; nothing here writes. Keys are in the `onboarding` namespace.
 */

/** The eight steps, in §7.1's fixed order: one per screen. */
export const ONBOARDING_STEPS = [
  'holding',
  'approach',
  'sectorGroups',
  'companies',
  'boundaries',
  'superAdmins',
  'centralReporter',
  'finish',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The route the wizard lives on; it mounts no sidebar. */
export const ONBOARDING_PATH = '/onboarding';

/**
 * Where the gate sends a signed-in account (D9): a masterkey of an unfinished
 * organisation to the wizard from any other protected path; anyone else —
 * a masterkey whose organisation is finished included — away from the wizard
 * to the dashboard (spec "Only a masterkey is given the wizard"); null to
 * stay. `justFinished`: this tab's Finish, which leads to the company tree
 * instead (§7.1 step 8) — a later visit to the wizard's address does not.
 */
export function onboardingRedirect(
  user: Pick<AuthUser, 'role' | 'onboardingPending'> | null,
  pathname: string,
  justFinished = false,
): string | null {
  if (!user) return null;
  const onWizard = isWizardPath(pathname);
  const held = can(user.role, 'onboarding.run') && user.onboardingPending === true;
  if (held && !onWizard) return ONBOARDING_PATH;
  if (!held && onWizard) return justFinished && can(user.role, 'onboarding.run') ? '/subsidiaries' : '/';
  return null;
}

export function isWizardPath(pathname: string): boolean {
  return pathname === ONBOARDING_PATH || pathname.startsWith(`${ONBOARDING_PATH}/`);
}

/** The automatic retries a run of failed account reads may take. */
export const GATE_AUTO_RETRIES = 3;

/**
 * The gate's automatic retry of a failed account read (owner review of WP8,
 * P2): on an Auth event while the read is failed — any but a sign-out, the
 * `INITIAL_SESSION` its one subscription is handed included, since a sign-in
 * that settled before the gate mounted leaves only that event — and at most
 * `GATE_AUTO_RETRIES` times in a run of failures. No event, no retry: a
 * failure that persists stays on screen, and only "Try again" reads again.
 */
export function retriesOnAuthEvent(event: string, retriesSoFar: number): boolean {
  return event !== 'SIGNED_OUT' && retriesSoFar < GATE_AUTO_RETRIES;
}

/**
 * The steps passed so far decide which can be shown: a step only after every
 * step before it is passed (§7.1, "one step per screen"); a return always
 * starts at step 1 (C8). Only step 1 has a condition — a holding with a
 * trading name — every other step is passed by moving on (C5: no minimum).
 */
export function maySeeStep(step: OnboardingStep, passed: ReadonlySet<OnboardingStep>): boolean {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS.slice(0, index).every((s) => passed.has(s));
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index >= 0 && index < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[index + 1]! : null;
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = ONBOARDING_STEPS.indexOf(step);
  return index > 0 ? ONBOARDING_STEPS[index - 1]! : null;
}

/** A node as the wizard reads it from `GET /subsidiaries`. */
export interface WizardNode {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  control: ControlKind;
  legalName: string;
  tradingName: string | null;
}

/** The organisation's root — its one holding — or null when it has none (C11). */
export function rootOf<N extends Pick<WizardNode, 'parentId' | 'nodeType'>>(nodes: readonly N[]): N | null {
  return nodes.find((n) => n.parentId === null && n.nodeType === 'holding') ?? nodes.find((n) => n.parentId === null) ?? null;
}

/**
 * Step 1's write (D10): create the root through the first-company request
 * when the organisation has none (C11), set its trading name when it differs,
 * nothing otherwise (C8: a return writes nothing unless changed). A blank
 * name passes nothing: the step is not passed without a trading name.
 */
export type HoldingAction =
  | { kind: 'invalid' }
  | { kind: 'create'; tradingName: string }
  | { kind: 'rename'; id: string; tradingName: string }
  | { kind: 'none'; id: string };

export function holdingAction(root: Pick<WizardNode, 'id' | 'tradingName'> | null, typed: string): HoldingAction {
  const tradingName = typed.trim();
  if (!tradingName) return { kind: 'invalid' };
  if (!root) return { kind: 'create', tradingName };
  return root.tradingName === tradingName ? { kind: 'none', id: root.id } : { kind: 'rename', id: root.id, tradingName };
}

/** Step 1 is passed with a root that carries a trading name. */
export function holdingPassed(root: Pick<WizardNode, 'tradingName'> | null): boolean {
  return !!root && !!root.tradingName?.trim();
}

/** Step 2: the stored approach, written only when the choice differs (C8). */
export function approachWrite(stored: ConsolidationApproach, chosen: ConsolidationApproach): ConsolidationApproach | null {
  return stored === chosen ? null : chosen;
}

/** Step 3's suggestions: the ten names of §7.1, as catalogue keys. */
export const SECTOR_GROUP_SUGGESTIONS = [
  'naturalGas',
  'banking',
  'mining',
  'retail',
  'refinery',
  'finance',
  'food',
  'automotive',
  'construction',
  'renewables',
] as const;
export type SectorGroupSuggestion = (typeof SECTOR_GROUP_SUGGESTIONS)[number];

/** The suggestions not yet used as a sector group's name (compared without case). */
export function unusedSuggestions(
  nodes: readonly Pick<WizardNode, 'nodeType' | 'legalName'>[],
  label: (key: SectorGroupSuggestion) => string,
  locale: string,
): SectorGroupSuggestion[] {
  const taken = new Set(nodes.filter((n) => n.nodeType === 'sector_group').map((n) => n.legalName.toLocaleLowerCase(locale)));
  return SECTOR_GROUP_SUGGESTIONS.filter((key) => !taken.has(label(key).toLocaleLowerCase(locale)));
}

/** Step 4's parents: the holding or a sector group (§7.1). */
export function companyParents<N extends Pick<WizardNode, 'nodeType'>>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => n.nodeType === 'holding' || n.nodeType === 'sector_group');
}

/** Step 3's and 4's lists, read from the API: the sector groups, and the companies. */
export function sectorGroupsOf<N extends Pick<WizardNode, 'nodeType'>>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => n.nodeType === 'sector_group');
}
export function companiesOf<N extends Pick<WizardNode, 'nodeType'>>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => n.nodeType === 'company' || n.nodeType === 'child_company' || n.nodeType === 'sub_holding');
}

/** Step 5's companies: those that hold records — no sector group, no associate (§2.1). */
export function boundaryCompanies<N extends Pick<WizardNode, 'nodeType' | 'control'>>(nodes: readonly N[]): N[] {
  return nodes.filter((n) => holdsRecords(n));
}

/**
 * Step 7's candidates (§7.1; owner review of WP8, P2): a standard user who
 * holds exactly one main company — the only account the grant's rules accept
 * (B2). Anyone else would be offered a grant the API refuses.
 */
export function grantCandidates<U extends Pick<UserSummaryDTO, 'role' | 'access'>>(users: readonly U[]): U[] {
  return users.filter((u) => u.role === 'standard_user' && mainCompanyOf(u.access) !== null);
}

/**
 * Step 5's version as shown (owner's second review of WP8, P1): nothing until
 * the selected year's read has landed, and never another year's version — so
 * Declare, Edit and Confirm act on the year the bar names, or on nothing.
 * `loadedFor`: the year whose read landed last (null while one is in flight or
 * after it failed).
 */
export function boundaryStepView<V extends { reportingYear: number }>(
  year: number,
  loadedFor: number | null,
  detail: V | null,
): { ready: boolean; version: V | null } {
  const ready = loadedFor === year && (detail === null || detail.reportingYear === year);
  return { ready, version: ready ? detail : null };
}

/**
 * Step 7's candidates (§7.1; owner's reviews of WP8, P2): a standard user who
 * holds exactly one main company (B2) and for whom a grant could be saved — a
 * company that holds records, other than that main company, with at least one
 * category the single-entry rule leaves open to a central reporter there (no
 * company user of it holds the category; `singleEntryConflicts`, the rule the
 * API applies). Anyone else would be offered a grant the API refuses.
 * `users`: every account of the organisation, whose rows are the standing.
 */
export function grantCandidatesIn<U extends Pick<UserSummaryDTO, 'id' | 'role' | 'access'>>(
  users: readonly U[],
  nodes: readonly Pick<WizardNode, 'id' | 'nodeType' | 'control'>[],
): U[] {
  const recordHolders = nodes.filter((n) => holdsRecords(n)).map((n) => n.id);
  const standing: SingleEntryAccessRow[] = users.flatMap((u) =>
    u.access.map((row) => ({ userId: u.id, subsidiaryId: row.subsidiaryId, kind: row.kind ?? 'assigned', categories: row.categories, holderRole: u.role })),
  );
  const grantableAt = (user: U, subsidiaryId: string) =>
    CATEGORIES.some(
      (category) =>
        singleEntryConflicts(standing, [
          { userId: user.id, subsidiaryId, kind: 'central_reporter', categories: [category], holderRole: 'standard_user' },
        ]).length === 0,
    );
  return grantCandidates(users).filter((u) => {
    const main = mainCompanyOf(u.access);
    return recordHolders.some((id) => id !== main && grantableAt(u, id));
  });
}
