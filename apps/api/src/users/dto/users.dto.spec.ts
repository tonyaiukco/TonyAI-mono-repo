import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { REGISTRATION_CONSENT_VERSION } from '@tonyai/shared-types';
import { InviteUserDto, ListUsersQueryDto, PasswordResetDto, RegistrationDto, ReplaceUserAccessDto } from './users.dto';

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

const REGISTRATION = {
  firstName: 'Ada',
  lastName: 'Yilmaz',
  companyName: 'Example Holding',
  jobTitle: 'Sustainability Manager',
  email: 'ada@example.test',
  registrationCode: 'aB3x9',
  consent: true,
  consentVersion: REGISTRATION_CONSENT_VERSION,
  language: 'tr',
};

describe('the registration DTO (self-service registration)', () => {
  it('accepts a complete registration — an address at a free provider like any other', async () => {
    expect(await errorsOf(RegistrationDto, REGISTRATION)).toEqual([]);
    expect(await errorsOf(RegistrationDto, { ...REGISTRATION, email: 'ada.yilmaz+qa@gmail.com' })).toEqual([]);
  });

  it('accepts each typed value at its bound', async () => {
    expect(
      await errorsOf(RegistrationDto, {
        ...REGISTRATION,
        firstName: 'x'.repeat(100),
        lastName: 'x'.repeat(100),
        companyName: 'x'.repeat(200),
        jobTitle: 'x'.repeat(100),
        registrationCode: 'x'.repeat(64),
      }),
    ).toEqual([]);
  });

  it.each(["o'brien@example.test", 'ada+qa@example.test', 'ada.yilmaz@sub.example.test', 'ADA@EXAMPLE.TEST', 'a_b-c@example-co.test'])(
    'accepts the plain address %s',
    async (email) => {
      expect(await errorsOf(RegistrationDto, { ...REGISTRATION, email })).toEqual([]);
    },
  );

  it('trims the typed values', () => {
    const dto = plainToInstance(RegistrationDto, { ...REGISTRATION, firstName: '  Ada ', companyName: ' Example Holding  ' });
    expect(dto.firstName).toBe('Ada');
    expect(dto.companyName).toBe('Example Holding');
  });

  it.each([
    ['a missing first name', { ...REGISTRATION, firstName: undefined }, 'firstName'],
    ['a blank last name', { ...REGISTRATION, lastName: '   ' }, 'lastName'],
    ['a blank company name', { ...REGISTRATION, companyName: '' }, 'companyName'],
    ['a company name past its bound', { ...REGISTRATION, companyName: 'x'.repeat(201) }, 'companyName'],
    ['a missing job title', { ...REGISTRATION, jobTitle: undefined }, 'jobTitle'],
    ['an address that is not one', { ...REGISTRATION, email: 'nope' }, 'email'],
    // Supabase Auth refuses these after the organisation would already exist.
    ['an address with a Turkish letter before the @', { ...REGISTRATION, email: 'ay\u015fe@example.test' }, 'email'],
    ['an address with a dotted capital I', { ...REGISTRATION, email: '\u0130lker@example.test' }, 'email'],
    ['an address at a non-ASCII domain', { ...REGISTRATION, email: 'ada@\u00f6rnek.test' }, 'email'],
    ['a quoted address (valid by the RFC, refused by Auth)', { ...REGISTRATION, email: '"qaquoted"@example.test' }, 'email'],
    ['an address with a comment', { ...REGISTRATION, email: 'ada(work)@example.test' }, 'email'],
    ['an address at an address literal', { ...REGISTRATION, email: 'ada@[127.0.0.1]' }, 'email'],
    ['an address with a space inside', { ...REGISTRATION, email: 'ada yilmaz@example.test' }, 'email'],
    ['an address with spaces around it', { ...REGISTRATION, email: ' ada@example.test ' }, 'email'],
    ['an address past its bound', { ...REGISTRATION, email: `${'a'.repeat(250)}@b.test` }, 'email'],
    ['a first name past its bound', { ...REGISTRATION, firstName: 'x'.repeat(101) }, 'firstName'],
    ['a last name past its bound', { ...REGISTRATION, lastName: 'x'.repeat(101) }, 'lastName'],
    ['a job title past its bound', { ...REGISTRATION, jobTitle: 'x'.repeat(101) }, 'jobTitle'],
    ['a blank job title', { ...REGISTRATION, jobTitle: '   ' }, 'jobTitle'],
    ['a code past its bound', { ...REGISTRATION, registrationCode: 'x'.repeat(65) }, 'registrationCode'],
    ['a consent not accepted', { ...REGISTRATION, consent: false }, 'consent'],
    ['a consent that is only truthy', { ...REGISTRATION, consent: 'true' }, 'consent'],
    ['a missing consent', { ...REGISTRATION, consent: undefined }, 'consent'],
    ['a notice version this API does not serve', { ...REGISTRATION, consentVersion: 'v0' }, 'consentVersion'],
    ['a language the product does not speak', { ...REGISTRATION, language: 'de' }, 'language'],
    ['a code that is not text', { ...REGISTRATION, registrationCode: 12345 }, 'registrationCode'],
    ['an extra field', { ...REGISTRATION, role: 'super_admin' }, 'role'],
    ['an organisation chosen by the caller', { ...REGISTRATION, organisationId: '11111111-1111-1111-1111-111111111111' }, 'organisationId'],
  ])('refuses %s', async (_label, body, property) => {
    expect(await errorsOf(RegistrationDto, body)).toContain(property);
  });

  it('leaves a code of the wrong shape to the service: a wrong code is a 403 in words, not a validation error', async () => {
    expect(await errorsOf(RegistrationDto, { ...REGISTRATION, registrationCode: 'nope' })).toEqual([]);
    expect(await errorsOf(RegistrationDto, { ...REGISTRATION, registrationCode: '' })).toEqual([]);
  });
});
