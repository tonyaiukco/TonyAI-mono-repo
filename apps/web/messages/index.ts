import type { Locale } from "@/lib/types";
import enAuth from "./en/auth.json";
import enBoundary from "./en/boundary.json";
import enCategories from "./en/categories.json";
import enCommon from "./en/common.json";
import enDashboard from "./en/dashboard.json";
import enDataEntry from "./en/dataEntry.json";
import enErrors from "./en/errors.json";
import enNav from "./en/nav.json";
import enNumbers from "./en/numbers.json";
import enPeriods from "./en/periods.json";
import enReportingContext from "./en/reportingContext.json";
import enReports from "./en/reports.json";
import enUsers from "./en/users.json";
import enAnomaly from "./en/anomaly.json";
import enRecordStatus from "./en/recordStatus.json";
import enUnits from "./en/units.json";
import enGeography from "./en/geography.json";
import enBulkSubmit from "./en/bulkSubmit.json";
import enImports from "./en/imports.json";
import enEvidence from "./en/evidence.json";
import enBulkUpload from "./en/bulkUpload.json";
import enCompleteness from "./en/completeness.json";
import enEmissions from "./en/emissions.json";
import enTargets from "./en/targets.json";
import enIntensity from "./en/intensity.json";
import enTargetStatus from "./en/targetStatus.json";
import enTargetBasis from "./en/targetBasis.json";
import enIntensityMetrics from "./en/intensityMetrics.json";
import enSubsidiaryStatus from "./en/subsidiaryStatus.json";
import enReview from "./en/review.json";
import enAudit from "./en/audit.json";
import enSubsidiaries from "./en/subsidiaries.json";
import trAuth from "./tr/auth.json";
import trBoundary from "./tr/boundary.json";
import trCategories from "./tr/categories.json";
import trCommon from "./tr/common.json";
import trDashboard from "./tr/dashboard.json";
import trDataEntry from "./tr/dataEntry.json";
import trErrors from "./tr/errors.json";
import trNav from "./tr/nav.json";
import trNumbers from "./tr/numbers.json";
import trPeriods from "./tr/periods.json";
import trReportingContext from "./tr/reportingContext.json";
import trReports from "./tr/reports.json";
import trUsers from "./tr/users.json";
import trAnomaly from "./tr/anomaly.json";
import trRecordStatus from "./tr/recordStatus.json";
import trUnits from "./tr/units.json";
import trGeography from "./tr/geography.json";
import trBulkSubmit from "./tr/bulkSubmit.json";
import trImports from "./tr/imports.json";
import trEvidence from "./tr/evidence.json";
import trBulkUpload from "./tr/bulkUpload.json";
import trCompleteness from "./tr/completeness.json";
import trEmissions from "./tr/emissions.json";
import trTargets from "./tr/targets.json";
import trIntensity from "./tr/intensity.json";
import trTargetStatus from "./tr/targetStatus.json";
import trTargetBasis from "./tr/targetBasis.json";
import trIntensityMetrics from "./tr/intensityMetrics.json";
import trSubsidiaryStatus from "./tr/subsidiaryStatus.json";
import trReview from "./tr/review.json";
import trAudit from "./tr/audit.json";
import trSubsidiaries from "./tr/subsidiaries.json";

