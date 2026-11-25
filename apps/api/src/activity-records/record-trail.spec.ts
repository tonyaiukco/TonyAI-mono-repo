import { describe, expect, it } from 'vitest';
import { buildRecordTrail, editChanges, type TrailAuditRow, type TrailLookups } from './record-trail';

const lookups: TrailLookups = {
  names: new Map([
    ['u-entry', 'Entry User'],
    ['u-review', 'Review User'],
    ['u-admin', 'Admin User'],
  ]),
  locations: new Map([
    ['loc-a', 'Istanbul plant'],
    ['loc-b', 'Izmir depot'],
  ]),
};

let seq = 0;
const at = (n: number) => new Date(Date.UTC(2026, 10, 25, 9, n));

function row(action: string, diff: unknown, over: Partial<TrailAuditRow> = {}): TrailAuditRow {
  seq += 1;
  return {
    id: `audit-${seq}`,
    action,
    userId: 'u-entry',
    role: 'data_entry',
    diff,
    createdAt: at(seq),
    ...over,
  };
}

const calc = (tCo2e: number) => ({ factorId: 'f-1', tCo2e, kgCo2e: tCo2e * 1000 });

function snapshot(over: Record<string, unknown> = {}) {
  return {
    id: 'rec-1',
    subsidiaryId: 'sub-1',
    locationId: null,
    reportingYear: 2026,
    reportingPeriod: 'quarterly',
    periodValue: 'Q1',
    category: 'Electricity',
    activityType: null,
    scope: 2,
    status: 'draft',
    activityValue: 1000,
    activityUnit: 'kWh',
    input: null,
    parameters: null,
    calculation: calc(0.442),
    createdBy: 'u-entry',
    anomalyFlag: false,
    varianceReason: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    submittedAt: null,
    submissionCount: 0,
    evidenceCount: 0,
    createdAt: '2026-11-25T09:00:00.000Z',
    updatedAt: '2026-11-25T09:00:00.000Z',
    ...over,
  };
}

const transition = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
  transition: { from, to },
  ...extra,
});
const reviewer = { userId: 'u-review', role: 'consultant' };

