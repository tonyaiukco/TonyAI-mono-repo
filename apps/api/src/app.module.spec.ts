import { RuntimeAuthGuard } from './common/runtime-request';
import type { ExecutionContext } from '@nestjs/common';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { PdfRenderer } from './common/pdf-renderer';
import { PdfRendererModule } from './common/pdf-renderer.module';
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

/**
 * One Chromium per replica (LP3-04 PR D): the report exports and the issuances
 * share ONE `PdfRenderer` — its one-render-at-a-time lock and its kill of a
 * stuck browser depend on it. Walks the whole import graph from AppModule, so
 * a second provider anywhere — the class, or `{ provide: PdfRenderer, … }` —
 * fails it (`qa-auditor`'s re-review: a metadata check of two named modules
 * missed both).
 */
describe('AppModule — the one PdfRenderer', () => {
  type Imported = { forwardRef?: () => unknown; module?: unknown; providers?: unknown[]; imports?: unknown[] };
  const providesRenderer = (p: unknown) =>
    p === PdfRenderer || (typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === PdfRenderer);

  function hostsOf(entry: unknown, seen = new Set<unknown>(), hosts: unknown[] = []): unknown[] {
    const resolved = typeof entry === 'object' && entry !== null && 'forwardRef' in entry ? (entry as Imported).forwardRef!() : entry;
    if (resolved === undefined || resolved === null || resolved instanceof Promise || seen.has(resolved)) return hosts;
    seen.add(resolved);
    const dynamic = typeof resolved === 'object' ? (resolved as Imported) : undefined;
    const cls = dynamic?.module ?? resolved;
    const providers = [...((Reflect.getMetadata('providers', cls as object) as unknown[] | undefined) ?? []), ...(dynamic?.providers ?? [])];
    if (providers.some(providesRenderer)) hosts.push(cls);
    for (const imported of [...((Reflect.getMetadata('imports', cls as object) as unknown[] | undefined) ?? []), ...(dynamic?.imports ?? [])]) {
      hostsOf(imported, seen, hosts);
    }
    return hosts;
  }

  it('is provided by PdfRendererModule alone, anywhere in the graph', () => {
    expect(hostsOf(AppModule)).toEqual([PdfRendererModule]);
  });

  it('would notice a second provider, as a class or by token', () => {
    class Stray {}
    Reflect.defineMetadata('providers', [{ provide: PdfRenderer, useClass: PdfRenderer }], Stray);
    Reflect.defineMetadata('imports', [AppModule], Stray);
    expect(hostsOf(Stray)).toEqual([Stray, PdfRendererModule]);
  });
});
