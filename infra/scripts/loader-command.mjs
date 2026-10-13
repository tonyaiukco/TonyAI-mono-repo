/** Run the built CLI locally without publishing its raw driver diagnostics. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loaderUrl } from './loader-identity.mjs';

const API_PATH = fileURLToPath(new URL('../../apps/api/', import.meta.url));
const OUTCOMES = {
  load: ['would_load', 'loaded', 'already_loaded'],
  withdraw: ['would_withdraw', 'withdrawn', 'already_withdrawn'],
};
export const FAILURE = 'FAIL: loader report withheld. Outcome may be unknown; reconcile through the owner before retrying. Credentials and driver details withheld.';

export const run = (env, args, execute = spawnSync, output = console.log) => {
  const url = loaderUrl(env);
  if (!Object.hasOwn(OUTCOMES, args[0])) throw new Error('Name load or withdraw.');
  const result = execute(process.execPath, ['dist/factor-releases/factor-release.cli.js', ...args], {
    cwd: API_PATH,
    // Only this explicit environment is passed at spawn; Prisma can subsequently
    // load .env files. The runbook requires an environment-file-free checkout.
    env: { FACTOR_LOADER_DATABASE_URL: url, NODE_ENV: 'production', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: 360_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr) throw new Error(FAILURE);
  const report = JSON.parse(result.stdout);
  if (report?.command !== args[0] || !OUTCOMES[args[0]].includes(report.outcome)) throw new Error(FAILURE);
  const text = JSON.stringify(report, null, 2);
  // Success reports contain metadata, never credentials. Refuse even if a future
  // CLI accidentally embeds its URL/password inside an otherwise valid report.
  if (text.includes(url) || text.includes(new URL(url).password)) throw new Error(FAILURE);
  output(text);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    run(process.env, process.argv.slice(2));
  } catch {
    console.error(FAILURE);
    process.exitCode = 2;
  }
}
