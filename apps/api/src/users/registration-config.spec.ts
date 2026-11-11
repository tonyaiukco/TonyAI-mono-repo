import { describe, expect, it } from 'vitest';
import { isPlaceholderConsentVersion, REGISTRATION_CONSENT_VERSION } from '@tonyai/shared-types';
import { readRegistrationConfig, registrationCodeMatches, RegistrationConfigError } from './registration-config';

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;
const ALLOW = { REGISTRATION_ALLOW_PLACEHOLDER_CONSENT: 'true' };

describe('readRegistrationConfig — the code is the switch', () => {
  it('is off without a code, whatever the allowance says', () => {
    expect(readRegistrationConfig(env({}))).toBeNull();
    expect(readRegistrationConfig(env({ REGISTRATION_CODE: '' }))).toBeNull();
    expect(readRegistrationConfig(env(ALLOW))).toBeNull();
  });

  it('is on with a five-character code, and names the notice it serves', () => {
    const config = readRegistrationConfig(env({ REGISTRATION_CODE: 'aB3x9', ...ALLOW }));
    expect(config).toMatchObject({
      consentVersion: REGISTRATION_CONSENT_VERSION,
      consentIsPlaceholder: isPlaceholderConsentVersion(REGISTRATION_CONSENT_VERSION),
    });
  });

  it.each(['aB3x', 'aB3x9z', 'aB3 9', 'aB3-9', 'aB3x9\n', ' aB3x', 'ğB3x9'])('refuses to start on the code %j, and never repeats it', (code) => {
    let thrown: unknown;
    try {
      readRegistrationConfig(env({ REGISTRATION_CODE: code, ...ALLOW }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegistrationConfigError);
    expect((thrown as Error).message).not.toContain(code.trim());
  });

  it('refuses to start with registration on over a placeholder notice the environment has not allowed', () => {
    // The guard this test rests on: the shipped notice is still a placeholder.
    expect(isPlaceholderConsentVersion(REGISTRATION_CONSENT_VERSION)).toBe(true);
    expect(() => readRegistrationConfig(env({ REGISTRATION_CODE: 'aB3x9' }))).toThrow(/placeholder/);
    expect(() => readRegistrationConfig(env({ REGISTRATION_CODE: 'aB3x9', REGISTRATION_ALLOW_PLACEHOLDER_CONSENT: 'false' }))).toThrow(/placeholder/);
  });

  it.each(['yes', '1', 'TRUE', ''])('refuses the allowance %j — true or false only, even with registration off', (value) => {
    expect(() => readRegistrationConfig(env({ REGISTRATION_ALLOW_PLACEHOLDER_CONSENT: value }))).toThrow(RegistrationConfigError);
  });
});

describe('registrationCodeMatches', () => {
  const config = readRegistrationConfig(env({ REGISTRATION_CODE: 'aB3x9', ...ALLOW }))!;

  it('accepts the code exactly, and keeps a digest rather than the code', () => {
    expect(registrationCodeMatches(config, 'aB3x9')).toBe(true);
    expect(JSON.stringify(config)).not.toContain('aB3x9');
    expect(config.codeDigest).toHaveLength(32);
  });

  it.each(['AB3X9', 'ab3x9', 'aB3x', 'aB3x9 ', '', 'aB3x90', 'x'.repeat(64)])('refuses %j — case matters, and any length is compared safely', (submitted) => {
    expect(registrationCodeMatches(config, submitted)).toBe(false);
  });
});
