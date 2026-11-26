import { test, expect, type APIRequestContext } from '@playwright/test';
import type { RollUpResponse, SubsidiaryDTO, UserSummaryDTO } from '@tonyai/shared-types';
import enUsers from '../apps/web/messages/en/users.json';
import enSubsidiaries from '../apps/web/messages/en/subsidiaries.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  AUDITOR_EMAIL,
  E2E_PERIOD,
  E2E_YEAR,
  ENTRY_EMAIL,
  SUB,
  bearer,
  createCommittedRecord,
  deleteCompanyWithFacilities,
  deleteRecordsAsService,
  getAccessToken,
  listAllPages,
  login,
  pickByFieldLabel,
  recordDeciderEmail,
  resetSeedAccess,
} from './helpers';

/**
 * The group tree end to end (inc26-group-tree, tasks 8.1–8.4): a masterkey's
 * branch nested on the company screen with its roll-up, a move and the tree's
 * refusals; an associate kept out of every picker and every figure; a
 * super_admin's child company granted to its creator, with a standard user's
 * record routed to it; a super_admin declaring its own company in the open
 * boundary version; and the consolidation approach in a live report.
 *
 * Every node is created by the spec and deleted in its own `finally`
 * (facilities first: a company with one is not deleted, RD9). Records live
 * in the quarterly space of `E2E_YEAR`, in companies made here.
 */

async function api<T>(request: APIRequestContext, token: string, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, data?: unknown) {
  const res = await request[method](`${API_BASE}${path}`, { headers: bearer(token), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  return { status: res.status(), json: (text ? JSON.parse(text) : null) as T };
}

async function node(request: APIRequestContext, token: string, body: Record<string, unknown>): Promise<SubsidiaryDTO> {
  const res = await api<SubsidiaryDTO>(request, token, 'post', '/subsidiaries', { geographyCode: 'TR', ...body });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json;
}

async function rootOf(request: APIRequestContext, token: string): Promise<SubsidiaryDTO> {
  const list = (await api<SubsidiaryDTO[]>(request, token, 'get', '/subsidiaries')).json;
  const root = list.find((s) => s.nodeType === 'holding');
  expect(root, 'the seed organisation has its root').toBeTruthy();
  return root as SubsidiaryDTO;
}

/** Bottom-up: a node with a child is not deleted. */
async function teardown(request: APIRequestContext, token: string, ids: string[]) {
  for (const id of [...ids].reverse()) await deleteCompanyWithFacilities(request, token, id);
}

test('a masterkey builds a branch, sees it nested with its roll-up, moves an empty company, and is refused a cycle and a delete with a child (8.1)', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const root = await rootOf(request, token);
  const made: string[] = [];
  try {
    const subHolding = await node(request, token, { legalName: 'E2E Tree Sub-holding', nodeType: 'sub_holding', parentId: root.id });
    made.push(subHolding.id);
    const sectorGroup = await node(request, token, { legalName: 'E2E Tree Sector', nodeType: 'sector_group', parentId: subHolding.id });
    made.push(sectorGroup.id);
    const company = await node(request, token, { legalName: 'E2E Tree Company', nodeType: 'company', parentId: sectorGroup.id });
    made.push(company.id);

    // The child company through the create dialog: its parent picked, its type follows.
    await login(page, ADMIN_EMAIL);
    await page.goto('/subsidiaries');
    await page.getByRole('button', { name: 'Add Subsidiary' }).click();
    const dialog = page.getByRole('dialog');
    await pickByFieldLabel(page, enSubsidiaries.tree.parent, `E2E Tree Company · ${enSubsidiaries.tree.types.company}`);
    await expect(dialog.getByRole('combobox', { name: enSubsidiaries.tree.type })).toHaveText(enSubsidiaries.tree.types.child_company);
    await dialog.getByRole('textbox').first().fill('E2E Tree Child');
    await dialog.getByLabel('Facility name').fill('E2E Tree Child Site');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/subsidiaries\/[0-9a-f-]{36}$/);
    const childId = page.url().split('/').pop() as string;
    made.push(childId);
    await expect(page.getByTestId('group-tree-card')).toContainText(enSubsidiaries.tree.types.child_company);

    // Four levels nested under the root, each with its type; the roll-up beside them.
    await page.goto('/subsidiaries');
    for (const [id, depth] of [[root.id, '0'], [subHolding.id, '1'], [sectorGroup.id, '2'], [company.id, '3'], [childId, '4']] as const) {
      await expect(page.getByTestId(`tree-row-${id}`)).toHaveAttribute('data-depth', depth);
    }
    await expect(page.getByTestId(`tree-row-${sectorGroup.id}`)).toContainText(enSubsidiaries.tree.types.sector_group);
    await expect(page.getByRole('columnheader', { name: enSubsidiaries.tree.columns.rollUp })).toBeVisible();
    await expect(page.getByText(enSubsidiaries.tree.figuresLoading)).toHaveCount(0);
    await expect(page.getByTestId(`tree-row-${root.id}`).getByRole('cell').nth(3)).toHaveText(/\d/);
    // A branch collapses and opens.
    await page.getByRole('button', { name: `Hide the companies under E2E Tree Sub-holding` }).click();
    await expect(page.getByTestId(`tree-row-${company.id}`)).toHaveCount(0);
    await page.getByRole('button', { name: `Show the companies under E2E Tree Sub-holding` }).click();
    await expect(page.getByTestId(`tree-row-${company.id}`)).toBeVisible();

    // An empty company moves; the tree refuses a cycle and a delete with a child.
    const empty = await node(request, token, { legalName: 'E2E Tree Empty' });
    made.push(empty.id);
    const moved = await api<SubsidiaryDTO>(request, token, 'patch', `/subsidiaries/${empty.id}`, { parentId: sectorGroup.id });
    expect(moved.status).toBe(200);
    expect(moved.json.parentId).toBe(sectorGroup.id);
    const beneath = await node(request, token, { legalName: 'E2E Tree Sub-holding 2', nodeType: 'sub_holding', parentId: subHolding.id });
    made.splice(1, 0, beneath.id);
    const cycle = await api<{ code: string }>(request, token, 'patch', `/subsidiaries/${subHolding.id}`, { parentId: beneath.id });
    expect([cycle.status, cycle.json.code]).toEqual([409, 'tree_cycle']);
    const del = await api<{ code: string; message: string }>(request, token, 'delete', `/subsidiaries/${company.id}`);
    expect([del.status, del.json.code]).toEqual([409, 'subsidiary_in_use']);
    expect(del.json.message).toMatch(/1 child company node\(s\)/);
  } finally {
    await teardown(request, token, made);
  }
});

