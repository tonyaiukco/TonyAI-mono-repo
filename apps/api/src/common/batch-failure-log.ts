import { sanitiseCallerText } from './caller-text';

/** Distinct classes kept with a sample message. Realistically one. */
const MAX_CLASSES = 5;
/** Refs named in the line. Enough to find the rows, not to list a file. */
const MAX_REFS = 10;
/** Code points of a sample message. Prisma names the column well inside this. */
const MAX_MESSAGE = 240;
/** Code points of a class key. `code` is not ours, so it is bounded too. */
const MAX_CLASS_KEY = 60;
/** Code points of a ref. A record id is 36; a row number is a handful. */
const MAX_REF = 40;
/** Frames of the one kept stack, and the width of each. */
const MAX_TRACE_LINES = 30;
const MAX_TRACE_LINE = 200;

/**
 * The unexpected failures of ONE batch, folded into one log line.
 *
 * A bulk route maps every failure it understands onto a row-level code and
 * reports it in the response. Anything it does NOT understand was logged in
 * full — `String(error)` plus the stack — once per row. So a file whose every
 * row trips the same driver error wrote one Prisma stack, code frame included,
 * per row: 50 rows carrying a 2,001-character id measured at 148,542 bytes of
 * stderr, and at the 1,000-row cap that is roughly 3 MB for a single request,
 * five of which a user may send each minute. The response stayed small; the
 * whole cost was in the log.
 *
 * One line per batch, then, carrying what a real failure actually needs: how
 * many refs failed, WHICH ones, the distinct error classes with their counts,
 * a sample message and first ref per class, and ONE stack. A thousand copies
 * of the same frame debug nothing the first does not.
 *
 * It FOLDS as failures arrive rather than keeping the errors to summarise at
 * the end, because holding a thousand of these alive would trade 3 MB of
 * stderr for 3 MB of retained heap per concurrent request.
 *
 * THE BOUND, stated in the unit the code actually enforces: every field is
 * bounded in CODE POINTS, and the worst case is ~8,500 of them however the
 * batch fails. That is ~8.5 KB of ASCII and up to ~34 KB if every character
 * is a 4-byte astral one — against the ~3 MB it replaces, but four times the
 * ASCII figure, so the bytes are worth knowing before sizing a log budget.
 * `batch-failure-log.spec.ts` pins both.
 *
 * KVKK/GDPR: a bounded, cleaned excerpt of a cell value DOES reach the log
 * here, through the sample message and through the leading lines of a Prisma
 * stack, which quote the rejected argument. An uploaded cell can carry
 * personal data and these lines ship to a log aggregator, so the log surface
 * needs the retention answer that `batchDiff` gives the audit row by bounding
 * `fileName`. Before this class the same content reached the log unbounded and
 * uncleaned, once per row.
 *
 * Request-scoped BY CONSTRUCTION: the bulk services are Nest singletons, so an
 * instance belongs to a local of the batch method and never to a field on the
 * service, or two concurrent imports would report each other's failures.
 */
export class BatchFailureLog {
  private failures = 0;
  private readonly refs: string[] = [];
  private refsOmitted = 0;
  private readonly classes = new Map<
    string,
    { count: number; sample: string; firstRef: string }
  >();
  private classesOmitted = 0;
  private firstTrace: string | undefined;

  /**
   * @param subject singular name of what a ref points at — `row`, `record`.
   *   Pluralised by appending `s`, which is all these two words need.
   */
  constructor(private readonly subject: string) {}

