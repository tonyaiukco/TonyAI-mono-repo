import { describe, it, expect } from 'vitest';
import { describeMove, hasMovedOffRecord, type RecordIdentity } from './record-identity';
import { NOT_CALCULATED_LABEL } from './calculation-display';

/**
 * These two functions decide whether the next save edits a record or creates
 * one. Both directions have already shipped as bugs — an overwrite when the
 * check was too narrow, a double-counted month when it was too broad — so the
 * assertions below name the defect each clause prevents.
 */

const opened = (over: Partial<RecordIdentity> = {}): RecordIdentity => ({
  category: 'Electricity',
  reportingYear: 2026,
  reportingPeriod: 'monthly',
  periodValue: 'January',
  locationId: '',
  ...over,
});

describe('hasMovedOffRecord', () => {
  it('does NOT treat a location change as a different record', () => {
    // The WP18 defect in one assertion. When this returned true the client
    // dropped `editingId`, the save became a POST, and the write SUCCEEDED —
    // the uniqueness index counts `location_id`, so the whole-company row and
    // the new site row are different keys. Both then feed the emissions total.
    expect(hasMovedOffRecord(opened(), opened({ locationId: 'loc-1' }))).toBe(false);
    // And back the other way — detaching a site record to the whole company.
    expect(
      hasMovedOffRecord(opened({ locationId: 'loc-1' }), opened({ locationId: '' })),
    ).toBe(false);
  });

  it('still treats a category change as a different record', () => {
    // The bug this guard exists for: opening a Fuel draft, switching to
    // Electricity and saving overwrote the Fuel record and reported success.
    expect(hasMovedOffRecord(opened(), opened({ category: 'Fuel' }))).toBe(true);
  });

  it('still catches every other identity field', () => {
    expect(hasMovedOffRecord(opened(), opened({ reportingYear: 2025 }))).toBe(true);
    expect(hasMovedOffRecord(opened(), opened({ reportingPeriod: 'quarterly' }))).toBe(true);
    expect(hasMovedOffRecord(opened(), opened({ periodValue: 'February' }))).toBe(true);
  });

  it('is false for an untouched form', () => {
    expect(hasMovedOffRecord(opened(), opened())).toBe(false);
  });

  it('sees a category change even when the location changed too', () => {
    // Changing both at once must not let the location clause mask the category
    // one — that would be the overwrite bug again, reachable from a deep link
    // that sets several fields in one go.
    expect(
      hasMovedOffRecord(opened(), opened({ category: 'Fuel', locationId: 'loc-1' })),
    ).toBe(true);
  });
});

describe('describeMove', () => {
  const names = new Map([
    ['loc-1', 'Ankara Power Plant'],
    ['loc-2', 'Istanbul HQ'],
  ]);

  it('names both ends of the move, and says the factor is recalculated', () => {
    const notice = describeMove(opened(), { locationId: 'loc-1' }, names, true);
    // The geography claim is not decoration: the location drives which emission
    // factor applies (data_entry_page.md §5.2), so a move can change the stored figure.
    expect(notice).toBe(
      'Saving moves this record from the whole company to Ankara Power Plant. It is not copied — the emission factor is recalculated for its geography.',
    );
  });

  it('describes a detach in the same terms', () => {
    expect(describeMove(opened({ locationId: 'loc-2' }), { locationId: '' }, names, true)).toContain(
      'from Istanbul HQ to the whole company',
    );
  });

  it('does not promise a recalculated factor for a record that has no figure', () => {
    // Keyed on the RECORD's own snapshot, not on its category.
    // `isRecordableWithoutFactor` is a permission — it says Water MAY be
    // recorded without a factor, not that it currently lacks one — so keying on
    // it would keep promising "stays Not calculated" the day a Water factor is
    // seeded and the move really does produce a number.
    const notice = describeMove(
      opened({ category: 'Water' }),
      { locationId: 'loc-1' },
      names,
      false,
    )!;
    expect(notice).toBe(
      `Saving moves this record from the whole company to Ankara Power Plant. It is not copied — and no emission factor resolves for it today, so it stays "${NOT_CALCULATED_LABEL}".`,
    );
  });

  it('promises the recalculation once that same record does have a figure', () => {
    // Same category, opposite snapshot state — the pair that proves the
    // sentence follows the record rather than a category allow-list.
    const notice = describeMove(
      opened({ category: 'Water' }),
      { locationId: 'loc-1' },
      names,
      true,
    )!;
    expect(notice).toContain('the emission factor is recalculated for its geography');
  });

  it('is silent when nothing is being moved', () => {
    expect(describeMove(opened(), { locationId: '' }, names, true)).toBeNull();
    // No record open — the user is creating, not moving.
    expect(describeMove(null, { locationId: 'loc-1' }, names, true)).toBeNull();
  });

  it('does not print a raw id when a site name is unknown', () => {
    // Reachable while the locations list is still loading, or for a site the
    // caller cannot see. A uuid in a sentence reads as a bug.
    const notice = describeMove(opened(), { locationId: 'loc-unknown' }, names, true)!;
    expect(notice).toContain('another site');
    expect(notice).not.toContain('loc-unknown');
  });

  it('renders with exactly one space between every word', () => {
    // The JSX whitespace trap, asserted rather than hoped for: WP17 shipped
    // "12 entries arerecorded" twice from `{expr}` on its own line.
    const notice = describeMove(opened(), { locationId: 'loc-1' }, names, true)!;
    expect(notice).not.toMatch(/\s{2,}/);
    expect(notice.trim()).toBe(notice);
  });
});
