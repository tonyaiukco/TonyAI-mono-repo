import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { EvidenceReadingStatus } from '@tonyai/shared-types';
import { READER_LIMITS, type ReaderLimits } from './reader-limits';

/**
 * Text as it may be stored: control characters and unpaired surrogates become
 * U+FFFD. pdf.js answers `\u0000` for a glyph with no Unicode mapping, and
 * PostgreSQL's jsonb refuses both, which would roll back the upload that
 * stores the reading (qa-auditor review of PR B, P1). Never a space: a
 * quantity cell of unmapped glyphs must stay a cell that cannot be read, not
 * become an empty one (re-review, P2). Same length, so the characters'
 * positions in the row stay where pdf.js put them.
 */
export function storableText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i += 1;
        continue;
      }
    }
    const lone = code >= 0xd800 && code <= 0xdfff;
    out += code < 0x20 || code === 0x7f || lone ? '\ufffd' : text[i]!;
  }
  return out;
}

/** One positioned text item as the reader gives it (D1's `text` job). */
export interface ReaderItem {
  /** The string. */
  s: string;
  /** Baseline x and y, in points from the page's bottom left. */
  x: number;
  y: number;
  /** Width and height in points. */
  w: number;
  h: number;
  /** Rotated or skewed: ignored by the layout reader (D2). */
  k: boolean;
}

export interface ReaderPage {
  w: number;
  h: number;
  items: ReaderItem[];
}

/** A status about the file itself, stored as its reading. */
export type StoredUnreadStatus = Exclude<EvidenceReadingStatus, 'read'>;

/** Why nothing was read this time; never stored, a later request tries again. */
export type TransientReason = 'reader_busy' | 'reader_unavailable' | 'timed_out';

export type TextOutcome =
  | { kind: 'text'; pageCount: number; pages: ReaderPage[] }
  | { kind: 'unread'; status: StoredUnreadStatus; pageCount: number }
  | { kind: 'transient'; reason: TransientReason };

export interface CutPart {
  pageFrom: number;
  pageTo: number;
  /** Null when the part failed its object-by-object isolation check. */
  bytes: Buffer | null;
}

export type CutOutcome =
  | { kind: 'parts'; parts: CutPart[] }
  | { kind: 'failed'; reason: 'isolation' | 'timed_out' | 'limit_exceeded' | 'failed' };

export interface ReaderSession {
  text(bytes: Buffer): Promise<TextOutcome>;
  cut(bytes: Buffer, ranges: Array<[number, number]>): Promise<CutOutcome>;
  /** What is left of the request's one budget (D1). */
  remainingMs(): number;
}

export type ReaderAvailability = 'pending' | 'available' | 'unavailable';

/** The producer every cut part carries, and nothing else of its source's metadata. */
export const PART_PRODUCER = 'TonyAI evidence assistant (invoice part)';

/** Environment names a macOS process gains on its own; an empty environment is otherwise empty. */
const PLATFORM_ENV_KEYS = new Set(['__CF_USER_TEXT_ENCODING']);

/** The worker file, beside this module in `src` and in `dist` (`nest-cli.json` assets). */
export const READER_WORKER_PATH = join(__dirname, 'pdf-reader.worker.mjs');

export const PDF_READER_OPTIONS = Symbol('PDF_READER_OPTIONS');

export interface PdfReaderOptions {
  limits?: Partial<ReaderLimits>;
  workerPath?: string;
  /** Tests: told each child's pid when it starts. */
  onSpawn?: (pid: number) => void;
}

type JobExit =
  | { exit: 'answer'; value: Record<string, unknown> }
  | { exit: 'deadline' }
  | { exit: 'memory' }
  | { exit: 'output' }
  | { exit: 'crash'; heap: boolean };

/** The directory of package `name` as seen from directory `from`, walking up `node_modules` as Node does; real path. */
function packageDir(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * What the child may read: the pnpm container of each package the reader
 * loads and of each package those depend on — never a `node_modules` root.
 * A root holds pnpm's workspace links (`.pnpm/node_modules/@tonyai/api` →
 * `apps/api`), and Node's permission model follows a symlink out of a granted
 * directory (devops-cloud and security-rls review of PR B, P2: `apps/api/.env`
 * was readable that way). A package's own directory holds no such link.
 */
