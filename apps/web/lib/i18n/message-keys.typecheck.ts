// Compile-time only: the unions are not `never`, and they refuse a key the
// catalogue lacks. Collected by `tsc`, never by vitest (no `.spec`).
import type { ActivityTypeKey, ContextFieldKey, UnitLabelKey } from "./message-keys";

const activity: ActivityTypeKey = "activityTypes.lpg";
const unit: UnitLabelKey = "label.kWh";
const label: ContextFieldKey<"label"> = "context.electricity.total_kwh.label";
const placeholder: ContextFieldKey<"placeholder"> = "context.fuel.quantity.placeholder";
// @ts-expect-error — no such activity type
const missing: ActivityTypeKey = "activityTypes.nope";
// @ts-expect-error — `purpose` has no placeholder
const noPlaceholder: ContextFieldKey<"placeholder"> = "context.fuel.purpose.placeholder";
void [activity, unit, label, placeholder, missing, noPlaceholder];
