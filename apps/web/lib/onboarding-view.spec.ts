import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '@/lib/types';
import {
  GATE_AUTO_RETRIES,
  boundaryStepView,
  grantCandidatesIn,
  grantCandidates,
  retriesOnAuthEvent,
  ONBOARDING_STEPS,
  approachWrite,
  boundaryCompanies,
  companyParents,
  holdingAction,
  holdingPassed,
  maySeeStep,
  nextStep,
  onboardingRedirect,
  previousStep,
  rootOf,
  unusedSuggestions,
  type OnboardingStep,
  type WizardNode,
} from './onboarding-view';

/** The setup wizard's decisions (inc26-central-reporter-onboarding, tasks 8.3–8.7). */

const node = (id: string, nodeType: WizardNode['nodeType'], over: Partial<WizardNode> = {}): WizardNode => ({
  id, parentId: nodeType === 'holding' ? null : 'root', nodeType, control: 'controlled', legalName: id, tradingName: null, ...over,
});

describe('the gate (D9)', () => {
  it('holds a masterkey of an unfinished organisation on the wizard from every protected path', () => {
    for (const path of ['/', '/data-entry', '/users', '/subsidiaries/abc']) {
      expect(onboardingRedirect({ role: 'masterkey', onboardingPending: true }, path)).toBe('/onboarding');
    }
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: true }, '/onboarding')).toBeNull();
  });

  it.each(['super_admin', 'standard_user', 'auditor'] as const)('never holds a %s, and sends it from the wizard to the dashboard', (role) => {
    expect(onboardingRedirect({ role, onboardingPending: false }, '/data-entry')).toBeNull();
    expect(onboardingRedirect({ role, onboardingPending: false }, '/onboarding')).toBe('/');
    // Even a stray true from an API answer holds only a masterkey.
    expect(onboardingRedirect({ role, onboardingPending: true }, '/users')).toBeNull();
  });

  it("a finished masterkey opening the wizard's address later goes to the dashboard, and is held nowhere", () => {
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: false }, '/onboarding')).toBe('/');
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: false }, '/users')).toBeNull();
  });

  it("this tab's Finish leads to the company tree; for no other role", () => {
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: false }, '/onboarding', true)).toBe('/subsidiaries');
    expect(onboardingRedirect({ role: 'super_admin', onboardingPending: false }, '/onboarding', true)).toBe('/');
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: true }, '/onboarding', true)).toBeNull();
  });

  it('decides nothing before the account is known', () => {
    expect(onboardingRedirect(null, '/users')).toBeNull();
  });
});

describe('the steps, one per screen, in a fixed order (8.4)', () => {
  it('has the eight steps of §7.1 in order', () => {
    expect(ONBOARDING_STEPS).toEqual(['holding', 'approach', 'sectorGroups', 'companies', 'boundaries', 'superAdmins', 'centralReporter', 'finish']);
    expect(nextStep('holding')).toBe('approach');
    expect(nextStep('finish')).toBeNull();
    expect(previousStep('holding')).toBeNull();
  });

  it('shows a step only after every step before it is passed; a return starts at step 1', () => {
    const passed = new Set<OnboardingStep>(['holding', 'approach']);
    expect(maySeeStep('sectorGroups', passed)).toBe(true);
    expect(maySeeStep('companies', passed)).toBe(false);
    expect(maySeeStep('holding', new Set())).toBe(true);
    expect(maySeeStep('approach', new Set())).toBe(false);
  });
});

describe('step 1: the holding (8.5, C11)', () => {
  it('is not passed without a trading name or a root', () => {
    expect(holdingAction(null, '   ')).toEqual({ kind: 'invalid' });
    expect(holdingPassed(null)).toBe(false);
    expect(holdingPassed({ tradingName: '' })).toBe(false);
    expect(holdingPassed({ tradingName: 'Acme Holding' })).toBe(true);
  });

  it('creates the root through the first-company request when there is none', () => {
    expect(holdingAction(null, ' Acme Holding ')).toEqual({ kind: 'create', tradingName: 'Acme Holding' });
  });

  it('writes the trading name only when it differs (C8)', () => {
    const root = node('root', 'holding', { tradingName: 'Acme Holding' });
    expect(holdingAction(root, 'Acme Holding')).toEqual({ kind: 'none', id: 'root' });
    expect(holdingAction(root, 'Acme Group')).toEqual({ kind: 'rename', id: 'root', tradingName: 'Acme Group' });
    expect(rootOf([node('a', 'company'), root])).toBe(root);
  });
});

describe('step 2: the approach (8.5)', () => {
  it('a return after choosing financial control shows it and writes nothing; a changed choice is written', () => {
    expect(approachWrite('financial_control', 'financial_control')).toBeNull();
    expect(approachWrite('operational_control', 'financial_control')).toBe('financial_control');
  });
});