function packageClosure(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      // An optional dependency left out of the install (the canvas addon) is simply not granted.
      const found = packageDir(dep, dirname(dir));
      if (found) queue.push(found);
    }
  }
  // Each package's pnpm container (`.pnpm/<pkg>@<ver>/node_modules`): the
  // package and its dependencies' links, which Node resolves through and the
  // permission model checks as written. Outside pnpm's store, the package alone.
  return [...new Set([...seen].map(containerOf))].sort();
}

function containerOf(packageDirectory: string): string {
  const parts = packageDirectory.split(sep);
  const store = parts.lastIndexOf('.pnpm');
  if (store >= 0 && parts[store + 2] === 'node_modules') return parts.slice(0, store + 3).join(sep);
  return packageDirectory;
}

function resolveModules(): { pdfjs: string; pdfjsDir: string; pdfLib: string; roots: string[]; apiDir: string } {
  const pdfjsDir = dirname(realpathSync(require.resolve('pdfjs-dist/package.json')));
  const pdfLib = realpathSync(require.resolve('@cantoo/pdf-lib'));
  const pdfLibDir = packageDir('@cantoo/pdf-lib', __dirname);
  if (!pdfLibDir) throw new Error('@cantoo/pdf-lib not found');
  const roots = packageClosure([pdfjsDir, pdfLibDir]);
  return { pdfjs: join(pdfjsDir, 'legacy', 'build', 'pdf.mjs'), pdfjsDir, pdfLib, roots, apiDir: realpathSync(join(__dirname, '..', '..')) };
}

/**
 * Paths outside the grant that must stay unreadable: the API's own package
 * file, and the same file reached through a workspace link under every
 * `node_modules` above the reader's packages (where one exists).
 */
function forbiddenReads(apiDir: string, roots: string[]): string[] {
  const out = [join(apiDir, 'package.json')];
  for (const root of roots) {
    let dir = root;
    for (;;) {
      const link = join(dir, 'node_modules', '.pnpm', 'node_modules', '@tonyai', 'api', 'package.json');
      if (existsSync(link)) out.push(link);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...new Set(out)];
}

/** The child's resident memory in KiB, or null if it cannot be read on this platform. */
function residentKb(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return Promise.resolve(match ? Number(match[1]) : null);
    } catch {
      return Promise.resolve(null);
    }
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1_000 }, (error, stdout) => {
        const kb = Number(String(stdout).trim());
        resolve(error || !Number.isFinite(kb) || kb <= 0 ? null : kb);
      });
    });
  }
  return Promise.resolve(null);
}

/**
 * The evidence assistant's PDF reader (inc29-evidence-assistant, design D1):
 * one short-lived process per job, never in the API's own, one at a time.
 *
 * - **Isolation.** The child runs `pdf-reader.worker.mjs` under Node's
 *   permission model (it reads only that file and the installed packages; no
 *   child process, worker, addon or WASI), with an empty environment (no
 *   database URL, no service key, no managed identity's endpoint or header),
 *   network entry points disabled before any parser code loads, and no code
 *   from strings. `start()` proves each of these in the running runtime before
 *   the first file is read; until it has, or if any fails, the reader is
 *   unavailable and every file is stored unread (`reader_unavailable`).
 * - **Limits.** A V8 heap cap, a resident-memory cap sampled from outside (it
 *   counts buffers, which a heap cap does not), a byte cap on the answer and
 *   the stderr kept, page and text-item counts, and one wall-clock budget per
 *   request shared by every job in it, each job also capped on its own. Past a
 *   deadline or a cap the child is killed (SIGKILL); it is always ended.
 * - **One at a time, refuse when busy**, as the report renderer does: a second
 *   request gets `reader_busy` at once and never waits.
 */
@Injectable()
export class PdfReaderService implements OnModuleDestroy {
  private readonly logger = new Logger('EvidenceAssistantReader');
  private readonly limits: ReaderLimits;
  private readonly workerPath: string;
  private readonly onSpawn?: (pid: number) => void;
  private availability: ReaderAvailability = 'pending';
  private startPromise: Promise<ReaderAvailability> | null = null;
  private modules: ReturnType<typeof resolveModules> | null = null;
  private busy = false;
  private readonly children = new Set<ReturnType<typeof spawn>>();

