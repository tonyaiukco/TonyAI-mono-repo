import type { Locale } from "@/lib/types";
import enAuth from "./en/auth.json";
import enCategories from "./en/categories.json";
import enCommon from "./en/common.json";
import enDataEntry from "./en/dataEntry.json";
import enErrors from "./en/errors.json";
import enNav from "./en/nav.json";
import enNumbers from "./en/numbers.json";
import enPeriods from "./en/periods.json";
import enUsers from "./en/users.json";
import trAuth from "./tr/auth.json";
import trCategories from "./tr/categories.json";
import trCommon from "./tr/common.json";
import trDataEntry from "./tr/dataEntry.json";
import trErrors from "./tr/errors.json";
import trNav from "./tr/nav.json";
import trNumbers from "./tr/numbers.json";
import trPeriods from "./tr/periods.json";
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
 */
const en = {
  common: enCommon,
  nav: enNav,
  errors: enErrors,
  numbers: enNumbers,
  periods: enPeriods,
  categories: enCategories,
  dataEntry: enDataEntry,
  auth: enAuth,
  users: enUsers,
};

export type Messages = typeof en;

const tr: Messages = {
  common: trCommon,
  nav: trNav,
  errors: trErrors,
  numbers: trNumbers,
  periods: trPeriods,
  categories: trCategories,
  dataEntry: trDataEntry,
  auth: trAuth,
  users: trUsers,
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, tr };
