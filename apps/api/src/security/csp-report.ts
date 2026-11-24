/**
 * What the API keeps of a browser's CSP violation report: four short fields,
 * never a query string, a fragment or free text (`web-response-security`;
 * `pre-g5-security-hardening`). Both formats are read — `report-uri`'s
 * `{ "csp-report": { … } }` and the Reporting API's `[{ type, body: { … } }]` —
 * and nothing here throws: a report the reader cannot use is dropped.
 */
export interface CspReportSummary {
  directive: string;
  blockedOrigin: string;
  pagePath: string;
  disposition: string;
}

/** At most this many reports are kept from one body. */
export const CSP_REPORTS_PER_BODY = 10;
/** Every kept field is cut to this many characters. */
export const CSP_REPORT_FIELD_MAX = 200;

/**
 * Control characters (C0, DEL, C1), line and paragraph separators, and the
 * zero-width and bidi format characters: a field can never forge a log line
 * or reorder how one reads. Built from code points, so the source holds no
 * invisible character.
 */
const UNSAFE = new RegExp(
  '[' +
    [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
      .map(([from, to]) => `\\u${from.toString(16).padStart(4, '0')}-\\u${to.toString(16).padStart(4, '0')}`)
      .join('') +
    ']',
  'g',
);

/** Printable, single-line, bounded. */
function clip(value: string): string {
  return value.replace(UNSAFE, '').slice(0, CSP_REPORT_FIELD_MAX);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? clip(value) : 'unknown';
}

/** A URL's origin; a keyword (`inline`, `eval`, `data`, …) as itself, never what follows `?` or `#`. */
function blockedOriginOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  try {
    const url = new URL(value);
    return clip(url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol.replace(/:$/, ''));
  } catch {
    return clip(value.split(/[?#]/)[0]);
  }
}

function pathOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  try {
    return clip(new URL(value).pathname);
  } catch {
    return 'unknown';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function fromReportUri(body: Record<string, unknown>): CspReportSummary {
  return {
    directive: text(body['effective-directive'] ?? body['violated-directive']),
    blockedOrigin: blockedOriginOf(body['blocked-uri']),
    pagePath: pathOf(body['document-uri']),
    disposition: text(body.disposition),
  };
}

function fromReportingApi(report: Record<string, unknown>): CspReportSummary | null {
  if (report.type !== 'csp-violation') return null;
  const body = record(report.body);
  if (!body) return null;
  return {
    directive: text(body.effectiveDirective),
    blockedOrigin: blockedOriginOf(body.blockedURL),
    pagePath: pathOf(body.documentURL ?? report.url),
    disposition: text(body.disposition),
  };
}

/** The reports in a raw body (a string, or what a parser made of it); empty when there are none. */
export function summariseCspReports(raw: unknown): CspReportSummary[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const single = record(parsed);
  const legacy = single ? record(single['csp-report']) : null;
  if (legacy) return [fromReportUri(legacy)];
  if (!Array.isArray(parsed)) return [];
  const out: CspReportSummary[] = [];
  for (const item of parsed.slice(0, CSP_REPORTS_PER_BODY)) {
    const report = record(item);
    const summary = report ? fromReportingApi(report) : null;
    if (summary) out.push(summary);
  }
  return out;
}
