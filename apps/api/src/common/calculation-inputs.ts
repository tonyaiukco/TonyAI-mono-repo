import { isProvenanceSnapshot, type ActivityCalculationSnapshot, type EquipmentType, type Locale } from '@tonyai/shared-types';

/**
 * A record's calculation inputs as a report prints them (LP4-02 PR5, task
 * 5.3): a natural gas record's own NCV beside the row's generic basis, and a
 * refrigerant's terms beside its total capacity, whose activity value is not
 * the mass priced (D7). Read from the snapshot alone, so a report says what
 * the figure was computed from, never what the library holds now. Empty for a
 * record whose snapshot carries no inputs (any V2, most V3).
 *
 * One function for the live reports and the issued ones, each passing its own
 * catalogue: both name these keys the same.
 */
export type CalculationInputsKey =
  | 'inputsNcv'
  | 'inputsOriginDefault'
  | 'inputsOriginUser'
  | 'inputsOriginDerived'
  | 'inputsBilledGcv'
  | 'inputsVolume'
  | 'inputsLine'
  | `inputsEquipment_${EquipmentType}`;

export interface CalculationInputsWords {
  text(key: CalculationInputsKey, values?: Record<string, string>): string;
  locale: Locale;
}

const ORIGIN_KEY = {
  default: 'inputsOriginDefault',
  user: 'inputsOriginUser',
  derived: 'inputsOriginDerived',
} as const satisfies Record<string, CalculationInputsKey>;

export function calculationInputs(calculation: unknown, words: CalculationInputsWords): string {
  const snapshot = calculation as ActivityCalculationSnapshot;
  if (!isProvenanceSnapshot(snapshot) || snapshot.snapshotSchema !== 3) return '';
  const tag = words.locale === 'tr' ? 'tr-TR' : 'en-GB';
  // Significant digits, never a fixed number of decimals: a refill of
  // 0.00049 kg is a real input (SF6 at 25,200), and three decimals printed it
  // as 0 beside the mass it produced (Codex's review of #282). An input shows
  // as entered, its 16th digit (float noise) dropped; a derived value to six.
  const format = (n: number, digits: number) => new Intl.NumberFormat(tag, { maximumSignificantDigits: digits }).format(n);
  const entered = (n: number) => format(n, 15);
  const derived = (n: number) => format(n, 6);
  const parts: string[] = [];
  for (const input of snapshot.parameters) {
    if (input.name === 'ncvKcalPerSm3') {
      const value = input.origin === 'derived' ? derived(input.value) : entered(input.value);
      parts.push(words.text('inputsNcv', { value, origin: words.text(ORIGIN_KEY[input.origin]) }));
    } else if (input.name === 'billedGcvKcalPerSm3') {
      parts.push(words.text('inputsBilledGcv', { value: entered(input.value) }));
    } else if (input.name === 'volumeCorrectionFactor') {
      parts.push(words.text('inputsVolume', { value: entered(input.value) }));
    }
  }
  for (const term of snapshot.refrigerantTerms ?? []) {
    parts.push(words.text('inputsLine', {
      equipment: words.text(`inputsEquipment_${term.equipmentType as EquipmentType}`),
      capacity: entered(term.capacityKg),
      // `%1` in Turkish, `1%` in English.
      rate: words.locale === 'tr' ? `%${entered(term.leakRate * 100)}` : `${entered(term.leakRate * 100)}%`,
      refill: entered(term.refillKg),
      mass: derived(term.leakedKg + term.refillKg),
    }));
  }
  return parts.join('; ');
}
