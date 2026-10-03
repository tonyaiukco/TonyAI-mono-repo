---
name: supabase-storage
description: Add a private, tenant-scoped Supabase Storage bucket to TonyAI — file uploads flow THROUGH the NestJS API (service-role), never the browser; metadata lives in a Prisma table with RLS, binaries in the bucket, downloads via short-lived signed URLs, and every Storage write or removal is recoverable through storage intents. Use when a feature needs file attachments (evidence, report exports, capacity documents).
---

# supabase-storage

Store user files without weakening the two-layer tenant model. The **canonical reference** is the
`evidence` feature: `apps/api/src/storage/` + `apps/api/src/evidence/` + the `evidence` table & RLS.

## When to use
Any file attachment tied to a tenant-scoped entity (evidence, capacity reports, report exports, generated export files).

## Rules (must hold)
- **Upload through the API, not the browser.** The browser posts multipart to a NestJS route; the API validates
  tenant access + file type/size, then reads/writes the bucket with the **service-role** key via `StorageService`.
  Never hand the browser a write path — it keeps enforcement in the guard layer (matches the tenant model).
- **Buckets are private.** No public buckets. Downloads are **short-lived signed URLs** minted by the API.
- **Metadata in Postgres, binary in the bucket.** A Prisma table holds `storagePath`, `fileName`, `mimeType`,
  `sizeBytes`, `uploadedBy`, timestamps + the FK to its parent. Apply the **`rls-for-table`** skill (SELECT-only,
  reached via the parent's subsidiary). Never expose `storagePath` in a DTO.
- **Validate the BYTES server-side, not the label.** Allow-list MIME types + a max size (mirror the bucket config),
  then check the content IS that type (`apps/api/src/evidence/file-content.ts`: signatures, XLSX without macros,
  CSV as text), clean the name (`sanitiseCallerText`), and store the SHA-256 (`CHAR(64)`, CHECKed lowercase hex).
  Reject before anything is stored. Downloads go out as attachments under the checked type's extension (`downloadName`).
- **Writes are gated like the parent.** Reuse the parent entity's write rules (e.g. author-or-`super_admin`, and
  only while the parent is still editable). Audit create/delete (`entity: '<file-entity>'`).
- **Every Storage write or removal goes through `StorageIntentsService` — never `StorageService.upload/remove`
  around a transaction by hand** (LP1-02; Storage has no transaction, and a hand-rolled "remove on failure" has
  deleted the bytes of a COMMITTED row when its acknowledgement was lost):
  - upload: `beginUpload(ref, origin)` → `storage.upload` (it never overwrites) → in the row's transaction, FIRST,
    `adoptUpload(tx, intentId)` → write the row + audit; on any failure `abandonUpload(intentId, ref, error, origin)`;
  - removal: delete the row + audit + `enqueueDeletes(tx, refs, origin)` in ONE transaction, then `runNow(refs)` after
    the commit. The in-process sweeper retries anything that failed; `pnpm storage:reconcile` finds what no intent names.
  - origin = `{ reason, organisationId, subsidiaryId }` — operators read it; Sentry gets ids, never object keys.
- **Register the bucket's owner.** Add it to `BUCKETS` and `OWNED` in `apps/api/src/storage/buckets.ts` and to
  `OWNERS` in `storage-reconcile.service.ts` (both are `Record<Bucket, …>`, so a missing entry does not compile).
  The owner column `storagePath` is `@unique`: one object, one row — the guard that keeps a removal off owned bytes.

## Steps
1. **Bucket** — declare it in `supabase/config.toml` (`[storage.buckets.<name>]`, `public = false`,
   `file_size_limit`, `allowed_mime_types`) for local, AND create it idempotently in the seed via
   `admin.storage.createBucket(<name>, { public: false })` (ignore an "already exists" error) for portability.
2. **StorageService + intents** — reuse `apps/api/src/storage/` (service-role `StorageService`: `upload` without
   upsert, `createSignedUrl` and `download`, which throw `StorageObjectMissingError` for missing bytes — answer it
   with a 404 and report it; `StorageIntentsService` for every write/removal). `StorageModule` is NOT global —
   import it in the feature module.
3. **Schema + RLS** — add the Prisma metadata model (FK to parent, `onDelete: Cascade`), migrate, then
   `rls-for-table` for the new table (policy joins through the parent to `subsidiaries`).
   **If one file may back several parents** (evidence since WP8 PR7), the file is owned by the TENANT
   (`subsidiary_id`) and a link table joins it to the parents, both foreign keys composite over
   `subsidiary_id` (`@@unique([id, subsidiaryId])` on each end) so the database refuses a cross-tenant
   link; both tables then take the plain subsidiary policy. The cascade takes LINKS, so the service must
   delete a file left with no link — rows by a conditional delete (`links: { none: {} }`) whose winner
   removes the blob — and deleting the file outright must check every parent it backs, not one.
4. **Types** — `XxxDTO` (no `storagePath`) + a signed-url DTO in `@tonyai/shared-types`; rebuild it.
5. **API** — a service (load parent scoped → assert write → check the file's bytes → `beginUpload` → `storage.upload`
   → transaction: `adoptUpload`, re-check under the parent's locks, create row + audit) + controller
   (`@UseInterceptors(FileInterceptor('file', { limits: { fileSize } }))`, `@UploadedFile()`). Expose list / upload /
   signed-url / delete (delete = row + audit + `enqueueDeletes` in one transaction, `runNow` after). DB-free spec:
   type/size/content rejection, tenant 404, RBAC, delete auth, intent order (begin before bytes, adopt first in tx).
6. **Web client** — a dedicated `uploadXxx` in `apps/web/lib/api.ts` that uses raw `fetch` with `FormData` and
   `authHeaders()` only (NO `Content-Type` — let the browser set the multipart boundary); reuse `ApiError`.
7. **UI** — a drag-drop + click uploader with a file list (download via the signed URL, delete where permitted);
   surface `ApiError.message` with `toast`.

## Verify
`pnpm --filter @tonyai/api test && pnpm typecheck`, then real Storage: copy the boundary cases of
`apps/api/test/int/storage-recovery.int.spec.ts` for the new bucket (a spied `StorageService` method fails, the
objects themselves are asserted; `pnpm --filter @tonyai/api test:int` with `apps/api/.env` sourced). Live: a valid
file (200 + row + sha256), a mismatched type (400, nothing stored), a signed URL (opens), a cross-tenant read (404),
then `pnpm storage:reconcile --verify` (exit 0). Re-run `pnpm db:seed` and confirm the bucket + seeded files exist.
