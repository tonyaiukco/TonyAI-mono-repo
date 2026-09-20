import { test, expect, type APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import type { BulkUploadAcceptedRow, BulkUploadRowIssue } from '@tonyai/shared-types';
// The API's own hand-built workbook fixtures: the files below are ones no
// spreadsheet writer can produce, which is the point of them.
import { row, xlsx } from '../apps/api/test/xlsx';
import {
  API_BASE,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_PERIOD,
  E2E_YEAR,
  ENTRY_EMAIL,
  SUB,
  getAccessToken,
  postBulkImport,
  waitOutImportThrottle,
} from './helpers';

/**
 * An XLSX through the real stack: multipart, the audited pre-flight, and the
 * bounded reader that replaced exceljs's loader.
 *
 * The reader's specs build every hostile file there is, but only a running API
 * can show what the change was for: a workbook that used to take the process
 * down is answered, and the next request is served. Under the old loader the
 * second test here aborted the API, and every test after it in the run would
 * have failed to connect.
 *
 * Lane: `SUB.logistics` / quarterly `E2E_YEAR` / Q1 and Q2, category `Waste` —
 * a subsidiary and category no other spec writes together. Every import is a
 * dry run, so nothing is written and nothing needs cleaning up.
 *
 * Budget: four imports, all as `entry@`, inside the fresh window `beforeAll`
 * buys. The route allows five per minute per user.
 */
const HEADER = [
  'subsidiaryId',
  'locationId',
  'reportingYear',
  'reportingPeriod',
  'periodValue',
  'category',
  'activityValue',
  'activityUnit',
  'varianceReason',
];

const values = (periodValue: string, activityValue: number, locationId: string | null = null) => [
  SUB.logistics,
  locationId,
  E2E_YEAR,
  E2E_PERIOD,
  periodValue,
  E2E_BULK_CATEGORY,
  activityValue,
  E2E_BULK_UNIT,
  null,
];

interface Report {
  dryRun: boolean;
  accepted: BulkUploadAcceptedRow[];
  errors: BulkUploadRowIssue[];
}

function dryRun(request: APIRequestContext, token: string, buffer: Buffer, fileName: string) {
  return postBulkImport(request, token, {
    buffer,
    fileName,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dryRun: 'true',
  });
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  // The hook's own timeout defaults to the test timeout, which is 60s — one
  // second less than the wait it has to make.
  test.setTimeout(90_000);
  await waitOutImportThrottle();
});

test('a workbook saved by a spreadsheet writer dry-runs row for row', async ({ request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Records');
  sheet.addRow(HEADER);
  sheet.addRow(values('Q1', 12));
  sheet.addRow(values('Q2', 14));

  const response = await dryRun(
    request,
    token,
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'records.xlsx',
  );

  expect(response.ok()).toBe(true);
  const report = (await response.json()) as Report;
  expect(report.dryRun).toBe(true);
  expect(report.errors).toEqual([]);
  expect(report.accepted.map((accepted) => accepted.row)).toEqual([2, 3]);
});

test('a workbook that killed the old loader is answered, and the API keeps serving', async ({
  request,
}) => {
  // A dropdown over the whole sheet, a merge to its last cell, a name over all
  // of it and a column span far past XFD. Under exceljs's loader, each of these
  // alone aborted the process under a 256 MB heap (measured).
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const buffer = xlsx({
    sheetData: row(1, HEADER) + row(2, values('Q1', 12)) + row(3, values('Q2', 14)),
    beforeSheetData: '<cols><col min="1" max="200000000" width="12" customWidth="1"/></cols>',
    afterSheetData:
      '<mergeCells count="1"><mergeCell ref="K4:XFD1048576"/></mergeCells>' +
      '<dataValidations count="1"><dataValidation type="list" sqref="A1:XFD1048576"><formula1>"a,b"</formula1></dataValidation></dataValidations>',
    afterSheets:
      '<definedNames><definedName name="Everything">Records!$A$1:$XFD$1048576</definedName></definedNames>',
  });
  expect(buffer.length).toBeLessThan(4 * 1024);

  const response = await dryRun(request, token, buffer, 'hostile.xlsx');

  expect(response.ok()).toBe(true);
  const report = (await response.json()) as Report;
  expect(report.accepted.map((accepted) => accepted.row)).toEqual([2, 3]);
  // The process is still there to answer.
  expect((await request.get(`${API_BASE}/health`)).ok()).toBe(true);
});

test('a merged cell over an imported column, and an archive that unpacks too far, are refused in words', async ({
  request,
}) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);

  const merged = await dryRun(
    request,
    token,
    xlsx({
      sheetData: row(1, HEADER) + row(2, values('Q1', 12, 'site')) + row(3, values('Q2', 14)),
      afterSheetData: '<mergeCells count="1"><mergeCell ref="B2:B3"/></mergeCells>',
    }),
    'merged.xlsx',
  );
  expect(merged.status()).toBe(400);
  // Keyed on WHICH cells and WHICH column, not on the prose around them:
  // naming the wrong range is the defect a user would be sent hunting by, and
  // `parse-rows.spec.ts` pins the sentence itself where the parser lives.
  expect((await merged.json()).message).toMatch(/merged cells B2:B3.*locationId/);

  // 64 MiB of sheet in a few kilobytes: the bomb shape.
  const bomb = xlsx({ sheetData: row(1, HEADER) + ' '.repeat(64 * 1024 * 1024) });
  const tooLarge = await dryRun(request, token, bomb, 'bomb.xlsx');
  expect(tooLarge.status()).toBe(400);
  // Likewise: that the refusal is about the UNPACKED size is the property —
  // a bomb refused for its packed size would be a different, broken cap.
  expect((await tooLarge.json()).message).toMatch(/unpacked/i);
});
