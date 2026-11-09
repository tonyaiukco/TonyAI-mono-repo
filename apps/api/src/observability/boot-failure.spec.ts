import { describe, expect, it, vi } from 'vitest';
import { exitOnBootFailure, safeBootMessage, type BootFailureDeps } from './boot-failure';

const deps = (over: Partial<BootFailureDeps> = {}): BootFailureDeps => ({
  log: vi.fn(),
  capture: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  exit: vi.fn(),
  flushLimitMs: 20,
  ...over,
});

describe('exitOnBootFailure', () => {
  it('reports, flushes, and only then exits 1', async () => {
    const order: string[] = [];
    const error = new Error('database down');
    await exitOnBootFailure(error, deps({
      log: () => order.push('log'),
      capture: (e) => {
        expect(e).toBe(error);
        order.push('capture');
      },
      flush: async () => {
        order.push('flush');
      },
      exit: (code) => {
        order.push(`exit ${code}`);
      },
    }));
    expect(order).toEqual(['log', 'capture', 'flush', 'exit 1']);
  });

  it.each([
    ['the flush rejects', { flush: () => Promise.reject(new Error('no network')) }],
    ['the flush never settles', { flush: () => new Promise(() => undefined) }],
    ['the capture throws', { capture: () => { throw new Error('no sdk'); } }],
    ['the log throws', { log: () => { throw new Error('no stdout'); } }],
  ])('still exits 1 when %s', async (_case, over) => {
    const d = deps(over as Partial<BootFailureDeps>);
    await exitOnBootFailure(new Error('database down'), d);
    expect(d.exit).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 for a thrown value that is no Error', async () => {
    const d = deps();
    await exitOnBootFailure('plain text', d);
    expect(d.log).toHaveBeenCalledWith({ errorName: 'string', message: 'plain text' });
    expect(d.exit).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(1);
  });
});

describe('safeBootMessage', () => {
  it('logs no connection string, whatever its scheme', () => {
    const secret = 'postgresql://tonyai_runtime:s3cret@db.example.com:5432/postgres?sslmode=require';
    const message = safeBootMessage(new Error(`Can't reach ${secret} now`));
    expect(message).toBe("Can't reach [url] now");
    expect(safeBootMessage(new Error('host=db password=s3cret'))).toBe('host=db password=[redacted]');
  });

  it('keeps the rest of the message, bounded', () => {
    expect(safeBootMessage(new Error('Set SUPABASE_JWT_SECRET'))).toBe('Set SUPABASE_JWT_SECRET');
    expect(safeBootMessage(new Error('x'.repeat(9000)))).toHaveLength(500);
  });
});