test('an associate is kept out of the pickers and the figures, named in the exclusions note; a company in use is not ticked (8.2)', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const associate = await node(request, token, { legalName: 'E2E Tree Associate', control: 'associate', sharePercent: 20 });
  try {
    const record = await api<{ code: string }>(request, token, 'post', '/activity-records', {
      subsidiaryId: associate.id, locationId: null, reportingYear: E2E_YEAR, reportingPeriod: E2E_PERIOD,
      periodValue: 'Q1', category: 'Electricity', activityValue: 10, activityUnit: 'kWh', varianceReason: null, input: null,
    });
    expect([record.status, record.json.code]).toEqual([409, 'entity_closed_to_data_entry']);
    const tick = await api<{ code: string; message: string }>(request, token, 'patch', `/subsidiaries/${SUB.energy}`, { control: 'associate' });
    expect([tick.status, tick.json.code]).toEqual([409, 'control_change_blocked']);
    expect(tick.json.message).toMatch(/activity records/);

    await login(page, ADMIN_EMAIL);
    await page.goto('/subsidiaries');
    await expect(page.getByTestId(`tree-row-${associate.id}`)).toContainText(enSubsidiaries.tree.associateLabel);
    const note = page.getByTestId('boundary-exclusions');
    // The whole sentence, share formatted: a bare '20' matched any number.
    await expect(note).toContainText(
      enSubsidiaries.exclusions.itemShare.replace('{name}', 'E2E Tree Associate').replace('{share}', '20'),
    );

    // The access picker of an invitation lists neither it nor the seed's sector group.
    await page.goto('/users');
    await page.getByRole('button', { name: enUsers.invite }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('checkbox', { name: 'TonyAI Energy A.Ş.' })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'E2E Tree Associate' })).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: 'TonyAI Energy & Utilities Group' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Data Entry offers neither.
    await page.goto('/data-entry');
    const field = page.locator('div.space-y-2', { has: page.getByText('Subsidiary', { exact: true }) });
    await field.getByRole('combobox').click();
    await expect(page.getByRole('option', { name: 'TonyAI Energy (TR)', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: /E2E Tree Associate/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /Utilities Group/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await teardown(request, token, [associate.id]);
  }
});

