/** Journalled bucket limits/MIME/absence checks; never changes bucket settings.
 * Provider error names: https://supabase.com/docs/guides/storage/debugging/error-codes
 */
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const BUCKETS = Object.freeze({
  evidence: { limit: 10 * 1024 * 1024, mimes: ['application/pdf', 'image/jpeg', 'image/png', XLSX, 'text/csv'] },
  'import-sources': { limit: 2 * 1024 * 1024, mimes: ['text/csv', XLSX] },
  'report-artifacts': { limit: 20 * 1024 * 1024, mimes: ['application/pdf'] },
});
const fail = () => new Error('Hosted Storage acceptance stopped; details withheld.');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const positive = (result) => { if (result?.error || result?.data == null) throw fail(); return result.data; };
export const absent = (result, providerCode) => result?.data == null && result?.error?.name === 'StorageApiError'
  && [400, 404].includes(result.error.status) && providerCode === 'NoSuchKey';
export function plan(nonce = randomUUID()) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(nonce)) throw fail();
  return Object.entries(BUCKETS).flatMap(([bucket, settings]) => ['small', 'limit', 'too-large', 'wrong-mime'].map((kind) => ({
    bucket, path: `lp2-l10-probe/${nonce}/${kind}.${bucket === 'report-artifacts' ? 'pdf' : 'csv'}`,
    kind, size: kind === 'limit' ? settings.limit : kind === 'too-large' ? settings.limit + 1 : 256,
    mime: kind === 'wrong-mime' ? 'application/octet-stream' : bucket === 'report-artifacts' ? 'application/pdf' : 'text/csv',
    attempted: false, deletionAcknowledged: false, absenceVerified: false,
  })));
}
export function validateSettings(bucket, data) {
  const expected = BUCKETS[bucket];
  if (!expected || data?.id !== bucket || data.public !== false || Number(data.file_size_limit) !== expected.limit
      || JSON.stringify([...(data.allowed_mime_types ?? [])].sort()) !== JSON.stringify([...expected.mimes].sort())) throw fail();
}
function bytesFor(entry) {
  const bytes = Buffer.alloc(entry.size, 32);
  bytes.write(entry.bucket === 'report-artifacts' ? '%PDF-1.4\n%Synthetic bucket MIME/size probe only\n' : 'purpose\nSynthetic bucket size probe\n');
  if (entry.bucket === 'report-artifacts') bytes.write('\n%%EOF\n', bytes.length - 7);
  return bytes;
}
export function validateSigned(value, origin, entry) {
  const url = new URL(value);
  if (url.origin !== origin || url.pathname !== `/storage/v1/object/sign/${entry.bucket}/${entry.path}`
      || url.hash || url.searchParams.getAll('token').length !== 1
      || [...url.searchParams.keys()].some((key) => key !== 'token')) throw fail();
  return url.href;
}
export function writeReceipt(path, value, initial = false) {
  const target = initial ? path : path + '.new';
  // The containing mount sits below the operator's unmounted mode-0700 root.
  // UID1000 writes with the operator's primary group; the operator can recover it.
  const fd = openSync(target, 'wx', 0o660);
  try { fchmodSync(fd, 0o660); writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (!initial) { try { renameSync(target, path); } finally { try { unlinkSync(target); } catch { /* Rename already removed it, or preserve the prior receipt. */ } } }
}

export async function probe(input, adapters) {
  const { service, anonymous, user, readSigned, lastCode, record, sleep, interrupted } = adapters;
  if (!/^[a-z]{20}$/.test(input.projectRef) || input.origin !== `https://${input.projectRef}.supabase.co`
      || !/^[a-f0-9]{40}$/.test(input.sourceSha) || !/^[a-z][a-z0-9-]{0,29}$/.test(input.releaseId)
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.nonce)) throw fail();
  const entries = plan(input.nonce);
  const receipt = { release_id: input.releaseId, source_sha: input.sourceSha, entries, complete: false };
  record(receipt, true); // Entire exact-path intent before any Storage request.
  for (const bucket of Object.keys(BUCKETS)) validateSettings(bucket, positive(await service.getBucket(bucket)));
  for (const entry of entries) {
    if (interrupted()) throw fail();
    const api = service.from(entry.bucket);
    const bytes = bytesFor(entry);
    entry.attempted = true;
    record(receipt);
    const removeAndVerify = async () => {
      const removed = await api.remove([entry.path]);
      if (removed?.error) throw fail();
      entry.deletionAcknowledged = true;
      if (!absent(await api.download(entry.path), lastCode())) throw fail();
      entry.absenceVerified = true;
      record(receipt);
    };
    try {
      const result = await api.upload(entry.path, bytes, { contentType: entry.mime, upsert: false });
      const code = lastCode(); // Fixed provider code captured before SDK drops it.
      if (['too-large', 'wrong-mime'].includes(entry.kind)) {
        const expected = entry.kind === 'too-large' ? 'EntityTooLarge' : 'InvalidMimeType';
        if (!result?.error || code !== expected) throw fail();
        entry.refusalCode = expected;
        if (!absent(await api.download(entry.path), lastCode())) throw fail();
      } else {
        positive(result);
        if (sha(Buffer.from(await positive(await api.download(entry.path)).arrayBuffer())) !== sha(bytes)) throw fail();
        if (entry.kind === 'small') {
          for (const client of [anonymous, user]) {
            const denied = await client.from(entry.bucket).download(entry.path);
            if (denied?.data != null || denied?.error?.name !== 'StorageApiError'
                || ![400, 401, 403, 404].includes(denied.error.status)
                || !['AccessDenied', 'NoSuchKey'].includes(lastCode())) throw fail();
          }
          const publicRead = await readSigned(`${input.origin}/storage/v1/object/public/${entry.bucket}/${entry.path}`);
          if (![400, 401, 403, 404].includes(publicRead.status)) throw fail();
          const signed = positive(await api.createSignedUrl(entry.path, 60));
          const url = validateSigned(signed.signedUrl, input.origin, entry);
          const downloaded = await readSigned(url);
          if (downloaded.status !== 200 || sha(downloaded.bytes) !== sha(bytes)) throw fail();
          await sleep(65000);
          const expired = await readSigned(url);
          if (![400, 401, 403].includes(expired.status)) throw fail();
          // The object must still exist, otherwise expiry could be a deletion false positive.
          if (sha(Buffer.from(await positive(await api.download(entry.path)).arrayBuffer())) !== sha(bytes)) throw fail();
          entry.privateAccessAndSignedExpiry = true;
        }
        entry.sha256 = sha(bytes);
      }
    } finally {
      try { record(receipt); }
      finally { await removeAndVerify(); }
    }
  }
  if (interrupted() || entries.some((entry) => !entry.absenceVerified)) throw fail();
  receipt.complete = true; record(receipt);
  return { status: 'STORAGE_PROBED', upload_attempts: 12, absent_objects: 12, private_signed_expiry_checks: 3 };
}

