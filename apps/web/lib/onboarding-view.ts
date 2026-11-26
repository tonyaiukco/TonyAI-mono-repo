import { can, holdsRecords, type AuthUser, type ConsolidationApproach, type ControlKind, type NodeType } from '@/lib/types';

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
 * organisation to the wizard from any other protected path; a masterkey whose
 * organisation is finished away from the wizard to the company tree (§7.1
 * step 8: Finish leads there, and a finished wizard never shows again);
 * anyone else away from the wizard to the dashboard; null to stay.
 */
export function onboardingRedirect(
  user: Pick<AuthUser, 'role' | 'onboardingPending'> | null,
  pathname: string,
): string | null {
  if (!user) return null;
  const onWizard = pathname === ONBOARDING_PATH || pathname.startsWith(`${ONBOARDING_PATH}/`);
  const held = can(user.role, 'onboarding.run') && user.onboardingPending === true;
  if (held && !onWizard) return ONBOARDING_PATH;
  if (!held && onWizard) return can(user.role, 'onboarding.run') ? '/subsidiaries' : '/';
  return null;
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
