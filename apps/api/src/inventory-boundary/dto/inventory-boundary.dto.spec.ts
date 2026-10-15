// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_REASON_MAX_LENGTH,
  INVENTORY_SOURCE_NAME_MAX_LENGTH,
  type PutInventoryBoundarySubsidiaryRequest,
} from '@tonyai/shared-types';
import {
  CreateInventoryBoundaryDto,
  INVENTORY_DECLARATION_LIMITS,
  ListInventoryBoundariesQueryDto,
  PutInventoryBoundarySubsidiaryDto,
} from './inventory-boundary.dto';

/** The options `main.ts` installs on the global ValidationPipe. */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

// Letters in every id, so upper-casing one really changes its spelling.
const SITE = 'abcdef33-3333-4333-8333-33333333000a';
const OTHER_SITE = 'abcdef33-3333-4333-8333-33333333000b';
const NIL = '00000000-0000-0000-0000-000000000000';
// Invisible characters built from their code points, so the source shows them.
const NUL = String.fromCharCode(0x0000);
const BEL = String.fromCharCode(0x0007);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
/** Combining acute: `e` + it is "é" decomposed, which is not NFC. */
const ACUTE = String.fromCharCode(0x0301);

/** Every sentence the pipe would send, nested ones included, as `path: sentence`. */
function sentences(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    return [
      ...Object.values(e.constraints ?? {}).map((m) => `${path}: ${m}`),
      ...sentences(e.children ?? [], path),
    ];
  });
}

function check<T extends object>(Dto: ClassConstructor<T>, body: unknown): string[] {
  return sentences(validateSync(plainToInstance(Dto, body) as object, PIPE_OPTIONS));
}

/** A complete valid declaration: a company entity and one July–December site. */
function valid(): PutInventoryBoundarySubsidiaryRequest & Record<string, unknown> {
  return {
    firstMonth: 1, lastMonth: 12,
    sites: [{ locationId: SITE, firstMonth: 7, lastMonth: 12 }],
    attribution: [
      { category: 'Electricity', level: 'company', reportingPeriod: 'monthly' },
      { category: 'Fuel', level: 'sites', reportingPeriod: 'quarterly' },
      { category: 'Mobile Combustion', level: 'sites', reportingPeriod: 'annual' },
    ],
    applicability: [
      { locationId: null, category: 'Electricity', applicability: 'included' },
      { locationId: SITE, category: 'Fuel', applicability: 'included' },
      { locationId: SITE, category: 'Mobile Combustion', applicability: 'excluded', reason: 'No fleet operates at this site.' },
    ],
    sources: [
      { locationId: null, name: 'Purchased electricity', mapping: { kind: 'mapped', category: 'Electricity', activityType: null },
        applicability: 'included', evidenceReportingPeriod: 'monthly' },
      { locationId: SITE, name: 'Generator', mapping: { kind: 'mapped', category: 'Fuel', activityType: 'diesel' },
        applicability: 'included', evidenceReportingPeriod: null },
      // A named exclusion may share an included meter's key (D05; PR B's (4)).
      { locationId: SITE, name: 'Spare generator', mapping: { kind: 'mapped', category: 'Fuel', activityType: 'diesel' },
        applicability: 'excluded', reason: 'Decommissioned in 2025.' },
      { locationId: null, name: 'Purchased heat', mapping: { kind: 'unsupported', reason: 'No mapped source form yet.' },
        scope: 2, applicability: 'included', reportingPeriod: 'annual', evidenceReportingPeriod: null },
      { locationId: null, name: 'Process emissions', mapping: { kind: 'unsupported', reason: 'Not a pilot source.' },
        scope: 1, applicability: 'undetermined', reason: 'Awaiting the source list.' },
    ],
  };
}

type Body = ReturnType<typeof valid>;
const put = (edit: (b: Body) => void): string[] => {
  const body = valid();
  edit(body);
  return check(PutInventoryBoundarySubsidiaryDto, body);
};
const sources = (b: Body) => b.sources as unknown as Record<string, unknown>[];
const cells = (b: Body) => b.applicability as unknown as Record<string, unknown>[];
const sites = (b: Body) => b.sites as unknown as Record<string, unknown>[];
const policies = (b: Body) => b.attribution as unknown as Record<string, unknown>[];

