import { captureException, flushSentry } from './sentry';
import { JsonLogger } from './json-logger';
import { scrubSecrets } from './scrub-secrets';

/** Past Sentry's own 5 s flush bound: a flush that never settles must not hold the process. */
const FLUSH_LIMIT_MS = 6_000;
const MESSAGE_LIMIT = 500;

/** A boot error's text, safe for a log and bounded. */
export function safeBootMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrubSecrets(text).slice(0, MESSAGE_LIMIT);
}

export interface BootFailureDeps {
  log: (fields: Record<string, unknown>) => void;
  capture: (error: unknown) => void;
  flush: () => Promise<unknown>;
  exit: (code: number) => void;
  flushLimitMs: number;
}

const realDeps = (): BootFailureDeps => {
  const logger = new JsonLogger();
  return {
    log: (fields) => logger.event('error', 'boot_failed', fields),
    capture: captureException,
    flush: flushSentry,
    exit: (code) => process.exit(code),
    flushLimitMs: FLUSH_LIMIT_MS,
  };
};

/**
 * A boot that fails ends the process with 1, whatever Sentry does. Without this
 * an unhandled rejection with Sentry on exited 0 (measured at G2), so an
 * orchestrator read a failed start as a clean one.
 */
export async function exitOnBootFailure(error: unknown, deps: BootFailureDeps = realDeps()): Promise<void> {
  try {
    deps.log({ errorName: error instanceof Error ? error.name : typeof error, message: safeBootMessage(error) });
    deps.capture(error);
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise((resolve) => {
      // Not unref'd: with an empty event loop the process would end at 0 before exit(1).
      timer = setTimeout(resolve, deps.flushLimitMs);
    });
    await Promise.race([deps.flush(), limit]).finally(() => clearTimeout(timer));
  } catch {
    // Reporting a failure must never change how the process ends.
  } finally {
    deps.exit(1);
  }
}
