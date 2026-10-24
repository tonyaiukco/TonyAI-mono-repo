import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { DecimalNote } from '@/components/i18n/decimal-note';
import { checkActivityValue } from '@/lib/i18n/number';
import { MESSAGES } from '@/messages';

/** The quantity field's note, rendered as the screen renders it. */
function note(locale: 'en' | 'tr', input: string): string {
  return renderToStaticMarkup(createElement(IntlProvider, {
    locale, timeZone: 'UTC', messages: MESSAGES[locale],
    children: createElement(DecimalNote, { id: 'n', check: checkActivityValue(input, locale), otherReading: null, locale }),
  }));
}

describe('the quantity note above ACTIVITY_VALUE_MAX (LP4-04)', () => {
  it('says the bound in Turkish, written the Turkish way', () => {
    expect(note('tr', '2.000.000.000.000')).toContain('En fazla 1.000.000.000.000 girin.');
  });

  it('says the bound in English, written the English way', () => {
    expect(note('en', '2,000,000,000,000')).toContain('Enter at most 1,000,000,000,000.');
  });

  it('marks it as a refusal, and says nothing at the bound itself', () => {
    expect(note('en', '2000000000000')).toContain('text-destructive');
    expect(note('en', '1000000000000')).not.toContain('at most');
  });
});
