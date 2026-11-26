import type { NodeType } from '@/lib/types';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { copyFor, describeFor } from '@/lib/i18n/testing';
import { SUBSIDIARY_BLOCKER_KINDS, type SubsidiaryBlockerCount } from '@/lib/types';
import { treeFigure, treeRows, parseNaceCode, parseSharePercent, blockerLines, deletableNote, locationCountLine, subsidiaryError } from './subsidiaries-view';

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
  openRecords: (n) => `${n} draft or returned record(s)`,
  locationsHoldingForeignRecords: (n) => `${n} facility(ies) holding a record that belongs to another subsidiary`,
  periodLocks: (n) => `${n} closed reporting period(s)`,
  targets: (n) => `${n} reduction target(s)`,
  denominators: (n) => `${n} intensity denominator(s)`,
  openBoundaryVersions: (n) => `${n} open inventory boundary version(s) declaring it`,
  // inc26-group-tree (RD9): a child node and any facility block.
  children: (n) => `${n} child company node(s)`,
  locations: (n) => `${n} facility(ies)`,
  // inc26-central-reporter-onboarding: shown to an organisation-wide reader only.
  reportedRecords: (n) => `${n} record(s) of other companies naming it as their reporting company`,
  centralReporters: (n) => `${n} central reporter(s) whose main company it is`,
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
  it('says nothing goes with the company: a facility now blocks the delete (inc26-group-tree, RD9)', () => {
    expect(deletableNote(en)).toBe('Nothing depends on this subsidiary, so it can be deleted from the register.');
    expect(deletableNote(tr)).toBe(tr.t('dependents.deletableNothing'));
  });
});


