import { unitSymbol, isProvenanceSnapshot, type ActivityCalculationSnapshot, type Locale } from '@/lib/types';
import { formatNumber } from '@/lib/i18n/number';
import en from '@/messages/en/dataEntry.json';

type ConversionKey = 'conversionNote.detail' | 'conversionNote.unknownConditions'
  | `conversionNote.basis.${keyof typeof en.conversionNote.basis}`
  | `conversionNote.status.${keyof typeof en.conversionNote.status}`;
type ConversionTranslator = (key: ConversionKey, values?: Record<string, string>) => string;

/** Describe the sourced step actually returned by the current preview. */
export function conversionNote(snapshot: ActivityCalculationSnapshot | null,
  pending: boolean, locale: Locale, translate: ConversionTranslator,
): string | null {
  if (pending || !isProvenanceSnapshot(snapshot) || !snapshot.conversion) return null;
  const conversion = snapshot.conversion;
  return translate('conversionNote.detail', {
    fromUnit: unitSymbol(conversion.fromUnit),
    toUnit: unitSymbol(conversion.toUnit),
    multiplier: formatNumber(conversion.multiplier, locale, { maximumSignificantDigits: 15 }),
    calorificBasis: translate(`conversionNote.basis.${conversion.calorificBasis}`),
    basis: conversion.basis,
    conditions: conversion.referenceConditions ?? translate('conversionNote.unknownConditions'),
    publisher: conversion.release.publisher,
    edition: conversion.release.edition,
    status: translate(`conversionNote.status.${conversion.release.status}`),
  });
}
