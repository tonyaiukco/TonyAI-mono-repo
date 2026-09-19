import { sanitiseCallerText } from './caller-text';

const MAX_REFS = 10;
const MAX_REF = 40;
const MAX_MESSAGE = 240;
const MAX_CLASS_KEY = 60;
const MAX_TRACE_LINES = 30;
const MAX_TRACE_LINE = 200;

/**
 * One log line for the unexpected failures of a whole batch, not one per row.
 *
 * A thousand-row file that fails on a driver error would otherwise write a
 * thousand error lines with a thousand stacks (3 MB measured). The line names
 * how many failed, the first ten of them, and the FIRST failure with its
 * stack — what an operator needs to start from; which rows failed is in the
 * response the caller got. Everything that can carry caller text (a ref, an
 * error's message or `code`, a stack line quoting a cell) is cleaned and
 * bounded, so the line cannot be broken or forged from a spreadsheet.
 *
 * Create one per request, never as a service field: a Nest service is a
 * singleton, and two imports would share it.
 */
export class BatchFailureLog {
  private failures = 0;
  private readonly refs: string[] = [];
  private first: { summary: string; trace: string | undefined } | undefined;

  constructor(private readonly subject: string) {}

  add(ref: string | number, error: unknown): void {
    this.failures += 1;
    if (this.refs.length < MAX_REFS) {
      this.refs.push(sanitiseCallerText(String(ref), MAX_REF, '…'));
    }
    this.first ??= { summary: summaryOf(error), trace: undefined };
    // The first stack AVAILABLE: a first failure that threw a non-Error must
    // not cost the batch its only trace.
    this.first.trace ??= boundedTrace(error);
  }

  entry(): { message: string; trace: string | undefined } | null {
    if (this.failures === 0 || !this.first) return null;
    const subject = this.failures === 1 ? this.subject : `${this.subject}s`;
    const more = this.failures - this.refs.length;
    const refs = this.refs.join(', ') + (more > 0 ? ` and ${more} more` : '');
    return {
      message: `${this.failures} ${subject} failed unexpectedly (${refs}); first: ${this.first.summary}`,
      trace: this.first.trace,
    };
  }
}

/** `ClassName [code]: message`, each part cleaned and bounded — `code` and `message` are not ours. */
function summaryOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const key = sanitiseCallerText(
    typeof code === 'string' ? `${name} ${code}` : name,
    MAX_CLASS_KEY,
    '…',
  );
  const text = error instanceof Error ? error.message : String(error);
  return `${key}: ${sanitiseCallerText(text, MAX_MESSAGE, '…') || '(no message)'}`;
}

/** A stack cleaned line by line (whole-string cleaning would drop its newlines), thirty lines at most. */
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
