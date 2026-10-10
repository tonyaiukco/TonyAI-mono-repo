import { describe, expect, it } from 'vitest';
import { CanonicalIdPipe } from './canonical-id.pipe';

describe('CanonicalIdPipe', () => {
  it('lowercases an id, so no spelling of one’s own id passes for another’s', () => {
    expect(new CanonicalIdPipe().transform('ABCDEF12-3456-4789-8ABC-DEF012345678')).toBe('abcdef12-3456-4789-8abc-def012345678');
  });

  it('still refuses what is not an id (invalid_id)', () => {
    expect(() => new CanonicalIdPipe().transform('nope')).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'invalid_id' }) }));
  });
});
