/** Scheduled reconciliation: never send raw paths or child stderr to cloud logs. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export const containsTruncation = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    (key === 'truncated' && item === true) || containsTruncation(item));
};

export const classifyVerification = (exitCode: number, stdout: string): number => {
  if (![0, 1].includes(exitCode)) return 2;
  try {
    const report = JSON.parse(stdout);
    if (!report.buckets?.evidence || !report.buckets?.['import-sources']) return 2;
    return exitCode === 1 || containsTruncation(report) ? 1 : 0;
  } catch {
    return 2;
  }
};

export const runStorageVerification = (): void => {
  execFile(process.execPath, [join(__dirname, 'storage/reconcile.cli.js'), '--verify', '--allow-remote'], {
    timeout: 15 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    // A verify job is read-only even if defaults change in a future image.
    env: { ...process.env, STORAGE_CLEANUP_HOLD: '1' },
  }, (error, stdout) => {
    const code = error ? (typeof error.code === 'number' ? error.code : 2) : 0;
    const exitCode = classifyVerification(code, stdout);
    process.stdout.write(`${JSON.stringify({ event: 'storage_verify', exitCode })}\n`);
    process.exitCode = exitCode;
  });
};

if (require.main === module) runStorageVerification();