export function guardedFetch(origin, entries, fetcher = fetch, timeoutMs = 30000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail();
  const paths = new Set(entries.flatMap((entry) => [
    `/storage/v1/object/${entry.bucket}/${entry.path}`, `/storage/v1/object/authenticated/${entry.bucket}/${entry.path}`,
    `/storage/v1/object/sign/${entry.bucket}/${entry.path}`, `/storage/v1/object/public/${entry.bucket}/${entry.path}`,
  ]));
  let code = null; let active = null; let requests = 0;
  const run = async (value, init = {}) => {
    const url = new URL(typeof value === 'string' ? value : value.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const bucket = Object.keys(BUCKETS).find((name) => url.pathname === `/storage/v1/object/${name}`);
    const metadata = Object.keys(BUCKETS).some((name) => url.pathname === `/storage/v1/bucket/${name}`);
    if (url.origin !== origin || url.hash || ++requests > 150
        || !(paths.has(url.pathname) || (method === 'DELETE' && bucket) || (method === 'GET' && metadata)
          || (method === 'GET' && url.pathname === '/auth/v1/user'))) throw fail();
    if (url.pathname.includes('/object/sign/') && method === 'POST') {
      const body = JSON.parse(init.body);
      if (Object.keys(body).join() !== 'expiresIn' || body.expiresIn !== 60) throw fail();
    }
    if (method === 'POST' && !url.pathname.includes('/object/sign/')
        && !entries.some((entry) => entry.attempted && url.pathname === `/storage/v1/object/${entry.bucket}/${entry.path}`)) throw fail();
    if (method === 'DELETE') {
      const body = JSON.parse(init.body);
      if (!bucket || Object.keys(body).join() !== 'prefixes' || body.prefixes?.length !== 1
          || !entries.some((entry) => entry.bucket === bucket && entry.path === body.prefixes[0] && entry.attempted)) throw fail();
    }
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw fail();
    code = null;
    const controller = new AbortController(); active = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader; let abortHandler;
    try {
      const result = await fetcher(value, { ...init, redirect: 'error', signal: controller.signal });
      const maximum = result.ok ? 21 * 1024 * 1024 : 8192;
      const declared = result.headers.get('content-length');
      if (declared && Number(declared) > maximum) throw fail();
      reader = result.body?.getReader();
      const chunks = []; let size = 0;
      const aborted = new Promise((_, reject) => {
        abortHandler = () => reject(fail());
        controller.signal.addEventListener('abort', abortHandler, { once: true });
      });
      while (reader) {
        if (controller.signal.aborted) throw fail();
        const part = await Promise.race([reader.read(), aborted]);
        if (part.done) break;
        size += part.value.length; if (size > maximum) throw fail();
        chunks.push(Buffer.from(part.value));
      }
      const bytes = Buffer.concat(chunks);
      if (!result.ok) {
        try { const error = JSON.parse(bytes.toString()); const value = error.code ?? error.error;
          if (['NoSuchKey', 'EntityTooLarge', 'InvalidMimeType', 'AccessDenied', 'InvalidJWT'].includes(value)) code = value;
        } catch { /* An unknown provider body is never classified as an expected refusal. */ }
      }
      // Consume under the same deadline before handing bytes to SDK .json()/Blob.
      // A committed upload with a stalled response body must still reject into cleanup.
      const headers = new Headers(result.headers);
      headers.delete('content-encoding'); headers.delete('content-length');
      return new Response([204, 205, 304].includes(result.status) ? null : bytes,
        { status: result.status, statusText: result.statusText, headers });
    } catch {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      throw fail();
    } finally {
      if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
      clearTimeout(timer); if (active === controller) active = null;
    }
  };
  return { fetch: run, code: () => code, abort: () => active?.abort() };
}

async function main() {
  let interrupted = false; let guarded;
  const lifetime = new AbortController();
  const interrupt = () => { interrupted = true; lifetime.abort(); guarded?.abort(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 32768) throw fail(); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (process.versions.node.split('.')[0] !== '22' || input.operation !== 'storage'
        || !/^[a-z]{20}$/.test(input.projectRef) || input.origin !== `https://${input.projectRef}.supabase.co`
        || typeof input.key !== 'string' || typeof input.publicKey !== 'string'
        || !input.userToken || !input.userId || input.key === input.publicKey) throw fail();
    const entries = plan(input.nonce);
    guarded = guardedFetch(input.origin, entries);
    const require = createRequire('/app/apps/api/dist/onboarding/onboarding.cli.js');
    const { createClient } = require('@supabase/supabase-js');
    const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, global: { fetch: guarded.fetch } };
    const service = createClient(input.origin, input.key, options);
    const anonymous = createClient(input.origin, input.publicKey, options);
    const user = createClient(input.origin, input.publicKey, { ...options, global: { fetch: guarded.fetch, headers: { Authorization: `Bearer ${input.userToken}` } } });
    const identity = await user.auth.getUser(input.userToken);
    if (identity.error || identity.data.user?.id !== input.userId) throw fail();
    const claims = JSON.parse(Buffer.from(input.userToken.split('.')[1], 'base64url').toString());
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() + 1020000) throw fail();
    const record = (value, initial) => {
      // Guard sees exactly the same attempted flags used for delete allowlisting.
      for (const item of value.entries) { const bound = entries.find((entry) => entry.bucket === item.bucket && entry.path === item.path); if (!bound) throw fail(); bound.attempted = item.attempted; }
      writeReceipt('/receipts/objects.json', value, initial);
    };
    const report = await probe(input, { service: service.storage, anonymous: anonymous.storage, user: user.storage,
      readSigned: async (url) => { const result = await guarded.fetch(url); return { status: result.status, bytes: Buffer.from(await result.arrayBuffer()) }; },
      lastCode: guarded.code, record, sleep: (ms) => pause(ms, undefined, { signal: lifetime.signal }), interrupted: () => interrupted });
    process.stdout.write(JSON.stringify(report));
  } catch { process.stdout.write(JSON.stringify({ status: 'STOPPED', retry: false })); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