  constructor(@Optional() @Inject(PDF_READER_OPTIONS) options: PdfReaderOptions | null = null) {
    this.limits = { ...READER_LIMITS, ...options?.limits };
    this.workerPath = options?.workerPath ?? READER_WORKER_PATH;
    this.onSpawn = options?.onSpawn;
  }

  get state(): ReaderAvailability {
    return this.availability;
  }

  onModuleDestroy(): void {
    for (const child of this.children) child.kill('SIGKILL');
  }

  /**
   * Proves the reader's boundaries (once; later calls share the answer). Never
   * throws: a failure leaves the reader unavailable and is logged by the names
   * of the checks that failed.
   */
  start(): Promise<ReaderAvailability> {
    this.startPromise ??= this.selfTest().then(
      (failed) => {
        this.availability = failed.length === 0 ? 'available' : 'unavailable';
        if (failed.length === 0) this.logger.log('evidence_assistant_reader available: isolation proven');
        else this.logger.warn(`evidence_assistant_reader unavailable: ${failed.join(', ')}; files are stored unread`);
        return this.availability;
      },
      (error: unknown) => {
        this.availability = 'unavailable';
        this.logger.warn(`evidence_assistant_reader unavailable: self-test failed (${error instanceof Error ? error.name : 'Error'})`);
        return this.availability;
      },
    );
    return this.startPromise;
  }

  /**
   * Runs `fn` holding the one reader, within one budget for the whole request.
   * Answers `reader_busy` at once when another request holds it, and
   * `reader_unavailable` when isolation is not proven.
   */
  async withSession<T>(budgetMs: number, fn: (session: ReaderSession) => Promise<T>): Promise<T | { refused: 'reader_busy' | 'reader_unavailable' }> {
    if (this.availability !== 'available') return { refused: 'reader_unavailable' };
    if (this.busy) return { refused: 'reader_busy' };
    this.busy = true;
    const endsAt = Date.now() + Math.min(budgetMs, this.limits.requestMs);
    const remainingMs = () => Math.max(0, endsAt - Date.now());
    try {
      return await fn({
        remainingMs,
        text: (bytes) => this.text(bytes, remainingMs()),
        cut: (bytes, ranges) => this.cut(bytes, ranges, remainingMs()),
      });
    } finally {
      this.busy = false;
    }
  }

  private jobDeadline(remaining: number): { ms: number; full: boolean } {
    return remaining >= this.limits.jobMs ? { ms: this.limits.jobMs, full: true } : { ms: remaining, full: false };
  }

  private async text(bytes: Buffer, remaining: number): Promise<TextOutcome> {
    const deadline = this.jobDeadline(remaining);
    if (deadline.ms <= 0) return { kind: 'transient', reason: 'timed_out' };
    const result = await this.run({ job: 'text', limits: this.jobLimits() }, bytes, deadline.ms);
    switch (result.exit) {
      case 'deadline':
        // A file slower than the whole limit is the file's own outcome; one cut
        // short by the request's budget is tried again later (owner, 2026-11-28).
        return deadline.full ? { kind: 'unread', status: 'timed_out', pageCount: 0 } : { kind: 'transient', reason: 'timed_out' };
      case 'memory':
      case 'output':
        return { kind: 'unread', status: 'limit_exceeded', pageCount: 0 };
      case 'crash':
        return result.heap ? { kind: 'unread', status: 'limit_exceeded', pageCount: 0 } : { kind: 'transient', reason: 'reader_unavailable' };
      case 'answer':
        return this.textAnswer(result.value);
    }
  }

