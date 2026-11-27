import {
  FUEL_MARINE_USAGE,
  FUEL_USAGES,
  MANUAL_FUELS,
  fuelRecordTarget,
  fuelUsagesFor,
  type Category,
  type FuelEntryUsage,
  type FuelRecordTarget,
  type ManualFuel,
} from "@/lib/types";

/**
 * Data Entry's fuel and usage for a company on the Türkiye factor set
 * (inc28-fuel-bulk D6, C15): two choices, nothing preselected, read through
 * the one table the API and the files read (`fuelRecordTarget`). A pair the
 * library does not price is never offered; a stationary usage is a `Fuel`
 * record.
 */

export interface FuelPair {
  fuel: ManualFuel | "";
  usage: FuelEntryUsage | "";
}

export const EMPTY_FUEL_PAIR: FuelPair = { fuel: "", usage: "" };

/**
 * The usages offered for a fuel: the priced ones, and — for a standard user,
 * whose grant ticks categories — only those whose record's category the grant
 * holds (`allowed` null: every category). Marine gas oil answers its one
 * fixed usage.
 */
export function usagesOffered(fuel: ManualFuel | "", allowed: readonly Category[] | null): FuelEntryUsage[] {
  if (!fuel) return [];
  return fuelUsagesFor(fuel).filter((usage) => {
    const target = fuelRecordTarget(fuel, usage);
    return target !== null && (allowed === null || allowed.includes(target.category));
  });
}

/** The fuels offered: those with at least one usage the user may enter. */
export function fuelsOffered(allowed: readonly Category[] | null): ManualFuel[] {
  return MANUAL_FUELS.filter((fuel) => usagesOffered(fuel, allowed).length > 0);
}

/** A fuel chosen: marine gas oil takes its fixed usage; any other fuel starts with none chosen. */
export function chooseFuel(fuel: ManualFuel): FuelPair {
  const usages = fuelUsagesFor(fuel);
  return { fuel, usage: usages.length === 1 && usages[0] === FUEL_MARINE_USAGE ? FUEL_MARINE_USAGE : "" };
}

/** The record the pair becomes, or null while a choice is missing or the pair is not priced. */
export function pairTarget(pair: FuelPair): FuelRecordTarget | null {
  if (!pair.fuel || !pair.usage) return null;
  return fuelRecordTarget(pair.fuel, pair.usage);
}

/** What the save waits for, named: the fuel, then the usage. */
export function missingChoice(pair: FuelPair): "fuel" | "usage" | null {
  if (!pair.fuel) return "fuel";
  if (!pair.usage) return "usage";
  return null;
}

/**
 * A stored record read back as its pair (an opened or copied record): every
 * activity type D6's table produces. Null for one it does not (an older
 * vehicle mode, another category), which the form then shows as before.
 */
export function pairOf(category: string, activityType: string | null): FuelPair | null {
  if (!activityType) return null;
  for (const fuel of MANUAL_FUELS) {
    for (const usage of [...FUEL_USAGES, FUEL_MARINE_USAGE] as const) {
      const target = fuelRecordTarget(fuel, usage);
      if (target && target.category === category && target.activityType === activityType) return { fuel, usage };
    }
  }
  return null;
}

/** Whether the pair files the record under stationary combustion (the form says so before the save). */
export function filedAsStationary(pair: FuelPair): boolean {
  return pairTarget(pair)?.category === "Fuel";
}

/** The categories whose entry shows the card-fuel note (the manual entries of fuel a card may have bought). */
export function showsCardFuelNote(category: string): boolean {
  return category === "Mobile Combustion" || category === "Fuel";
}

/**
 * Whether the entry shows the fuel and usage controls: a company on the
 * Türkiye factor set, on the Mobile Combustion entry (unless an opened record
 * no pair produces), or on the `Fuel` record a stationary pair made. Any
 * other company's entry is as it was before (D6).
 */
export function showsFuelPair(options: { category: string; trRules: boolean; pairOrigin: boolean; pairLegacy: boolean }): boolean {
  if (!options.trRules) return false;
  if (options.category === "Mobile Combustion") return !options.pairLegacy;
  return options.category === "Fuel" && options.pairOrigin;
}
