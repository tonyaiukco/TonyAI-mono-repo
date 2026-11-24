import 'reflect-metadata';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller';
import type { RequestUser } from './auth.types';
import type { PreferencesService } from './preferences.service';

const user = { id: 'u-1', role: 'data_entry' } as RequestUser;

describe('POST /me/password-set (pre-g5-security-hardening)', () => {
  it.each(['invite', 'recovery'] as const)('records the caller\'s own password set with the flow it was given (%s)', async (flow) => {
    const recordPasswordSet = vi.fn(async () => undefined);
    const controller = new AuthController({} as never, { recordPasswordSet } as unknown as PreferencesService);
    await expect(controller.recordPasswordSet(user, { flow, changeId: 'c-1' })).resolves.toBeUndefined();
    expect(recordPasswordSet).toHaveBeenCalledWith(user, flow, 'c-1');
  });

  it('answers 204', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.recordPasswordSet)).toBe(204);
  });
});
