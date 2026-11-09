import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrub-secrets';

describe('scrubSecrets', () => {
  it.each([
    ['a URL', 'at postgresql://tonyai_runtime:s3cret@db.example.com:5432/postgres?sslmode=require now', 'at [url] now'],
    ['a scheme-less login', 'user:s3cret@host:5432/db refused', '[redacted] refused'],
    ['a key=value connection string', 'host=db password=s3cret port=5', 'host=db password=[redacted] port=5'],
    ['a query string', 'failed ?password=s3cret', 'failed ?password=[redacted]'],
    ['an environment name holding the secret', 'SUPABASE_JWT_SECRET=s3cret is short', 'SUPABASE_JWT_SECRET=[redacted] is short'],
    ['a prefixed key', 'access_token=s3cret and client_secret: s3cret', 'access_token=[redacted] and client_secret=[redacted]'],
    ['a quoted value with a space', 'password: "s3cret long pass" given', 'password=[redacted] given'],
    ['a bearer token', 'sent Bearer abc.s3cret.ghi', 'sent Bearer [redacted]'],
    ['an email address', 'no profile for s3cret.person@example.com', 'no profile for [redacted]'],
  ])('takes out %s', (_case, text, expected) => {
    expect(scrubSecrets(text)).toBe(expected);
    expect(scrubSecrets(text)).not.toContain('s3cret');
  });

  it.each([
    "Can't reach database server at `127.0.0.1:1`.",
    'Set SUPABASE_JWT_SECRET.',
    "Cannot find module '@tonyai/db'",
    '/app/node_modules/.pnpm/@nestjs+core@11.1.6/node_modules/@nestjs/core/index.js',
    'Missing bearer token',
    'The token expired',
  ])('keeps a message with no secret, so an operator can read what failed: %s', (text) => {
    expect(scrubSecrets(text)).toBe(text);
  });
});
