import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RecordPasswordSetDto } from './record-password-set.dto';

/** POST /me/password-set's body (pre-g5-security-hardening). */
const errorsOf = async (body: unknown) =>
  (await validate(plainToInstance(RecordPasswordSetDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

describe('RecordPasswordSetDto', () => {
  const changeId = '7f3c2a1e-4b5d-4c6e-8f90-123456789abc';

  it('admits the two flows with a change id', async () => {
    expect(await errorsOf({ flow: 'invite', changeId })).toEqual([]);
    expect(await errorsOf({ flow: 'recovery', changeId })).toEqual([]);
  });

  it('refuses a missing or malformed change id', async () => {
    for (const body of [{ flow: 'invite' }, { flow: 'invite', changeId: 'x' }, { flow: 'invite', changeId: 5 }]) {
      expect(await errorsOf(body), JSON.stringify(body)).toContain('changeId');
    }
  });

  it('refuses anything else, a missing flow and an extra field', async () => {
    for (const body of [{ flow: 'admin', changeId }, { flow: null, changeId }, { changeId }, { flow: 'RECOVERY', changeId }]) {
      expect(await errorsOf(body), JSON.stringify(body)).toContain('flow');
    }
    expect(await errorsOf({ flow: 'invite', changeId, password: 'x' })).toContain('password');
  });
});
