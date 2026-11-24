import { describe, expect, it } from 'vitest';
import { CSP_REPORT_FIELD_MAX, CSP_REPORTS_PER_BODY, summariseCspReports } from './csp-report';

const legacy = (report: Record<string, unknown>) => JSON.stringify({ 'csp-report': report });
const reporting = (bodies: Record<string, unknown>[]) =>
  JSON.stringify(bodies.map((body) => ({ type: 'csp-violation', url: 'https://qa.example/users?token=t', body })));

describe('summariseCspReports (pre-g5-security-hardening)', () => {
  it('reads a report-uri report: directive, blocked origin, page path, disposition — no query, no fragment', () => {
    expect(summariseCspReports(legacy({
      'document-uri': 'https://qa.example/reports?year=2026#x',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.example/x.js?session=secret#frag',
      disposition: 'enforce',
    }))).toEqual([{ directive: 'script-src-elem', blockedOrigin: 'https://evil.example', pagePath: '/reports', disposition: 'enforce' }]);
  });

  it('reads Reporting API reports, keeps keywords as themselves, and skips other report types', () => {
    const body = JSON.stringify([
      { type: 'csp-violation', url: 'https://qa.example/', body: { documentURL: 'https://qa.example/emissions?a=1', blockedURL: 'inline', effectiveDirective: 'style-src-attr', disposition: 'enforce' } },
      { type: 'deprecation', body: { id: 'x' } },
      { type: 'csp-violation', body: { documentURL: 'https://qa.example/', blockedURL: 'eval?x', effectiveDirective: 'script-src', disposition: 'report' } },
    ]);
    expect(summariseCspReports(body)).toEqual([
      { directive: 'style-src-attr', blockedOrigin: 'inline', pagePath: '/emissions', disposition: 'enforce' },
      { directive: 'script-src', blockedOrigin: 'eval', pagePath: '/', disposition: 'report' },
    ]);
  });

  it('keeps a scheme, not a data or blob URL\'s content', () => {
    expect(summariseCspReports(legacy({ 'blocked-uri': 'data:text/html;base64,PHNjcmlwdD4=' }))[0].blockedOrigin).toBe('data');
  });

  it('never throws, and answers nothing it cannot use', () => {
    for (const raw of ['{', '', 'null', '42', '"x"', '{}', '[1, null, "x"]', '{"csp-report": 5}', undefined, null, {}, [], 7]) {
      expect(summariseCspReports(raw), String(raw)).toEqual([]);
    }
  });

  it('reads an already parsed body as well as text', () => {
    expect(summariseCspReports({ 'csp-report': { 'effective-directive': 'img-src' } })[0].directive).toBe('img-src');
  });

  it(`keeps at most ${CSP_REPORTS_PER_BODY} reports from one body`, () => {
    const many = reporting(Array.from({ length: 50 }, () => ({ effectiveDirective: 'img-src', documentURL: 'https://qa.example/' })));
    expect(summariseCspReports(many)).toHaveLength(CSP_REPORTS_PER_BODY);
  });

  it('cuts every field, and strips control and line-separator characters so a field cannot forge a log line', () => {
    const [summary] = summariseCspReports(legacy({
      'effective-directive': `img-src\n{"event":"forged"}\u2028${'x'.repeat(500)}`,
      'blocked-uri': `not a url\r\n${'y'.repeat(500)}`,
      disposition: 'enforce\u0000',
      // A right-to-left override and a zero-width space, built from code points.
      'document-uri': `https://qa.example/${String.fromCharCode(0x202e)}gpj.exe${String.fromCharCode(0x200b)}`,
    }));
    for (const value of Object.values(summary)) {
      expect(value.length).toBeLessThanOrEqual(CSP_REPORT_FIELD_MAX);
      // eslint-disable-next-line no-control-regex -- matching control characters is the point: they are stripped (or must be absent).
      expect(value).not.toMatch(/[\u0000-\u001f\u2028\u2029]/);
    }
    expect(summary.disposition).toBe('enforce');
    expect([...summary.pagePath].some((c) => [0x202e, 0x200b].includes(c.codePointAt(0)!))).toBe(false);
  });
});
