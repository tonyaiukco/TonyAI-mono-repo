import { describe, expect, it } from 'vitest';
import {
  documentInvoiceRef,
  FILE_FUELS,
  FUEL_INVOICE_REF_MAX_LENGTH,
  FUEL_ROW_STATES,
  FUEL_USAGES,
  fuelRecordTarget,
  fuelRowState,
  fuelUsagesFor,
  MANUAL_FUELS,
  parseShellInvoiceRef,
  recogniseFuel,
  shellHalfMonth,
  shellInvoiceRef,
  type FuelAccountTarget,
  type FuelEntryUsage,
  type FuelRowState,
} from './fuel';
import {
  FUEL_BATCH_OPEN_STATUSES,
  FUEL_INVOICE_ROW_STATES,
  FUEL_TANKER_MAX_DELIVERIES,
  FUEL_TRAY_ROW_STATES,
  FUEL_UPLOAD_MAX_ROWS,
  FUEL_UPLOAD_MAX_SIZE_BYTES,
} from './fuel';
import { isRecordActivityTypeAllowed, MARINE_GAS_OIL_UNITS, unitsForCategory } from './index';
import { RECORD_INVOICE_NO_MAX_LENGTH } from './record-references';

describe('recogniseFuel (INC-2.8 §2)', () => {
  it.each([
    'Kurşunsuz 95 V/Max',
    'Kurşunsuz 95 Oktan',
    'Kurşunsuz 95 Ultimate',
    'Kurşunsuz 95 - Shell Vp',
    'KURŞUNSUZ BENZİN SHELL - 95 VP',
    'Kurşunsuz 95 Benzin',
  ])('reads the 2025 petrol name %s as petrol', (name) => {
    expect(recogniseFuel(name)).toBe('petrol');
  });

  it.each(['Motorin Med', 'Motorin Ultimate', 'Motorin Diesel', 'Motorin - Shell Vp Diesel', 'MOTORIN-SHELL VP DIESEL'])(
    'reads the 2025 diesel name %s as diesel',
    (name) => {
      expect(recogniseFuel(name)).toBe('diesel');
    },
  );

  it('folds case and Turkish characters both ways', () => {
    expect(recogniseFuel('MOTORİN')).toBe('diesel');
    expect(recogniseFuel('motorın')).toBe('diesel');
    expect(recogniseFuel('DİZEL')).toBe('diesel');
    expect(recogniseFuel('dizel')).toBe('diesel');
    expect(recogniseFuel('KURSUNSUZ')).toBe('petrol');
    expect(recogniseFuel('benzın')).toBe('petrol');
    expect(recogniseFuel('BENZİN')).toBe('petrol');
  });

  it('recognises nothing for a name matching neither rule (B11, C7)', () => {
    expect(recogniseFuel('Otogaz LPG')).toBeNull();
    expect(recogniseFuel('AdBlue')).toBeNull();
    expect(recogniseFuel('')).toBeNull();
    expect(recogniseFuel(null)).toBeNull();
    expect(recogniseFuel(undefined)).toBeNull();
  });

  it('recognises nothing for a name matching both rules (B11)', () => {
    expect(recogniseFuel('Motorin / Kurşunsuz karışık')).toBeNull();
    expect(recogniseFuel('Diesel Benzin')).toBeNull();
  });
});

