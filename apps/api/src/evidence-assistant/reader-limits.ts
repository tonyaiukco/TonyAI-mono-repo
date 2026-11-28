/**
 * The PDF reader's limits (inc29-evidence-assistant, design D1). Constants in
 * code, set from task 2.4's measurements on the capped built API — NOT
 * `LIMIT_DEFAULTS` keys: a key there must equal `infra/config/runtime-limits.json`,
 * and until an owner release carried it the hosted release tooling would refuse.
 * The 10 MiB evidence limit already bounds the input.
 */
export interface ReaderLimits {
  maxPages: number;
  maxItems: number;
  maxChars: number;
  jobMs: number;
  requestMs: number;
  heapMb: number;
  rssMb: number;
  rssSampleMs: number;
  outputBytes: number;
  stderrBytes: number;
}

export const READER_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  /** A PDF with more pages is not read (`limit_exceeded`). */
  maxPages: 120,
  /** Text items (non-blank) across the whole file. */
  maxItems: 60_000,
  /** Characters across those items. */
  maxChars: 1_500_000,
  /** One process's wall-clock limit: a read that passes it with the full limit is `timed_out` for good. */
  jobMs: 8_000,
  /**
   * One request's budget for every read, cut and check it makes (D1, D4): an
   * upload's split, or a comparison's lazy reads across the package's files.
   */
  requestMs: 20_000,
  /** The child's V8 heap (`--max-old-space-size`). */
  heapMb: 256,
  /** The child's resident memory, buffers included: past it the process is killed. */
  rssMb: 384,
  /** How often the child's resident memory is sampled. */
  rssSampleMs: 20,
  /** The answer read from the child's stdout; more is refused unread. */
  outputBytes: 24 * 1024 * 1024,
  /** What is kept of the child's stderr (logged by kind only, never its text). */
  stderrBytes: 64 * 1024,
});