  private textAnswer(value: Record<string, unknown>): TextOutcome {
    const pageCount = typeof value.pageCount === 'number' && Number.isInteger(value.pageCount) && value.pageCount >= 0 ? value.pageCount : 0;
    if (value.ok !== true) {
      const status = value.status;
      if (status === 'encrypted' || status === 'unreadable' || status === 'limit_exceeded') return { kind: 'unread', status, pageCount };
      return { kind: 'transient', reason: 'reader_unavailable' };
    }
    // The answer's shape and cardinality are checked before anything uses it.
    const pages = value.pages;
    if (!Array.isArray(pages) || pages.length !== pageCount || pageCount > this.limits.maxPages) {
      return { kind: 'transient', reason: 'reader_unavailable' };
    }
    let items = 0;
    let chars = 0;
    const out: ReaderPage[] = [];
    for (const page of pages as unknown[]) {
      const p = page as { w?: unknown; h?: unknown; items?: unknown };
      if (typeof p.w !== 'number' || typeof p.h !== 'number' || !Array.isArray(p.items)) return { kind: 'transient', reason: 'reader_unavailable' };
      const list: ReaderItem[] = [];
      for (const raw of p.items as unknown[]) {
        const it = raw as Partial<ReaderItem>;
        if (typeof it.s !== 'string' || ![it.x, it.y, it.w, it.h].every((n) => typeof n === 'number' && Number.isFinite(n))) {
          return { kind: 'transient', reason: 'reader_unavailable' };
        }
        items += 1;
        chars += it.s.length;
        list.push({ s: storableText(it.s), x: it.x!, y: it.y!, w: it.w!, h: it.h!, k: it.k === true });
      }
      out.push({ w: p.w, h: p.h, items: list });
    }
    if (items > this.limits.maxItems || chars > this.limits.maxChars) return { kind: 'unread', status: 'limit_exceeded', pageCount };
    if (items === 0) return { kind: 'unread', status: 'no_text', pageCount };
    return { kind: 'text', pageCount, pages: out };
  }

  private async cut(bytes: Buffer, ranges: Array<[number, number]>, remaining: number): Promise<CutOutcome> {
    const deadline = this.jobDeadline(remaining);
    if (deadline.ms <= 0 || ranges.length === 0) return { kind: 'failed', reason: ranges.length === 0 ? 'failed' : 'timed_out' };
    const result = await this.run({ job: 'cut', ranges, producer: PART_PRODUCER }, bytes, deadline.ms);
    if (result.exit === 'deadline') return { kind: 'failed', reason: 'timed_out' };
    if (result.exit === 'memory' || result.exit === 'output' || (result.exit === 'crash' && result.heap)) return { kind: 'failed', reason: 'limit_exceeded' };
    if (result.exit !== 'answer') return { kind: 'failed', reason: 'failed' };
    const value = result.value;
    if (value.ok !== true) return { kind: 'failed', reason: value.reason === 'isolation' ? 'isolation' : 'failed' };
    const parts = value.parts;
    if (!Array.isArray(parts) || parts.length !== ranges.length) return { kind: 'failed', reason: 'failed' };
    const out: CutPart[] = [];
    for (const [i, raw] of (parts as unknown[]).entries()) {
      const part = raw as { pageFrom?: unknown; pageTo?: unknown; pdf?: unknown; refused?: unknown };
      const [from, to] = ranges[i]!;
      if (part.pageFrom !== from || part.pageTo !== to) return { kind: 'failed', reason: 'failed' };
      if (part.refused === 'isolation') {
        out.push({ pageFrom: from, pageTo: to, bytes: null });
        continue;
      }
      if (typeof part.pdf !== 'string') return { kind: 'failed', reason: 'failed' };
      const pdf = Buffer.from(part.pdf, 'base64');
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { kind: 'failed', reason: 'failed' };
      out.push({ pageFrom: from, pageTo: to, bytes: pdf });
    }
    return { kind: 'parts', parts: out };
  }

  private jobLimits() {
    return { maxPages: this.limits.maxPages, maxItems: this.limits.maxItems, maxChars: this.limits.maxChars };
  }

  private nodeArgs(extraRead: string[] = []): string[] {
    const modules = (this.modules ??= resolveModules());
    // The worker by its real path: the permission model checks the path as
    // given, and resolving a symlinked one (macOS' /var → /private/var) would
    // need its parents.
    const worker = existsSync(this.workerPath) ? realpathSync(this.workerPath) : this.workerPath;
    return [
      `--max-old-space-size=${this.limits.heapMb}`,
      '--permission',
      `--allow-fs-read=${worker}`,
      ...modules.roots.map((root) => `--allow-fs-read=${root}`),
      ...extraRead.map((path) => `--allow-fs-read=${path}`),
      '--disallow-code-generation-from-strings',
      '--no-warnings',
      worker,
    ];
  }

