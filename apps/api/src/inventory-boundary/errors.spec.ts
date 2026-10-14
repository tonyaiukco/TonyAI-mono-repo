import { describe, it, expect } from 'vitest';
import { Prisma } from '@tonyai/db';
import { boundaryGuardRefused } from './errors';

const engine = (code: string, message = 'refused') =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: 'test' },
  );

describe('boundaryGuardRefused', () => {
  it('reads TA014 from a model query and from a raw one', () => {
    expect(boundaryGuardRefused(engine('TA014'))).toBe(true);
    expect(
      boundaryGuardRefused(new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 'test', meta: { code: 'TA014' } })),
    ).toBe(true);
  });

  it('answers no for another trigger, a key violation or an ordinary failure', () => {
    expect(boundaryGuardRefused(engine('TA001'))).toBe(false);
    expect(boundaryGuardRefused(new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }))).toBe(false);
    expect(boundaryGuardRefused(new Error('PostgresError { code: "TA014"'))).toBe(false);
  });

  it('reads the code from the engine\'s framing, not from text inside the message', () => {
    expect(boundaryGuardRefused(engine('TA001', 'PostgresError { code: \\"TA014\\"'))).toBe(false);
  });
});