test("a super_admin creates a child company under its own, is granted it alone, and decides its standard user's record there (8.3)", async ({ page, request }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  let childId: string | null = null;
  let recordId: string | null = null;
  try {
    await login(page, APPROVER_EMAIL);
    await page.goto('/subsidiaries');
    await page.getByRole('button', { name: 'Add Subsidiary' }).click();
    const dialog = page.getByRole('dialog');
    await pickByFieldLabel(page, enSubsidiaries.tree.parent, `TonyAI Gas Ltd. · ${enSubsidiaries.tree.types.company}`);
    await expect(dialog.getByRole('combobox', { name: enSubsidiaries.tree.type })).toHaveText(enSubsidiaries.tree.types.child_company);
    await dialog.getByRole('textbox').first().fill('E2E Tree SA Child');
    await dialog.getByLabel('Facility name').fill('E2E Tree SA Site');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/subsidiaries\/[0-9a-f-]{36}$/);
    childId = page.url().split('/').pop() as string;
    await expect(page.getByTestId('group-tree-card')).toContainText(enUsers.roles.super_admin);

    // Granted to its creator in the same step, and to nobody else.
    const users = await listAllPages<UserSummaryDTO>(request, admin, '/users');
    const holders = users.filter((u) => u.access.some((g) => g.subsidiaryId === childId)).map((u) => u.email);
    expect(holders).toEqual([APPROVER_EMAIL]);

    // The super_admin assigns the standard user to it (within its own companies).
    const approver = await getAccessToken(request, APPROVER_EMAIL);
    const entry = users.find((u) => u.email === ENTRY_EMAIL) as UserSummaryDTO;
    const assigned = await api(request, approver, 'put', `/users/${entry.id}/access`, { access: [{ subsidiaryId: childId, categories: ['Water'] }] });
    expect(assigned.status, JSON.stringify(assigned.json)).toBe(200);

    // The standard user's submitted record there awaits that super_admin.
    recordId = await createCommittedRecord(request, await getAccessToken(request, ENTRY_EMAIL), {
      subsidiaryId: childId, category: 'Water', periodValue: 'Q2', activityValue: 30, activityUnit: 'cubic_metres',
      activityType: null, varianceReason: 'e2e: group tree lane',
    });
    expect(await recordDeciderEmail(request, recordId)).toBe(APPROVER_EMAIL);
  } finally {
    if (recordId) await deleteRecordsAsService(request, [recordId]);
    await resetSeedAccess(request);
    if (childId) await deleteCompanyWithFacilities(request, admin, childId);
  }
});

test("a super_admin declares its own company in the masterkey's open version and cannot confirm it; the approach reaches the live report (8.4)", async ({ page, request }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const approver = await getAccessToken(request, APPROVER_EMAIL);
  const year = 2032; // a year no other spec's boundary uses
  const opened = await api<{ id: string }>(request, admin, 'post', '/inventory-boundaries', { reportingYear: year });
  expect(opened.status).toBe(201);
  try {
    const listed = await api<{ id: string }[]>(request, approver, 'get', `/inventory-boundaries?reportingYear=${year}`);
    expect(listed.json.map((v) => v.id)).toEqual([opened.json.id]);
    const declaration = { firstMonth: 1, lastMonth: 12, sites: [], attribution: [], applicability: [], sources: [] };
    const put = await api(request, approver, 'put', `/inventory-boundaries/${opened.json.id}/subsidiaries/${SUB.gas}`, declaration);
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const other = await api<{ code: string }>(request, approver, 'put', `/inventory-boundaries/${opened.json.id}/subsidiaries/${SUB.trading}`, declaration);
    expect([other.status, other.json.code]).toEqual([404, 'subsidiary_not_found']);
    expect((await api(request, approver, 'post', `/inventory-boundaries/${opened.json.id}/confirm`)).status).toBe(403);

    // The masterkey changes the approach; the live report's methodology states it.
    expect((await api(request, admin, 'patch', '/organisation/consolidation-approach', { consolidationApproach: 'financial_control' })).status).toBe(200);
    await login(page, ADMIN_EMAIL);
    await page.goto('/reports');
    await expect(page.getByText(/Consolidation approach: financial control\./)).toBeVisible();
    await expect(page.getByText(/Boundary: operational control/)).toHaveCount(0);
  } finally {
    await api(request, admin, 'patch', '/organisation/consolidation-approach', { consolidationApproach: 'operational_control' });
    await api(request, admin, 'delete', `/inventory-boundaries/${opened.json.id}`);
  }
});

