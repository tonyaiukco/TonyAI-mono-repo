import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RuntimeLimits } from './runtime-limits';
import { installRuntimeShutdown } from './runtime-shutdown';

describe('runtime shutdown before provider destruction', () => {
  it.each(['SIGTERM', 'SIGINT'])('%s closes admission before awaiting settled work and destroying providers', async (signal) => {
    const limits = new RuntimeLimits();
    const release = limits.acquire('mutations', 2);
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    installRuntimeShutdown({ close }, limits, signals as never);
    signals.emit(signal);
    expect(limits.stopping).toBe(true);
    expect(close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT')).toBe(0);
    limits.onApplicationShutdown();
  });
});
