import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrub-secrets';

describe('scrubSecrets', () => {
  it.each([
    ['a URL', 'at postgresql://tonyai_runtime:s3cret@db.example.com:5432/postgres?sslmode=require now', 'at [url] now'],
    ['a scheme-less login', 'user:s3cret@host:5432/db refused', '[redacted] refused'],
    ['a key=value connection string', 'host=db password=s3cret port=5', 'host=db password=[redacted] port=5'],
    ['a query string', 'failed ?password=s3cret', 'failed ?password=[redacted]'],
    ['a bearer token', 'sent Bearer abc.def.ghi', 'sent Bearer [redacted]'],
    ['a URL whose password holds a space', 'postgres://u:p ss@h down', '[url] [redacted] down'],
    ['an email address', 'no profile for a.person@example.com', 'no profile for [redacted]'],
  ])('takes out %s', (_case, text, expected) => {
    expect(scrubSecrets(text)).toBe(expected);
    expect(scrubSecrets(text)).not.toContain('s3cret');
  });

  it("keeps a message with no secret, so an operator can still read what failed", () => {
    const text = "Can't reach database server at `127.0.0.1:1`. Set SUPABASE_JWT_SECRET.";
    expect(scrubSecrets(text)).toBe(text);
  });
});