  /** One job in one child: the header line, the bytes, one JSON answer. */
  private run(header: Record<string, unknown>, bytes: Buffer, deadlineMs: number, onPid?: (pid: number) => void): Promise<JobExit> {
    const modules = (this.modules ??= resolveModules());
    return new Promise<JobExit>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, this.nodeArgs(), { env: {}, cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        resolve({ exit: 'crash', heap: false });
        return;
      }
      this.children.add(child);
      if (child.pid !== undefined) {
        this.onSpawn?.(child.pid);
        onPid?.(child.pid);
      }
      let verdict: JobExit | null = null;
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      const kill = (why: JobExit) => {
        verdict ??= why;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill({ exit: 'deadline' }), deadlineMs);
      const sampleMs = process.platform === 'darwin' ? Math.max(this.limits.rssSampleMs, 100) : this.limits.rssSampleMs;
      const sampler = setInterval(() => {
        if (child.pid === undefined || verdict) return;
        void residentKb(child.pid).then((kb) => {
          if (kb !== null && kb > this.limits.rssMb * 1024) kill({ exit: 'memory' });
        });
      }, sampleMs);
      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.limits.outputBytes) kill({ exit: 'output' });
        else stdout.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (stderr.length < this.limits.stderrBytes) stderr += chunk.toString('utf8').slice(0, this.limits.stderrBytes - stderr.length);
      });
      child.stdin!.on('error', () => undefined);
      child.on('error', () => kill({ exit: 'crash', heap: false }));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearInterval(sampler);
        this.children.delete(child);
        if (verdict) return resolve(verdict);
        const heap = /heap out of memory|Reached heap limit/i.test(stderr);
        if (code !== 0 || signal) return resolve({ exit: 'crash', heap });
        try {
          const value = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown;
          if (value && typeof value === 'object' && !Array.isArray(value)) return resolve({ exit: 'answer', value: value as Record<string, unknown> });
        } catch {
          // An answer that is not JSON is the reader's failure, not the file's.
        }
        resolve({ exit: 'crash', heap: false });
      });
      const line = JSON.stringify({ ...header, modules: { pdfjs: modules.pdfjs, pdfjsDir: modules.pdfjsDir, pdfLib: modules.pdfLib } });
      child.stdin!.write(`${line}\n`);
      child.stdin!.end(bytes);
    });
  }

  /** The names of the boundaries that did not hold; empty when the reader may run. */
  private async selfTest(): Promise<string[]> {
    if (!existsSync(this.workerPath)) return ['worker file missing'];
    try {
      this.modules ??= resolveModules();
    } catch {
      return ['packages unresolved'];
    }
    if ((await residentKb(process.pid)) === null) return ['memory sampling'];
    const dir = mkdtempSync(join(tmpdir(), 'tonyai-reader-'));
    const secretPath = join(dir, 'secret');
    writeFileSync(secretPath, 'not for the reader');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      });
      let sampled: Promise<boolean> = Promise.resolve(false);
      const result = await this.run({ job: 'selftest', port, secretPath, forbidden: forbiddenReads(this.modules.apiDir, this.modules.roots) }, Buffer.alloc(0), 15_000, (pid) => {
        sampled = residentKb(pid).then((kb) => kb !== null);
      });
      if (result.exit !== 'answer') return [`self-test ${result.exit}`];
      const value = result.value as { checks?: Record<string, string>; envKeys?: string[]; permission?: boolean };
      const failed = Object.entries(value.checks ?? {}).filter(([, outcome]) => outcome === 'allowed').map(([name]) => name);
      if (Object.keys(value.checks ?? {}).length !== 11) failed.push('checks incomplete');
      if (!Array.isArray(value.envKeys) || value.envKeys.some((key) => !PLATFORM_ENV_KEYS.has(key))) failed.push('environment');
      if (value.permission !== true) failed.push('permission model');
      if (connections !== 0) failed.push('loopback connection');
      if (!(await sampled)) failed.push('child memory sampling');
      return failed;
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Tests only: holds `megabytes` outside the heap for `holdMs` (the memory cap's own proof). */
  async allocateForTest(megabytes: number, holdMs: number): Promise<JobExit['exit']> {
    return (await this.run({ job: 'allocate', megabytes, holdMs }, Buffer.alloc(0), 30_000)).exit;
  }
}
