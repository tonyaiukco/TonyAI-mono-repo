import {
  KWH_PER_KCAL,
  type NaturalGasRecordParameters,
  type RefrigerantEquipmentLine,
  type RefrigerantRecordParameters,
  type RefrigerantTerm,
  type SnapshotInput,
  type SnapshotParameterRow,
} from '@tonyai/shared-types';
import { FactorLibraryConflictError } from './errors';
import type { readReleaseParameters } from './factor-lookup';

/** The rows `readReleaseParameters` returns. */
type ReleaseParameter = Awaited<ReturnType<typeof readReleaseParameters>>[number];

export function snapshotParameterRow(row: ReleaseParameter): SnapshotParameterRow {
  return {
    id: row.id,
    releaseId: row.releaseId,
    key: row.key,
    equipmentType: row.subject,
    value: row.value,
    unit: row.unit,
    isDefault: row.isDefault,
    source: row.source,
    edition: row.release.edition,
  };
}

function reference(rows: readonly ReleaseParameter[], key: string): ReleaseParameter {
  const row = rows.find((r) => r.key === key && r.subject === null && r.isDefault);
  if (!row) {
    throw new FactorLibraryConflictError('parameter_missing', `The factor release holds no ${key}, which this calculation reads.`);
  }
  return row;
}

export interface NaturalGasChain {
  /** kWh per Sm³: the row's own when no input overrides it (D5). */
  multiplier: number;
  inputs: SnapshotInput[];
  rowsUsed: ReleaseParameter[];
}

/**
 * The natural gas chain's multiplier (D5): the conversion row's for an unedited
 * record, `NCV × 4.184 / 3,600` for an edited one, and for a billed GCV an
 * effective NCV of `reference NCV × reference GCV / billed GCV`, the direction
 * the source document writes it (owner decision 2026-11-05).
 */
export function naturalGasChain(
  parameters: NaturalGasRecordParameters | null,
  rowMultiplier: number,
  rows: readonly ReleaseParameter[],
): NaturalGasChain {
  const ncv = reference(rows, 'reference_ncv');
  const volume = parameters?.volumeCorrectionFactor ?? null;
  const volumeInput: SnapshotInput[] = volume === null ? [] : [{ name: 'volumeCorrectionFactor', value: volume, origin: 'user' }];
  const billedGcv = parameters?.billedGcvKcalPerSm3 ?? null;
  if (billedGcv !== null) {
    const gcv = reference(rows, 'reference_gcv');
    const effective = (ncv.value * gcv.value) / billedGcv;
    return {
      multiplier: effective * KWH_PER_KCAL,
      inputs: [
        { name: 'billedGcvKcalPerSm3', value: billedGcv, origin: 'user' },
        { name: 'ncvKcalPerSm3', value: effective, origin: 'derived' },
        ...volumeInput,
      ],
      rowsUsed: [ncv, gcv],
    };
  }
  const edited = parameters?.ncvKcalPerSm3 ?? null;
  if (edited !== null) {
    return {
      multiplier: edited * KWH_PER_KCAL,
      inputs: [{ name: 'ncvKcalPerSm3', value: edited, origin: 'user' }, ...volumeInput],
      rowsUsed: [],
    };
  }
  return {
    multiplier: rowMultiplier,
    inputs: [{ name: 'ncvKcalPerSm3', value: ncv.value, origin: 'default' }, ...volumeInput],
    rowsUsed: [ncv],
  };
}

export interface CapacityMethod {
  /** The priced mass: Σ (capacity × rate + refill), kg. */
  massKg: number;
  terms: RefrigerantTerm[];
  rowsUsed: ReleaseParameter[];
}

function rateFor(line: RefrigerantEquipmentLine, rows: readonly ReleaseParameter[]): ReleaseParameter {
  const isDefault = line.leakRateChoice === 'default';
  const row = rows.find((r) => r.key === 'leak_rate' && r.subject === line.equipmentType && r.isDefault === isDefault);
  if (!row) {
    throw new FactorLibraryConflictError(
      'parameter_missing',
      `The factor release holds no ${line.leakRateChoice} leak rate for ${line.equipmentType}.`,
    );
  }
  return row;
}

/** The refrigerant capacity method (D7), line by line. */
export function capacityMethod(parameters: RefrigerantRecordParameters, rows: readonly ReleaseParameter[]): CapacityMethod {
  const rowsUsed: ReleaseParameter[] = [];
  const terms = parameters.equipment.map((line): RefrigerantTerm => {
    const rate = rateFor(line, rows);
    rowsUsed.push(rate);
    return {
      equipmentType: line.equipmentType,
      leakRateChoice: line.leakRateChoice,
      capacityKg: line.capacityKg,
      leakRate: rate.value,
      leakedKg: line.capacityKg * rate.value,
      refillKg: line.refillKg,
    };
  });
  return { massKg: terms.reduce((sum, t) => sum + t.leakedKg + t.refillKg, 0), terms, rowsUsed };
}
