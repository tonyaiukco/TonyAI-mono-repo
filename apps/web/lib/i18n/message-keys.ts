import type { Messages } from "@/messages";

/**
 * Catalogue keys a screen builds from a canonical value at runtime, as unions
 * of the keys the catalogue holds (LP4-04 slice 2 follow-up (3)). A value is
 * narrowed to one of these rather than to `never`, so a key the catalogue
 * lacks is a type error at the cast's target, and `messages.spec.ts` proves
 * every canonical value has its key.
 */

type DataEntry = Messages["dataEntry"];
type Context = DataEntry["context"];
type ContextSet = { [S in keyof Context & string]: Context[S] extends Record<string, { label: string }> ? S : never }[keyof Context & string];

/** `dataEntry.activityTypes.<value>`, relative to `dataEntry`. */
export type ActivityTypeKey = `activityTypes.${keyof DataEntry["activityTypes"] & string}`;

/** `units.label.<value>`, relative to `units`. */
export type UnitLabelKey = `label.${keyof Messages["units"]["label"] & string}`;

/** `units.blocked.<value>` — a blocked unit's reason, relative to `units`. */
export type UnitBlockedKey = `blocked.${keyof Messages["units"]["blocked"] & string}`;

/** An Additional Context field's `label` or `placeholder`, relative to `dataEntry`. */
export type ContextFieldKey<P extends "label" | "placeholder"> = {
  [S in ContextSet]: {
    [F in keyof Context[S] & string]: Context[S][F] extends Record<P, string> ? `context.${S}.${F}.${P}` : never;
  }[keyof Context[S] & string];
}[ContextSet];
