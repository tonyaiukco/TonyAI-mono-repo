import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  ADMIN_EMAIL,
  API_BASE,
  E2E_YEAR,
  ENTRY_EMAIL,
  SUB,
  approveRecord,
  bearer,
  createCommittedRecord,
  getAccessToken,
  login,
} from './helpers';

/**
 * Reports (WP6, FR §5): the page renders live data and each export button
 * produces a real, non-empty downloaded artifact. Generation is read-only
 * (plus an audit row), so no teardown is needed.
 */

test('reports: live preview + PDF/Excel/CSV downloads', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/reports');

  // Live preview: branded header, a real status badge (exact status depends on
  // what other serial tests have committed this run) and committed totals.
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.getByText('TonyAI Holding')).toBeVisible();
  await expect(
    page.getByText(/^(Approved|Draft — pending review|Contains incomplete data)$/).first(),
  ).toBeVisible();
  await expect(page.getByText('Committed records', { exact: false })).toBeVisible();

  // Each export produces a real download with the expected extension + content.
  // Exact server-chosen filenames (proves Content-Disposition survives CORS)
  // plus a magic-byte check that the artifact really is what it claims to be.
  const cases = [
    { button: 'Download PDF', file: 'tonyai-executive_summary-2026.pdf', magic: '%PDF', toast: 'PDF report generated' },
    { button: 'Export Excel', file: 'tonyai-executive_summary-2026.xlsx', magic: 'PK', toast: 'EXCEL report generated' },
    { button: 'Export CSV', file: 'tonyai-executive_summary-2026.csv', magic: 'subsidiary,', toast: 'CSV report generated' },
  ] as const;

  for (const c of cases) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: c.button }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(c.file);
    const path = await download.path();
    expect(path).toBeTruthy();
    const head = readFileSync(path!).subarray(0, 16).toString('utf8');
    expect(head.startsWith(c.magic)).toBe(true);
    await expect(page.getByText(c.toast).first()).toBeVisible();
  }
});

test('reports: data_entry can view report data but has no export controls', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  // Permissions matrix: "Generate and export reports" is denied to data_entry.
  await expect(page.getByText(/cannot generate or export reports/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0);
});

/**
 * WP20 — a restatement a reader can see.
 *
 * The unit specs prove the writers emit the disclosure from assembled data;
 * what they cannot show is that a figure withdrawn through the real API comes
 * back out of the real export with its reason attached. Until this shipped, an
 * export silently dropped withdrawn records and said nothing about it.
 *
 * Mostly API-level: the browser download path is already covered above, and the
 * central claim is about the artifact's CONTENT. It ends at the browser for the
 * one claim the artifact cannot make — that the SCREEN discloses the same thing
 * before anyone generates a file. Writes live in the quarterly space (global
 * teardown reclaims it) on a (subsidiary, category, quarter) tuple no other
 * spec uses.
 */
/** A seeded location belonging to `SUB.gas` (TonyAI Gas · London). */
const GAS_LONDON_LOCATION = '33333333-3333-3333-3333-333333330003';

async function withdrawnCount(request: APIRequestContext, token: string): Promise<number> {
  const res = await request.get(`${API_BASE}/reports/meta?year=${E2E_YEAR}`, {
    headers: bearer(token),
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { voidedCount: number }).voidedCount;
}

test('reports: a withdrawn figure is disclosed in the export, not silently omitted', async ({
  page,
  request,
}) => {
  const REASON = 'Withdrawn by the reports E2E — duplicate of the quarterly site invoice.';
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const before = await withdrawnCount(request, token);

  // Attributed to a SITE, not to the company: the reporting-entity column is
  // half of what this package added, and a company-level record would read
  // "Whole company" whether that column works or is hard-coded. Q2 rather than
  // Q3 keeps this off the tuple `turkish-filenames.spec` writes — sharing one
  // would leave two "/Q3 2026/" buttons in a list that spec clicks by `.first()`.
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.gas,
    locationId: GAS_LONDON_LOCATION,
    category: 'Electricity',
    periodValue: 'Q2',
    activityValue: 54_321,
  });
  await approveRecord(request, token, id);
  const withdrawal = await request.post(`${API_BASE}/activity-records/${id}/void`, {
    headers: bearer(token),
    data: { voidReason: REASON },
  });
  expect(withdrawal.ok()).toBe(true);

  const csvRes = await request.get(
    `${API_BASE}/reports/csv?template=ghg_protocol_detail&year=${E2E_YEAR}`,
    { headers: bearer(token) },
  );
  expect(csvRes.ok()).toBe(true);
  const lines = (await csvRes.text()).trim().split('\n');
  const header = lines[0].split(',');
  const at = (line: string, name: string) => line.split(',')[header.indexOf(name)];

  // The reason is deliberately comma-free so this row survives a naive split.
  const row = lines.find((l) => l.includes(REASON));
  expect(row, 'the withdrawn record is absent from the export').toBeDefined();
  expect(at(row!, 'status')).toBe('voided');
  expect(at(row!, 'reporting_entity')).toBe('London Distribution Centre');
  expect(at(row!, 'period_value')).toBe('Q2');
  // What left the inventory is stated in its own columns, and every column a
  // reader could sum carries the marker instead of a number.
  expect(Number(at(row!, 'voided_tco2e'))).toBeGreaterThan(0);
  expect(at(row!, 'voided_activity_value')).toBe('54321');
  for (const column of ['tco2e', 'activity_value', 'evidence_files', 'anomaly_flag']) {
    expect(at(row!, column)).toBe('Withdrawn');
  }
  // ...and it is the ONLY line carrying this activity value: a withdrawn record
  // that also appeared as a counted ledger row would be back in every total.
  expect(lines.filter((l) => l.includes('54321')).length).toBe(1);

  // Relative, not `> 0`: this database already holds withdrawn records (the six
  // WP18 repaired), so an absolute assertion is satisfied by the neighbours and
  // would pass with the endpoint ignoring this withdrawal entirely.
  expect(await withdrawnCount(request, token)).toBe(before + 1);

  // And the screen says it too, BEFORE anyone generates a file. The sentence
  // itself lives in `lib/report-view.ts` with its own unit spec, so the copy is
  // held; what nothing exercised is the wiring — that the page reads `meta` and
  // that the string reaches the DOM. Asserting the COUNT rather than the phrase
  // is what makes this bite: a banner built from the wrong field (the committed
  // count, say) still reads as a grammatical English sentence.
  //
  // The page defaults to `DEFAULT_REPORTING_YEAR`, which is `E2E_YEAR`, and the
  // suite runs with `workers: 1`, so the count the API just returned is the one
  // the page will load.
  await login(page, ADMIN_EMAIL);
  await page.goto('/reports');
  await expect(
    page.getByText(
      new RegExp(`${before + 1} records? (was|were) withdrawn from this reporting year`),
    ),
  ).toBeVisible();
});
