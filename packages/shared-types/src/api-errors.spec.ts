import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_PARAMS,
  API_ERROR_STATUS,
  CALCULATION_REFUSAL_CODES,
  CALCULATION_REFUSAL_STATUS,
  DEFAULT_LOCALE,
  DOMAIN_ERROR_STATUS,
  GENERIC_ERROR_STATUS,
  LOCALE_FORMAT_TAGS,
  SUPPORTED_LOCALES,
  genericErrorCode,
  isApiErrorCode,
  isGenericErrorCode,
  isLocale,
  type ApiErrorBody,
  type CalculationRefusalBody,
} from './index';

describe('the error-code registry', () => {
  it('adopts every calculation refusal code with its status', () => {
    for (const code of CALCULATION_REFUSAL_CODES) {
      expect(API_ERROR_STATUS[code], code).toBe(CALCULATION_REFUSAL_STATUS[code]);
    }
  });

  it('has no code in two groups — a later spread would silently change its status', () => {
    const groups = [
      Object.keys(GENERIC_ERROR_STATUS),
      Object.keys(DOMAIN_ERROR_STATUS),
      [...CALCULATION_REFUSAL_CODES],
    ];
    const all = groups.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(API_ERROR_CODES).toHaveLength(all.length);
  });

  it('spells every code in snake_case, the catalogue key shape', () => {
    for (const code of API_ERROR_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('answers each code with a 4xx or 5xx status', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
      expect(API_ERROR_STATUS[code], code).toBeLessThan(600);
    }
  });

  it('gives no 404 params — a not-found answer must not differ by why', () => {
    for (const code of Object.keys(API_ERROR_PARAMS)) {
      expect(API_ERROR_STATUS[code as keyof typeof API_ERROR_STATUS], code).not.toBe(404);
    }
  });

  it('declares params only for codes that exist', () => {
    for (const code of Object.keys(API_ERROR_PARAMS)) expect(isApiErrorCode(code), code).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(API_ERROR_STATUS)).toBe(true);
    expect(Object.isFrozen(API_ERROR_PARAMS)).toBe(true);
    expect(Object.isFrozen(API_ERROR_PARAMS.period_locked)).toBe(true);
  });
});

describe('isApiErrorCode / isGenericErrorCode', () => {
  it('accepts registered codes only', () => {
    expect(isApiErrorCode('record_changed')).toBe(true);
    expect(isApiErrorCode('no_factor')).toBe(true);
    expect(isApiErrorCode('not_a_code')).toBe(false);
    expect(isApiErrorCode(404)).toBe(false);
    expect(isApiErrorCode(undefined)).toBe(false);
  });

  it('is not fooled by Object.prototype keys', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isApiErrorCode(key), key).toBe(false);
      expect(isGenericErrorCode(key), key).toBe(false);
    }
  });

  it('tells generic codes from specific ones', () => {
    expect(isGenericErrorCode('not_found')).toBe(true);
    expect(isGenericErrorCode('record_not_found')).toBe(false);
    expect(isGenericErrorCode('no_factor')).toBe(false);
  });
});

describe('genericErrorCode', () => {
  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'payload_too_large'],
    [429, 'rate_limited'],
    [500, 'internal_error'],
    [502, 'internal_error'],
    [503, 'internal_error'],
    // A 4xx with no code of its own still gets a 4xx code, never a 5xx one.
    [405, 'bad_request'],
    [422, 'bad_request'],
  ] as const)('%i → %s', (status, code) => {
    expect(genericErrorCode(status)).toBe(code);
  });
});

describe('the contract types', () => {
  it('a calculation refusal body is an API error body', () => {
    expectTypeOf<CalculationRefusalBody>().toMatchTypeOf<ApiErrorBody>();
  });
});

describe('locales', () => {
  it('English is the default and every locale has a format tag', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(Object.keys(LOCALE_FORMAT_TAGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(LOCALE_FORMAT_TAGS.en).toBe('en-GB');
    expect(LOCALE_FORMAT_TAGS.tr).toBe('tr-TR');
  });

  it('isLocale accepts exactly the supported codes', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('tr')).toBe(true);
    for (const value of ['EN', 'tr-TR', 'de', '', ' en', null, undefined, 1]) {
      expect(isLocale(value), String(value)).toBe(false);
    }
  });
});
