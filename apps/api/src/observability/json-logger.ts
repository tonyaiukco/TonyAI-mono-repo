import type { LoggerService } from '@nestjs/common';
import { currentRequestContext } from './request-context';

/** Log levels as they appear in the JSON output (Nest's `log` maps to `info`). */
export type EventLevel = 'info' | 'warn' | 'error' | 'debug' | 'verbose';

/**
 * Structured logger: one JSON object per line, which is what every log
 * aggregator (Cloud Logging, Sentry, Loki) expects from a container's stdout.
 *
 * `LOG_FORMAT=pretty` keeps the human-readable form for local `pnpm dev`;
 * anything else (and the default in production) emits JSON.
 */
export class JsonLogger implements LoggerService {
  private readonly pretty: boolean;

  constructor(format = process.env.LOG_FORMAT) {
    this.pretty = format
      ? format === 'pretty'
      : process.env.NODE_ENV !== 'production';
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string) {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }

  /** Emit a log line with arbitrary structured fields merged in. */
  event(level: EventLevel, message: string, fields: Record<string, unknown>) {
    this.write(level, message, undefined, undefined, fields);
  }

  private write(
    level: EventLevel,
    message: unknown,
    context?: string,
    stack?: string,
    fields?: Record<string, unknown>,
  ): void {
    const ctx = currentRequestContext();
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: typeof message === 'string' ? message : safeStringify(message),
      ...(context ? { context } : {}),
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.userId ? { userId: ctx.userId } : {}),
      ...(fields ?? {}),
      ...(stack ? { stack } : {}),
    };

    const line = this.pretty ? formatPretty(entry) : safeStringify(entry);
    // Errors and warnings go to stderr so container runtimes classify them.
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

function formatPretty(entry: Record<string, unknown>): string {
  const { ts, level, msg, context, stack, ...rest } = entry;
  const extras = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : safeStringify(v)}`)
    .join(' ');
  return [
    String(ts).slice(11, 23),
    String(level).toUpperCase().padEnd(5),
    context ? `[${String(context)}]` : '',
    String(msg),
    extras,
    stack ? `\n${String(stack)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** JSON.stringify that survives circular refs and BigInt (Prisma counts). */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }) as string;
  } catch {
    return String(value);
  }
}
