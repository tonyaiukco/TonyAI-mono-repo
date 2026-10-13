import { IntlMessageFormat } from 'intl-messageformat';
import type { ReportingContext } from '@tonyai/shared-types';
import en from './i18n/en.json';
import tr from './i18n/tr.json';

/** Current report writers remain English until LP4-03 adds whole-report language selection. */
export function contextLabels(context: ReportingContext, subsidiaryName: string | null, locale: 'en' | 'tr' = 'en'): [string, string][] {
  const messages = locale === 'tr' ? tr : en;
  const t = (key: keyof typeof en, values?: Record<string, string | number>) =>
    new IntlMessageFormat(messages[key], locale).format(values) as string;
  return [
    [t('subsidiary'), context.subsidiaryId === undefined ? t('allSubsidiaries') :
      subsidiaryName ?? t('selectedSubsidiary', { id: context.subsidiaryId })],
    [t('scope'), context.scope === undefined ? t('allScopes') : t('selectedScope', { scope: context.scope })],
    [t('category'), context.category ?? t('allCategories')],
  ];
}
