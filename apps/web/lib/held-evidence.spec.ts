import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_SIZE_BYTES } from '@/lib/types';
import { addHeldFiles, uploadHeldFiles, validateHeldFile, type HeldFileLike } from './held-evidence';

/**
 * BUG-R2-05: files chosen on a new record are held until the save that creates
 * the record. What must hold: the browser refuses what the bucket would refuse,
 * a failed upload does not stop the others, and once the form has moved on to
 * another record nothing more is uploaded — a held file reaches only the record
 * its own save created.
 */

const file = (name: string, over: Partial<HeldFileLike> = {}): HeldFileLike => ({
  name,
  type: 'application/pdf',
  size: 1000,
  lastModified: 1,
  ...over,
});

describe('validateHeldFile', () => {
  it('accepts a PDF under the limit', () => {
    expect(validateHeldFile(file('bill.pdf'))).toBe('ok');
  });
  it('accepts a file exactly at the limit', () => {
    expect(validateHeldFile(file('bill.pdf', { size: EVIDENCE_MAX_SIZE_BYTES }))).toBe('ok');
  });
  it('refuses a type the bucket does not take', () => {
    expect(validateHeldFile(file('notes.txt', { type: 'text/plain' }))).toBe('unsupported_type');
    expect(validateHeldFile(file('unknown', { type: '' }))).toBe('unsupported_type');
  });
  it('refuses a file over the limit', () => {
    expect(validateHeldFile(file('scan.png', { type: 'image/png', size: EVIDENCE_MAX_SIZE_BYTES + 1 }))).toBe(
      'too_large',
    );
  });
});

describe('addHeldFiles', () => {
  it('keeps the order chosen and reports each refusal with its reason', () => {
    const a = file('a.pdf');
    const bad = file('b.txt', { type: 'text/plain' });
    const big = file('c.pdf', { size: EVIDENCE_MAX_SIZE_BYTES + 1 });
    const d = file('d.png', { type: 'image/png' });
    const out = addHeldFiles([], [a, bad, big, d]);
    expect(out.held).toEqual([a, d]);
    expect(out.refused).toEqual([
      { file: bad, reason: 'unsupported_type' },
      { file: big, reason: 'too_large' },
    ]);
  });
  it('keeps a file chosen twice once', () => {
    const a = file('a.pdf');
    const again = file('a.pdf');
    const out = addHeldFiles([a], [again]);
    expect(out.held).toEqual([a]);
    expect(out.refused).toEqual([]);
  });
  it('keeps two files that only share a name', () => {
    const a = file('a.pdf', { lastModified: 1 });
    const b = file('a.pdf', { lastModified: 2 });
    expect(addHeldFiles([a], [b]).held).toEqual([a, b]);
  });
  it('does not change the list it was given', () => {
    const held = [file('a.pdf')];
    addHeldFiles(held, [file('b.pdf')]);
    expect(held).toHaveLength(1);
  });
});

describe('uploadHeldFiles', () => {
  it('uploads one at a time, in order, to the record given', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const upload = async (id: string, f: string) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      calls.push(`${id}:${f}`);
      inFlight -= 1;
    };
    const out = await uploadHeldFiles('rec-1', ['a', 'b', 'c'], upload, () => true);
    expect(calls).toEqual(['rec-1:a', 'rec-1:b', 'rec-1:c']);
    expect(out).toEqual({ uploaded: ['a', 'b', 'c'], failed: [], abandoned: [] });
  });

  it('keeps going after a failure and reports the failed file with its error', async () => {
    const boom = new Error('storage down');
    const upload = async (_id: string, f: string) => {
      if (f === 'b') throw boom;
    };
    const out = await uploadHeldFiles('rec-1', ['a', 'b', 'c'], upload, () => true);
    expect(out.uploaded).toEqual(['a', 'c']);
    expect(out.failed).toEqual([{ file: 'b', error: boom }]);
    expect(out.abandoned).toEqual([]);
  });

  it('uploads nothing when the form moved on before the first file', async () => {
    const calls: string[] = [];
    const out = await uploadHeldFiles('rec-1', ['a', 'b'], async (_id, f) => void calls.push(f), () => false);
    expect(calls).toEqual([]);
    expect(out).toEqual({ uploaded: [], failed: [], abandoned: ['a', 'b'] });
  });

  it('stops between files once the form moved on', async () => {
    let current = true;
    const calls: string[] = [];
    const upload = async (_id: string, f: string) => {
      calls.push(f);
      // The user starts another record while the first upload is in flight.
      current = false;
    };
    const out = await uploadHeldFiles('rec-1', ['a', 'b', 'c'], upload, () => current);
    expect(calls).toEqual(['a']);
    expect(out).toEqual({ uploaded: ['a'], failed: [], abandoned: ['b', 'c'] });
  });

  it('does nothing for an empty list', async () => {
    const out = await uploadHeldFiles('rec-1', [], async () => undefined, () => true);
    expect(out).toEqual({ uploaded: [], failed: [], abandoned: [] });
  });
});
