import { describe, expect, it } from 'vitest';
import { classifyVerification } from './health-storage-verify.cli';

const report = { buckets: { evidence: {}, 'import-sources': {} } };
describe('scheduled verification exit contract', () => {
  it('preserves exit 1 for operator attention and exit 2 for failed checks', () => {
    expect(classifyVerification(0, JSON.stringify(report))).toBe(0);
    expect(classifyVerification(1, JSON.stringify(report))).toBe(1);
    expect(classifyVerification(2, 'secret exception')).toBe(2);
    expect(classifyVerification(0, '{}')).toBe(2);
  });
  it('treats truncated coverage as attention, never a clean verification', () => {
    expect(classifyVerification(0, JSON.stringify({ ...report, intents: { nested: { truncated: true } } }))).toBe(1);
    expect(classifyVerification(0, 'not JSON with private/file.pdf')).toBe(2);
  });
});
