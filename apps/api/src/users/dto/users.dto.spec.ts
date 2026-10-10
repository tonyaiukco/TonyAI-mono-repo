import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { InviteUserDto, ListUsersQueryDto, PasswordResetDto, ReplaceUserAccessDto } from './users.dto';

const errorsOf = async (cls: new () => object, body: object) =>
  (await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

const INVITE = { email: 'a@b.test', fullName: 'A', role: 'data_entry', language: 'tr' };

describe('the users DTOs refuse what would otherwise reach Prisma or a mailbox', () => {
  it('accepts a complete invitation, the seed’s fixed ids among its grants', async () => {
    expect(await errorsOf(InviteUserDto, { ...INVITE, subsidiaryIds: ['22222222-2222-2222-2222-222222220001'] })).toEqual([]);
  });

  it.each([
    ['an address that is not one', { ...INVITE, email: 'nope' }, 'email'],
    ['a blank name', { ...INVITE, fullName: '   ' }, 'fullName'],
    ['an unknown role', { ...INVITE, role: 'platform_admin' }, 'role'],
    ['a language the product does not speak', { ...INVITE, language: 'de' }, 'language'],
    ['a grant that is not an id (a 500 from Prisma otherwise)', { ...INVITE, subsidiaryIds: ['nope'] }, 'subsidiaryIds'],
    ['an extra field', { ...INVITE, organisationId: '11111111-1111-1111-1111-111111111111' }, 'organisationId'],
  ])('refuses %s', async (_label, body, property) => {
    expect(await errorsOf(InviteUserDto, body)).toContain(property);
  });

  it('bounds the access set, the page and the reset address', async () => {
    expect(await errorsOf(ReplaceUserAccessDto, { subsidiaryIds: ['x'] })).toContain('subsidiaryIds');
    expect(await errorsOf(ListUsersQueryDto, { limit: '101' })).toContain('limit');
    expect(await errorsOf(ListUsersQueryDto, { cursor: '' })).toContain('cursor');
    expect(await errorsOf(PasswordResetDto, { email: `${'a'.repeat(250)}@b.test` })).toContain('email');
  });
});
