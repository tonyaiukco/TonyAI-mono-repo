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
 * a sample message per class, and ONE stack. A thousand copies of the same
 * frame debug nothing the first does not.
 *
 * It FOLDS as failures arrive rather than keeping the errors to summarise at
 * the end, because holding a thousand of these alive would trade 3 MB of
 * stderr for 3 MB of retained heap per concurrent request. Every field is
 * bounded, so an instance costs a few KB whatever the batch does.
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
    { count: number; sample: string }
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

    if (this.refs.length < MAX_REFS) {
      this.refs.push(sanitiseCallerText(String(ref), MAX_REF, '…'));
    } else {
      this.refsOmitted += 1;
    }

    const key = classKeyOf(error);
    const seen = this.classes.get(key);
    if (seen) {
      seen.count += 1;
    } else if (this.classes.size < MAX_CLASSES) {
      // The FIRST message of a class, not the last: it names the column or the
      // character that broke, and for the first class it is the message whose
      // stack is the one attached.
      this.classes.set(key, { count: 1, sample: messageOf(error) });
    } else {
      this.classesOmitted += 1;
    }

    // The first stack there IS: `??=` keeps looking, so a batch whose first
    // failure was a thrown string still attaches the next real error's frames.
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
      .map(([key, { count, sample }]) => `${key} ×${count}: ${sample}`)
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
  const key = typeof code === 'string' ? `${name} ${code}` : name;
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
 */
export function boundedTrace(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return undefined;
  }
  const lines = error.stack.split('\n');
  const kept = lines
    .slice(0, MAX_TRACE_LINES)
    .map((line) => sanitiseCallerText(line, MAX_TRACE_LINE, '…'));
  if (lines.length > MAX_TRACE_LINES) {
    kept.push(`… ${lines.length - MAX_TRACE_LINES} more line(s)`);
  }
  return kept.join('\n');
}