  /** One unexpected failure, added where the refusal is classified. */
  add(ref: string | number, error: unknown): void {
    this.failures += 1;

    // Cleaned once, because the class below keeps it too. Computed here rather
    // than read back off `refs`, which stops accepting them after the tenth.
    const cleanRef = sanitiseCallerText(String(ref), MAX_REF, '…');
    if (this.refs.length < MAX_REFS) {
      this.refs.push(cleanRef);
    } else {
      this.refsOmitted += 1;
    }

    const key = classKeyOf(error);
    const seen = this.classes.get(key);
    if (seen) {
      seen.count += 1;
    } else if (this.classes.size < MAX_CLASSES) {
      // The FIRST message of a class, not the last: it names the column or the
      // character that broke. And the first REF of the class, because the named
      // refs above are whichever rows failed EARLIEST, not one per class — ten
      // transient timeouts on rows 1-10 would otherwise hide the fifty rows
      // that actually carry bad data behind "and 50 more".
      this.classes.set(key, {
        count: 1,
        sample: messageOf(error),
        firstRef: cleanRef,
      });
    } else {
      this.classesOmitted += 1;
    }

    // The first stack there IS, not the first failure's: `??=` keeps looking,
    // so a batch whose first failure was a thrown string still attaches the
    // next real error's frames.
    //
    // The contract that makes this work lives in `boundedTrace`, which answers
    // `undefined` and never `''`: an empty string is not nullish, so it would
    // end the search with nothing to show. Because of that contract `??=` and
    // `||=` are interchangeable HERE — the guard carries the load, not the
    // operator, and swapping the operator is not the mutation to worry about.
    this.firstTrace ??= boundedTrace(error);
  }

  /**
   * The one line to log and the one stack to attach — or `null` when nothing
   * failed unexpectedly, which is the normal case and must log nothing at all.
   */
  entry(): { message: string; trace: string | undefined } | null {
    if (this.failures === 0) return null;

    const subject = this.failures === 1 ? this.subject : `${this.subject}s`;
    const refs =
      this.refsOmitted > 0
        ? `${this.refs.join(', ')} and ${this.refsOmitted} more`
        : this.refs.join(', ');
    const classes = [...this.classes.entries()]
      .map(
        ([key, { count, sample, firstRef }]) =>
          `${key} ×${count} (first at ${firstRef}): ${sample}`,
      )
      .join(' | ');
    const unnamed =
      this.classesOmitted > 0
        ? `; ${this.classesOmitted} more in classes past the first ${MAX_CLASSES}`
        : '';

    return {
      message: `${this.failures} ${subject} failed unexpectedly (${refs}); ${classes}${unnamed}`,
      trace: this.firstTrace,
    };
  }
}

/** An error's class and code — never its value, which `messageOf` bounds. */
function classKeyOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.constructor.name : typeof error;
  // `code` is bounded BEFORE the interpolation, not after: a library free to
  // set it to a megabyte would otherwise have that megabyte copied per row
  // only to be thrown away. The result is bounded again, for `name`.
  const key =
    typeof code === 'string'
      ? `${name} ${sanitiseCallerText(code, MAX_CLASS_KEY, '…')}`
      : name;
  return sanitiseCallerText(key, MAX_CLASS_KEY, '…');
}

/**
 * The error's own text, cleaned and bounded.
 *
 * Cleaned because it is not ours: a Prisma parse failure quotes the character
 * it choked on, so a cell's U+202E reaches this line and would reorder
 * everything a reader sees after it. Bounded because those same messages quote
 * the rejected value, and a 2,001-character cell is how this was found.
 */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return sanitiseCallerText(text, MAX_MESSAGE, '…') || '(no message)';
}

/**
 * A stack made safe to log without being destroyed in the process.
 *
 * `sanitiseCallerText` drops C0 controls, newline among them, so running a
 * stack through it whole would fold thirty frames into one unreadable run.
 * Each line is cleaned on its own and the newlines are put back — which also
 * bounds the width of a Prisma code frame, whose query line carries the
 * caller's value verbatim.
 *
 * Those kept newlines are deliberate and they are ALSO attacker-reachable: a
 * newline inside a driver message is a real line boundary here, so in `pretty`
 * mode a cell can put a plausible-looking extra log line on screen. In `json`
 * mode — the production default — it is escaped inside one field, so no record
 * is split and no level is forged. Judged the right trade: a stack that cannot
 * be read is not worth keeping, and the alternative is no stack at all.
 *
 * `undefined`, never `''`, for an error with nothing to give: the caller uses
 * `??=` to take the first stack there is, and `''` would end that search.
 */
export function boundedTrace(error: unknown): string | undefined {
  const stack =
    error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  if (!stack) return undefined;
  const lines = stack.split('\n');
  const kept = lines
    .slice(0, MAX_TRACE_LINES)
    .map((line) => sanitiseCallerText(line, MAX_TRACE_LINE, '…'));
  if (lines.length > MAX_TRACE_LINES) {
    kept.push(`… ${lines.length - MAX_TRACE_LINES} more line(s)`);
  }
  return kept.join('\n');
}
