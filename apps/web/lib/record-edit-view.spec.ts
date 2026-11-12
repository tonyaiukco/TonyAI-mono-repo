import { describe, expect, it } from 'vitest';
import {
  copyPrefill,
  createFormSessions,
  describeEdit as describeEditIn,
  evidencePlan,
  recordActions,
  type EditIdentity,
  type EditLabels,
} from './record-edit-view';
import { copyFor } from '@/lib/i18n/testing';

/**
 * BUG-R2-03's Edit mode, Recall and Copy, as the Data Entry page reads them.
 * The band must name every identity change before the save; the evidence plan
 * must never let a category change keep a file (the API refuses it); and the
 * row actions must offer exactly what the API's gates allow.
 */

const labels: EditLabels = {
  category: (c) => c,
  activityType: (_c, v) => `type:${v}`,
  period: (p) => p,
  location: (id) => (id ? `site:${id}` : 'the whole subsidiary'),
};
const describeEdit = (original: EditIdentity, form: EditIdentity, locale: 'en' | 'tr' = 'en') =>
  describeEditIn(original, form, labels, copyFor('dataEntry', locale));

const stored = (over: Partial<EditIdentity> = {}): EditIdentity => ({
  category: 'Fuel',
  activityType: 'diesel',
  reportingYear: 2026,
  reportingPeriod: 'quarterly',
  periodValue: 'Q3',
  locationId: '',
  ...over,
});

describe('describeEdit — the band names each identity change, before the save', () => {
  it('says nothing for a value-only edit', () => {
    expect(describeEdit(stored(), stored())).toEqual([]);
  });

  it('names a category change, and not the type it clears', () => {
    expect(describeEdit(stored(), stored({ category: 'Electricity', activityType: null }))).toEqual([
      'Category: Fuel → Electricity',
    ]);
  });

  it('names a type change within the category', () => {
    expect(describeEdit(stored(), stored({ activityType: 'petrol' }))).toEqual(['Type: type:diesel → type:petrol']);
    expect(describeEdit(stored({ activityType: null }), stored({ activityType: 'petrol' }))).toEqual(['Type: none → type:petrol']);
  });

  it('names a year, a period and a location change', () => {
    expect(describeEdit(stored(), stored({ reportingYear: 2025 }))).toEqual(['Reporting year: 2026 → 2025']);
    expect(describeEdit(stored(), stored({ periodValue: 'Q1' }))).toEqual(['Period: Q3 → Q1']);
    expect(describeEdit(stored(), stored({ reportingPeriod: 'annual', periodValue: 'Annual' }))).toEqual(['Period: Q3 → Annual']);
    expect(describeEdit(stored(), stored({ locationId: 'loc-1' }))).toEqual(['Facility: the whole subsidiary → site:loc-1']);
  });

  it('lists several changes in a fixed order — QA\'s Fuel Q3 to Electricity Q1', () => {
    expect(
      describeEdit(stored(), stored({ category: 'Electricity', activityType: null, periodValue: 'Q1', reportingYear: 2025, locationId: 'loc-1' })),
    ).toEqual([
      'Category: Fuel → Electricity',
      'Reporting year: 2026 → 2025',
      'Period: Q3 → Q1',
      'Facility: the whole subsidiary → site:loc-1',
    ]);
  });

  it('is worded in Turkish for a Turkish user', () => {
    expect(describeEdit(stored(), stored({ periodValue: 'Q1' }), 'tr')).toEqual(['Dönem: Q3 → Q1']);
  });
});

describe('evidencePlan — owner decision D1', () => {
  const files = ['ev-1', 'ev-2'];
  const none = new Set<string>();

  it('removes every file on a category change, and waits for the confirmation', () => {
    const plan = evidencePlan(stored(), stored({ category: 'Water', activityType: null }), files, none, false);
    expect(plan).toEqual({ mode: 'removeAll', detachIds: ['ev-1', 'ev-2'], needsConfirmation: true });
    expect(evidencePlan(stored(), stored({ category: 'Water' }), files, none, true).needsConfirmation).toBe(false);
  });

  it('a category change ignores per-file choices: nothing may stay', () => {
    const plan = evidencePlan(stored(), stored({ category: 'Water' }), files, new Set(['ev-1']), true);
    expect(plan.detachIds).toEqual(['ev-1', 'ev-2']);
  });

  it.each([
    ['type', { activityType: 'petrol' }],
    ['year', { reportingYear: 2025 }],
    ['period', { periodValue: 'Q4' }],
    ['location', { locationId: 'loc-1' }],
  ])('a %s change keeps every file unless the user removes one', (_name, over) => {
    expect(evidencePlan(stored(), stored(over), files, none, false)).toEqual({ mode: 'choose', detachIds: [], needsConfirmation: false });
    expect(evidencePlan(stored(), stored(over), files, new Set(['ev-2']), false).detachIds).toEqual(['ev-2']);
  });

  it('a value-only edit touches no file, whatever was ticked', () => {
    expect(evidencePlan(stored(), stored(), files, new Set(['ev-1']), false)).toEqual({ mode: 'none', detachIds: [], needsConfirmation: false });
  });

  it('a record with no file needs no confirmation, even on a category change', () => {
    expect(evidencePlan(stored(), stored({ category: 'Water' }), [], none, false)).toEqual({ mode: 'none', detachIds: [], needsConfirmation: false });
  });
});

