import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { copyFor, describeFor } from '@/lib/i18n/testing';
import { SUBSIDIARY_BLOCKER_KINDS, type SubsidiaryBlockerCount } from '@/lib/types';
import { blockerLines, deletableNote, locationCountLine, subsidiaryError } from './subsidiaries-view';

const en = copyFor('subsidiaries');
const tr = copyFor('subsidiaries', 'tr');

/** The API's own phrases (SubsidiariesService.describeBlockers), copied here
 *  so the screen's English is held to them word for word. */
const SERVER: Record<string, (n: number) => string> = {
  terminalRecords: (n) =>
    `${n} approved, locked or voided activity record(s) belong to this subsidiary, and deleting it would permanently destroy them along with their evidence. Those records cannot be deleted at any point, so a subsidiary that has reported data stays. Set its status to "inactive" to retire it instead.`,
  frozenBoundaryVersions: (n) =>
    `This subsidiary is declared in ${n} confirmed or captured inventory boundary version(s), which record the inventory a report was issued from and never change, so a subsidiary declared in one stays. Set its status to "inactive" to retire it instead.`,
  reviewRecords: (n) => `${n} record(s) awaiting review`,
  openRecords: (n) => `${n} draft or rejected record(s)`,
  locationsHoldingForeignRecords: (n) => `${n} location(s) holding a record that belongs to another subsidiary`,
  periodLocks: (n) => `${n} closed reporting period(s)`,
  targets: (n) => `${n} reduction target(s)`,
  denominators: (n) => `${n} intensity denominator(s)`,
  openBoundaryVersions: (n) => `${n} open inventory boundary version(s) declaring it`,
};

describe('blockerLines', () => {
  it.each(SUBSIDIARY_BLOCKER_KINDS)('%s: English is the server sentence, word for word', (kind) => {
    const counts: SubsidiaryBlockerCount[] = [{ kind, count: 3 }];
    expect(blockerLines({ blockers: ['ignored'], blockerCounts: counts }, en)).toEqual([SERVER[kind](3)]);
  });

  it('keeps the order the facts came in, and words them in Turkish', () => {
    const summary = {
      blockers: ['x', 'y'],
      blockerCounts: [
        { kind: 'reviewRecords', count: 2 },
        { kind: 'targets', count: 1200 },
      ] satisfies SubsidiaryBlockerCount[],
    };
    expect(blockerLines(summary, tr)).toEqual(['İnceleme bekleyen 2 kayıt', '1.200 azaltım hedefi']);
    expect(blockerLines(summary, en)).toEqual(['2 record(s) awaiting review', '1,200 reduction target(s)']);
  });

  it('falls back to the English sentences when an older API sends no facts', () => {
    expect(blockerLines({ blockers: ['1 reduction target(s)'], blockerCounts: [] }, tr)).toEqual(['1 reduction target(s)']);
    expect(blockerLines({ blockers: ['a'] } as never, tr)).toEqual(['a']);
  });
});

describe('deletableNote', () => {
  it('says what goes with the subsidiary, one or many, in both languages', () => {
    expect(deletableNote(0, en)).toBe('Nothing depends on this subsidiary, so it can be deleted from the register.');
    expect(deletableNote(1, en)).toBe(
      'This subsidiary can be deleted from the register. Its 1 location would go with it, each recorded in the audit log.',
    );
    expect(deletableNote(2, en)).toMatch(/^This subsidiary can be deleted from the register\. Its 2 locations would go/);
    expect(deletableNote(1000, tr)).toMatch(/1\.000 lokasyonu/);
  });
});

describe('locationCountLine', () => {
  it('counts the locations beside the name', () => {
    expect(locationCountLine('Acme', 1, en)).toBe('Acme · 1 location');
    expect(locationCountLine('Acme', 2, en)).toBe('Acme · 2 locations');
    expect(locationCountLine('Acme', 1500, tr)).toBe('Acme · 1.500 lokasyon');
  });
});

describe('subsidiaryError', () => {
  const describeEn = describeFor('en');
  const describeTr = describeFor('tr');

  it("words the page's own statuses, and leaves everything else to the code", () => {
    expect(subsidiaryError(new ApiError('x', 403), en, describeEn)).toEqual({ title: 'You do not have access to this subsidiary.' });
    expect(subsidiaryError(new ApiError('x', 503), en, describeEn)).toEqual({ title: 'The service is unavailable right now.' });
    expect(subsidiaryError(new ApiError('x', 503), tr, describeTr)).toEqual({ title: 'Hizmet şu anda kullanılamıyor.' });
    expect(subsidiaryError(new ApiError('x', 401), en, describeEn)).toEqual({
      title: 'Your session has expired — please sign in again.',
    });
    const inUse = new ApiError('This subsidiary still holds 1 reduction target(s). …', 409, 'subsidiary_in_use');
    expect(subsidiaryError(inUse, en, describeEn)).toEqual({ title: inUse.message });
    expect(subsidiaryError(inUse, tr, describeTr).description).toBe(inUse.message);
  });
});
