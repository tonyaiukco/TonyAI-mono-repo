import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  bearer, getAccessToken, supabaseEnv,
  ADMIN_EMAIL, API_BASE, E2E_YEAR, E2E_PERIOD, EVIDENCE_FIXTURE,
} from './helpers';

/**
 * Evidence files are utility invoices — commercial and personal data. A file
 * that outlives every pointer to it is a retention problem (KVKK/GDPR), not
 * wasted disk.
 *
 * Evidence rows once hung off one record with ON DELETE CASCADE, so deleting a
 * record removed them inside Postgres, below the application, where nothing
 * could see them go and therefore nothing deleted the objects. Measured on the
 * local stack before this: 1501 objects in the bucket against 102 rows. Since
 * WP8 PR7 one file can back several records: deleting a record takes its
 * LINKS, and the file goes only with its last one.
 *
 * These specs assert against STORAGE, not against the API's own view of itself.
 * Asking the API whether the evidence is gone only proves the rows cascaded,
 * which was never in doubt and is exactly what made the leak invisible.
 */

function serviceKey(): string {
  const key = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  return key;
}

/** The object keys behind a record's evidence — never exposed by the API (the
 *  DTO deliberately strips `storagePath`), so read them straight from the tables. */
async function storagePathsOf(request: APIRequestContext, recordId: string): Promise<string[]> {
  const { url } = supabaseEnv();
  const key = serviceKey();
  const res = await request.get(
    `${url}/rest/v1/evidence?select=storage_path,activity_record_evidence!inner(activity_record_id)` +
      `&activity_record_evidence.activity_record_id=eq.${recordId}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { storage_path: string }[]).map((r) => r.storage_path);
}

async function objectExists(request: APIRequestContext, path: string): Promise<boolean> {
  const { url } = supabaseEnv();
  const key = serviceKey();
  const res = await request.get(`${url}/storage/v1/object/evidence/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return res.status() === 200;
}

test('deleting a record deletes its evidence FILES, not just the rows', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const subs = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  const rec = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: subs[0].id, locationId: null, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q3', category: 'Electricity',
      activityValue: 77, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();
  await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
    headers: bearer(token),
    multipart: { file: { name: 'retention.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) } },
  });

  const [path] = await storagePathsOf(request, rec.id);
  expect(path, 'the upload must have produced an object key').toBeTruthy();
  expect(await objectExists(request, path)).toBe(true);

  expect((await request.delete(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) })).status()).toBe(200);

  // The row cascading away was never in doubt. The file is the point.
  expect(
    await objectExists(request, path),
    'the evidence file must not outlive the record that pointed at it',
  ).toBe(false);
});

test('deleting one evidence file leaves the record and its other files alone', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const subs = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  const rec = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: subs[0].id, locationId: null, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q4', category: 'Electricity',
      activityValue: 88, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();
  for (const name of ['keep.pdf', 'drop.pdf']) {
    await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
      headers: bearer(token),
      multipart: { file: { name, mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) } },
    });
  }

  const list = await (await request.get(`${API_BASE}/activity-records/${rec.id}/evidence`, { headers: bearer(token) })).json();
  const drop = list.find((e: { fileName: string }) => e.fileName === 'drop.pdf');
  const before = await storagePathsOf(request, rec.id);
  expect(before).toHaveLength(2);

  expect((await request.delete(`${API_BASE}/evidence/${drop.id}`, { headers: bearer(token) })).status()).toBe(200);

  const after = await storagePathsOf(request, rec.id);
  expect(after).toHaveLength(1);
  // Exactly one object went, and it was the right one.
  const [gone] = before.filter((p) => !after.includes(p));
  expect(await objectExists(request, gone)).toBe(false);
  expect(await objectExists(request, after[0])).toBe(true);

  await request.delete(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) });
});

test('a file shared by two records survives the first record and goes with its last link', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const subs = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  // At a LOCATION, unlike the two tests above. Uniqueness includes
  // `location_id` (NULLS NOT DISTINCT), so a site record is a different slot
  // from the whole-company one — and the whole-company quarters of this
  // subsidiary are spoken for: `data-entry-happy` takes Q1 and
  // `bulk-upload-panel` takes Q3. The first nightly on `main` failed here
  // with a 409 for exactly that reason.
  const locs = await (await request.get(
    `${API_BASE}/locations?subsidiaryId=${subs[0].id}`,
    { headers: bearer(token) },
  )).json();
  expect(locs.length, 'the seed gives this subsidiary at least one location').toBeGreaterThan(0);
  const locationId = (locs[0] as { id: string }).id;
  const create = async (periodValue: string) => {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: { subsidiaryId: subs[0].id, locationId, reportingYear: E2E_YEAR,
        reportingPeriod: E2E_PERIOD, periodValue, category: 'Electricity',
        activityValue: 66, activityUnit: 'kWh', varianceReason: null, input: null },
    });
    // A leftover record in this slot would otherwise surface later as a
    // confusing upload refusal instead of the real conflict.
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const first = await create('Q1');
  const second = await create('Q2');

  // One upload for both records (`POST /evidence`, WP8 PR7).
  const upload = await request.post(`${API_BASE}/evidence`, {
    headers: bearer(token),
    multipart: {
      file: { name: 'shared.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) },
      recordIds: JSON.stringify([first.id, second.id]),
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const file = (await upload.json()) as { id: string; linkedRecords: { id: string }[] };
  expect(file.linkedRecords.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());

  const [path] = await storagePathsOf(request, first.id);
  expect(await storagePathsOf(request, second.id)).toEqual([path]);
  expect(await objectExists(request, path)).toBe(true);

  // Deleting one record keeps the file the other still holds.
  expect((await request.delete(`${API_BASE}/activity-records/${first.id}`, { headers: bearer(token) })).status()).toBe(200);
  expect(await objectExists(request, path), 'the other record still holds this file').toBe(true);
  const left = await (await request.get(`${API_BASE}/activity-records/${second.id}/evidence`, { headers: bearer(token) })).json();
  expect(left.map((e: { id: string }) => e.id)).toEqual([file.id]);

  // Taking it off its last record deletes it — in storage, not just in the table.
  const detach = await request.delete(
    `${API_BASE}/activity-records/${second.id}/evidence/${file.id}`,
    { headers: bearer(token) },
  );
  expect(detach.status()).toBe(200);
  expect(await detach.json()).toEqual({ evidenceId: file.id, recordId: second.id, fileDeleted: true });
  expect(await objectExists(request, path)).toBe(false);

  await request.delete(`${API_BASE}/activity-records/${second.id}`, { headers: bearer(token) });
});
