import { describe, expect, it } from 'vitest';
import {
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

  it('a finished masterkey is sent from the wizard to the company tree (Finish) and held nowhere', () => {
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: false }, '/onboarding')).toBe('/subsidiaries');
    expect(onboardingRedirect({ role: 'masterkey', onboardingPending: false }, '/users')).toBeNull();
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
