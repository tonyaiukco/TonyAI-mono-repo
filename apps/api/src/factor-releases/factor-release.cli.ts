/**
 * `pnpm --filter @tonyai/api factor-release <command>` — the factor library's
 * loader (LP4-02; decisions L5, P1–P9). Releases are loaded here and nowhere
 * else: the service role writes nothing in the library, the API only reads it,
 * and the seed loads the local placeholder library alone.
 *
 * Usage (arguments after the script name):
 *
 *   pnpm --filter @tonyai/api factor-release load --file=<release.json> --operator=<firm or role> \
 *     [--supersedes=<edition> --reason=<why>] [--apply] [--allow-remote]
 *   pnpm --filter @tonyai/api factor-release withdraw --publisher=<name> --edition=<edition> \
 *     --reason=<why> --operator=<firm or role> [--apply] [--allow-remote]
 *
 *   --apply          write; without it every command is a dry run that prints its plan
 *   --allow-remote   required for --apply off a loopback database — a guard against a
 *                    typo, not a control (a tunnel to production is "localhost" too)
 *
 * `load` reads a release file in the import contract's shape
 * (`FactorReleaseImport` in @tonyai/shared-types), checks it with
 * `validateFactorReleaseImport` — a release under a publisher the registry does
 * not hold, or an authoritative one without its provenance, never reaches the
 * database — and loads the release, its factors and conversions and its seal
 * in one transaction. An erratum is a new edition with the next ordinal:
 * `--supersedes` withdraws the edition it corrects in the same transaction.
 * Re-run with the same file it is a no-op; a different file under a loaded
 * edition is refused. `withdraw` withdraws one release that has no replacement.
 *
 * `--operator` names a firm or a role, never a person: it is the stated actor
 * of every event the library's record writes, and a withdrawal's
 * `withdrawn_by`.
 *
 * Connects with FACTOR_LOADER_DATABASE_URL — the `tonyai_factor_loader` login,
 * provisioned per environment — and refuses any other login (the owner would
 * load past the loader's bounds). Locally `set -a; source apps/api/.env; set +a`
 * first.
 *
 * Prints one JSON report. Exit code 0 when done (or planned); 2 on a usage
 * error, a refusal (with every issue the file has) or a failure.
 *
 * In the API image: `node dist/factor-releases/factor-release.cli.js <command> [flags]`.
 */
import { statSync, readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@tonyai/db';
import { FactorReleaseLoader, LoaderRefusal, type LoadReport, type WithdrawReport } from './factor-release-loader';

export class UsageError extends Error {}

export type Command = 'load' | 'withdraw';

export interface Options {
  command: Command;
  operator: string;
  apply: boolean;
  allowRemote: boolean;
  file?: string;
  supersedes?: string;
  reason?: string;
  publisher?: string;
  edition?: string;
}

/** Far above any published edition (DESNZ's full set is a few MB as JSON), far below a memory problem. */
export const FACTOR_RELEASE_FILE_MAX_BYTES = 16 * 1024 * 1024;

const FLAGS: Record<Command, { valued: string[]; required: string[] }> = {
  load: { valued: ['file', 'operator', 'supersedes', 'reason'], required: ['file', 'operator'] },
  withdraw: { valued: ['publisher', 'edition', 'reason', 'operator'], required: ['publisher', 'edition', 'reason', 'operator'] },
};
const SWITCHES = ['apply', 'allow-remote'];

/** Control, formatting, surrogate and default-ignorable characters — as the contract refuses in a release's text. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why a stated text is unacceptable — the bounds of the record's `actor` and the release's text CHECKs — or null. */
function textIssue(value: string, max: number): string | null {
  if (value !== value.trim()) return 'has leading or trailing white space';
  if (value.length > max) return `is longer than ${max} characters`;
  if (CONTROL_OR_FORMAT.test(value)) return 'contains a control or invisible formatting character';
  if (value !== value.normalize('NFC')) return 'is not in Unicode NFC form';
  return null;
}

export function parseArgs(argv: string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const [command, ...rest] = args;
  if (command !== 'load' && command !== 'withdraw') throw new UsageError('Name a command: load or withdraw');
  const spec = FLAGS[command];
  const flags = new Map<string, string | true>();
  for (const arg of rest) {
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!match) throw new UsageError(`Unknown argument "${arg}"`);
    const [, name, value] = match;
    if (flags.has(name)) throw new UsageError(`--${name} is given twice`);
    if (SWITCHES.includes(name)) {
      if (value !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (spec.valued.includes(name)) {
      if (value === undefined || value.trim() === '') throw new UsageError(`--${name} needs a value: --${name}=<value>`);
      // As written: a stated name or reason is recorded verbatim, so it is
      // refused rather than quietly cleaned.
      flags.set(name, value);
    } else {
      throw new UsageError(`Unknown flag --${name} for ${command}`);
    }
  }
  for (const name of spec.required) if (!flags.has(name)) throw new UsageError(`${command} needs --${name}`);
  const text = (name: string) => flags.get(name) as string | undefined;

  const operator = text('operator')!;
  const operatorIssue = EMAIL_SHAPE.test(operator) ? 'is an address — name a firm or a role, never a person' : textIssue(operator, 200);
  if (operatorIssue) throw new UsageError(`--operator ${operatorIssue}`);
  const reason = text('reason');
  const reasonIssue = reason === undefined ? null : textIssue(reason, 2000);
  if (reasonIssue) throw new UsageError(`--reason ${reasonIssue}`);

  const options: Options = { command, operator, apply: flags.has('apply'), allowRemote: flags.has('allow-remote') };
  if (command === 'load') {
    if (flags.has('supersedes') !== flags.has('reason')) {
      throw new UsageError('an erratum names the edition it supersedes and why: --supersedes=<edition> --reason=<why>, together');
    }
    options.file = text('file');
    if (flags.has('supersedes')) {
      options.supersedes = text('supersedes');
      options.reason = reason;
    }
  } else {
    options.publisher = text('publisher');
    options.edition = text('edition');
    options.reason = reason;
  }
  return options;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** What a local URL may carry — `runtime-role.mjs`'s list: anything else (`host`, `hostaddr`, `options`) could send it elsewhere. */
const LOCAL_URL_PARAMS = new Set([
  'schema', 'connection_limit', 'pool_timeout', 'connect_timeout', 'socket_timeout',
  'statement_cache_size', 'pgbouncer', 'sslmode', 'application_name',
]);

/**
 * True only when `url` plainly points at this machine: a loopback host and no
 * parameter that could redirect it (Prisma honours `?host=` over the URL's
 * host). An allowlist, as `runtime-role.mjs`'s `isLoopbackUrl`. A guard
 * against a typo, not proof: a tunnel to production is "localhost" too.
 */
export function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:') &&
      LOOPBACK_HOSTS.has(parsed.hostname) &&
      [...parsed.searchParams.keys()].every((key) => LOCAL_URL_PARAMS.has(key))
    );
  } catch {
    return false;
  }
}

