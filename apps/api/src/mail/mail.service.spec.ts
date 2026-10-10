import { describe, expect, it, vi } from 'vitest';
import { MailConfigError, MailService, readMailConfig, type MailConfig } from './mail.service';

const env = (over: Record<string, string | undefined>) => over as NodeJS.ProcessEnv;
const BASE = { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'TonyAI <no-reply@example.com>', APP_URL: 'https://app.example.com' };
const CONFIG: MailConfig = { host: 'smtp.example.com', port: 587, secure: false, from: 'x@example.com', appUrl: 'https://app.example.com' };

describe('readMailConfig', () => {
  it('is null when nothing is set — the API still boots without mail', () => {
    expect(readMailConfig(env({}))).toBeNull();
  });

  it('reads a complete configuration, defaulting to port 587 with STARTTLS', () => {
    expect(readMailConfig(env(BASE))).toEqual({
      host: 'smtp.example.com', port: 587, secure: false, user: undefined, password: undefined,
      from: BASE.MAIL_FROM, appUrl: 'https://app.example.com',
    });
    expect(readMailConfig(env({ ...BASE, SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }))).toMatchObject({
      port: 465, secure: true, user: 'u', password: 'p',
    });
  });

  it.each([
    ['a host without the rest', { SMTP_HOST: 'smtp.example.com' }],
    ['an APP_URL with a path', { ...BASE, APP_URL: 'https://app.example.com/evil' }],
    ['an APP_URL with a query', { ...BASE, APP_URL: 'https://app.example.com/?next=x' }],
    ['an APP_URL with credentials', { ...BASE, APP_URL: 'https://a:b@app.example.com' }],
    ['a non-web APP_URL', { ...BASE, APP_URL: 'javascript:alert(1)' }],
    ['a port out of range', { ...BASE, SMTP_PORT: '70000' }],
    ['SMTP_SECURE that is not a boolean', { ...BASE, SMTP_SECURE: 'yes' }],
    ['a user without a password', { ...BASE, SMTP_USER: 'u' }],
  ])('refuses %s', (_label, over) => {
    expect(() => readMailConfig(env(over))).toThrow(MailConfigError);
  });
});

describe('MailService', () => {
  it('builds the confirm link on APP_URL alone, the token encoded', () => {
    const mail = new MailService({ sendMail: vi.fn() }, CONFIG);
    expect(mail.confirmLink('a/b+c', 'recovery')).toBe('https://app.example.com/auth/confirm?token_hash=a%2Fb%2Bc&type=recovery');
    expect(new MailService(undefined, null).confirmLink('x', 'invite')).toBeNull();
  });

  it('reports a delivered email, a failed one (never throwing) and an unconfigured mailer', async () => {
    const sendMail = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('rejected rcpt a@b.test'), { responseCode: 550 }));
    const mail = new MailService({ sendMail }, CONFIG);
    const content = { kind: 'password_reset' as const, language: 'en' as const, name: 'A', link: 'https://app.example.com/auth/confirm' };
    await expect(mail.send('a@b.test', content)).resolves.toEqual({ ok: true });
    expect(sendMail.mock.calls[0][0]).toMatchObject({ from: 'x@example.com', to: 'a@b.test', subject: 'Reset your TonyAI password' });
    await expect(mail.send('a@b.test', content)).resolves.toEqual({ ok: false, code: 'smtp_failed' });
    await expect(new MailService(undefined, null).send('a@b.test', content)).resolves.toEqual({ ok: false, code: 'mail_not_configured' });
  });
});
