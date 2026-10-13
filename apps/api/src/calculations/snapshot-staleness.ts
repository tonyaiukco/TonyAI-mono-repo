import { isCalculated, type ActivityCalculationSnapshot } from '@tonyai/shared-types';
import { storedUnit } from './storable-unit';

/**
 * Which part of a stored snapshot disagrees with the recomputed one — logged
 * when K11 refuses a record, so a library change (`factor`, `conversion`) is
 * told from a direct writer's rewrite (`figure`, `input`). Never shown to a
 * caller: `calculation_stale` carries no params.
 */
export type StalenessClass = 'input' | 'conversion' | 'figure' | 'factor';

/** The order classes are reported in — fixed, so a log line is greppable. */
const CLASS_ORDER: readonly StalenessClass[] = ['input', 'conversion', 'figure', 'factor'];

/** The fields that are not the factor's. Every other field — unknown ones included — counts with the factor (P6). */
const CLASS_OF: Readonly<Record<string, StalenessClass>> = {
  category: 'input',
  geographyCode: 'input',
  reportingYear: 'input',
  inputValue: 'input',
  inputUnit: 'input',
  activityType: 'input',
  normalizedValue: 'conversion',
  normalizedUnit: 'conversion',
  conversionApplied: 'conversion',
  conversionFactor: 'conversion',
  conversionBasis: 'conversion',
  conversion: 'conversion',
  kgCo2e: 'figure',
  tCo2e: 'figure',
};

export interface SnapshotComparison {
  /** True when the record must not commit: it differs, or it is legacy. */
  stale: boolean;
  /** The parts that differ, in `CLASS_ORDER`; empty when only `legacy` makes it stale. */
  classes: StalenessClass[];
  /** A calculated snapshot from before LP3-03's provenance shape (no `snapshotSchema`). */
  legacy: boolean;
}

/**
 * How far apart, relative to the larger, two numbers may be and still be the
 * same number. Prisma's write path rounds a double to 16 significant digits —
 * in a float8 column and inside jsonb alike (measured: 0.30000000000000004 is
 * stored as 0.3) — so a snapshot saved from the caller's value and the one
 * recomputed from the stored, rounded `activity_value` differ by a few parts
 * in 10^16 (`qa-auditor` P0, B2 review). Exact comparison refused a third to
 * all of the honest records on real paths, and saving again could not clear
 * it. 10^-12 is four orders above that noise and far below any change a
 * factor release or a rewrite makes — no published factor is stated to
 * twelve significant digits, and a figure moved by less is no figure moved.
 */
export const NUMBER_TOLERANCE = 1e-12;

function sameNumber(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= NUMBER_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A key's OWN value, never one inherited from `Object.prototype`: a stored
 * key named `toString`, `constructor` or `__proto__` (`JSON.parse` makes it an
 * own property) must read as itself, not as the prototype's member — or it
 * compares equal to it, or looks a class up (`security-rls` P2-2, B2 review).
 */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

/**
 * Structural equality of two JSON values. Key order is irrelevant — `jsonb`
 * reorders keys — and a key holding `undefined` is an absent key, as it is
 * once serialised. Numbers compare within `NUMBER_TOLERANCE`; everything else
 * exactly.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!sameJson(own(a, key), own(b, key))) return false;
  }
  return true;
}

function sameField(key: string, stored: unknown, recomputed: unknown): boolean {
  // The snapshot keeps the unit as it was entered (`kwh`) until the record is
  // next edited, while the recompute reads the stored column (`kWh`) — the
  // same unit (`storedUnit`).
  if (key === 'inputUnit' && typeof stored === 'string' && typeof recomputed === 'string') {
    return storedUnit(stored) === storedUnit(recomputed);
  }
  return sameJson(stored, recomputed);
}

/**
 * K11 (Decisions 2026-10-11 (second), P6): compare a record's stored
 * `calculation` with the snapshot the engine computes now from the record's
 * stored inputs. The whole snapshot is compared — the figure, the factor and
 * its release, the conversion, the inputs it echoes — so a figure rewritten
 * with a matching factor value is caught as surely as an erratum. A calculated
 * snapshot without `snapshotSchema` (before LP3-03) is stale whatever it
 * holds: its provenance cannot be checked. An uncalculated snapshot is
 * compared like any other, so one a factor has since covered is stale.
 *
 * `stored` is whatever the column holds; anything that is not an object is
 * stale with every class.
 */
export function compareSnapshots(
  stored: unknown,
  recomputed: ActivityCalculationSnapshot,
): SnapshotComparison {
  const storedObject = isPlainObject(stored) ? stored : {};
  const recomputedObject = recomputed as unknown as Record<string, unknown>;
  const differing = new Set<StalenessClass>();
  const keys = new Set([...Object.keys(storedObject), ...Object.keys(recomputedObject)]);
  for (const key of keys) {
    if (!sameField(key, own(storedObject, key), own(recomputedObject, key))) {
      differing.add((own(CLASS_OF as Record<string, unknown>, key) as StalenessClass | undefined) ?? 'factor');
    }
  }
  const legacy =
    isCalculated(storedObject as unknown as ActivityCalculationSnapshot) &&
    storedObject.snapshotSchema === undefined;
  const classes = CLASS_ORDER.filter((c) => differing.has(c));
  return { stale: legacy || differing.size > 0, classes, legacy };
}
