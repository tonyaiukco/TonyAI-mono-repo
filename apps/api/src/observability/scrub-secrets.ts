/**
 * Credentials taken out of an error's text before it reaches a log or Sentry:
 * Prisma's and a driver's errors can name a connection string. A URL goes whole
 * first, before its parts could match. A package path or a sentence about a
 * token stays readable: an operator still has to see what failed.
 */
const PATTERNS: readonly [RegExp, string][] = [
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'],
  [/\bbearer\s+[a-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  [/([a-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key))\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[redacted]'],
  // A login with no scheme, then an email address; `@tonyai/db` and `pkg@1.2.3` are neither.
  [/[^\s'"`@:]+:[^\s'"`@]*@\S+/g, '[redacted]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, '[redacted]'],
];

export function scrubSecrets(text: string): string {
  return PATTERNS.reduce((scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement), text);
}