/** The run's refusals that depend on where it points — testable alone. */
export function refuseUnsafe(options: Options, local: boolean): void {
  if (options.apply && !local && !options.allowRemote) {
    throw new UsageError(
      '--apply off a loopback database needs --allow-remote: this writes the factor library every tenant is priced from.',
    );
  }
}

/** The release file as JSON, unvalidated — the import contract checks it. */
export function readReleaseFile(path: string): unknown {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new UsageError(`${path} is not a file`);
    size = stat.size;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  if (size > FACTOR_RELEASE_FILE_MAX_BYTES) {
    throw new UsageError(`${path} is larger than ${FACTOR_RELEASE_FILE_MAX_BYTES / 1024 / 1024} MiB — not a release file`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`${path} is not JSON: ${(error as Error).message}`);
  }
}

export async function run(options: Options): Promise<LoadReport | WithdrawReport> {
  const url = process.env.FACTOR_LOADER_DATABASE_URL;
  if (!url) throw new UsageError("FACTOR_LOADER_DATABASE_URL (the factor loader's own login) is required");
  refuseUnsafe(options, isLocalDatabase(url));
  const input = options.command === 'load' ? readReleaseFile(options.file!) : undefined;
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const loader = new FactorReleaseLoader(db, options.operator);
    if (options.command === 'load') {
      return await loader.load(input, { apply: options.apply, supersedes: options.supersedes, reason: options.reason });
    }
    return await loader.withdraw({ publisher: options.publisher!, edition: options.edition!, reason: options.reason! }, options.apply);
  } finally {
    await db.$disconnect();
  }
}

type Sink = { write(chunk: string): boolean };

/**
 * The CLI, its exit code returned: 0 when done (or planned), 2 on a usage
 * error, a refusal (its report on `out`, every issue) or a failure. The code
 * is set, never forced: `process.exit()` right after a large write to a pipe
 * drops what the pipe has not taken yet, and the process ends on its own once
 * stdout drains.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  out: Sink = process.stdout,
  err: Sink = process.stderr,
  execute: (options: Options) => Promise<LoadReport | WithdrawReport> = run,
): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err.write(`${(error as Error).message}\n`);
    return 2;
  }
  try {
    out.write(`${JSON.stringify(await execute(options), null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof LoaderRefusal) {
      out.write(`${JSON.stringify({ outcome: 'refused', message: error.message, issues: error.issues }, null, 2)}\n`);
      return 2;
    }
    if (error instanceof UsageError) {
      err.write(`${error.message}\n`);
      return 2;
    }
    new Logger('factor-release').error(error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
    return 2;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