describe('locationCountLine', () => {
  it('counts the locations beside the name', () => {
    expect(locationCountLine('Acme', 1, en)).toBe('Acme · 1 facility');
    expect(locationCountLine('Acme', 2, en)).toBe('Acme · 2 facilities');
    expect(locationCountLine('Acme', 1500, tr)).toBe('Acme · 1.500 tesis');
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

describe('treeRows — the company screen as a tree (inc26-group-tree)', () => {
  const n = (id: string, parentId: string | null, nodeType: NodeType, legalName = id) => ({ id, parentId, nodeType, legalName });
  const TREE = [
    n('C2', 'H', 'company', 'Zeta'),
    n('B', 'A', 'child_company'),
    n('H', null, 'holding'),
    n('A', 'G', 'company', 'Alpha'),
    n('G', 'H', 'sector_group'),
    n('S', 'H', 'sub_holding'),
    n('C1', 'H', 'company', 'Beta'),
  ];
  const shape = (rows: ReturnType<typeof treeRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.node.id}${r.hasChildren ? '+' : ''}`);

  it("walks a chain far deeper than the call stack, in order (owner's third review of WP7, P3)", () => {
    const depth = 50_000;
    const chain = Array.from({ length: depth }, (_, k) => n(`n${k}`, k === 0 ? null : `n${k - 1}`, k === 0 ? 'holding' : 'child_company'));
    const rows = treeRows(chain.reverse());
    expect(rows).toHaveLength(depth);
    expect(rows[0].node.id).toBe('n0');
    expect(rows[depth - 1]).toMatchObject({ depth: depth - 1, hasChildren: false });
    expect(treeRows(chain, new Set(['n0']))).toHaveLength(1);
  });

  it('puts the root first and every node under its parent, siblings by type then name', () => {
    expect(shape(treeRows(TREE))).toEqual(['H+', '  S', '  G+', '    A+', '      B', '  C1', '  C2']);
  });

  it('leaves out the children of a collapsed node, and only those', () => {
    expect(shape(treeRows(TREE, new Set(['G'])))).toEqual(['H+', '  S', '  G+', '  C1', '  C2']);
    expect(shape(treeRows(TREE, new Set(['H'])))).toEqual(['H+']);
  });

  it('shows a node whose parent the reader cannot read at the top level (the API sends null)', () => {
    // A super_admin granted a child company and its child, not the company above.
    expect(shape(treeRows([n('B', null, 'child_company'), n('D', 'B', 'child_company')]))).toEqual(['B+', '  D']);
    // A parent id left in (an older API) but absent from the list: still a top.
    expect(shape(treeRows([n('B', 'A', 'child_company')]))).toEqual(['B']);
  });

  it('terminates on a malformed cycle, each node once', () => {
    const rows = treeRows([n('X', 'Y', 'company'), n('Y', 'X', 'child_company')]);
    expect(rows.map((r) => r.node.id).sort()).toEqual(['X', 'Y']);
  });
});

describe('the share percent and NACE fields (inc26-group-tree)', () => {
  it('reads a share in the user\'s convention, blank as none, and refuses what the API would', () => {
    expect(parseSharePercent('', 'en')).toBeNull();
    expect(parseSharePercent('20', 'en')).toBe(20);
    expect(parseSharePercent('12.5', 'en')).toBe(12.5);
    expect(parseSharePercent('12,5', 'tr')).toBe(12.5);
    for (const bad of ['101', '-1', '12.345', '0.001', '99.999', 'abc']) expect(parseSharePercent(bad, 'en'), bad).toBe('invalid');
  });

  it('reads every share from 0 to 100 with up to two decimals, in both languages', () => {
    const refused: string[] = [];
    for (let hundredths = 0; hundredths <= 10_000; hundredths++) {
      const en = (hundredths / 100).toFixed(2);
      if (parseSharePercent(en, 'en') !== Number(en)) refused.push(en);
      if (parseSharePercent(en.replace('.', ','), 'tr') !== Number(en)) refused.push(`tr ${en}`);
    }
    expect(refused).toEqual([]);
    for (const ok of ['1.1', '2.01', '0.07']) expect(parseSharePercent(ok, 'en'), ok).toBe(Number(ok));
    expect(parseSharePercent('1,1', 'tr')).toBe(1.1);
  });

  it("never shows a positive tonnage as 0 — one decimal from 1 up, three significant digits below (owner's fourth review, P2)", () => {
    expect(treeFigure(0.04, 'en')).toBe('0.04');
    expect(treeFigure(0.00024, 'en')).toBe('0.00024');
    expect(treeFigure(0.04, 'tr')).toBe('0,04');
    expect(treeFigure(0.00024, 'tr')).toBe('0,00024');
    expect(treeFigure(12.345, 'en')).toBe('12.3');
    expect(treeFigure(12345.67, 'tr')).toBe('12.345,7');
    expect(treeFigure(0, 'en')).toBe('0');
  });

  it('reads a NACE code, upper-cased, blank as none', () => {
    expect(parseNaceCode('')).toBeNull();
    expect(parseNaceCode(' c10.11 ')).toBe('C10.11');
    for (const ok of ['C', '10', '10.1', '35.21']) expect(parseNaceCode(ok), ok).toBe(ok);
    for (const bad of ['Z', '1', '10.111', 'C10.11.1', 'hello']) expect(parseNaceCode(bad), bad).toBe('invalid');
  });
});

describe('the central reporting blockers on the panel (inc26-central-reporter-onboarding, task 5.6)', () => {
  it("words both for a masterkey, whose summary carries them, in English and Turkish", () => {
    const summary = {
      blockers: ['x', 'y'],
      blockerCounts: [{ kind: 'reportedRecords', count: 40 }, { kind: 'centralReporters', count: 1 }] satisfies SubsidiaryBlockerCount[],
    };
    expect(blockerLines(summary, en)).toEqual([
      '40 record(s) of other companies naming it as their reporting company',
      '1 central reporter(s) whose main company it is',
    ]);
    expect(blockerLines(summary, tr)).toEqual([
      'Onu raporlayan şirket olarak gösteren, başka şirketlere ait 40 kayıt',
      'Ana şirketi bu şirket olan 1 merkezi raportör',
    ]);
  });

  it('shows nothing to a company-scoped reader, whose summary the API answers without them', () => {
    expect(blockerLines({ blockers: [], blockerCounts: [] }, tr)).toEqual([]);
  });
});