describe('fuelRecordTarget (D6)', () => {
  const rows: Array<[string, FuelEntryUsage, string, string, string[], boolean]> = [
    ['diesel', 'on_road', 'Mobile Combustion', 'on_road_diesel', ['litres'], true],
    ['diesel', 'off_road', 'Mobile Combustion', 'off_road_diesel', ['litres'], true],
    ['diesel', 'stationary', 'Fuel', 'diesel', ['litres'], true],
    ['petrol', 'on_road', 'Mobile Combustion', 'on_road_petrol', ['litres'], true],
    ['petrol', 'off_road', 'Mobile Combustion', 'off_road_petrol', ['litres'], true],
    ['petrol', 'stationary', 'Fuel', 'petrol', ['litres'], true],
    ['lpg', 'on_road', 'Mobile Combustion', 'on_road_lpg', ['litres'], false],
    ['lpg', 'stationary', 'Fuel', 'lpg', ['kg'], false],
    ['marine_gas_oil', 'marine', 'Mobile Combustion', 'marine_gas_oil', ['kg', 'tonnes'], false],
  ];

  it.each(rows)('%s %s → %s %s', (fuel, usage, category, activityType, units, fromFiles) => {
    const t = fuelRecordTarget(fuel as never, usage);
    expect(t).toEqual({ category, activityType, units, fromFiles });
    // Every target is a stored token of its category, in a unit the category takes.
    expect(isRecordActivityTypeAllowed(category, activityType)).toBe(true);
    const categoryUnits = unitsForCategory(category).map((u) => u.value);
    for (const unit of units) expect(categoryUnits).toContain(unit);
  });

  it('answers null for every pair the library does not price', () => {
    const present = new Set(rows.map(([fuel, usage]) => `${fuel}:${usage}`));
    const usages: FuelEntryUsage[] = [...FUEL_USAGES, 'marine'];
    let absent = 0;
    for (const fuel of MANUAL_FUELS) {
      for (const usage of usages) {
        if (present.has(`${fuel}:${usage}`)) continue;
        expect(fuelRecordTarget(fuel, usage)).toBeNull();
        absent += 1;
      }
    }
    // LPG off-road and marine; diesel and petrol marine; MGO's three declared usages.
    expect(absent).toBe(7);
  });

  it('lets files produce litres of diesel and petrol only', () => {
    for (const fuel of FILE_FUELS) {
      for (const usage of FUEL_USAGES) {
        const t = fuelRecordTarget(fuel, usage)!;
        expect(t.fromFiles).toBe(true);
        expect(t.units).toEqual(['litres']);
      }
    }
  });

  it('offers each fuel its priced usages in order, MGO its fixed one (C15)', () => {
    expect(fuelUsagesFor('diesel')).toEqual(['on_road', 'off_road', 'stationary']);
    expect(fuelUsagesFor('petrol')).toEqual(['on_road', 'off_road', 'stationary']);
    expect(fuelUsagesFor('lpg')).toEqual(['on_road', 'stationary']);
    expect(fuelUsagesFor('marine_gas_oil')).toEqual(['marine']);
  });
});