test("a facility takes an optional type; in Turkish the tree names its types and the approach; a super_admin's boundary screen edits only its own companies (6.4, 6.6, 7.2)", async ({ page, request, browser }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const year = 2033; // a year no other spec's boundary uses
  // What a failed earlier run left: its open version and its company.
  for (const v of (await api<{ id: string; frozenAt: string | null }[]>(request, admin, 'get', `/inventory-boundaries?reportingYear=${year}`)).json) {
    if (v.frozenAt === null) await api(request, admin, 'delete', `/inventory-boundaries/${v.id}`);
  }
  for (const s of (await api<SubsidiaryDTO[]>(request, admin, 'get', '/subsidiaries')).json) {
    if (s.legalName === 'E2E Tree Facility Co') await deleteCompanyWithFacilities(request, admin, s.id);
  }
  const company = await node(request, admin, { legalName: 'E2E Tree Facility Co' });
  const opened = await api<{ id: string }>(request, admin, 'post', '/inventory-boundaries', { reportingYear: year });
  expect(opened.status).toBe(201);
  try {
    // A facility with a type, then without one (RD12).
    await login(page, ADMIN_EMAIL);
    await page.goto(`/subsidiaries/${company.id}`);
    const name = page.locator('div.space-y-2', { has: page.getByText(enSubsidiaries.locations.name, { exact: true }) }).getByRole('textbox');
    await name.fill('E2E Tree Warehouse');
    await pickByFieldLabel(page, enSubsidiaries.locations.type, enSubsidiaries.locations.types.warehouse);
    await page.getByRole('button', { name: enSubsidiaries.locations.add }).click();
    await expect(page.getByText(enSubsidiaries.locations.added)).toBeVisible();
    await expect(page.getByText(`${enSubsidiaries.locations.types.warehouse} · `)).toBeVisible();
    const [site] = (await api<{ id: string; locationType: string | null }[]>(request, admin, 'get', `/locations?subsidiaryId=${company.id}`)).json;
    expect(site.locationType).toBe('warehouse');
    await page.getByRole('button', { name: enSubsidiaries.locations.edit }).first().click();
    await pickByFieldLabel(page, enSubsidiaries.locations.type, enSubsidiaries.locations.typeNone);
    await page.getByRole('button', { name: enSubsidiaries.locations.save }).click();
    await expect(page.getByText(enSubsidiaries.locations.updated)).toBeVisible();
    expect((await api<{ locationType: string | null }>(request, admin, 'get', `/locations/${site.id}`)).json.locationType).toBeNull();

    // The tree in Turkish: the fixed type names, the approach, the associate label.
    expect((await api(request, admin, 'patch', '/me/preferences', { language: 'tr' })).status).toBe(200);
    await page.goto('/subsidiaries');
    await expect(page.getByTestId(`tree-row-${SUB.sectorGroup}`)).toContainText('Sektör Grubu');
    await expect(page.getByTestId(`tree-row-${SUB.childCompany}`)).toContainText('Alt Şirket');
    await expect(page.getByTestId(`tree-row-${SUB.associate}`)).toContainText('Öz kaynak — Kapsam 1/2 dışı');
    await expect(page.getByTestId('consolidation-card')).toContainText('Operasyonel kontrol');
    await expect(page.getByTestId('boundary-exclusions')).toContainText('Bosphorus Associates A.Ş.');
    await api(request, admin, 'patch', '/me/preferences', { language: 'en' });

    // The masterkey's boundary screen offers every company that holds records
    // and no closed node — the anchor the super_admin's absences below lack
    // (a super_admin is never granted a closed node at all).
    const mk = await browser.newContext();
    try {
      const mkPage = await mk.newPage();
      await login(mkPage, ADMIN_EMAIL);
      await mkPage.goto(`/inventory-boundary?year=${year}`);
      await expect(mkPage.getByRole('button', { name: /^Declare TonyAI Trading/ })).toBeVisible();
      await expect(mkPage.getByRole('button', { name: /^Declare TonyAI Energy Services/ })).toBeVisible();
      await expect(mkPage.getByRole('button', { name: /^Declare (Bosphorus|TonyAI Energy & Utilities)/ })).toHaveCount(0);
    } finally {
      await mk.close();
    }

    // The super_admin's boundary screen, in a browser of its own (the Turkish
    // session above keeps its locale): its companies declarable, no confirm or delete.
    const context = await browser.newContext();
    try {
      const sa = await context.newPage();
      await login(sa, APPROVER_EMAIL);
      await sa.goto(`/inventory-boundary?year=${year}`);
      await expect(sa.getByRole('button', { name: /^Declare TonyAI Gas/ })).toBeVisible();
      await expect(sa.getByRole('button', { name: /Declare TonyAI Trading/ })).toHaveCount(0);
      await expect(sa.getByRole('button', { name: /Bosphorus|Utilities Group/ })).toHaveCount(0);
      await expect(sa.getByRole('button', { name: 'Confirm version' })).toHaveCount(0);
      await expect(sa.getByRole('button', { name: 'Delete version' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  } finally {
    await api(request, admin, 'patch', '/me/preferences', { language: 'en' });
    await api(request, admin, 'delete', `/inventory-boundaries/${opened.json.id}`);
    await deleteCompanyWithFacilities(request, admin, company.id);
  }
});

test("the tree marks figures resting on non-authoritative factors, up to the root; a read-only reader opens an associate's page from the tree (owner review of WP7)", async ({ page, request }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const year = 2026; // the seed's figures rest on the placeholder library
  const roll = (await api<RollUpResponse>(request, admin, 'get', `/emissions/roll-up?reportingYear=${year}`)).json;
  const root = roll.rows.find((r) => r.parentId === null && r.nodeType === 'holding');
  const energy = roll.rows.find((r) => r.subsidiaryId === SUB.energy);
  // The anchor: the seed has such records, so the marks below are not vacuous.
  expect(energy?.own?.nonAuthoritativeRecordCount ?? 0).toBeGreaterThan(0);
  expect(root?.rollUp?.nonAuthoritativeRecordCount ?? 0).toBeGreaterThanOrEqual(energy?.own?.nonAuthoritativeRecordCount ?? 0);

  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await expect(page.getByTestId('tree-non-authoritative')).toContainText(enSubsidiaries.tree.nonAuthoritativeNote);
  await expect(page.getByTestId(`non-authoritative-own-${SUB.energy}`)).toBeVisible();
  await expect(page.getByTestId(`non-authoritative-rollup-${root!.subsidiaryId}`)).toBeVisible();
  // A company with no such figure carries no mark.
  for (const row of roll.rows) {
    if (row.rollUp !== null && row.rollUp.nonAuthoritativeRecordCount === 0) {
      await expect(page.getByTestId(`non-authoritative-rollup-${row.subsidiaryId}`)).toHaveCount(0);
    }
  }

  // An auditor reads the associate's page — its basis and why it takes no data.
  const context = await page.context().browser()!.newContext();
  try {
    const auditor = await context.newPage();
    await login(auditor, AUDITOR_EMAIL);
    await auditor.goto('/subsidiaries');
    await auditor.getByTestId(`tree-row-${SUB.associate}`).getByRole('button', { name: enSubsidiaries.list.view }).click();
    await expect(auditor).toHaveURL(new RegExp(`/subsidiaries/${SUB.associate}$`));
    await expect(auditor.getByTestId('ghg-basis')).toHaveText(enSubsidiaries.tree.ghgBasisAssociate);
    await expect(auditor.getByText(enSubsidiaries.tree.associateClosed)).toBeVisible();
    await expect(auditor.getByRole('button', { name: enSubsidiaries.list.open })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
