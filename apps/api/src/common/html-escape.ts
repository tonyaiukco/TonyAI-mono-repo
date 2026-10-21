/**
 * Escapes text a server-built HTML page interpolates as element content (the
 * report PDFs — `reports/report-columns.ts`'s `esc` — and the issued report's,
 * LP3-04 PR D). Quote-unaware on purpose — nothing interpolates caller text
 * into an attribute, and the day something does this must grow `"` and `'`
 * with it.
 */
export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
