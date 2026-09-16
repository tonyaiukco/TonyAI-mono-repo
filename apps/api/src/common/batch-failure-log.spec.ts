import { describe, expect, it } from 'vitest';
import { BatchFailureLog, boundedTrace } from './batch-failure-log';

// Built from code points, never typed: escape sequences typed into this repo
// have arrived in files as the literal, invisible character.
const char = (code: number) => String.fromCharCode(code);

/** An error with a stack this spec can recognise line by line. */
function withStack(message: string, frames: number, width = 10): Error {
  const error = new Error(message);
  error.stack = [
    `Error: ${message}`,
    ...Array.from({ length: frames }, (_, i) => `    at frame${i} ${'x'.repeat(width)}`),
  ].join('\n');
  return error;
}

/** A driver error as Prisma raises one: a class, a code and a long message. */
function driverError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  error.stack = `Error: ${message}\n    at PrismaClient._request (/app/node_modules/@prisma/client/runtime/library.js:123:45)`;
  return error;
}

describe('BatchFailureLog — nothing to say', () => {
  it('has no entry when no row failed unexpectedly, so nothing is logged', () => {
    // The normal import. The caller logs only on a non-null entry, so this is
    // the assertion that keeps a clean import silent.
    expect(new BatchFailureLog('row').entry()).toBeNull();
  });
});

describe('BatchFailureLog — one line for a whole batch', () => {
  it('names the count, the refs and the class of a single failure', () => {
    const log = new BatchFailureLog('row');
    log.add(7, driverError('P2000', 'The provided value for locationId is too long'));

    const entry = log.entry();

    expect(entry?.message).toBe(
      '1 row failed unexpectedly (7); Error P2000 ×1: The provided value for locationId is too long',
    );
  });

  it('counts a repeated class once, with a multiplier', () => {
    // The measured case: fifty rows, one driver error, fifty identical stacks.
    const log = new BatchFailureLog('row');
    for (let row = 1; row <= 50; row += 1) {
      log.add(row, driverError('P2000', 'value too long for column locationId'));
    }

    const entry = log.entry();

    expect(entry?.message).toContain('50 rows failed unexpectedly');
    expect(entry?.message).toContain('Error P2000 ×50: value too long for column locationId');
  });

  it('names the first ten refs and counts the rest', () => {
    // Which rows, not every row: ten is enough to find the file's bad region.
    const log = new BatchFailureLog('row');
    for (let row = 1; row <= 14; row += 1) log.add(row, new Error('boom'));

    expect(log.entry()?.message).toContain(
      '(1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 4 more)',
    );
  });

  it('keeps a sample message per class, and says how many classes it dropped', () => {
    // Five distinct classes are kept WITH their messages, because the message
    // is where Prisma names the column. A sixth class is counted, not named.
    const log = new BatchFailureLog('record');
    for (let i = 0; i < 7; i += 1) {
      log.add(`rec-${i}`, driverError(`P200${i}`, `failure number ${i}`));
    }

    const message = log.entry()?.message ?? '';

    for (let i = 0; i < 5; i += 1) {
      expect(message).toContain(`Error P200${i} ×1: failure number ${i}`);
    }
    expect(message).not.toContain('failure number 5');
    expect(message).toContain('2 more in classes past the first 5');
  });

  it('reads a class without a code, and a failure that is not an Error', () => {
    const log = new BatchFailureLog('row');
    log.add(1, new TypeError('records.create is not a function'));
    log.add(2, 'a thrown string');

    const message = log.entry()?.message ?? '';

    expect(message).toContain('TypeError ×1: records.create is not a function');
    expect(message).toContain('string ×1: a thrown string');
  });

  it('says so rather than trailing off when a failure carries no message', () => {
    const log = new BatchFailureLog('row');
    log.add(1, new Error(char(0x200b)));

    expect(log.entry()?.message).toContain('Error ×1: (no message)');
  });
});

describe('BatchFailureLog — one stack, the first one available', () => {
  it('attaches the first failure’s stack and no others', () => {
    const log = new BatchFailureLog('row');
    log.add(1, withStack('first', 2));
    log.add(2, withStack('second', 2));

    const trace = log.entry()?.trace ?? '';

    expect(trace).toContain('Error: first');
    expect(trace).not.toContain('Error: second');
  });

  it('takes a later stack when the first failure had none', () => {
    // A thrown string must not cost the batch its only stack.
    const log = new BatchFailureLog('row');
    log.add(1, 'a thrown string');
    log.add(2, withStack('the real one', 2));

    expect(log.entry()?.trace).toContain('Error: the real one');
  });

  it('has no trace at all when nothing threw an Error', () => {
    const log = new BatchFailureLog('row');
    log.add(1, 'a thrown string');

    const entry = log.entry();

    expect(entry).not.toBeNull();
    expect(entry?.trace).toBeUndefined();
  });
});

