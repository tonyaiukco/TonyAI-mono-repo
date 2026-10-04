import { captureException, flushSentry, initSentry, isSentryEnabled } from './sentry';

/** Owner-run, fixed synthetic message: no public error-injection route. */
const main = async (): Promise<void> => {
  await initSentry();
  if (!isSentryEnabled()) throw new Error('SENTRY_DSN is required for this check');
  captureException(new Error('TonyAI staging synthetic error-reporting check'));
  if (!await flushSentry()) throw new Error('Sentry delivery did not flush');
  process.stdout.write('Synthetic event flushed; operator receipt still requires verification.\n');
};

if (require.main === module) void main().catch(() => {
  process.stderr.write('Synthetic error-reporting check failed; details withheld.\n');
  process.exitCode = 1;
});
