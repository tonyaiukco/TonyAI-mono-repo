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

/**
 * The UI catalogues (LP3-01): one JSON file per namespace per locale, so two
 * features translating at once touch different files. English is the source —
 * its shape is the `Messages` type every `useTranslations` call is checked
 * against — and `messages.spec.ts` holds Turkish to the same keys and ICU
 * arguments. Conventions: README "Localisation and error codes" and the
 * `localise-ui` skill.
 *
 *   common      words every screen shares (Sign out, …)
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
 *   dashboard   the dashboard's KPI words LP4-03 PR B changed (the rest is LP4-04's)
 *   reports     the Reports screen — live preview and issued reports — and the
 *               boundary coverage card the dashboard and Data Entry share (LP4-03 PR B)
 *   boundary    the inventory boundary editor, and the coverage card's link to it (LP4-03 PR C)
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
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, tr };