describe('boundedTrace — cleaned without being flattened', () => {
  it('keeps the newlines, which whole-string cleaning would drop', () => {
    // `sanitiseCallerText` drops C0 controls, U+000A among them. Run over a
    // stack whole it would fold every frame into one unreadable run.
    const trace = boundedTrace(withStack('boom', 3)) ?? '';

    expect(trace.split('\n')).toHaveLength(4);
    expect(trace.split('\n')[1]).toBe(`    at frame0 ${'x'.repeat(10)}`);
  });

  it('drops a bidi override a Prisma message quoted from a cell', () => {
    // The reason the stack is cleaned at all: a parse failure names the
    // character it choked on, and U+202E reorders every later word in the log.
    const trace = boundedTrace(withStack(`cell ${char(0x202e)}gpj.exe`, 1)) ?? '';

    expect(trace).not.toContain(char(0x202e));
    expect(trace).toContain('cell gpj.exe');
  });

  it('keeps the letters a careless range would eat', () => {
    // Turkish text reaches these messages through the cells themselves.
    expect(boundedTrace(withStack('Çöp ölçümü üretimi', 1))).toContain(
      'Çöp ölçümü üretimi',
    );
  });

  it('keeps thirty lines and counts the rest', () => {
    const trace = boundedTrace(withStack('boom', 99)) ?? '';
    const lines = trace.split('\n');

    expect(lines).toHaveLength(31);
    // 100 lines in (the message line plus 99 frames), 30 kept.
    expect(lines[30]).toBe('… 70 more line(s)');
    expect(lines[29]).toContain('at frame28');
  });

  it('cuts a line at 200 characters, marking the cut', () => {
    // A Prisma code frame prints the query — with the caller's value in it —
    // on one line.
    const trace = boundedTrace(withStack('boom', 1, 500)) ?? '';
    const frame = trace.split('\n')[1];

    expect([...frame]).toHaveLength(201);
    expect(frame.endsWith('…')).toBe(true);
  });

  it('has nothing to give for a non-Error, or an Error with no stack', () => {
    const stackless = new Error('boom');
    delete (stackless as { stack?: string }).stack;

    expect(boundedTrace('a thrown string')).toBeUndefined();
    expect(boundedTrace(undefined)).toBeUndefined();
    expect(boundedTrace(stackless)).toBeUndefined();
  });
});

describe('BatchFailureLog — bounded whatever the batch does', () => {
  it('stays a few KB for a thousand rows that each fail differently', () => {
    // The point of the class. Measured before this change: fifty rows carrying
    // a 2,001-character id wrote 148,542 bytes of stderr — one Prisma stack
    // with a code frame per row — which the 1,000-row cap puts near 3 MB per
    // request, five times a minute per user.
    //
    // This is the adversarial shape: every row a DISTINCT class, every message
    // 3,000 characters, every stack 80 wide frames. Nothing here may grow with
    // the row count.
    const log = new BatchFailureLog('row');
    for (let row = 1; row <= 1000; row += 1) {
      const error = withStack('x'.repeat(3000), 80, 400);
      Object.assign(error, { code: `P${row}` });
      log.add(row, error);
    }

    const entry = log.entry();
    const bytes =
      Buffer.byteLength(entry?.message ?? '') +
      Buffer.byteLength(entry?.trace ?? '');

    expect(entry?.message).toContain('1000 rows failed unexpectedly');
    expect(bytes).toBeLessThan(9_000);
  });

  it('bounds a class key, because `code` is not ours', () => {
    const log = new BatchFailureLog('row');
    const error = new Error('boom');
    Object.assign(error, { code: 'P'.repeat(500) });
    log.add(1, error);

    // `Error ` plus 60 kept code points plus the cut mark.
    expect([...(log.entry()?.message ?? '')].indexOf(';')).toBe(
      '1 row failed unexpectedly (1)'.length,
    );
    expect(log.entry()?.message).toContain(`Error ${'P'.repeat(54)}…`);
  });

  it('bounds a ref, and cleans it', () => {
    const log = new BatchFailureLog('record');
    log.add(`${char(0x202e)}${'r'.repeat(60)}`, new Error('boom'));

    const message = log.entry()?.message ?? '';

    expect(message).not.toContain(char(0x202e));
    expect(message).toContain(`(${'r'.repeat(40)}…)`);
  });

  it('bounds a sample message, and cleans it', () => {
    // The 2,001-character cell, quoted back by the driver.
    const log = new BatchFailureLog('row');
    log.add(1, new Error(`id ${char(0x202e)}${'z'.repeat(2001)}`));

    const message = log.entry()?.message ?? '';

    expect(message).not.toContain(char(0x202e));
    // `id ` plus 237 of the z's, then the cut mark.
    expect(message).toContain(`id ${'z'.repeat(237)}…`);
    expect([...message]).toHaveLength(
      '1 row failed unexpectedly (1); Error ×1: '.length + 241,
    );
  });
});
