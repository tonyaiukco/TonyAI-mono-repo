import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  login, bearer, getAccessToken, ADMIN_EMAIL, API_BASE, SUB,
  E2E_YEAR, E2E_PERIOD, EVIDENCE_FIXTURE,
} from './helpers';

/**
 * WP15 slice (e) — round-1 DE-8.
 *
 * This has to go through the REAL multipart path. The mangling happened inside
 * multer, before any of our code ran, so a unit test calling the service with a
 * hand-built `file` object cannot see it: `originalname` would already be
 * whatever the test author typed.
 */
const TURKISH_NAME = 'Şubat-Faturası-İĞÜÖÇ-ığüöç.pdf';

async function makeRecord(request: import('@playwright/test').APIRequestContext, token: string, periodValue: string) {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.gas, locationId: null, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue, category: 'Electricity',
      activityValue: 10, activityUnit: 'kWh', varianceReason: null, input: null,
    },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test('a Turkish filename survives the upload byte for byte', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const rec = await makeRecord(request, token, 'Q4');
  try {
    const up = await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
      headers: bearer(token),
      multipart: {
        file: { name: TURKISH_NAME, mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) },
      },
    });
    expect(up.status()).toBe(201);
    const ev = await up.json();

    // Byte-for-byte, not "looks Turkish": the failure mode was mojibake that
    // still contains letters, so a loose assertion would have passed.
    expect(ev.fileName).toBe(TURKISH_NAME);

    // …and it must come back the same way from a fresh read.
    const listed = await (
      await request.get(`${API_BASE}/activity-records/${rec.id}/evidence`, { headers: bearer(token) })
    ).json();
    expect(listed[0].fileName).toBe(TURKISH_NAME);

    // The download must land under the user's name, not the sanitised key.
    const signed = await (
      await request.get(`${API_BASE}/evidence/${ev.id}/url`, { headers: bearer(token) })
    ).json();
    expect(signed.url, 'the signed URL must carry a download filename').toMatch(/[?&]download=/);
    const downloadAs = decodeURIComponent(new URL(signed.url).searchParams.get('download') ?? '');
    expect(downloadAs).toBe(TURKISH_NAME);

    // The object key stays ASCII on purpose — opaque, uuid-uniquified, never shown.
    expect(signed.url).not.toContain('Ş');
  } finally {
    await request.delete(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) });
  }
});

test('the name renders unmangled in the evidence vault', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const rec = await makeRecord(request, token, 'Q3');
  try {
    await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
      headers: bearer(token),
      multipart: {
        file: { name: TURKISH_NAME, mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) },
      },
    });

    await login(page, ADMIN_EMAIL);
    await page.goto(`/data-entry?subsidiaryId=${SUB.gas}&category=Electricity&year=${E2E_YEAR}`);
    await page.getByRole('button', { name: /Q3 2026/ }).first().click();
    await expect(page.getByText(TURKISH_NAME)).toBeVisible();
  } finally {
    await request.delete(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) });
  }
});
