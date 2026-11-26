import { describe, expect, it } from 'vitest';
import { CONTROL_KINDS, NODE_TYPES, holdsRecords } from '@tonyai/shared-types';
import { HOLDS_RECORDS_WHERE } from './reporting-set';

/** The filter, evaluated the way Postgres would for these two columns. */
function matches(node: { nodeType: string; control: string }): boolean {
  return node.nodeType !== HOLDS_RECORDS_WHERE.nodeType.not && node.control === HOLDS_RECORDS_WHERE.control;
}

describe('HOLDS_RECORDS_WHERE — holdsRecords as a query', () => {
  for (const nodeType of NODE_TYPES) {
    for (const control of CONTROL_KINDS) {
      it(`${nodeType} × ${control} agrees with holdsRecords`, () => {
        expect(matches({ nodeType, control })).toBe(holdsRecords({ nodeType, control }));
      });
    }
  }
});
