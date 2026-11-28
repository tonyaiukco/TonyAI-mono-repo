import { describe, expect, it } from 'vitest';
import { main } from './single-entry-overlaps.cli';

const sink = () => {
  let text = '';
  return { write: (s: string) => ((text += s), true), text: () => text };
};

describe('pnpm single-entry:overlaps', () => {
  const none = async () => ({ pairs: 0, approvedPairs: 0, overlaps: [] });
  const one = async () => ({
    pairs: 1,
    approvedPairs: 1,
    overlaps: [{
      subsidiaryId: 's', category: 'Electricity', reportingYear: 2026,
      companyUserRecord: { id: 'a', period: 'monthly May', status: 'approved' },
      centralReporterRecord: { id: 'b', period: 'quarterly Q2', status: 'draft' },
    }],
  });

  it('exits 0 with an empty report when no pair overlaps, and 2 with the pairs when one does', async () => {
    const out = sink();
    expect(await main([], out, sink(), none, 'postgres://x')).toBe(0);
    expect(JSON.parse(out.text())).toEqual({ pairs: 0, approvedPairs: 0, overlaps: [] });
    const found = sink();
    expect(await main([], found, sink(), one, 'postgres://x')).toBe(2);
    expect(JSON.parse(found.text()).overlaps[0].centralReporterRecord).toEqual({ id: 'b', period: 'quarterly Q2', status: 'draft' });
  });

  it('takes no switch, needs a database, and never echoes an unexpected error', async () => {
    const err = sink();
    expect(await main(['--apply'], sink(), err, none, 'postgres://x')).toBe(2);
    expect(err.text()).toContain('takes no switches');
    const noDb = sink();
    expect(await main([], sink(), noDb, none, '')).toBe(2);
    expect(noDb.text()).toContain('DATABASE_URL');
    const leak = sink();
    expect(await main([], sink(), leak, async () => { throw new Error('postgres://user:secret@host'); }, 'postgres://x')).toBe(2);
    expect(leak.text()).not.toContain('secret');
  });
});
