import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { RegistrationController, RegistrationEnabledGuard } from './registration.controller';
import type { RegistrationService } from './registration.service';

describe('RegistrationController', () => {
  it('marks both routes public, and puts the switch in front of the whole controller', () => {
    const reflector = new Reflector();
    for (const handler of [RegistrationController.prototype.status, RegistrationController.prototype.register]) {
      expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    }
    expect(Reflect.getMetadata('__guards__', RegistrationController)).toEqual([RegistrationEnabledGuard]);
  });

  it('answers 404 from the guard while registration is off — before any body is validated', () => {
    const off = new RegistrationEnabledGuard({ enabled: false } as RegistrationService);
    expect(() => off.canActivate()).toThrow(expect.objectContaining({ status: 404, response: expect.objectContaining({ code: 'registration_unavailable' }) }));
    expect(new RegistrationEnabledGuard({ enabled: true } as RegistrationService).canActivate()).toBe(true);
  });

  it('hands the service the client address the proxy boundary resolved, and returns nothing', async () => {
    const request = vi.fn(async () => undefined);
    const controller = new RegistrationController({ request } as unknown as RegistrationService);
    const dto = { email: 'a@b.test' } as never;
    await expect(controller.register({ ip: '203.0.113.7', socket: {} } as never, dto)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith('203.0.113.7', dto);
  });
});
