import { describe, expect, it } from 'vitest';
import { AUTH_LINK_TTL_HOURS, escapeHtml, MAIL_CATALOGUES, renderMail } from './mail-templates';

const LINK = 'http://localhost:3000/auth/confirm?token_hash=abc&type=invite';

/** Every leaf of a catalogue, by dotted path. */
function leaves(node: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string') out.set(`${path}${key}`, value);
    else for (const [k, v] of leaves(value, `${path}${key}.`)) out.set(k, v);
  }
  return out;
}
const argsOf = (message: string) => [...message.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

describe('the email catalogues (D16)', () => {
  const en = leaves(MAIL_CATALOGUES.en);
  const tr = leaves(MAIL_CATALOGUES.tr);

  it('hold the same keys and the same ICU arguments in both languages', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, message] of en) expect(argsOf(tr.get(key)!), key).toEqual(argsOf(message));
  });

  it('translate every sentence — none left in English', () => {
    for (const [key, message] of en) expect(tr.get(key), key).not.toBe(message);
  });

  it('carry no control, bidi, zero-width or no-break character', () => {
    // By code point: written as characters, these would hide in this file too.
    const invisible = (cp: number) =>
      (cp < 0x20 && cp !== 0x0a) || cp === 0xa0 || (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff;
    for (const catalogue of [en, tr]) {
      for (const [key, message] of catalogue) {
        expect([...message].some((ch) => invisible(ch.codePointAt(0)!)), key).toBe(false);
      }
    }
  });
});

describe('escapeHtml', () => {
  it('escapes all five characters that change HTML meaning, attributes included', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('renderMail', () => {
  it('renders an invitation in the chosen language, with the inviter and the link', () => {
    const mail = renderMail({ kind: 'invitation', language: 'tr', name: 'Ayşe', organisation: 'Örnek Holding', inviter: 'Mehmet', link: LINK });
    expect(mail.subject).toBe("TonyAI'da Örnek Holding için davetiniz var");
    expect(mail.text).toContain('Mehmet, sizi');
    expect(mail.text).toContain(LINK);
    expect(mail.text).toContain(`${AUTH_LINK_TTL_HOURS} saat`);
    expect(mail.text).toContain('yöneticinizden');
    expect(mail.html).toContain('lang="tr"');
    expect(mail.html).toContain(`href="${escapeHtml(LINK)}"`);
  });

  it('words the operator’s invitation for a first administrator — no administrator to ask yet', () => {
    const mail = renderMail({ kind: 'invitation', language: 'en', name: 'Ann', organisation: 'Acme', inviter: null, link: LINK });
    expect(mail.text).toContain('as its first administrator');
    expect(mail.text).toContain('ask TonyAI');
    expect(mail.text).not.toContain('ask your administrator');
  });

  it('renders a reset in English, one hour stated', () => {
    const mail = renderMail({ kind: 'password_reset', language: 'en', name: 'Ann', link: LINK });
    expect(mail.subject).toBe('Reset your TonyAI password');
    expect(mail.text).toContain('expires in 1 hour.');
  });

  it('escapes what people typed in the HTML part, never in the text part, and keeps the subject on one line', () => {
    const mail = renderMail({
      kind: 'invitation',
      language: 'en',
      name: '<img src=x onerror=alert(1)>',
      organisation: 'Evil "Org"\r\nBcc: victim@example.com',
      inviter: "O'Brien & <b>Co</b>",
      link: LINK,
    });
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail.html).toContain('O&#39;Brien &amp; &lt;b&gt;Co&lt;/b&gt;');
    expect(mail.text).toContain('<img src=x onerror=alert(1)>');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});
