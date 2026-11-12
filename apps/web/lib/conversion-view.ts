import { unitSymbol, isProvenanceSnapshot, type ActivityCalculationSnapshot, type Locale } from '@/lib/types';
import { formatNumber } from '@/lib/i18n/number';
import { formatSealDate, sealDateFor, type SealDates } from '@/lib/release-seal-view';
import en from '@/messages/en/dataEntry.json';

type ConversionKey = 'conversionNote.detail' | 'conversionNote.ncvDetail' | 'conversionNote.volumeCorrection'
  | 'conversionNote.unknownConditions'
  | 'conversionNote.sealedOn'
  | `conversionNote.basis.${keyof typeof en.conversionNote.basis}`
  | `conversionNote.status.${keyof typeof en.conversionNote.status}`
  | `conversionNote.ncvOrigin.${keyof typeof en.conversionNote.ncvOrigin}`;
type ConversionTranslator = (key: ConversionKey, values?: Record<string, string>) => string;

const DIGITS = { maximumSignificantDigits: 15 } as const;

/** Describe the sourced step actually returned by the current preview. */
export function conversionNote(snapshot: ActivityCalculationSnapshot | null,
  pending: boolean, locale: Locale, translate: ConversionTranslator, sealDates: SealDates | null = null,
): string | null {
  if (pending || !isProvenanceSnapshot(snapshot) || !snapshot.conversion) return null;
  const conversion = snapshot.conversion;
  // The conversion release's seal date (UAT round 2, S2), when the list knows it.
  const sealedAt = sealDateFor(sealDates, conversion.release.id);
  const sealed = sealedAt ? ` ${translate('conversionNote.sealedOn', { date: formatSealDate(sealedAt, locale) })}` : '';
  const release = {
    conditions: conversion.referenceConditions ?? translate('conversionNote.unknownConditions'),
    publisher: conversion.release.publisher,
    edition: conversion.release.edition,
    status: translate(`conversionNote.status.${conversion.release.status}`),
  };
  // The TR natural gas chain (LP4-02, D5): the record's own NCV sets the
  // multiplier, so the note names that NCV and the whole step from the unit
  // entered, never the row's multiplier or its derivation from the default.
  const inputs = 'parameters' in snapshot ? snapshot.parameters : [];
  const ncv = inputs.find((p) => p.name === 'ncvKcalPerSm3');
  if (ncv && snapshot.conversionFactor !== undefined) {
    const volume = inputs.find((p) => p.name === 'volumeCorrectionFactor');
    return translate('conversionNote.ncvDetail', {
      fromUnit: unitSymbol(snapshot.inputUnit),
      toUnit: unitSymbol(snapshot.normalizedUnit),
      multiplier: formatNumber(snapshot.conversionFactor, locale, DIGITS),
      ncv: formatNumber(ncv.value, locale, { maximumFractionDigits: 2 }),
      origin: translate(`conversionNote.ncvOrigin.${ncv.origin}`),
      volume: volume ? translate('conversionNote.volumeCorrection', { factor: formatNumber(volume.value, locale, DIGITS) }) : '',
      ...release,
    }) + sealed;
  }
  return translate('conversionNote.detail', {
    fromUnit: unitSymbol(conversion.fromUnit),
    toUnit: unitSymbol(conversion.toUnit),
    multiplier: formatNumber(conversion.multiplier, locale, DIGITS),
    calorificBasis: translate(`conversionNote.basis.${conversion.calorificBasis}`),
    basis: conversion.basis,
    ...release,
  }) + sealed;
}
