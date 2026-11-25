import { describe, expect, it } from 'vitest';
import { CATEGORIES, type Category, type UserRole } from '@/lib/types';
import { copyFor } from '@/lib/i18n/testing';
import { MESSAGES } from '@/messages';
import { categoryGate, categoryGateMessage, fallbackCategory, offeredCategories, type EntryUser } from './entry-categories-view';

/**
 * Spec "Data Entry offers a standard user only granted categories"
 * (inc26-roles-approval-chain, activity-data-entry): one case per scenario,
 * then the edges the page relies on.
 */
const A = 'company-a';
const B = 'company-b';
const standardUser = (access: EntryUser['access']): EntryUser => ({ role: 'standard_user', access });
const named = (locale: 'en' | 'tr') => ({
  company: 'Acme Energy',
  category: (value: Category) => MESSAGES[locale].categories[value],
});

describe('Data Entry offers a standard user only granted categories', () => {
  const user = standardUser([
    { subsidiaryId: A, categories: ['Natural Gas', 'Electricity'] },
    { subsidiaryId: B, categories: ['Fuel'] },
  ]);

  it('scenario "Two categories granted": the picker lists Electricity and Natural Gas and nothing else', () => {
    const gate = categoryGate(user, A, null);
    expect(gate).toEqual({ kind: 'open', categories: ['Electricity', 'Natural Gas'] });
    // In the product's order, whatever order the grant stored them in.
    expect(offeredCategories(user, A)).toEqual(CATEGORIES.filter((c) => c === 'Electricity' || c === 'Natural Gas'));
  });

  it('scenario "Changing company changes the list": company B lists Fuel alone', () => {
    expect(categoryGate(user, B, null)).toEqual({ kind: 'open', categories: ['Fuel'] });
    // The form holding Electricity from A moves to Fuel.
    expect(fallbackCategory(categoryGate(user, B, null), 'Electricity')).toBe('Fuel');
  });

  it('scenario "No category granted": the not-assigned message naming who assigns them, and no form', () => {
    const gate = categoryGate(standardUser([{ subsidiaryId: A, categories: [] }]), A, null);
    expect(gate).toEqual({ kind: 'none' });
    const en = categoryGateMessage(gate, named('en'), copyFor('dataEntry', 'en'));
    expect(en).toContain('Acme Energy');
    expect(en).toContain('Super Admin');
    const tr = categoryGateMessage(gate, named('tr'), copyFor('dataEntry', 'tr'));
    expect(tr).toContain('Acme Energy');
    expect(tr).toContain('Süper Yönetici');
    expect(fallbackCategory(gate, 'Electricity')).toBeNull();
  });

  it('scenario "A link to an ungranted category": the not-assigned message for Fuel, no form', () => {
    const onlyElectricity = standardUser([{ subsidiaryId: A, categories: ['Electricity'] }]);
    const gate = categoryGate(onlyElectricity, A, 'Fuel');
    expect(gate).toEqual({ kind: 'not_granted', category: 'Fuel', categories: ['Electricity'] });
    expect(categoryGateMessage(gate, named('en'), copyFor('dataEntry', 'en'))).toContain('Fuel');
    expect(categoryGateMessage(gate, named('tr'), copyFor('dataEntry', 'tr'))).toContain(MESSAGES.tr.categories.Fuel);
    // The form keeps the linked category behind the message; it is not swapped silently.
    expect(fallbackCategory(gate, 'Fuel')).toBeNull();
    // A link to a granted category opens the form on it.
    expect(categoryGate(onlyElectricity, A, 'Electricity')).toEqual({ kind: 'open', categories: ['Electricity'] });
  });

  it('scenario "A masterkey sees every category": every category the product offers, as before', () => {
    expect(categoryGate({ role: 'masterkey', access: [] }, A, null)).toEqual({ kind: 'open', categories: CATEGORIES });
    expect(categoryGate({ role: 'masterkey', access: [] }, A, 'Fuel')).toEqual({ kind: 'open', categories: CATEGORIES });
  });
});

describe('the category gate — edges', () => {
  it.each(['masterkey', 'super_admin', 'auditor'] as const satisfies readonly UserRole[])(
    'offers a %s every category, whatever its grants say',
    (role) => {
      // A super_admin's grant carries no categories and covers them all.
      expect(offeredCategories({ role, access: [{ subsidiaryId: A, categories: [] }] }, A)).toEqual(CATEGORIES);
    },
  );

  it('offers a standard user nothing for a company it holds no grant for', () => {
    expect(categoryGate(standardUser([{ subsidiaryId: A, categories: ['Fuel'] }]), B, null)).toEqual({ kind: 'none' });
  });

  it('decides nothing before a company is chosen, and keeps the form for a user still loading', () => {
    expect(categoryGate(standardUser([]), '', null).kind).toBe('open');
    expect(categoryGate(null, A, 'Fuel')).toEqual({ kind: 'open', categories: CATEGORIES });
  });

  it('keeps the held category when it is offered', () => {
    const gate = categoryGate(standardUser([{ subsidiaryId: A, categories: ['Fuel', 'Electricity'] }]), A, null);
    expect(fallbackCategory(gate, 'Fuel')).toBeNull();
    expect(categoryGateMessage(gate, named('en'), copyFor('dataEntry', 'en'))).toBeNull();
  });
});
