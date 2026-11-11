import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { FactorCoverageLegend } from '@/components/data-entry/factor-coverage-legend';
import type { FactorCoverageDTO } from '@/lib/types';
import { MESSAGES } from '@/messages';

/**
 * The Data Entry coverage legend (UAT round 2, BUG-R2-09) in both languages:
 * the pilot library, a geography outside it, a placeholder-only year, and an
 * unreadable report. HTML entities are decoded so the catalogue's own text can
 * be compared.
 */

type Props = Parameters<typeof FactorCoverageLegend>[0];
const render = (locale: 'en' | 'tr', props: Props) =>
  renderToStaticMarkup(createElement(IntlProvider, {
    locale, timeZone: 'UTC', messages: MESSAGES[locale], children: createElement(FactorCoverageLegend, props),
  })).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const PILOT: FactorCoverageDTO = {
  entries: [2024, 2025, 2026].map((reportingYear) => ({ geographyCode: 'TR', reportingYear, statuses: ['authoritative'] })),
};

describe('FactorCoverageLegend (BUG-R2-09)', () => {
  it.each([
    ['en', 'Emission factors are defined for: Türkiye (TR) 2024–2026.'],
    ['tr', 'Emisyon faktörleri şu kapsamlar için tanımlıdır: Türkiye (TR) 2024–2026.'],
  ] as const)('%s states the pilot coverage, unlabelled, with nothing amber for TR', (locale, sentence) => {
    const html = render(locale, { coverage: PILOT, geography: 'TR', year: 2026 });
    expect(html).toContain(sentence);
    expect(html).not.toContain(MESSAGES[locale].dataEntry.factorCoverage.placeholder);
    expect(html).not.toContain('text-amber-700');
  });

  it.each([
    ['en', 'No emission factor is defined for United Kingdom (UK) in 2026'],
    ['tr', '2026 yılında Birleşik Krallık (UK) için tanımlı emisyon faktörü yok'],
  ] as const)('%s warns in amber when the record\'s geography is outside the library', (locale, sentence) => {
    const html = render(locale, { coverage: PILOT, geography: 'UK', year: 2026 });
    expect(html).toContain(sentence);
    expect(html).toMatch(/text-amber-700[^>]*role="status"|role="status"[^>]*text-amber-700/);
  });

  it.each([
    ['en', 'United Kingdom (UK) 2026 (placeholder — not authoritative)', 'United Kingdom (UK) in 2026 rests on placeholder factors, which are not authoritative.'],
    ['tr', 'Birleşik Krallık (UK) 2026 (yer tutucu — resmi değil)', '2026 yılında Birleşik Krallık (UK) için kullanılan faktörler yer tutucudur ve resmi değildir.'],
  ] as const)('%s labels placeholder-only coverage and the record standing on it', (locale, range, selected) => {
    const coverage: FactorCoverageDTO = {
      entries: [...PILOT.entries, { geographyCode: 'UK', reportingYear: 2026, statuses: ['placeholder'] }],
    };
    const html = render(locale, { coverage, geography: 'UK', year: 2026 });
    expect(html).toContain(range);
    expect(html).toContain(selected);
    expect(html).toMatch(/text-amber-700[^>]*role="status"|role="status"[^>]*text-amber-700/);
    // The authoritative TR range stays unlabelled beside it.
    expect(html).toContain('Türkiye (TR) 2024–2026;');
  });

  it('prints years as written, never grouped', () => {
    const html = render('en', { coverage: PILOT, geography: 'TR', year: 2023 });
    expect(html).toContain('2024–2026');
    expect(html).toContain('in 2023');
    expect(html).not.toMatch(/2,02\d/);
  });

  it('renders nothing when the report could not be read — no claim of coverage', () => {
    expect(render('en', { coverage: null, geography: 'TR', year: 2026 })).toBe('');
  });

  it('says plainly, in amber and once, that nothing can be calculated over an empty library', () => {
    const html = render('en', { coverage: { entries: [] }, geography: 'TR', year: 2026 });
    expect(html).toContain(MESSAGES.en.dataEntry.factorCoverage.none);
    expect(html).toContain('text-amber-700');
    // Not a second amber line naming the pair: the empty library already says it.
    expect(html).not.toContain('No emission factor is defined for');
  });
});
