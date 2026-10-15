import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReportDataset } from '@tonyai/shared-types';
import {
  assertDatasetIdentities, canonicalDatasetContent, canonicalJson, CanonicalJsonError,
  REPORT_DATASET_CANONICALIZATION, reportDatasetFingerprint,
} from './dataset-fingerprint';

/**
 * `tonyai-report-dataset-v1` (README, "Fingerprint encoding"): what the
 * canonical form accepts, refuses and how it orders — each rule its own case.
 */

const refuses = (value: unknown, problem: RegExp) => {
  expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  expect(() => canonicalJson(value)).toThrow(problem);
};

describe('canonicalJson — values', () => {
  it('spells scalars as JSON.stringify does, with -0 as 0', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalJson('a"b\\c\n ')).toBe(JSON.stringify('a"b\\c\n '));
  });

  it('never normalises Unicode: composed and decomposed é differ', () => {
    expect(canonicalJson('é')).not.toBe(canonicalJson('é'));
  });

  it('refuses non-finite numbers', () => {
    refuses(Number.NaN, /non-finite/);
    refuses(Number.POSITIVE_INFINITY, /non-finite/);
    refuses({ a: Number.NEGATIVE_INFINITY }, /\$\.a: a non-finite/);
  });

  it('refuses values JSON cannot hold', () => {
    refuses(undefined, /undefined is not JSON/);
    refuses(10n, /bigint is not JSON/);
    refuses(() => 1, /function is not JSON/);
    refuses(Symbol('s'), /symbol is not JSON/);
  });
});

describe('canonicalJson — objects', () => {
  it('sorts keys by UTF-16 code units, not code points or locale', () => {
    // U+10000 is the surrogate pair D800 DC00, which sorts before U+FFFF in code units.
    expect(canonicalJson({ '￿': 1, '\u{10000}': 2, b: 3, B: 4, a: 5 }))
      .toBe('{"B":4,"a":5,"b":3,"\u{10000}":2,"￿":1}');
  });

  it('spells a null-prototype object as the plain one', () => {
    const bare = Object.assign(Object.create(null) as object, { b: 1, a: [2] });
    expect(canonicalJson(bare)).toBe(canonicalJson({ a: [2], b: 1 }));
  });

  it('keeps null distinct from omission and refuses a present undefined', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({})).toBe('{}');
    refuses({ a: undefined }, /\$\.a: undefined/);
  });

  it('refuses a Date, Buffer, class instance or Decimal-like object', () => {
    refuses({ at: new Date(0) }, /not a plain object/);
    refuses(Buffer.from('x'), /not a plain object/);
    class Decimal { constructor(readonly v: string) {} }
    refuses(new Decimal('1.0'), /not a plain object/);
    refuses(new Map(), /not a plain object/);
  });

  it('refuses accessors, symbol and non-enumerable properties', () => {
    refuses(Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }), /\$\.a: an accessor/);
    refuses({ [Symbol('s')]: 1 }, /symbol property/);
    refuses(Object.defineProperty({}, 'a', { value: 1, enumerable: false }), /non-enumerable/);
  });

  it('refuses a custom toJSON, own or inherited', () => {
    refuses({ toJSON: () => ({}) }, /custom toJSON/);
    const proto = Object.create(null) as { toJSON?: unknown };
    proto.toJSON = () => 1;
    refuses(Object.create(proto) as object, /not a plain object/);
  });

  it('refuses a cycle but accepts a shared reference', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    refuses(cyclic, /a cycle/);
  });
});

describe('canonicalJson — arrays', () => {
  it('sorts members as a set by their canonical strings and keeps multiplicity', () => {
    expect(canonicalJson([3, 'b', 1, { z: 1, a: 2 }, 1, 'a', null]))
      .toBe('["a","b",1,1,3,null,{"a":2,"z":1}]');
  });

  it('sorts nested arrays recursively', () => {
    expect(canonicalJson([[2, 1], [1, 0]])).toBe('[[0,1],[1,2]]');
  });

  it('refuses holes, undefined elements and extra properties', () => {
    // eslint-disable-next-line no-sparse-arrays
    refuses([1, , 3], /\$\[1\]: a hole|a hole or a property/);
    refuses([1, undefined], /\$\[1\]: undefined/);
    refuses(Object.assign([1], { extra: true }), /a hole or a property other than its elements/);
    refuses(Object.assign([1], { [Symbol('s')]: 1 }), /symbol property/);
  });

  it('refuses an index accessor and an array subclass', () => {
    const withGetter = [1, 2];
    Object.defineProperty(withGetter, 1, { get: () => 2, enumerable: true });
    refuses(withGetter, /\$\[1\]: an accessor/);
    class Tuple extends Array<number> {}
    refuses(Tuple.from([1]), /not a plain array/);
  });
});

