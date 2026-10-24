/**
 * Data Entry's "Additional context" fields — optional metadata saved into a
 * record's `input`, never fed to the calculation engine.
 *
 * Moved here from the deleted `data-entry-data.ts` (LP4-04), which held their English
 * labels; the words now live in the `dataEntry.context` catalogue, keyed by
 * the field SET and the field id, because two sets share an id (`notes`) with
 * different words. The ids and the option VALUES are what records store, so
 * neither may change; an option's label is translated, its value is not.
 * File fields of the old mock were never rendered and are not listed.
 */

export type ContextFieldSet = "electricity" | "fuel" | "businessTravel" | "waste" | "water" | "logistics" | "other";

export type ContextFieldType = "number" | "text" | "textarea" | "date" | "select";

export interface ContextOption {
  /** What is stored. */
  value: string;
  /** Its label under `dataEntry.context.options`, or none for a unit symbol
   *  that reads the same in every language. */
  key?: ContextOptionKey;
}

export interface ContextField {
  /** The key in the record's `input` — stored, never renamed. */
  id: string;
  type: ContextFieldType;
  /** The field has a `placeholder` message in its set. */
  placeholder?: true;
  options?: readonly ContextOption[];
}

export type ContextOptionKey =
  | "liters"
  | "cubicMeters"
  | "tonnes"
  | "heating"
  | "powerGeneration"
  | "industrialProcess"
  | "other"
  | "economy"
  | "business"
  | "firstClass"
  | "mixed"
  | "landfill"
  | "incineration"
  | "recycling"
  | "composting";

const num = (id: string): ContextField => ({ id, type: "number", placeholder: true });

export const CONTEXT_FIELDS: Readonly<Record<ContextFieldSet, readonly ContextField[]>> = {
  electricity: [
    num("total_kwh"),
    num("renewable_kwh"),
    // `grid_region` was removed in WP15 (round-1 DE-6/DE-7): it never reached
    // the calculation engine, so a user picking a region got a different
    // factor than the one they chose. Data Entry shows the factor geography
    // read-only instead.
    { id: "billing_period_start", type: "date" },
    { id: "billing_period_end", type: "date" },
    { id: "utility_provider", type: "text", placeholder: true },
    { id: "notes", type: "textarea", placeholder: true },
  ],
  fuel: [
    // No "Fuel Type" here: the fuel is the record's activity type (LP3-03),
    // chosen in the form's own "Fuel or gas" field and priced by it.
    num("quantity"),
    {
      id: "quantity_unit",
      type: "select",
      options: [
        { value: "Liters", key: "liters" },
        { value: "Cubic Meters", key: "cubicMeters" },
        { value: "Tonnes", key: "tonnes" },
        { value: "kWh" },
      ],
    },
    {
      id: "purpose",
      type: "select",
      options: [
        { value: "Heating", key: "heating" },
        { value: "Power Generation", key: "powerGeneration" },
        { value: "Industrial Process", key: "industrialProcess" },
        { value: "Other", key: "other" },
      ],
    },
    { id: "fuel_notes", type: "textarea", placeholder: true },
  ],
  businessTravel: [
    num("short_haul_km"),
    num("medium_haul_km"),
    num("long_haul_km"),
    {
      id: "travel_class",
      type: "select",
      options: [
        { value: "Economy", key: "economy" },
        { value: "Business", key: "business" },
        { value: "First Class", key: "firstClass" },
        { value: "Mixed", key: "mixed" },
      ],
    },
    num("rental_car_km"),
    num("train_km"),
    num("taxi_km"),
  ],
  waste: [
    num("general_waste_tonnes"),
    num("recycled_waste_tonnes"),
    num("hazardous_waste_tonnes"),
    {
      id: "disposal_method",
      type: "select",
      options: [
        { value: "Landfill", key: "landfill" },
        { value: "Incineration", key: "incineration" },
        { value: "Recycling", key: "recycling" },
        { value: "Composting", key: "composting" },
        { value: "Mixed", key: "mixed" },
      ],
    },
    { id: "waste_notes", type: "textarea", placeholder: true },
  ],
  water: [num("municipal_water_m3"), num("groundwater_m3"), num("recycled_water_m3")],
  logistics: [
    num("road_freight_tkm"),
    num("rail_freight_tkm"),
    num("sea_freight_tkm"),
    num("air_freight_tkm"),
    { id: "logistics_notes", type: "textarea", placeholder: true },
  ],
  other: [
    num("activity_value"),
    {
      id: "activity_unit",
      type: "select",
      options: [
        { value: "kWh" },
        { value: "MWh" },
        { value: "Liters", key: "liters" },
        { value: "Tonnes", key: "tonnes" },
        { value: "km" },
        { value: "m³" },
      ],
    },
    { id: "notes", type: "textarea", placeholder: true },
  ],
};

const SET_BY_CATEGORY: Readonly<Record<string, ContextFieldSet>> = {
  Electricity: "electricity",
  Fuel: "fuel",
  "Business Travel": "businessTravel",
  Waste: "waste",
  Water: "water",
  Logistics: "logistics",
};

/** The field set a category shows; every category without its own gets `other`. */
export function contextFieldSet(category: string): ContextFieldSet {
  return SET_BY_CATEGORY[category] ?? "other";
}

/**
 * A stored context number as the number it means. Values saved before LP4-04
 * came from `<input type="number">`, whose value is always dot-decimal text;
 * values saved since are JSON numbers. Anything else is not a number.
 */
export function storedContextNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!/^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}
