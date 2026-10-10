import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, parseEmailLink, passwordProblem, setPasswordFailureKey, signInFailureKey } from './auth-view';

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