/** A minimal dataset, shaped as the contract's, for the identity rules. */
function dataset(): Omit<ReportDataset, 'fingerprint'> {
  const entity = {
    subsidiaryId: 's1', subsidiaryName: 'S1', locationId: null, locationName: null,
    geographyCode: 'GB', firstMonth: 1 as const, lastMonth: 12 as const,
  };
  return {
    schemaVersion: 1,
    datasetId: 'd1',
    capturedAt: '2026-10-15T00:00:00.000Z',
    organisationId: 'o1',
    organisationName: 'Org',
    context: { reportingYear: 2026, scope: null, category: null, subsidiaryId: null, locationId: null } as unknown as ReportDataset['context'],
    selection: 'inventory',
    resolvedSubsidiaryIds: ['s1'],
    boundary: {
      id: 'b1', version: 1, organisationId: 'o1', reportingYear: 2026, subsidiaryIds: ['s1'],
      decision: 'confirmed', decidedBy: 'u1', decidedAt: '2026-10-01T00:00:00.000Z',
      entities: [entity],
      applicability: [{ subsidiaryId: 's1', locationId: null, category: 'Electricity', applicability: 'included', sourceIds: ['src1'] }],
      attribution: [{ subsidiaryId: 's1', category: 'Electricity', level: 'company', reportingPeriod: 'annual' }],
      sources: [{
        id: 'src1', name: 'Meter', entity, scope: 2, mapping: { kind: 'mapped', category: 'Electricity', activityType: null },
        applicability: 'included', reportingPeriod: 'annual', evidenceReportingPeriod: null,
        obligations: [{ id: 'ob1', reportingPeriod: 'annual', periodValue: 'Annual', firstMonth: 1, lastMonth: 12, evidencePeriods: [] }],
      }],
    },
    records: [],
    evidence: [],
    periodLocks: [],
    review: { approvedRecordIds: [], unapprovedRecordIds: [], voidedRecordIds: [] },
    coverage: {
      obligations: [{ obligationId: 'ob1', state: 'missing', recordIds: [], evidencePeriods: [] }],
      excludedSourceIds: [],
      gaps: [{ code: 'missing_record', sourceIds: ['src1'], obligationIds: ['ob1'], recordIds: [] }],
    },
    provenance: { records: [], releases: [] },
    scopes: [
      { scope: 1, coverage: 'covered', tCo2e: null, countedRecordIds: [] },
      { scope: 2, coverage: 'partial', tCo2e: null, countedRecordIds: [] },
      { scope: 3, coverage: 'not_covered' },
    ],
  };
}

