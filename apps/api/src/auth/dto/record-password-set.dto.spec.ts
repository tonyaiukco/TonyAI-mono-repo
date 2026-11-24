import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RecordPasswordSetDto } from './record-password-set.dto';

/** POST /me/password-set's body (pre-g5-security-hardening). */
const errorsOf = async (body: unknown) =>
  (await validate(plainToInstance(RecordPasswordSetDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

describe('RecordPasswordSetDto', () => {
  it('admits the two flows', async () => {
    expect(await errorsOf({ flow: 'invite' })).toEqual([]);
    expect(await errorsOf({ flow: 'recovery' })).toEqual([]);
  });

  it('refuses anything else, a missing flow and an extra field', async () => {
    for (const body of [{ flow: 'admin' }, { flow: null }, {}, { flow: 'RECOVERY' }]) {
      expect(await errorsOf(body), JSON.stringify(body)).toContain('flow');
    }
    expect(await errorsOf({ flow: 'invite', password: 'x' })).toContain('password');
  });
});