describe('buildRecordTrail — the events of one record, in order', () => {
  it('classifies every legacy `update` transition by its target, and an unknown target as an edit', () => {
    const events = buildRecordTrail(
      [
        row('update', transition('submitted', 'draft')),
        row('update', transition('under_review', 'approved'), reviewer),
        row('update', transition('approved', 'voided', { voidReason: 'Duplicate' })),
        row('update', transition('approved', 'locked')),
      ],
      lookups,
    );
    expect(events.map((e) => e.kind)).toEqual(['recalled', 'approved', 'voided', 'edited']);
    expect(events[2].reason).toBe('Duplicate');
  });

  it('ignores a submission number that is not a positive whole number, counting on from the last', () => {
    const events = buildRecordTrail(
      [
        row('submit', transition('draft', 'submitted', { submission: 0 })),
        row('submit', transition('draft', 'submitted', { submission: 1.5 })),
        row('submit', transition('draft', 'submitted', { submission: 5 })),
        row('submit', transition('draft', 'submitted')),
      ],
      lookups,
    );
    expect(events.map((e) => e.submission)).toEqual([1, 2, 5, 6]);
  });

  it('drops a blank reason', () => {
    const [event] = buildRecordTrail([row('reject', transition('submitted', 'rejected', { reviewNote: '   ' }), reviewer)], lookups);
    expect(event.reason).toBeNull();
  });

  it('carries no reason on a kind that has none', () => {
    const [event] = buildRecordTrail([row('approve', transition('submitted', 'approved', { reviewNote: 'x', voidReason: 'y' }), reviewer)], lookups);
    expect(event.reason).toBeNull();
  });

  it('tells the eleven-event story of the spec', () => {
    const rows = [
      row('create', { after: snapshot() }),
      row('submit', transition('draft', 'submitted', { submission: 1 })),
      row('recall', transition('submitted', 'draft')),
      row('update', { before: snapshot(), after: snapshot({ activityValue: 1200, calculation: calc(0.53) }) }),
      row('submit', transition('draft', 'submitted', { submission: 2 })),
      row('review', transition('submitted', 'under_review'), reviewer),
      row('reject', transition('under_review', 'rejected', { reviewNote: 'The March invoice is missing' }), reviewer),
      row('update', { before: snapshot({ activityValue: 1200 }), after: snapshot({ activityValue: 1250 }) }),
      row('submit', transition('rejected', 'submitted', { submission: 3 })),
      row('review', transition('submitted', 'under_review'), reviewer),
      row('approve', transition('under_review', 'approved'), reviewer),
    ];

    const events = buildRecordTrail(rows, lookups);

    expect(events.map((e) => e.kind)).toEqual([
      'created',
      'submitted',
      'recalled',
      'edited',
      'resubmitted',
      'review_started',
      'returned',
      'edited',
      'resubmitted',
      'review_started',
      'approved',
    ]);
    expect(events.map((e) => e.submission)).toEqual([null, 1, null, null, 2, null, null, null, 3, null, null]);
    const returned = events[6];
    expect(returned.reason).toBe('The March invoice is missing');
    expect(returned.actor).toEqual({ name: 'Review User', role: 'consultant' });
    // A lifecycle event changes no input.
    for (const i of [1, 2, 4, 5, 6, 8, 9, 10]) expect(events[i].changes).toEqual([]);
    expect(events[0].changes).toEqual([]);
  });

  it('numbers two submits written before submissions were numbered by their order', () => {
    const events = buildRecordTrail(
      [
        row('submit', transition('draft', 'submitted')),
        row('recall', transition('submitted', 'draft')),
        row('submit', transition('draft', 'submitted')),
      ],
      lookups,
    );
    expect(events.map((e) => [e.kind, e.submission])).toEqual([
      ['submitted', 1],
      ['recalled', null],
      ['resubmitted', 2],
    ]);
  });

  it('classifies a submit logged as `update` with a transition, before the audit taxonomy', () => {
    const events = buildRecordTrail(
      [
        row('update', transition('draft', 'submitted')),
        row('update', transition('submitted', 'under_review'), reviewer),
        row('update', transition('under_review', 'rejected', { reviewNote: 'Wrong meter' }), reviewer),
        row('update', transition('rejected', 'submitted')),
      ],
      lookups,
    );
    expect(events.map((e) => [e.kind, e.submission, e.action])).toEqual([
      ['submitted', 1, 'update'],
      ['review_started', null, 'update'],
      ['returned', null, 'update'],
      ['resubmitted', 2, 'update'],
    ]);
    expect(events[2].reason).toBe('Wrong meter');
    expect(events[0].changes).toEqual([]);
  });

  it('carries the reasons of a return, a void and a submit', () => {
    const events = buildRecordTrail(
      [
        row('submit', transition('draft', 'submitted', { submission: 1, varianceReason: 'New chiller in March' })),
        row('reject', transition('submitted', 'rejected', { reviewNote: 'Attach the invoice' }), reviewer),
        row(
          'void',
          transition('approved', 'voided', { voidReason: 'Duplicate of the site invoice', before: snapshot() }),
          { userId: 'u-admin', role: 'super_admin' },
        ),
      ],
      lookups,
    );
    expect(events.map((e) => e.reason)).toEqual([
      'New chiller in March',
      'Attach the invoice',
      'Duplicate of the site invoice',
    ]);
    expect(events[2].kind).toBe('voided');
    // The void's stored snapshot never leaves the server.
    expect(events[2].changes).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('calculation');
  });

  it('passes an operator\'s `reprice` row through under its own name, with no user and its figure', () => {
    const [event, odd] = buildRecordTrail(
      [
        row('reprice', { before: { tCo2e: 129.6 }, after: { tCo2e: 126 } }, { userId: null, role: null }),
        row('reprice', { before: { tCo2e: 'x' }, after: 7 }, { userId: null, role: null }),
      ],
      lookups,
    );
    expect(event).toMatchObject({ kind: 'other', action: 'reprice', actor: null, submission: null });
    expect(event.changes).toEqual([{ field: 'figure', before: 129.6, after: 126 }]);
    // A shape it does not know shows no change rather than a guess.
    expect(odd.changes).toEqual([]);
  });

  it('names an actor who no longer exists by role only', () => {
    const [event] = buildRecordTrail(
      [row('approve', transition('submitted', 'approved'), { userId: 'u-gone', role: 'consultant' })],
      lookups,
    );
    expect(event.actor).toEqual({ name: null, role: 'consultant' });
  });

  it('reads a role it does not know, or none, as null', () => {
    const events = buildRecordTrail(
      [
        row('create', {}, { role: null }),
        row('update', {}, { role: 'auditor' }),
      ],
      lookups,
    );
    expect(events.map((e) => e.actor?.role)).toEqual([null, null]);
  });

  it('holds a draft that was only created as one event', () => {
    const events = buildRecordTrail([row('create', { after: snapshot() })], lookups);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'created', actor: { name: 'Entry User', role: 'data_entry' } });
  });

  it('returns no user id, no email and no stored content', () => {
    const events = buildRecordTrail(
      [
        row('create', { after: snapshot() }),
        row('update', { before: snapshot(), after: snapshot({ activityValue: 2 }) }),
        row('approve', transition('submitted', 'approved'), reviewer),
      ],
      lookups,
    );
    const json = JSON.stringify(events);
    for (const forbidden of ['u-entry', 'u-review', '@', 'calculation', 'factorId', 'createdBy', 'transition']) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe('buildRecordTrail — the owner review of 52ceb7e8', () => {
  it("gives a submit row written without the reason the author's reason from the last saved snapshot", () => {
    const events = buildRecordTrail(
      [
        row('create', { after: snapshot({ varianceReason: null }) }),
        row('update', { before: snapshot(), after: snapshot({ activityValue: 9000, varianceReason: 'New chiller since March' }) }),
        row('submit', transition('draft', 'submitted')),
        row('recall', transition('submitted', 'draft')),
        row('update', { before: snapshot({ varianceReason: 'New chiller since March' }), after: snapshot({ varianceReason: null, activityValue: 1000 }) }),
        row('submit', transition('draft', 'submitted')),
      ],
      lookups,
    );
    expect(events[2]).toMatchObject({ kind: 'submitted', reason: 'New chiller since March' });
    // Cleared since: the second submit went without one.
    expect(events[5]).toMatchObject({ kind: 'resubmitted', reason: null });
  });

  it('prefers the reason the submit row itself carries', () => {
    const [, event] = buildRecordTrail(
      [
        row('create', { after: snapshot({ varianceReason: 'old' }) }),
        row('submit', transition('draft', 'submitted', { submission: 1, varianceReason: 'as submitted' })),
      ],
      lookups,
    );
    expect(event.reason).toBe('as submitted');
  });

  it('reads the note of a return logged before `reviewNote` existed', () => {
    const [event] = buildRecordTrail(
      [row('update', transition('submitted', 'rejected', { varianceReason: 'The March invoice is missing' }), reviewer)],
      lookups,
    );
    expect(event).toMatchObject({ kind: 'returned', reason: 'The March invoice is missing' });
  });

  it('never numbers a submission lower than its order (a submit made in the deploy window)', () => {
    const events = buildRecordTrail(
      [
        row('submit', transition('draft', 'submitted')),
        row('recall', transition('submitted', 'draft')),
        row('submit', transition('draft', 'submitted', { submission: 1 })),
      ],
      lookups,
    );
    expect(events.map((e) => [e.kind, e.submission])).toEqual([
      ['submitted', 1],
      ['recalled', null],
      ['resubmitted', 2],
    ]);
  });

  it('keeps a list apart from an object with digit keys, and lists an empty list added', () => {
    expect(editChanges(snapshot({ input: { meters: [12] } }), snapshot({ input: { meters: { 0: 12 } } }), lookups)).toEqual([
      { field: 'input.meters.~20', before: null, after: 12 },
      { field: 'input.meters.0', before: 12, after: null },
    ]);
    expect(editChanges(snapshot({ input: { notes: 'x' } }), snapshot({ input: { notes: 'x', meters: [] } }), lookups)).toEqual([
      { field: 'input.meters', before: null, after: '[]' },
    ]);
    // An input absent or empty is still nothing to report.
    expect(editChanges(snapshot({ input: null }), snapshot({ input: {} }), lookups)).toEqual([]);
  });

  it('keeps a key holding a dot apart from a nested key', () => {
    const changes = editChanges(
      snapshot({ input: { 'meter.reading': 12 } }),
      snapshot({ input: { meter: { reading: 12 } } }),
      lookups,
    );
    expect(changes).toEqual([
      { field: 'input.meter.reading', before: null, after: 12 },
      { field: 'input.meter~1reading', before: 12, after: null },
    ]);
  });
});

describe('editChanges — each changed input, before and after', () => {
  it.each([
    ['activityValue', 1000, 1300, 'activityValue'],
    ['activityUnit', 'kWh', 'MWh', 'activityUnit'],
    ['activityType', 'diesel', 'petrol', 'activityType'],
    ['category', 'Fuel', 'Mobile Combustion', 'category'],
    ['reportingYear', 2025, 2026, 'reportingYear'],
    ['reportingPeriod', 'monthly', 'quarterly', 'reportingPeriod'],
    ['periodValue', 'Q1', 'Q3', 'periodValue'],
    ['varianceReason', null, 'New chiller', 'varianceReason'],
    ['locationId', 'loc-a', null, 'location'],
  ] as const)('lists %s when it alone changed', (key, was, now, field) => {
    const changes = editChanges(snapshot({ [key]: was }), snapshot({ [key]: now }), lookups);
    expect(changes.map((c) => c.field)).toEqual([field]);
  });

  it('shows a location it cannot name as empty, never by its id', () => {
    expect(editChanges(snapshot({ locationId: 'loc-gone' }), snapshot({ locationId: 'loc-a' }), lookups)).toEqual([
      { field: 'location', before: null, after: 'Istanbul plant' },
    ]);
  });

  it('never takes an inherited name for a kind', () => {
    const events = buildRecordTrail(
      [
        row('constructor', {}),
        row('toString', {}),
        row('update', transition('draft', 'constructor')),
      ],
      lookups,
    );
    expect(events.map((e) => e.kind)).toEqual(['other', 'other', 'edited']);
    expect(events.map((e) => e.action)).toEqual(['constructor', 'toString', 'update']);
  });

  it('reads an absent scalar input as null, the same as a stored null', () => {
    const before = snapshot();
    delete (before as Record<string, unknown>).varianceReason;
    expect(editChanges(before, snapshot({ varianceReason: null }), lookups)).toEqual([]);
  });

  it('orders equipment lines by number, not as text', () => {
    const lines = (n: number, refill: number) =>
      Array.from({ length: n }, (_, i) => ({ equipmentType: `t${i}`, capacityKg: 1, refillKg: i === 2 || i === 10 ? refill : 0, leakRateChoice: 'default' }));
    const changes = editChanges(
      snapshot({ parameters: { equipment: lines(11, 0) } }),
      snapshot({ parameters: { equipment: lines(11, 5) } }),
      lookups,
    );
    expect(changes.map((c) => c.field)).toEqual(['parameters.equipment.2.refillKg', 'parameters.equipment.10.refillKg']);
  });

  it('lists the activity value and the figure, and nothing else', () => {
    const changes = editChanges(
      snapshot(),
      snapshot({ activityValue: 1200, calculation: calc(0.5304) }),
      lookups,
    );
    expect(changes).toEqual([
      { field: 'activityValue', before: 1000, after: 1200 },
      { field: 'figure', before: 0.442, after: 0.5304 },
    ]);
  });

  it('lists the period and the location together, the location by name', () => {
    const changes = editChanges(
      snapshot({ locationId: 'loc-a', periodValue: 'Q1' }),
      snapshot({ locationId: 'loc-b', periodValue: 'Q2' }),
      lookups,
    );
    expect(changes).toEqual([
      { field: 'periodValue', before: 'Q1', after: 'Q2' },
      { field: 'location', before: 'Istanbul plant', after: 'Izmir depot' },
    ]);
  });

  it('names one equipment line\'s refill, not the other line', () => {
    const line = (refillKg: number, capacityKg: number) => ({
      equipmentType: 'fm200_system',
      capacityKg,
      refillKg,
      leakRateChoice: 'default',
    });
    const changes = editChanges(
      snapshot({ category: 'Refrigerants', parameters: { equipment: [line(0, 20), line(0, 50)] } }),
      snapshot({ category: 'Refrigerants', parameters: { equipment: [line(0, 20), line(35, 50)] } }),
      lookups,
    );
    expect(changes).toEqual([{ field: 'parameters.equipment.1.refillKg', before: 0, after: 35 }]);
  });

  it('lists an invoice number added with an empty value before', () => {
    const changes = editChanges(snapshot({ input: null }), snapshot({ input: { invoice_no: 'INV-2026-031' } }), lookups);
    expect(changes).toEqual([{ field: 'input.invoice_no', before: null, after: 'INV-2026-031' }]);
  });

  it('lists nothing when no listed input or the figure changed', () => {
    const before = snapshot();
    const after = snapshot({
      updatedAt: '2026-11-25T10:00:00.000Z',
      evidenceCount: 3,
      submissionCount: 2,
      status: 'rejected',
      reviewNote: 'x',
      reviewedBy: 'u-review',
      reviewedAt: '2026-11-25T10:00:00.000Z',
      anomalyFlag: true,
      calculation: { ...calc(0.442), factorValue: 0.9, computedAt: 'later' },
    });
    expect(editChanges(before, after, lookups)).toEqual([]);
    const [event] = buildRecordTrail([row('update', { before, after })], lookups);
    expect(event).toMatchObject({ kind: 'edited', changes: [] });
  });

  it('reads a cleared optional block as null after, leaf by leaf', () => {
    const changes = editChanges(
      snapshot({ parameters: { cvBasis: 'net' } }),
      snapshot({ parameters: null }),
      lookups,
    );
    expect(changes).toEqual([{ field: 'parameters.cvBasis', before: 'net', after: null }]);
  });

  it('reports a figure that became uncalculated as null', () => {
    const changes = editChanges(
      snapshot(),
      snapshot({ calculation: { reasonCode: 'no_factor' } }),
      lookups,
    );
    expect(changes).toEqual([{ field: 'figure', before: 0.442, after: null }]);
  });
});
