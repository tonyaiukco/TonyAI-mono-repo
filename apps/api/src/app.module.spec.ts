import { RuntimeAuthGuard } from './common/runtime-request';
import type { ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { CapacityError, RuntimeLimits } from './common/runtime-limits';

// Compile only the production admission provider: no database/auth clients.
describe('AppModule runtime admission', () => {
  it('registers one authentication/admission guard with the runtime policy', () => {
    const providers = Reflect.getMetadata('providers', AppModule);
    expect(providers).toContain(RuntimeLimits);
    const guards = providers.filter((p) => p.provide === APP_GUARD);
    expect(guards).toHaveLength(1);
    expect(guards[0].inject).toContain(RuntimeLimits);
  });
  it('the production factory wraps real authentication and refuses missing bearer tokens', async () => {
    const provider = Reflect.getMetadata('providers', AppModule).find((p) => p.provide === APP_GUARD);
    const limits = new RuntimeLimits();
    try {
      const guard = provider.useFactory(new Reflector(), {}, limits);
      expect(guard).toBeInstanceOf(RuntimeAuthGuard);
      const context = {
        getHandler: () => () => undefined, getClass: () => AppModule,
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }), getResponse: () => ({}) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
    } finally { limits.onApplicationShutdown(); }
  });
  it('creates independent counters for separate applications', async () => {
    const first = await Test.createTestingModule({ providers: [RuntimeLimits] }).compile();
    const second = await Test.createTestingModule({ providers: [RuntimeLimits] }).compile();
    try {
      await first.get(RuntimeLimits).quota('same-user', 1);
      await expect(first.get(RuntimeLimits).quota('same-user', 1)).rejects.toBeInstanceOf(CapacityError);
      await expect(second.get(RuntimeLimits).quota('same-user', 1)).resolves.toBeUndefined();
    } finally { await first.close(); await second.close(); }
  });
});
