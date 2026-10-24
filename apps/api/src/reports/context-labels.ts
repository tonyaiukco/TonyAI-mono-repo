import { IntlMessageFormat } from 'intl-messageformat';
import type { Locale, ReportingContext } from '@tonyai/shared-types';
import { reportVocabulary } from './report-vocabulary';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/** The selection's labels in the report's language (D16; LP4-03 K6) — the PDF's and the workbook's. */
export function contextLabels(context: ReportingContext, subsidiaryName: string | null, locale: Locale = 'en'): [string, string][] {
  const messages = locale === 'tr' ? tr : en;
  const t = (key: keyof typeof en, values?: Record<string, string | number>) =>
    new IntlMessageFormat(messages[key], locale).format(values) as string;
  return [
    [t('subsidiary'), context.subsidiaryId === undefined ? t('allSubsidiaries') :
      subsidiaryName ?? t('selectedSubsidiary', { id: context.subsidiaryId })],
    [t('scope'), context.scope === undefined ? t('allScopes') : t('selectedScope', { scope: context.scope })],
    [t('category'), context.category === undefined ? t('allCategories') : reportVocabulary(locale).category(context.category)],
  ];
}