/**
 * The UI catalogues (LP3-01): one JSON file per namespace per locale, so two
 * features translating at once touch different files. English is the source —
 * its shape is the `Messages` type every `useTranslations` call is checked
 * against — and `messages.spec.ts` holds Turkish to the same keys and ICU
 * arguments. Conventions: README "Localisation and error codes" and the
 * `localise-ui` skill.
 *
 *   common      words every screen shares — Sign out, loading/saving/cancel, the not-calculated and
 *               no-factor labels, the tCO₂e symbol, a reporting entity's and an actor's words
 *   nav         the app shell
 *   errors      `codes.<ApiErrorCode>` — one sentence per registered code — plus
 *               network/unexpected
 *   numbers     numeric input refusals and hints (D15)
 *   periods     `granularity.<ReportingPeriod>`, `values.<PERIOD_VALUES entry>`
 *   categories  one label per `CATEGORIES` entry, keyed by the canonical value
 *   dataEntry   the Data Entry screen
 *   auth        sign-in, forgot password, the email-link and set-password screens (LP4-01)
 *   users       user and access management (LP4-01)
 *   reportingContext  the annual screens' year/subsidiary/scope/category selection (LP3-02 N1)
 *   dashboard   the dashboard — its header, register, KPI cards, charts, matrix, cells, drawer and invoice grid (LP4-04)
 *   reports     the Reports screen — live preview and issued reports — and the
 *               boundary coverage card the dashboard and Data Entry share (LP4-03 PR B)
 *   boundary    the inventory boundary editor, and the coverage card's link to it (LP4-03 PR C)
 *   anomaly     the VAR §4 verdict — Data Entry, the review queue and the emissions drawer (LP4-04)
 *   recordStatus  an activity record's status: `label` (a badge) and `inline` (inside a sentence), keyed by ACTIVITY_RECORD_STATUSES
 *   units       ACTIVITY_UNITS' labels and blocked-unit reasons, keyed by the unit's value
 *   geography   GEOGRAPHY_CODES' names, keyed by the code
 *   bulkSubmit  sending several drafts for review at once — Previous submissions, Recent imports and the bulk upload (LP4-04)
 *   imports     Data Entry's Recent imports panel (LP4-04)
 *   evidence    evidence files — the record's vault, attaching one file to several records, the review sheet's shared note (LP4-04)
 *   bulkUpload  Data Entry's bulk upload panel and its verdicts (LP4-04)
 *   completeness  invoice coverage — Data Entry's coverage panel and the dashboard's cells and grid (LP4-04)
 *   targets     the Emissions screen's Targets tab (LP4-04)
 *   intensity   the Emissions screen's intensity view (LP4-04)
 *   targetStatus  a target's progress status, keyed by `TargetStatus` (`TARGET_STATUSES`, lib/vocabulary.ts)
 *   targetBasis   a target's basis, keyed by `TargetBasis` (`TARGET_BASES`)
 *   intensityMetrics  INTENSITY_METRIC_KEYS' labels, keyed by the metric (English = INTENSITY_METRIC_META's)
 *   subsidiaryStatus  a subsidiary's reporting status, keyed by `SUBSIDIARY_STATUSES` (English lowercase, as the screens always printed it)
 *   review      the review queue and its record sheet (LP4-04 slice 2 PR C)
 *   audit       the audit trail; action and entity codes stay raw identifiers (M2)
 *   subsidiaries  the Subsidiaries list and detail, locations and period locks (LP4-04 slice 2 PR C)
 *   emissions   the Emissions screen — its tabs, the record drawer and the withdrawal (`lib/void-view.ts`) (LP4-04)
 */
const en = {
  common: enCommon,
  dashboard: enDashboard,
  nav: enNav,
  errors: enErrors,
  numbers: enNumbers,
  periods: enPeriods,
  categories: enCategories,
  dataEntry: enDataEntry,
  auth: enAuth,
  users: enUsers,
  reportingContext: enReportingContext,
  reports: enReports,
  boundary: enBoundary,
  anomaly: enAnomaly,
  recordStatus: enRecordStatus,
  units: enUnits,
  geography: enGeography,
  bulkSubmit: enBulkSubmit,
  imports: enImports,
  evidence: enEvidence,
  bulkUpload: enBulkUpload,
  completeness: enCompleteness,
  emissions: enEmissions,
  targets: enTargets,
  intensity: enIntensity,
  targetStatus: enTargetStatus,
  targetBasis: enTargetBasis,
  intensityMetrics: enIntensityMetrics,
  subsidiaryStatus: enSubsidiaryStatus,
  review: enReview,
  audit: enAudit,
  subsidiaries: enSubsidiaries,
};

export type Messages = typeof en;

const tr: Messages = {
  common: trCommon,
  dashboard: trDashboard,
  nav: trNav,
  errors: trErrors,
  numbers: trNumbers,
  periods: trPeriods,
  categories: trCategories,
  dataEntry: trDataEntry,
  auth: trAuth,
  users: trUsers,
  reportingContext: trReportingContext,
  reports: trReports,
  boundary: trBoundary,
  anomaly: trAnomaly,
  recordStatus: trRecordStatus,
  units: trUnits,
  geography: trGeography,
  bulkSubmit: trBulkSubmit,
  imports: trImports,
  evidence: trEvidence,
  bulkUpload: trBulkUpload,
  completeness: trCompleteness,
  emissions: trEmissions,
  targets: trTargets,
  intensity: trIntensity,
  targetStatus: trTargetStatus,
  targetBasis: trTargetBasis,
  intensityMetrics: trIntensityMetrics,
  subsidiaryStatus: trSubsidiaryStatus,
  review: trReview,
  audit: trAudit,
  subsidiaries: trSubsidiaries,
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, tr };
