import { afterEach, describe, expect, it, vi } from 'vitest';
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: exec }));
import { classifyVerification, runStorageVerification } from './health-storage-verify.cli';

const report = { buckets: { evidence: {}, 'import-sources': {} } };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('scheduled verification exit contract', () => {
  it.each([2, 3, -1])('rejects exit %i even with a valid report', (code) => {
    expect(classifyVerification(code, JSON.stringify(report))).toBe(2);
  });
  it('requires both buckets and preserves operator attention', () => {
    expect(classifyVerification(0, JSON.stringify(report))).toBe(0);
    expect(classifyVerification(1, JSON.stringify(report))).toBe(1);
    expect(classifyVerification(0, JSON.stringify({ buckets: { evidence: {} } }))).toBe(2);
    expect(classifyVerification(0, JSON.stringify({ buckets: { 'import-sources': {} } }))).toBe(2);
    expect(classifyVerification(0, '{}')).toBe(2);
  });
  it.each([true, false, 'false', 'true', 1, 0, null])('requires literal true for truncation: %j', (truncated) => {
    expect(classifyVerification(0, JSON.stringify({ ...report, intents: { nested: { truncated } } }))).toBe(truncated === true ? 1 : 0);
    expect(classifyVerification(0, 'not JSON with private/file.pdf')).toBe(2);
  });
  it('executes the hash verifier under a hold and never forwards child output', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const previousExit = process.exitCode;
    try {
      runStorageVerification();
      const [binary, args, options, callback] = exec.mock.calls[0];
      expect(binary).toBe(process.execPath);
      expect(args).toEqual([expect.stringContaining('storage/reconcile.cli.js'), '--verify', '--allow-remote']);
      expect(options).toMatchObject({ timeout: 900000, maxBuffer: 16 * 1024 * 1024, env: { STORAGE_CLEANUP_HOLD: '1' } });
      callback({ code: 1 }, JSON.stringify({ ...report, privatePath: 'tenant/private.pdf' }), 'secret child error');
      expect(stdout).toHaveBeenCalledWith('{"event":"storage_verify","exitCode":1}\n');
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previousExit; }
  });
});