describe('reportDatasetFingerprint', () => {
  it('hashes the canonical content without the identity members, as lowercase hex', () => {
    const d = dataset();
    const { datasetId: _id, capturedAt: _at, ...content } = d;
    const expected = createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
    expect(reportDatasetFingerprint(d)).toEqual({
      algorithm: 'sha256', canonicalization: REPORT_DATASET_CANONICALIZATION, hex: expected,
    });
    expect(reportDatasetFingerprint(d).hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for another capture of the same facts, in any order', () => {
    const a = dataset();
    const b = { ...dataset(), datasetId: 'd2', capturedAt: '2027-01-01T00:00:00.000Z' };
    b.scopes = [b.scopes[2], b.scopes[0], b.scopes[1]] as unknown as typeof b.scopes;
    const withFingerprint = { ...a, fingerprint: reportDatasetFingerprint(a) };
    expect(reportDatasetFingerprint(b)).toEqual(reportDatasetFingerprint(a));
    expect(reportDatasetFingerprint(withFingerprint)).toEqual(reportDatasetFingerprint(a));
  });

  it('changes with any fact — a name, an actor, a nested month', () => {
    const base = reportDatasetFingerprint(dataset()).hex;
    const renamed = dataset();
    renamed.organisationName = 'Org ';
    const decided = dataset();
    decided.boundary = { ...decided.boundary, decidedBy: 'u2' };
    const month = dataset();
    (month.boundary.sources[0].obligations as unknown as Array<{ lastMonth: number }>)[0].lastMonth = 11;
    for (const changed of [renamed, decided, month]) {
      expect(reportDatasetFingerprint(changed).hex).not.toBe(base);
    }
  });

  it('refuses a dataset that is not canonical JSON — a Date left in', () => {
    const d = dataset() as unknown as Record<string, unknown>;
    d.organisationName = new Date(0);
    expect(() => canonicalDatasetContent(d as never)).toThrow(/\$\.organisationName: not a plain object/);
  });
});

describe('assertDatasetIdentities', () => {
  it('admits the minimal dataset', () => {
    expect(() => assertDatasetIdentities(dataset())).not.toThrow();
  });

  const cases: Array<[string, (d: ReturnType<typeof dataset>) => void, RegExp]> = [
    ['a duplicate record id', (d) => { d.records = [{ id: 'r' }, { id: 'r' }] as never; }, /\$\.records: a duplicate identity r/],
    ['a duplicate evidence id', (d) => { d.evidence = [{ id: 'e', recordIds: [] }, { id: 'e', recordIds: [] }] as never; }, /\$\.evidence/],
    ['a duplicate release id', (d) => { d.provenance = { records: [], releases: [{ id: 'x' }, { id: 'x' }] as never }; }, /\$\.provenance\.releases/],
    ['a duplicate source id', (d) => { d.boundary.sources = [d.boundary.sources[0], d.boundary.sources[0]]; }, /\$\.boundary\.sources: /],
    ['a duplicate entity key', (d) => { d.boundary.entities = [d.boundary.entities[0], { ...d.boundary.entities[0], subsidiaryName: 'other' }]; }, /\$\.boundary\.entities/],
    ['a duplicate attribution key', (d) => { d.boundary.attribution = [d.boundary.attribution[0], { ...d.boundary.attribution[0], level: 'sites' }]; }, /\$\.boundary\.attribution/],
    ['a duplicate applicability key', (d) => { d.boundary.applicability = [d.boundary.applicability[0], { subsidiaryId: 's1', locationId: null, category: 'Electricity', applicability: 'excluded', reason: 'x' }]; }, /\$\.boundary\.applicability/],
    ['an obligation id repeated across two sources', (d) => {
      const other = { ...d.boundary.sources[0], id: 'src2' };
      d.boundary.sources = [d.boundary.sources[0], other];
    }, /\$\.boundary\.sources\[\]\.obligations: a duplicate identity ob1/],
    ['a repeated id in a reference list', (d) => { d.coverage = { ...d.coverage, gaps: [{ ...d.coverage.gaps[0], obligationIds: ['ob1', 'ob1'] }] }; }, /\$\.coverage\.gaps\[0\]\.obligationIds/],
    ['a repeated resolved subsidiary', (d) => { d.resolvedSubsidiaryIds = ['s1', 's1']; }, /\$\.resolvedSubsidiaryIds/],
  ];
  it.each(cases)('refuses %s', (_name, mutate, problem) => {
    const d = dataset();
    mutate(d);
    expect(() => assertDatasetIdentities(d)).toThrow(problem);
    expect(() => reportDatasetFingerprint(d)).toThrow(CanonicalJsonError);
  });

  it('distinguishes a company entity from a site whose id spells null', () => {
    const d = dataset();
    d.boundary.entities = [d.boundary.entities[0], { ...d.boundary.entities[0], locationId: 'null' }];
    expect(() => assertDatasetIdentities(d)).not.toThrow();
  });

  it("leaves a record's calculation snapshot unsearched", () => {
    const d = dataset();
    d.records = [{ id: 'r', calculation: { factorIds: ['f', 'f'] } }] as never;
    expect(() => assertDatasetIdentities(d)).not.toThrow();
  });
});
