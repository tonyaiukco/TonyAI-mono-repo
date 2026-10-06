/**
 * The shape of an activity type on the wire (LP3-03): a token from
 * `CATEGORY_ACTIVITY_TYPES` in @tonyai/shared-types — `diesel`, `R-410A`.
 * Checked by the DTOs before anything looks it up or quotes it back; whether
 * the record's category HAS that type — against the effective category, so a
 * PATCH moving a diesel Fuel draft to Electricity is refused — and whether a
 * new record must name one are the service's checks. The database holds the
 * same shape as a CHECK on `activity_records.activity_type`.
 */
export const ACTIVITY_TYPE_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

export const ACTIVITY_TYPE_SHAPE_MESSAGE =
  'activityType must be 1 to 32 letters, digits, "_" or "-"';
