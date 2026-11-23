import { describe, expect, it, vi } from 'vitest';
import {
  acceptInvitationQuietly,
  EMPTY_REGISTRATION_FORM,
  isPublicPath,
  isSignedOutOnlyPath,
  MIN_PASSWORD_LENGTH,
  parseEmailLink,
  passwordProblem,
  registrationFailure,
  registrationNoticeIsCurrent,
  registrationProblem,
  registrationRequest,
  setPasswordFailureKey,
  signInFailureKey,
} from './auth-view';
import { REGISTRATION_CONSENT_VERSION } from './types';

describe('signInFailureKey', () => {
  it('words wrong credentials and a banned (disabled) account; everything else is generic', () => {
    expect(signInFailureKey('invalid_credentials')).toBe('signIn.invalidCredentials');
    expect(signInFailureKey('user_banned')).toBe('signIn.disabled');
    expect(signInFailureKey('email_provider_disabled')).toBe('signIn.failed');
    expect(signInFailureKey(undefined)).toBe('signIn.failed');
  });
});

describe('parseEmailLink — only a link the API built', () => {
  const parse = (query: string) => parseEmailLink(new URLSearchParams(query));
  const hash = 'a'.repeat(56);

  it('reads an invitation and a recovery link', () => {
    expect(parse(`token_hash=${hash}&type=invite`)).toEqual({ tokenHash: hash, type: 'invite' });
    expect(parse(`token_hash=${hash}&type=recovery`)).toEqual({ tokenHash: hash, type: 'recovery' });
  });

  it('refuses another link type, a missing or odd token', () => {
    expect(parse(`token_hash=${hash}&type=magiclink`)).toBeNull();
    expect(parse(`token_hash=${hash}&type=signup`)).toBeNull();
    expect(parse('type=invite')).toBeNull();
    expect(parse(`token_hash=short&type=invite`)).toBeNull();
    expect(parse(`token_hash=${encodeURIComponent('<script>')}${hash}&type=invite`)).toBeNull();
    expect(parse(`token_hash=${'a'.repeat(513)}&type=invite`)).toBeNull();
  });
});

describe('passwordProblem', () => {
  it(`asks for ${MIN_PASSWORD_LENGTH} characters (decision S9), then a matching repeat`, () => {
    const short = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
    const ok = 'x'.repeat(MIN_PASSWORD_LENGTH);
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordProblem(short, short)).toBe('tooShort');
    expect(passwordProblem(ok, `${ok}y`)).toBe('mismatch');
    expect(passwordProblem(ok, ok)).toBeNull();
  });
});

describe('setPasswordFailureKey', () => {
  it("words Supabase's weak and same-password refusals", () => {
    expect(setPasswordFailureKey('weak_password')).toBe('setPassword.weak');
    expect(setPasswordFailureKey('same_password')).toBe('setPassword.same');
    expect(setPasswordFailureKey('session_not_found')).toBe('setPassword.failed');
  });
});