describe('PutInventoryBoundarySubsidiaryDto — the whole declaration of one subsidiary (E1)', () => {
  it('accepts a complete declaration', () => {
    expect(put(() => {})).toEqual([]);
  });

  it('accepts an empty declaration — gaps are reported, not refused', () => {
    expect(put((b) => { b.sites = []; b.attribution = []; b.applicability = []; b.sources = []; })).toEqual([]);
  });

  it('refuses a key it does not know, at every level — the actor and the ids are the API\'s', () => {
    expect(put((b) => { b.createdBy = 'someone'; }).join()).toMatch(/createdBy/);
    expect(put((b) => { b.subsidiaryId = SITE; }).join()).toMatch(/subsidiaryId/);
    expect(put((b) => { sites(b)[0].subsidiaryId = SITE; }).join()).toMatch(/subsidiaryId/);
    expect(put((b) => { policies(b)[0].subsidiaryId = SITE; }).join()).toMatch(/subsidiaryId/);
    expect(put((b) => { sources(b)[0].id = SITE; }).join()).toMatch(/\bid\b/);
    expect(put((b) => { sources(b)[0].obligations = []; }).join()).toMatch(/obligations/);
    expect(put((b) => { cells(b)[0].sourceIds = []; }).join()).toMatch(/sourceIds/);
    expect(put((b) => { (sources(b)[0].mapping as Record<string, unknown>).scope = 2; }).join()).toMatch(/scope/);
  });

  it('refuses a missing list rather than reading it as empty', () => {
    for (const key of ['sites', 'attribution', 'applicability', 'sources'] as const) {
      expect(put((b) => { delete (b as Record<string, unknown>)[key]; }).join(), key).toMatch(new RegExp(`${key}: ${key} must be an array`));
    }
  });

  describe('months', () => {
    it.each([0, 13, 1.5, '1', null])('refuses %s as a month, in every month field', (month) => {
      expect(put((b) => { (b as Record<string, unknown>).firstMonth = month; }).join()).toMatch(/firstMonth: firstMonth/);
      expect(put((b) => { (b as Record<string, unknown>).lastMonth = month; }).join()).toMatch(/lastMonth: lastMonth/);
      expect(put((b) => { sites(b)[0].firstMonth = month; }).join()).toMatch(/sites\.0\.firstMonth: firstMonth/);
      expect(put((b) => { sites(b)[0].lastMonth = month; }).join()).toMatch(/sites\.0\.lastMonth: lastMonth/);
    });

    it('accepts a one-month interval', () => {
      expect(put((b) => { b.firstMonth = 7; b.lastMonth = 7; sites(b)[0].lastMonth = 7; })).toEqual([]);
      expect(put((b) => { sites(b)[0].firstMonth = 9; sites(b)[0].lastMonth = 9; })).toEqual([]);
    });

    it('refuses an interval that ends before it starts', () => {
      expect(put((b) => { b.firstMonth = 6; b.lastMonth = 5; sites(b)[0].firstMonth = 6; sites(b)[0].lastMonth = 6; }).join())
        .toMatch(/lastMonth must not precede firstMonth/);
      expect(put((b) => { sites(b)[0].firstMonth = 9; sites(b)[0].lastMonth = 8; }).join())
        .toMatch(/sites\[0\]: lastMonth must not precede firstMonth/);
    });

    it("keeps a site inside its subsidiary's months (Decisions 2026-10-15 (third) (5))", () => {
      expect(put((b) => { b.firstMonth = 8; }).join()).toMatch(/sites\[0\] .*outside the subsidiary's months/);
      expect(put((b) => { b.firstMonth = 7; b.lastMonth = 11; }).join()).toMatch(/sites\[0\] .*outside the subsidiary's months/);
      expect(put((b) => { b.firstMonth = 7; })).toEqual([]);
    });
  });

  describe('sites', () => {
    it('refuses an id that is not one, and the nil uuid — the company entity\'s key', () => {
      expect(put((b) => { sites(b)[0].locationId = 'site'; }).join()).toMatch(/locationId/);
      expect(put((b) => { sites(b)[0].locationId = NIL; }).join()).toMatch(/locationId/);
      expect(put((b) => { sites(b)[0].locationId = null; }).join()).toMatch(/locationId/);
    });

    it('refuses a site declared twice, whatever the spelling of its id', () => {
      expect(put((b) => { b.sites = [...b.sites, { locationId: SITE.toUpperCase(), firstMonth: 7, lastMonth: 12 }]; }).join())
        .toMatch(/sites\[1\] .*declared twice/);
    });

    it('reads an id in either case as the same site, and hands the service the lowercase one', () => {
      expect(SITE.toUpperCase()).not.toBe(SITE);
      expect(put((b) => { sites(b)[0].locationId = SITE.toUpperCase(); })).toEqual([]);
      const body = valid();
      sites(body)[0].locationId = SITE.toUpperCase();
      cells(body)[1].locationId = SITE.toUpperCase();
      sources(body)[1].locationId = SITE.toUpperCase();
      const dto = plainToInstance(PutInventoryBoundarySubsidiaryDto, body);
      expect([dto.sites[0].locationId, dto.applicability[1].locationId, dto.sources[1].locationId]).toEqual([SITE, SITE, SITE]);
    });
  });

  describe('attribution (D11)', () => {
    it('refuses a category outside Scope 1/2, a level or a cadence it does not know', () => {
      expect(put((b) => { policies(b)[0].category = 'Water'; }).join()).toMatch(/category/);
      expect(put((b) => { policies(b)[0].level = 'site'; }).join()).toMatch(/level/);
      expect(put((b) => { policies(b)[0].reportingPeriod = 'weekly'; }).join()).toMatch(/reportingPeriod/);
    });

    it('refuses two policies for one category', () => {
      expect(put((b) => { b.attribution = [...b.attribution, { category: 'Fuel', level: 'company', reportingPeriod: 'annual' }]; }).join())
        .toMatch(/attribution\[3\] .*declared twice/);
    });
  });

  describe('applicability (D12)', () => {
    it('refuses a category outside Scope 1/2, or none', () => {
      expect(put((b) => { cells(b)[0].category = 'Water'; }).join()).toMatch(/applicability\.0\.category/);
      expect(put((b) => { delete cells(b)[0].category; }).join()).toMatch(/applicability\.0\.category/);
    });

    it('takes one category at two entities — the D12 matrix', () => {
      expect(put((b) => { b.applicability = [...b.applicability, { locationId: null, category: 'Fuel', applicability: 'excluded', reason: 'Sites only.' }]; }))
        .toEqual([]);
    });

    it('refuses a cell with no location at all — null is the company entity, absent is not', () => {
      expect(put((b) => { delete cells(b)[1].locationId; }).join()).toMatch(/applicability\.1\.locationId/);
    });

    it('refuses a cell declared twice for one entity and category', () => {
      expect(put((b) => { b.applicability = [...b.applicability, { locationId: SITE.toUpperCase(), category: 'Fuel', applicability: 'undetermined', reason: 'Unsure.' }]; }).join())
        .toMatch(/applicability\[3\] .*declared twice/);
    });

    it('refuses a cell at a site this declaration does not hold', () => {
      expect(put((b) => { cells(b)[1].locationId = OTHER_SITE; }).join()).toMatch(/applicability\[1\] .*not a declared site/);
      expect(put((b) => { cells(b)[1].locationId = NIL; }).join()).toMatch(/locationId/);
    });

    it('ties a reason to every decision but inclusion', () => {
      expect(put((b) => { cells(b)[0].reason = 'Why'; }).join()).toMatch(/applicability\[0\] .*must carry no reason/);
      expect(put((b) => { delete cells(b)[2].reason; }).join()).toMatch(/applicability\[2\] .*must name its reason/);
      expect(put((b) => { cells(b)[2].reason = null; }).join()).toMatch(/applicability\[2\] .*must name its reason/);
      expect(put((b) => { cells(b)[0].applicability = 'undetermined'; }).join()).toMatch(/applicability\[0\] .*must name its reason/);
      expect(put((b) => { cells(b)[0].applicability = 'unknown'; }).join()).toMatch(/applicability/);
    });

    it("holds a reason to the database's free-text rule", () => {
      for (const reason of ['', '   ', ' edge', 'edge ', `a${NUL}b`, `bidi${RLO}flip`, `zero${ZWSP}width`, `e${ACUTE}`, 'x'.repeat(INVENTORY_REASON_MAX_LENGTH + 1), 7]) {
        expect(put((b) => { cells(b)[2].reason = reason; }).join(), JSON.stringify(reason)).toMatch(/reason/);
      }
      expect(put((b) => { cells(b)[2].reason = 'x'.repeat(INVENTORY_REASON_MAX_LENGTH); })).toEqual([]);
      expect(put((b) => { cells(b)[2].reason = 'été — İstanbul şubesi'; })).toEqual([]);
    });
  });

  describe('sources (D05)', () => {
    it("holds a name to the database's free-text rule", () => {
      for (const name of ['', ' x', `a${BEL}b`, `e${ACUTE}`, 'x'.repeat(INVENTORY_SOURCE_NAME_MAX_LENGTH + 1), null]) {
        expect(put((b) => { sources(b)[0].name = name; }).join(), JSON.stringify(name)).toMatch(/name/);
      }
      expect(put((b) => { sources(b)[0].name = 'x'.repeat(INVENTORY_SOURCE_NAME_MAX_LENGTH); })).toEqual([]);
    });

    it('refuses a source at a site this declaration does not hold, or with no location at all', () => {
      expect(put((b) => { sources(b)[1].locationId = OTHER_SITE; }).join()).toMatch(/sources\[1\] .*not a declared site/);
      expect(put((b) => { delete sources(b)[1].locationId; }).join()).toMatch(/sources\.1\.locationId/);
    });

    it('refuses a decision it does not know, or none', () => {
      expect(put((b) => { sources(b)[0].applicability = 'unknown'; }).join()).toMatch(/sources\.0\.applicability/);
      expect(put((b) => { delete sources(b)[0].applicability; }).join()).toMatch(/sources\.0\.applicability/);
    });

    it("holds a reason to the database's free-text rule", () => {
      for (const reason of [' padded', `a${NUL}b`, 'x'.repeat(INVENTORY_REASON_MAX_LENGTH + 1), 7]) {
        expect(put((b) => { sources(b)[2].reason = reason; }).join(), JSON.stringify(reason)).toMatch(/sources\.2\.reason/);
      }
    });

    it('refuses a source with no mapping', () => {
      expect(put((b) => { delete sources(b)[0].mapping; }).join()).toMatch(/sources\.0\.mapping/);
      expect(put((b) => { sources(b)[0].mapping = 'mapped'; }).join()).toMatch(/sources\.0\.mapping/);
    });

    it('gives a mapped source its category', () => {
      expect(put((b) => { delete (sources(b)[0].mapping as Record<string, unknown>).category; }).join()).toMatch(/sources\[0\] must name its category when mapped/);
      expect(put((b) => { (sources(b)[0].mapping as Record<string, unknown>).category = null; }).join()).toMatch(/sources\[0\] must name its category when mapped/);
    });

    it("names one of a typed category's own activity types, and none for an untyped one (21; PR B (6))", () => {
      const mapping = (b: Body, i: number) => sources(b)[i].mapping as Record<string, unknown>;
      expect(put((b) => { mapping(b, 1).activityType = null; }).join()).toMatch(/sources\[1\] .*activity type/);
      expect(put((b) => { delete mapping(b, 1).activityType; }).join()).toMatch(/sources\[1\] .*activity type/);
      expect(put((b) => { mapping(b, 1).activityType = 'petrol'; }).join()).toMatch(/sources\[1\] .*activity type/);
      expect(put((b) => { mapping(b, 0).activityType = 'diesel'; }).join()).toMatch(/sources\[0\] .*activity type/);
      expect(put((b) => { mapping(b, 1).activityType = 'gas_oil'; })).toEqual([]);
    });

    it('maps only to a Scope 1/2 category', () => {
      expect(put((b) => { (sources(b)[0].mapping as Record<string, unknown>).category = 'Water'; }).join()).toMatch(/category/);
      expect(put((b) => { (sources(b)[0].mapping as Record<string, unknown>).kind = 'guessed'; }).join()).toMatch(/kind/);
    });

    it('sends no scope or cadence for a mapped source — both are derived', () => {
      expect(put((b) => { sources(b)[0].scope = 2; }).join()).toMatch(/sources\[0\] .*scope/);
      expect(put((b) => { sources(b)[0].reportingPeriod = 'monthly'; }).join()).toMatch(/sources\[0\] .*cadence/);
    });

    it('gives an unsupported source a reason and a declared scope, and no category or type', () => {
      const mapping = (b: Body) => sources(b)[3].mapping as Record<string, unknown>;
      expect(put((b) => { delete mapping(b).reason; }).join()).toMatch(/sources\[3\] .*reason/);
      expect(put((b) => { mapping(b).reason = ' padded'; }).join()).toMatch(/reason/);
      expect(put((b) => { mapping(b).category = 'Electricity'; }).join()).toMatch(/sources\[3\] .*category/);
      expect(put((b) => { mapping(b).activityType = null; }).join()).toMatch(/sources\[3\] .*activity type/);
      expect(put((b) => { mapping(b).reason = null; }).join()).toMatch(/sources\[3\] must name why it is unsupported/);
      expect(put((b) => { delete sources(b)[3].scope; }).join()).toMatch(/sources\[3\] .*scope/);
      expect(put((b) => { sources(b)[3].scope = null; }).join()).toMatch(/sources\[3\] must declare its scope/);
      expect(put((b) => { sources(b)[3].scope = 3; }).join()).toMatch(/scope/);
      expect(put((b) => { (sources(b)[0].mapping as Record<string, unknown>).reason = 'x'; }).join()).toMatch(/sources\[0\] .*reason/);
    });

    it('gives an included unsupported source its cadence, and no other source one', () => {
      expect(put((b) => { delete sources(b)[3].reportingPeriod; }).join()).toMatch(/sources\[3\] .*cadence/);
      expect(put((b) => { sources(b)[3].reportingPeriod = null; }).join()).toMatch(/sources\[3\] must declare its cadence when included/);
      expect(put((b) => { sources(b)[4].reportingPeriod = 'annual'; }).join()).toMatch(/sources\[4\] .*cadence/);
      expect(put((b) => { sources(b)[3].reportingPeriod = 'weekly'; }).join()).toMatch(/reportingPeriod/);
    });

    it('ties a reason and an evidence cadence to the decision', () => {
      expect(put((b) => { sources(b)[0].reason = 'x'; }).join()).toMatch(/sources\[0\] .*must carry no reason/);
      expect(put((b) => { delete sources(b)[2].reason; }).join()).toMatch(/sources\[2\] .*must name its reason/);
      expect(put((b) => { sources(b)[2].reason = null; }).join()).toMatch(/sources\[2\] .*must name its reason/);
      expect(put((b) => { delete sources(b)[4].reason; }).join()).toMatch(/sources\[4\] .*must name its reason/);
      expect(put((b) => { delete sources(b)[0].evidenceReportingPeriod; }).join()).toMatch(/sources\[0\] .*evidence cadence/);
      expect(put((b) => { sources(b)[2].evidenceReportingPeriod = 'monthly'; }).join()).toMatch(/sources\[2\] .*evidence cadence/);
      expect(put((b) => { sources(b)[2].evidenceReportingPeriod = null; }).join()).toMatch(/sources\[2\] .*evidence cadence/);
      expect(put((b) => { sources(b)[0].evidenceReportingPeriod = 'weekly'; }).join()).toMatch(/evidenceReportingPeriod/);
    });

    it("gives an included mapped source its category's policy first (Decisions 2026-10-15 (third) (7))", () => {
      expect(put((b) => { b.attribution = b.attribution.filter((p) => p.category !== 'Fuel'); }).join())
        .toMatch(/sources\[1\] .*no attribution policy for Fuel/);
      // An excluded mapped source has no cadence, so it needs no policy.
      expect(put((b) => { b.attribution = b.attribution.filter((p) => p.category !== 'Mobile Combustion'); b.sources = [...b.sources,
        { locationId: SITE, name: 'Van', mapping: { kind: 'mapped', category: 'Mobile Combustion', activityType: 'diesel' }, applicability: 'excluded', reason: 'Sold.' }]; }))
        .toEqual([]);
    });

    it('refuses two included mapped sources on one key — a typed one, and an untyped one (PR B (4))', () => {
      expect(put((b) => { b.sources = [...b.sources, { ...b.sources[1], name: 'Second generator', locationId: SITE.toUpperCase() } as never]; }).join())
        .toMatch(/sources\[5\] .*same entity, category and activity type/);
      expect(put((b) => { b.sources = [...b.sources, { ...b.sources[0], name: 'Second meter' }]; }).join())
        .toMatch(/sources\[5\] .*same entity, category and activity type/);
      // Another type, another entity or another category is another key.
      expect(put((b) => { b.sources = [...b.sources, { ...b.sources[1], name: 'Boiler', mapping: { kind: 'mapped', category: 'Fuel', activityType: 'gas_oil' } } as never]; }))
        .toEqual([]);
      expect(put((b) => {
        b.sites = [...b.sites, { locationId: OTHER_SITE, firstMonth: 1, lastMonth: 12 }];
        b.sources = [...b.sources, { ...b.sources[1], name: 'Other generator', locationId: OTHER_SITE } as never];
      })).toEqual([]);
      expect(put((b) => { b.sources = [...b.sources, { ...b.sources[1], name: 'Van', mapping: { kind: 'mapped', category: 'Mobile Combustion', activityType: 'diesel' } } as never]; }))
        .toEqual([]);
    });
  });

  it('bounds every list', () => {
    const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
    expect(put((b) => { b.sites = many(INVENTORY_DECLARATION_LIMITS.sites + 1, (i) => ({ locationId: `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`, firstMonth: 1, lastMonth: 12 })); }).join())
      .toMatch(/sites must contain no more than/);
    expect(put((b) => { b.sources = many(INVENTORY_DECLARATION_LIMITS.sources + 1, () => b.sources[4]); }).join())
      .toMatch(/sources must contain no more than/);
    expect(put((b) => { b.applicability = many(INVENTORY_DECLARATION_LIMITS.applicability + 1, () => b.applicability[0]); }).join())
      .toMatch(/applicability must contain no more than/);
    expect(put((b) => { b.attribution = many(INVENTORY_DECLARATION_LIMITS.attribution + 1, () => b.attribution[0]); }).join())
      .toMatch(/attribution must contain no more than/);
  });

  it('accepts every list at exactly its bound', () => {
    const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
    const bound = /must contain no more than/;
    expect(put((b) => { b.sites = many(INVENTORY_DECLARATION_LIMITS.sites, (i) => ({ locationId: `abcdef33-3333-4333-8333-${String(i).padStart(12, '0')}`, firstMonth: 1, lastMonth: 12 })); }).join()).not.toMatch(bound);
    expect(put((b) => { b.sources = many(INVENTORY_DECLARATION_LIMITS.sources, () => b.sources[4]); }).join()).not.toMatch(bound);
    expect(put((b) => { b.applicability = many(INVENTORY_DECLARATION_LIMITS.applicability, () => b.applicability[0]); }).join()).not.toMatch(bound);
    expect(put((b) => { b.attribution = many(INVENTORY_DECLARATION_LIMITS.attribution, () => b.attribution[0]); }).join()).not.toMatch(bound);
  });

  it('pins the bounds', () => {
    expect(INVENTORY_DECLARATION_LIMITS).toEqual({ sites: 500, attribution: 5, applicability: 2505, sources: 2000 });
  });
});

describe('CreateInventoryBoundaryDto', () => {
  it('takes a year in range and an optional version to copy', () => {
    expect(check(CreateInventoryBoundaryDto, { reportingYear: 2026 })).toEqual([]);
    expect(check(CreateInventoryBoundaryDto, { reportingYear: 2000, copyOf: SITE })).toEqual([]);
    expect(check(CreateInventoryBoundaryDto, { reportingYear: 2100 })).toEqual([]);
    for (const reportingYear of [1999, 2101, 2026.5, '2026', null, undefined]) {
      expect(check(CreateInventoryBoundaryDto, { reportingYear }).join(), String(reportingYear)).toMatch(/reportingYear/);
    }
    for (const copyOf of ['v1', NIL.slice(1), 7, null]) {
      expect(check(CreateInventoryBoundaryDto, { reportingYear: 2026, copyOf }).join(), String(copyOf)).toMatch(/copyOf/);
    }
  });

  it("lowercases the copied version's id — the database's spelling", () => {
    const dto = plainToInstance(CreateInventoryBoundaryDto, { reportingYear: 2026, copyOf: SITE.toUpperCase() });
    expect(dto.copyOf).toBe(SITE);
  });

  it('refuses an actor or a version number — the API assigns both', () => {
    expect(check(CreateInventoryBoundaryDto, { reportingYear: 2026, createdBy: SITE }).join()).toMatch(/createdBy/);
    expect(check(CreateInventoryBoundaryDto, { reportingYear: 2026, version: 3 }).join()).toMatch(/version/);
  });
});

describe('ListInventoryBoundariesQueryDto', () => {
  it('requires one reporting year', () => {
    expect(check(ListInventoryBoundariesQueryDto, { reportingYear: '2026' })).toEqual([]);
    expect(plainToInstance(ListInventoryBoundariesQueryDto, { reportingYear: '2026' }).reportingYear).toBe(2026);
    for (const reportingYear of [undefined, '', 'abc', '2026.0', ['2026', '2027'], '1999', '2101']) {
      expect(check(ListInventoryBoundariesQueryDto, { reportingYear }).join(), JSON.stringify(reportingYear)).toMatch(/reportingYear/);
    }
    expect(check(ListInventoryBoundariesQueryDto, { reportingYear: '2026', subsidiaryId: SITE }).join()).toMatch(/subsidiaryId/);
  });
});
