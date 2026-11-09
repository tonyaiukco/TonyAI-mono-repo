/**
 * Credentials taken out of an error's text before it reaches a log or Sentry:
 * Prisma's and a driver's errors can name a connection string. Order matters:
 * a URL goes whole before its parts could match.
 */
const PATTERNS: readonly [RegExp, string][] = [
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'],
  [/\bbearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey)\s*[=:]\s*\S+/gi, '$1=[redacted]'],
  [/\S+@\S+/g, '[redacted]'],
];

export function scrubSecrets(text: string): string {
  return PATTERNS.reduce((scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement), text);
}