describe('recordActions — the API\'s gates, row by row', () => {
  const author = { id: 'u-entry', role: 'data_entry' };
  const admin = { id: 'u-admin', role: 'super_admin' };
  const row = (status: string, createdBy = author.id, periodLocked = false) => ({ status, createdBy, periodLocked });

  it('offers Edit on the author\'s draft and rejected records only', () => {
    expect(recordActions(author, row('draft'))).toEqual({ edit: true, recall: false, copy: false });
    expect(recordActions(author, row('rejected')).edit).toBe(true);
    for (const status of ['submitted', 'under_review', 'approved', 'locked', 'voided']) {
      expect(recordActions(author, row(status)).edit).toBe(false);
    }
  });

  it('never offers a super_admin Edit or Recall on a colleague\'s record', () => {
    expect(recordActions(admin, row('draft'))).toEqual({ edit: false, recall: false, copy: false });
    expect(recordActions(admin, row('submitted'))).toEqual({ edit: false, recall: false, copy: false });
    expect(recordActions(admin, row('draft', admin.id)).edit).toBe(true);
  });

  it('offers Recall on the author\'s submitted record only — not once review started', () => {
    expect(recordActions(author, row('submitted'))).toEqual({ edit: false, recall: true, copy: false });
    expect(recordActions(author, row('under_review')).recall).toBe(false);
  });

  it('offers neither Edit nor Recall in a locked period', () => {
    expect(recordActions(author, row('draft', author.id, true)).edit).toBe(false);
    expect(recordActions(author, row('submitted', author.id, true)).recall).toBe(false);
  });

  it('offers Copy on a voided record to its author and to a super_admin, locked period or not', () => {
    expect(recordActions(author, row('voided')).copy).toBe(true);
    expect(recordActions(admin, row('voided')).copy).toBe(true);
    expect(recordActions(admin, row('voided', author.id, true)).copy).toBe(true);
    expect(recordActions({ id: 'u-other', role: 'data_entry' }, row('voided')).copy).toBe(false);
    expect(recordActions({ id: 'u-c', role: 'consultant' }, row('voided', 'u-c')).copy).toBe(false);
  });

  it('offers nothing to a signed-out shell', () => {
    expect(recordActions(null, row('draft'))).toEqual({ edit: false, recall: false, copy: false });
  });
});

describe('copyPrefill — a voided record into a NEW draft', () => {
  it('carries the values, and no id, file or old justification', () => {
    const prefill = copyPrefill({
      subsidiaryId: 'sub-1',
      locationId: null,
      reportingYear: 2025,
      reportingPeriod: 'monthly',
      periodValue: 'March',
      category: 'Fuel',
      activityType: 'diesel',
      activityValue: 1200,
      activityUnit: 'litres',
      input: { note: 'tank 2' },
      parameters: null,
    });
    expect(prefill).toEqual({
      subsidiaryId: 'sub-1',
      locationId: '',
      reportingYear: 2025,
      reportingPeriod: 'monthly',
      periodValue: 'March',
      category: 'Fuel',
      activityType: 'diesel',
      activityValue: 1200,
      activityUnit: 'litres',
      input: { note: 'tank 2' },
      parameters: null,
      varianceReason: '',
    });
    expect(prefill).not.toHaveProperty('id');
    expect(prefill).not.toHaveProperty('evidenceCount');
  });
});

describe('createFormSessions — a late answer never overwrites a newer form (owner review P2)', () => {
  it('keeps only the latest session current', () => {
    const sessions = createFormSessions();
    const cancelOfA = sessions.begin();
    expect(sessions.isCurrent(cancelOfA)).toBe(true);
    const openedB = sessions.begin();
    expect(sessions.isCurrent(cancelOfA)).toBe(false);
    expect(sessions.isCurrent(openedB)).toBe(true);
  });

  it('reads the running session without beginning one (a save in flight, BUG-R2-05)', () => {
    const sessions = createFormSessions();
    const opened = sessions.begin();
    const atSave = sessions.current();
    expect(atSave).toBe(opened);
    expect(sessions.isCurrent(atSave)).toBe(true);
    // Reading it again is not a new session.
    expect(sessions.current()).toBe(opened);
    sessions.begin();
    expect(sessions.isCurrent(atSave)).toBe(false);
  });

  it('is per form: two forms do not share sessions', () => {
    const a = createFormSessions();
    const b = createFormSessions();
    const token = a.begin();
    b.begin();
    b.begin();
    expect(a.isCurrent(token)).toBe(true);
  });
});
