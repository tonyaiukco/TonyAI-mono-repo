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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural equality of two JSON values. Key order is irrelevant — `jsonb`
 * reorders keys — and a key holding `undefined` is an absent key, as it is
 * once serialised. Numbers compare exactly: the engine is deterministic and
 * `activity_value` is a double, so the same inputs give the same bits.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
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
    if (!sameJson(a[key], b[key])) return false;
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
    if (!sameField(key, storedObject[key], recomputedObject[key])) {
      differing.add(CLASS_OF[key] ?? 'factor');
    }
  }
  const legacy =
    isCalculated(storedObject as unknown as ActivityCalculationSnapshot) &&
    storedObject.snapshotSchema === undefined;
  const classes = CLASS_ORDER.filter((c) => differing.has(c));
  return { stale: legacy || classes.length > 0, classes, legacy };
}
