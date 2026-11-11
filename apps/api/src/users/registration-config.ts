import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isPlaceholderConsentVersion,
  REGISTRATION_CODE_PATTERN,
  REGISTRATION_CONSENT_VERSION,
} from '@tonyai/shared-types';

/** Injection token for the registration settings (tests pass their own). */
export const REGISTRATION_CONFIG = Symbol('REGISTRATION_CONFIG');

export class RegistrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationConfigError';
  }
}

export interface RegistrationConfig {
  /** SHA-256 of the registration code — the code itself is not kept. */
  codeDigest: Buffer;
  consentVersion: string;
  consentIsPlaceholder: boolean;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Reads self-service registration's settings. Null when `REGISTRATION_CODE`
 * is not set: the code is the switch, so an environment without it has no
 * registration (the endpoints answer 404). A code of the wrong shape throws,
 * and so does a placeholder KVKK notice in an environment that has not said
 * `REGISTRATION_ALLOW_PLACEHOLDER_CONSENT=true` — the pilot cannot open
 * registration before the reviewed notice ships under a new version.
 * Never puts the code in an error.
 */
export function readRegistrationConfig(env: NodeJS.ProcessEnv = process.env): RegistrationConfig | null {
  const allow = env.REGISTRATION_ALLOW_PLACEHOLDER_CONSENT;
  if (allow !== undefined && allow !== 'true' && allow !== 'false') {
    throw new RegistrationConfigError("REGISTRATION_ALLOW_PLACEHOLDER_CONSENT must be 'true' or 'false'");
  }
  const code = env.REGISTRATION_CODE;
  if (code === undefined || code === '') return null;
  if (!REGISTRATION_CODE_PATTERN.test(code)) {
    throw new RegistrationConfigError('REGISTRATION_CODE must be exactly 5 letters or digits');
  }
  const consentIsPlaceholder = isPlaceholderConsentVersion(REGISTRATION_CONSENT_VERSION);
  if (consentIsPlaceholder && allow !== 'true') {
    throw new RegistrationConfigError(
      'Registration is enabled but the KVKK notice is a placeholder: ship the reviewed notice, or set REGISTRATION_ALLOW_PLACEHOLDER_CONSENT=true (never where real customers register)',
    );
  }
  return { codeDigest: digest(code), consentVersion: REGISTRATION_CONSENT_VERSION, consentIsPlaceholder };
}

/** Whether `submitted` is the environment's code — case-sensitive, and in
 *  constant time over digests, so neither length nor a matching prefix shows. */
export function registrationCodeMatches(config: RegistrationConfig, submitted: string): boolean {
  return timingSafeEqual(config.codeDigest, digest(submitted));
}
