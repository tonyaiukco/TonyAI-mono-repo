import type { Locale } from "@/lib/types";
import type { Messages } from "@/messages";

// Types every `useTranslations` key and `useLocale()` against the English
// catalogue and the supported locales.
declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
