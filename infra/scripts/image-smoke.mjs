#!/usr/bin/env node
/** Actual-image/browser smoke; no local E2E setup, seed, storageState or trace. */
import { chromium } from '@playwright/test';
import { validateSmoke } from './smoke-contract.mjs';

const requireThat = (condition) => { if (!condition) throw new Error('Smoke assertion failed'); };
const request = async (url, options = {}) => fetch(url, {
  ...options, redirect: 'error', signal: AbortSignal.timeout(60_000),
});

async function probe(target, tenant, other, token, publicKey) {
  const headers = { Authorization: `Bearer ${token}` };
  const meResponse = await request(`${target.api}/me`, { headers });
  requireThat(meResponse.status === 200);
  const me = await meResponse.json();
  requireThat(me.id === tenant.userId && me.organisationId === tenant.organisationId && me.role === 'super_admin');
  const own = await request(`${target.api}/subsidiaries/${tenant.subsidiaryId}`, { headers });
  requireThat(own.status === 200);
  const row = await own.json();
  requireThat(row.id === tenant.subsidiaryId);
  if (target.mode === 'staging') requireThat(row.legalName === tenant.name);
  if (other) {
    const foreign = await request(`${target.api}/subsidiaries/${other.subsidiaryId}`, { headers });
    requireThat([403, 404].includes(foreign.status));
    const listed = await request(`${target.api}/subsidiaries`, { headers });
    requireThat(listed.status === 200);
    const rows = await listed.json();
    requireThat(rows.length === 1 && rows[0].id === tenant.subsidiaryId);
    const restHeaders = { ...headers, apikey: publicKey };
    for (const [id, count] of [[tenant.subsidiaryId, 1], [other.subsidiaryId, 0]]) {
      const rest = await request(`${target.supabase}/rest/v1/subsidiaries?id=eq.${id}&select=id`, { headers: restHeaders });
      requireThat(rest.status === 200 && (await rest.json()).length === count);
    }
  }
  // PDF proves distro Chromium starts inside the API image; XLSX proves ZIP output.
  for (const [format, magic, mime] of [['pdf', '%PDF', 'application/pdf'], ['excel', 'PK', 'application/vnd.openxmlformats'], ['csv', '\uFEFFsubsidiary,', 'text/csv']]) {
    const response = await request(`${target.api}/reports/${format}?template=executive_summary&year=2026&subsidiaryId=${tenant.subsidiaryId}`, { headers });
    requireThat(response.status === 200 && response.headers.get('content-type')?.startsWith(mime));
    const bytes = Buffer.from(await response.arrayBuffer());
    requireThat(bytes.length > magic.length && bytes.toString('utf8').startsWith(magic));
  }
}

async function main() {
  const target = validateSmoke(JSON.parse(process.env.SMOKE_TARGET_JSON));
  const publicKey = process.env.SMOKE_PUBLIC_KEY;
  requireThat(publicKey && !publicKey.startsWith('sb_secret_'));
  const anonymous = await request(`${target.api}/me`);
  requireThat(anonymous.status === 401);
  const health = await request(`${target.api}/health`);
  requireThat(health.status === 200);
  const browser = await chromium.launch();
  try {
    for (const [index, tenant] of target.tenants.entries()) {
      const password = process.env[`SMOKE_PASSWORD_${index + 1}`];
      requireThat(password && (target.mode === 'ci-local' || (password.length >= 20 && password !== 'TonyAI!2026')));
      const context = await browser.newContext({ acceptDownloads: true });
      let token;
      try {
        // Block unexpected origins before sending credentials; no third-party telemetry.
        const origins = new Set([target.web, new URL(target.api).origin, target.supabase]);
        await context.route('**/*', (route) => origins.has(new URL(route.request().url()).origin)
          ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.goto(`${target.web}/login`);
        await page.getByLabel('Email', { exact: true }).fill(tenant.email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        const login = page.waitForResponse((response) => response.url() === `${target.supabase}/auth/v1/token?grant_type=password`);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        const response = await login;
        requireThat(response.status() === 200);
        token = (await response.json()).access_token;
        requireThat(typeof token === 'string');
        await page.waitForURL(target.web + '/', { timeout: 30_000 });
        await probe(target, tenant, target.tenants[1 - index], token, publicKey);
        await page.goto(`${target.web}/reports`);
        await page.getByRole('heading', { name: 'Reports', exact: true }).waitFor();
        // Exercise the web's compiled API URL and CORS/download wiring as well.
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
        const download = await downloadPromise;
        requireThat((await download.failure()) === null && download.suggestedFilename().endsWith('.pdf'));
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        requireThat(Buffer.concat(chunks).toString('utf8').startsWith('%PDF'));
        await download.delete();
      } finally {
        try {
          if (token) {
            // Revoke only this session. Preserve synthetic tenant rows and append-only audit.
            const logout = await request(`${target.supabase}/auth/v1/logout?scope=local`, {
              method: 'POST', headers: { apikey: publicKey, Authorization: `Bearer ${token}` },
            });
            requireThat(logout.status === 204);
          }
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log('PASS: actual application startup, browser login/download, authenticated PDF/XLSX/CSV and session cleanup.');
  if (target.mode === 'staging') console.log('PASS: both dedicated tenants pass positive and negative API/PostgREST isolation probes.');
}

main().catch(() => {
  // Playwright errors include input values, request URLs and response bodies.
  console.error('FAIL: image smoke or session cleanup failed; sensitive details withheld.');
  process.exitCode = 1;
});