describe('Shell half-month and invoice references (C2, D1)', () => {
  it('puts day 15 in the first half and day 16 in the second', () => {
    expect(shellHalfMonth(1)).toBe(1);
    expect(shellHalfMonth(15)).toBe(1);
    expect(shellHalfMonth(16)).toBe(2);
  });

  it('puts a month’s last day in the second half', () => {
    expect(shellHalfMonth(28)).toBe(2);
    expect(shellHalfMonth(29)).toBe(2);
    expect(shellHalfMonth(30)).toBe(2);
    expect(shellHalfMonth(31)).toBe(2);
    expect(shellInvoiceRef({ year: 2025, month: 3, day: 31 })).toBe('2025-03-2');
    expect(shellInvoiceRef({ year: 2025, month: 2, day: 28 })).toBe('2025-02-2');
  });

  it('writes and reads a Shell reference', () => {
    expect(shellInvoiceRef({ year: 2025, month: 3, day: 15 })).toBe('2025-03-1');
    expect(shellInvoiceRef({ year: 2025, month: 11, day: 16 })).toBe('2025-11-2');
    expect(parseShellInvoiceRef('2025-03-1')).toEqual({ year: 2025, month: 3, half: 1 });
    expect(parseShellInvoiceRef('2025-12-2')).toEqual({ year: 2025, month: 12, half: 2 });
    expect(parseShellInvoiceRef('2025-13-1')).toBeNull();
    expect(parseShellInvoiceRef('2025-03-3')).toBeNull();
    expect(parseShellInvoiceRef('OZK2025000011923')).toBeNull();
  });

  it('keeps a document reference as written, trimmed, with leading zeros', () => {
    expect(documentInvoiceRef(' OZK2025000011923 ')).toBe('OZK2025000011923');
    expect(documentInvoiceRef('000123')).toBe('000123');
    expect(documentInvoiceRef('')).toBeNull();
    expect(documentInvoiceRef('   ')).toBeNull();
    expect(documentInvoiceRef(null)).toBeNull();
    expect(documentInvoiceRef('x'.repeat(FUEL_INVOICE_REF_MAX_LENGTH))).toHaveLength(FUEL_INVOICE_REF_MAX_LENGTH);
    expect(documentInvoiceRef('x'.repeat(FUEL_INVOICE_REF_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('fuelRowState (D8)', () => {
  // The reference: D8's table read top to bottom.
  const expected = (input: {
    withdrawn: boolean;
    inBatch: boolean;
    account: FuelAccountTarget;
    fuel: 'diesel' | null;
    holdReason: string | null;
  }): FuelRowState => {
    if (input.withdrawn) return 'withdrawn';
    if (input.inBatch) return 'assigned';
    if (input.account === 'none') return 'waiting_account';
    if (input.account === 'associate') return 'excluded';
    if (input.fuel === null) return 'waiting_fuel';
    if (input.holdReason !== null) return 'held';
    return 'ready';
  };

  it('answers every combination of its five conditions by the table’s order', () => {
    const seen = new Set<FuelRowState>();
    let combinations = 0;
    for (const withdrawn of [false, true]) {
      for (const inBatch of [false, true]) {
        for (const account of ['none', 'associate', 'records'] as const) {
          for (const fuel of ['diesel', null] as const) {
            for (const holdReason of [null, 'period_locked'] as const) {
              const input = { withdrawn, inBatch, account, fuel, holdReason };
              const state = fuelRowState(input);
              expect(state).toBe(expected(input));
              seen.add(state);
              combinations += 1;
            }
          }
        }
      }
    }
    expect(combinations).toBe(48);
    expect([...seen].sort()).toEqual([...FUEL_ROW_STATES].sort());
  });

  it('excludes an associate’s row whatever its fuel name', () => {
    expect(fuelRowState({ withdrawn: false, inBatch: false, account: 'associate', fuel: null, holdReason: null })).toBe(
      'excluded',
    );
  });

  it('makes a held row ready again when re-stated without its reason', () => {
    const row = { withdrawn: false, inBatch: false, account: 'records' as const, fuel: 'diesel' as const };
    expect(fuelRowState({ ...row, holdReason: 'fuel_out_of_scope' })).toBe('held');
    expect(fuelRowState({ ...row, holdReason: null })).toBe('ready');
  });
});

describe('the fuel contract’s constants', () => {
  it('pins C18’s provisional limits until the measurement sets them', () => {
    expect(FUEL_UPLOAD_MAX_ROWS).toBe(60_000);
    expect(FUEL_UPLOAD_MAX_SIZE_BYTES).toBe(32 * 1024 * 1024);
    expect(FUEL_TANKER_MAX_DELIVERIES).toBe(1_000);
  });

  it('names the open batch statuses, the tray’s rows and an invoice’s live rows', () => {
    expect(FUEL_BATCH_OPEN_STATUSES).toEqual(['draft', 'rejected']);
    expect(FUEL_TRAY_ROW_STATES).toEqual(['waiting_account', 'waiting_fuel']);
    expect(FUEL_INVOICE_ROW_STATES).toEqual(['assigned', 'excluded']);
  });

  it('keeps an invoice reference within the record’s invoice number, and MGO in its own units', () => {
    expect(FUEL_INVOICE_REF_MAX_LENGTH).toBe(RECORD_INVOICE_NO_MAX_LENGTH);
    expect(fuelRecordTarget('marine_gas_oil', 'marine')!.units).toEqual([...MARINE_GAS_OIL_UNITS]);
  });

  it('answers nothing for a name this build does not know, an inherited key included', () => {
    expect(fuelRecordTarget('__proto__' as never, 'toString' as never)).toBeNull();
    expect(fuelRecordTarget('diesel', 'constructor' as never)).toBeNull();
    expect(fuelRecordTarget('kerosene' as never, 'on_road')).toBeNull();
    expect(fuelUsagesFor('toString' as never)).toEqual([]);
  });
});
