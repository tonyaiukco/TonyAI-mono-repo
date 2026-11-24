import { describe, expect, it, vi } from 'vitest';
import { main, parseArgs, requireDatabase } from './draft-reprice.cli';
import type { DraftRepriceReport } from './draft-reprice.service';

const LOCAL = 'postgresql://runtime@127.0.0.1:54322/local';
const REMOTE = 'postgresql://runtime@database.example.invalid/db';

function output() {
  return { write: vi.fn().mockReturnValue(true) };
}

describe('draft-reprice CLI', () => {
  it('defaults to a dry run and refuses unknown switches', () => {
    expect(parseArgs([])).toEqual({ apply: false, allowRemote: false });
    expect(parseArgs(['--apply', '--allow-remote'])).toEqual({ apply: true, allowRemote: true });
    expect(() => parseArgs(['--write'])).toThrow(/Expected/);
  });

  it('guards remote and redirected applies before connecting', async () => {
    const options = parseArgs(['--apply']);
    expect(() => requireDatabase(options, LOCAL)).not.toThrow();
    expect(() => requireDatabase(options, `${LOCAL}?host=outside.example.invalid`)).toThrow(/--allow-remote/);
    expect(() => requireDatabase(parseArgs([]), REMOTE)).not.toThrow();
    expect(() => requireDatabase(parseArgs(['--apply', '--allow-remote']), REMOTE)).not.toThrow();
    const execute = vi.fn();
    const err = output();
    expect(await main(['--apply'], output(), err, execute, REMOTE)).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(err.write).toHaveBeenCalledWith(expect.stringContaining('--allow-remote'));
  });

  it('prints refusals as a report and exits nonzero', async () => {
    const report: DraftRepriceReport = {
      mode: 'dry_run', counts: { would_reprice: 0, repriced: 0, up_to_date: 0, skipped: 0, refused: 1,
        sum_rule_review: 0, unclassified_review: 0 },
      records: [], reviewQueue: { sumRule: [], unclassified: [] },
    };
    const out = output();
    const execute = vi.fn().mockResolvedValue(report);
    expect(await main([], out, output(), execute, LOCAL)).toBe(2);
    expect(execute).toHaveBeenCalledWith({ apply: false, allowRemote: false });
    expect(JSON.parse(out.write.mock.calls[0][0])).toEqual(report);
  });
});