describe('steps 3 to 5: groups, companies, boundaries (8.6, 8.7)', () => {
  const nodes = [
    node('root', 'holding'),
    node('Banking', 'sector_group'),
    node('A', 'company'),
    node('Assoc', 'company', { control: 'associate' }),
  ];

  it("offers the ten suggestions not yet used, in the reader's language", () => {
    const label = (k: string) => ({ banking: 'Banking', mining: 'Mining' } as Record<string, string>)[k] ?? k;
    expect(unusedSuggestions(nodes, label, 'en')).not.toContain('banking');
    expect(unusedSuggestions(nodes, label, 'en')).toContain('mining');
    expect(unusedSuggestions(nodes, label, 'en')).toHaveLength(9);
  });

  it('a company goes under the holding or a sector group', () => {
    expect(companyParents(nodes).map((n) => n.id)).toEqual(['root', 'Banking']);
  });

  it('the boundary step lists companies that hold records — no sector group, no associate', () => {
    expect(boundaryCompanies(nodes).map((n) => n.id)).toEqual(['root', 'A']);
  });
});

describe("the gate's automatic retry (owner review of WP8, P2)", () => {
  it('any Auth event but a sign-out retries — INITIAL_SESSION included — up to the bound', () => {
    for (const event of ['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']) {
      expect(retriesOnAuthEvent(event, 0)).toBe(true);
      expect(retriesOnAuthEvent(event, GATE_AUTO_RETRIES - 1)).toBe(true);
      expect(retriesOnAuthEvent(event, GATE_AUTO_RETRIES)).toBe(false);
    }
  });

  it('a sign-out never does', () => {
    expect(retriesOnAuthEvent('SIGNED_OUT', 0)).toBe(false);
  });
});

describe("step 7's candidates (owner review of WP8, P2)", () => {
  const row = (subsidiaryId: string, kind: 'assigned' | 'central_reporter') => ({ subsidiaryId, categories: ['Fuel' as const], kind });
  it('only a standard user with exactly one main company', () => {
    const users = [
      { id: 'ok', role: 'standard_user' as const, access: [row('a', 'assigned')] },
      { id: 'reporter', role: 'standard_user' as const, access: [row('a', 'assigned'), row('b', 'central_reporter')] },
      { id: 'none', role: 'standard_user' as const, access: [] },
      { id: 'carried', role: 'standard_user' as const, access: [row('a', 'assigned'), row('b', 'assigned')] },
      { id: 'admin', role: 'super_admin' as const, access: [row('a', 'assigned')] },
    ];
    expect(grantCandidates(users).map((u) => u.id)).toEqual(['ok', 'reporter']);
  });
});

describe("step 5 acts on the selected year's version only (owner's second review of WP8, P1)", () => {
  const v2026 = { id: 'v26', reportingYear: 2026 };
  it("shows the year's version once its read has landed", () => {
    expect(boundaryStepView(2026, 2026, v2026)).toEqual({ ready: true, version: v2026 });
    expect(boundaryStepView(2025, 2025, null)).toEqual({ ready: true, version: null });
  });
  it('shows nothing — no Declare, no Confirm — while the new year is read, after a failed read, or for another year', () => {
    expect(boundaryStepView(2025, null, v2026)).toEqual({ ready: false, version: null });
    expect(boundaryStepView(2025, 2026, v2026)).toEqual({ ready: false, version: null });
    expect(boundaryStepView(2025, 2025, v2026)).toEqual({ ready: false, version: null });
    // No version yet and the year's read still out: nothing may open one (QA review).
    expect(boundaryStepView(2025, null, null)).toEqual({ ready: false, version: null });
  });
});

describe("step 7 offers only a user a grant can be given to (owner's second review of WP8, P2)", () => {
  const row = (subsidiaryId: string) => ({ subsidiaryId, categories: ['Fuel' as const], kind: 'assigned' as const });
  const company = (id: string, extra: Partial<{ nodeType: 'company' | 'sector_group'; control: 'controlled' | 'associate' }> = {}) =>
    ({ id, nodeType: 'company' as const, control: 'controlled' as const, ...extra });
  const user = { id: 'u', role: 'standard_user' as const, access: [row('A')] };
  it("no one when the user's main company is the organisation's only company that holds records", () => {
    expect(grantCandidatesIn([user], [company('A'), company('G', { nodeType: 'sector_group' }), company('X', { control: 'associate' })])).toEqual([]);
  });
  it('the user once another company holds records', () => {
    expect(grantCandidatesIn([user], [company('A'), company('B')])).toEqual([user]);
  });

  it("no one when every category of every other company is its own users' (single entry; owner's third review, P2)", () => {
    const all = CATEGORIES.map((c) => c);
    const a = { id: 'a', role: 'standard_user' as const, access: [{ subsidiaryId: 'A', categories: all, kind: 'assigned' as const }] };
    const b = { id: 'b', role: 'standard_user' as const, access: [{ subsidiaryId: 'B', categories: all, kind: 'assigned' as const }] };
    expect(grantCandidatesIn([a, b], [company('A'), company('B')])).toEqual([]);
    // One category left open at B: a may take it.
    const bNarrow = { ...b, access: [{ subsidiaryId: 'B', categories: all.filter((c) => c !== 'Water'), kind: 'assigned' as const }] };
    expect(grantCandidatesIn([a, bNarrow], [company('A'), company('B')]).map((u) => u.id)).toEqual(['a']);
  });

  it("a super_admin's rows at the other company close nothing", () => {
    const a = { id: 'a', role: 'standard_user' as const, access: [row('A')] };
    const admin = { id: 's', role: 'super_admin' as const, access: [{ subsidiaryId: 'B', categories: [], kind: 'assigned' as const }] };
    expect(grantCandidatesIn([a, admin], [company('A'), company('B')]).map((u) => u.id)).toEqual(['a']);
  });
});
