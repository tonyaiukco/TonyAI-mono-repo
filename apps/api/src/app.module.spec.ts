import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  ThrottlerModule,
  ThrottlerStorageService,
  getStorageToken,
} from '@nestjs/throttler';
import { AppModule } from './app.module';

/**
 * The app once installed its own storage over a defect in `@nestjs/throttler`;
 * 6.7.0 fixed it and the workaround is gone. Each test compiles AppModule's own
 * ThrottlerModule import and nothing else, so no database, Supabase client or
 * config is constructed.
 */
describe('AppModule — rate limiting', () => {
  function throttlerImport(): never {
    const imports = Reflect.getMetadata('imports', AppModule) as { module?: unknown }[];
    const found = imports.find((entry) => entry?.module === ThrottlerModule);
    expect(found).toBeDefined();
    return found as never;
  }

  it('uses the library’s own storage — no workaround installed over it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [throttlerImport()] }).compile();
    try {
      expect(moduleRef.get(getStorageToken())).toBeInstanceOf(ThrottlerStorageService);
    } finally {
      await moduleRef.close();
    }
  });

  it('builds a storage per app, so two apps in one process share no counts', async () => {
    // A storage constructed at module definition would be shared by every app
    // built in the same process, hit counts included (security-rls).
    const first = await Test.createTestingModule({ imports: [throttlerImport()] }).compile();
    const second = await Test.createTestingModule({ imports: [throttlerImport()] }).compile();
    try {
      expect(first.get(getStorageToken())).not.toBe(second.get(getStorageToken()));
    } finally {
      await first.close();
      await second.close();
    }
  });
});