describe('the proxy\'s paths (LP4-01)', () => {
  it('serves sign-in, forgot-password and the email-link pages without a session — and nothing else', () => {
    for (const path of ['/login', '/forgot-password', '/register', '/auth/confirm', '/auth/set-password', '/auth/confirm/x']) {
      expect(isPublicPath(path), path).toBe(true);
    }
    for (const path of ['/', '/users', '/audit', '/auth', '/auth/other', '/login-as', '/forgot-password-x', '/registered', '/register-admin', '/data-entry']) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it('sends a signed-in visitor from sign-in and forgot-password to the dashboard, never from the email-link pages', () => {
    expect(isSignedOutOnlyPath('/login')).toBe(true);
    expect(isSignedOutOnlyPath('/forgot-password')).toBe(true);
    // A signed-in person has an organisation already: registration is not for them.
    expect(isSignedOutOnlyPath('/register')).toBe(true);
    expect(isSignedOutOnlyPath('/auth/confirm')).toBe(false);
    expect(isSignedOutOnlyPath('/auth/set-password')).toBe(false);
  });
});

describe('the registration form (self-service registration)', () => {
  const COMPLETE = {
    firstName: ' Ada ',
    lastName: 'Yilmaz',
    companyName: ' Example Holding ',
    jobTitle: 'Sustainability Manager ',
    email: ' ada@example.test ',
    registrationCode: 'aB3x9',
    consent: true,
  };

  it('starts empty, with the notice not accepted', () => {
    expect(registrationProblem(EMPTY_REGISTRATION_FORM)).toBe('incomplete');
    expect(EMPTY_REGISTRATION_FORM.consent).toBe(false);
  });

  it.each(['firstName', 'lastName', 'companyName', 'jobTitle', 'email', 'registrationCode'] as const)(
    'stops on a blank %s — spaces alone are blank',
    (field) => {
      expect(registrationProblem({ ...COMPLETE, [field]: '' })).toBe('incomplete');
      expect(registrationProblem({ ...COMPLETE, [field]: '   ' })).toBe('incomplete');
    },
  );

  it('stops on a one-character company name — the default subsidiary carries it (K1)', () => {
    expect(registrationProblem({ ...COMPLETE, companyName: ' X ' })).toBe('companyNameTooShort');
    expect(registrationProblem({ ...COMPLETE, companyName: 'XY' })).toBeNull();
    // Blank still reads as incomplete, before the length.
    expect(registrationProblem({ ...COMPLETE, companyName: '  ' })).toBe('incomplete');
  });

  it('stops on the notice not accepted, only once every field is filled', () => {
    expect(registrationProblem({ ...COMPLETE, consent: false })).toBe('consentRequired');
    expect(registrationProblem({ ...COMPLETE, consent: false, email: '' })).toBe('incomplete');
    expect(registrationProblem(COMPLETE)).toBeNull();
  });

  it('builds the request: values trimmed, the notice version and language of the page, the code\'s case kept', () => {
    expect(registrationRequest(COMPLETE, 'tr')).toEqual({
      firstName: 'Ada',
      lastName: 'Yilmaz',
      companyName: 'Example Holding',
      jobTitle: 'Sustainability Manager',
      email: 'ada@example.test',
      registrationCode: 'aB3x9',
      consent: true,
      // This build's own notice version — never one the API reported.
      consentVersion: REGISTRATION_CONSENT_VERSION,
      language: 'tr',
    });
  });

  it('offers the form only when the API records consent to the notice this build shows', () => {
    expect(registrationNoticeIsCurrent({ consentVersion: REGISTRATION_CONSENT_VERSION, consentIsPlaceholder: true })).toBe(true);
    // Another build's notice (a rolling deploy, a stale tab): no form.
    expect(registrationNoticeIsCurrent({ consentVersion: 'kvkk-2027-01', consentIsPlaceholder: false })).toBe(false);
    expect(registrationNoticeIsCurrent({ consentVersion: '', consentIsPlaceholder: false })).toBe(false);
  });

  it('answers a wrong code at its field, a switched-off registration by replacing the form, anything else as a toast', () => {
    expect(registrationFailure({ status: 403, code: 'registration_code_invalid' })).toBe('codeInvalid');
    expect(registrationFailure({ status: 404, code: 'registration_unavailable' })).toBe('unavailable');
    expect(registrationFailure({ status: 429, code: 'rate_limited' })).toBe('other');
    expect(registrationFailure({ status: 400, code: 'validation_failed' })).toBe('other');
    expect(registrationFailure(new TypeError('Failed to fetch'))).toBe('other');
    expect(registrationFailure(null)).toBe('other');
  });
});

describe('acceptInvitationQuietly (pre-pilot defects)', () => {
  const noWait = vi.fn(async () => undefined);
  const failing = (status?: number) => Object.assign(new Error('x'), status === undefined ? {} : { status });

  it('accepts on the first try', async () => {
    const accept = vi.fn(async () => undefined);
    expect(await acceptInvitationQuietly(accept, noWait)).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('repeats a transient failure, a 5xx or a network error, until it goes through', async () => {
    const accept = vi.fn().mockRejectedValueOnce(failing(503)).mockRejectedValueOnce(failing()).mockResolvedValue(undefined);
    expect(await acceptInvitationQuietly(accept, noWait)).toBe(true);
    expect(accept).toHaveBeenCalledTimes(3);
  });

  it('stops at once on a refusal a repeat cannot change', async () => {
    for (const status of [400, 401, 403, 404]) {
      const accept = vi.fn().mockRejectedValue(failing(status));
      expect(await acceptInvitationQuietly(accept, noWait), String(status)).toBe(false);
      expect(accept).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after the last attempt and never throws', async () => {
    const accept = vi.fn().mockRejectedValue(failing(500));
    const wait = vi.fn(async () => undefined);
    expect(await acceptInvitationQuietly(accept, wait, 3)).toBe(false);
    expect(accept).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
