---
name: supabase-storage
description: Add a private, tenant-scoped Supabase Storage bucket to TonyAI — file uploads flow THROUGH the NestJS API (service-role), never the browser; metadata lives in a Prisma table with RLS, binaries in the bucket, downloads via short-lived signed URLs. Use when a feature needs file attachments (evidence, report exports, capacity documents, bulk-upload sources).
---

# supabase-storage

Store user files without weakening the two-layer tenant model. The **canonical reference** is the
`evidence` feature: `apps/api/src/storage/` + `apps/api/src/evidence/` + the `evidence` table & RLS.

## When to use
Any file attachment tied to a tenant-scoped entity (evidence, capacity reports, report exports, bulk-upload CSVs).

## Rules (must hold)
- **Upload through the API, not the browser.** The browser posts multipart to a NestJS route; the API validates
  tenant access + file type/size, then reads/writes the bucket with the **service-role** key via `StorageService`.
  Never hand the browser a write path — it keeps enforcement in the guard layer (matches the tenant model).
- **Buckets are private.** No public buckets. Downloads are **short-lived signed URLs** minted by the API.
- **Metadata in Postgres, binary in the bucket.** A Prisma table holds `storagePath`, `fileName`, `mimeType`,
  `sizeBytes`, `uploadedBy`, timestamps + the FK to its parent. Apply the **`rls-for-table`** skill (SELECT-only,
  reached via the parent's subsidiary). Never expose `storagePath` in a DTO.
- **Validate server-side.** Allow-list MIME types + a max size (mirror the bucket config). Reject before uploading.
- **Writes are gated like the parent.** Reuse the parent entity's write rules (e.g. author-or-`super_admin`, and
  only while the parent is still editable). Audit create/delete (`entity: '<file-entity>'`).
- **Clean up the object on delete** (StorageService.remove) before deleting the row.

## Steps
1. **Bucket** — declare it in `supabase/config.toml` (`[storage.buckets.<name>]`, `public = false`,
   `file_size_limit`, `allowed_mime_types`) for local, AND create it idempotently in the seed via
   `admin.storage.createBucket(<name>, { public: false })` (ignore an "already exists" error) for portability.
2. **StorageService** — reuse `apps/api/src/storage/storage.service.ts` (service-role client: `upload`,
   `createSignedUrl`, `remove`). It's a global module — just import `StorageModule`.
3. **Schema + RLS** — add the Prisma metadata model (FK to parent, `onDelete: Cascade`), migrate, then
   `rls-for-table` for the new table (policy joins through the parent to `subsidiaries`).
4. **Types** — `XxxDTO` (no `storagePath`) + a signed-url DTO in `@tonyai/shared-types`; rebuild it.
5. **API** — a service (load parent scoped → assert write → validate mime/size → `storage.upload` → create row →
   audit) + controller (`@UseInterceptors(FileInterceptor('file', { limits: { fileSize } }))`, `@UploadedFile()`).
   Expose list / upload / signed-url / delete. DB-free spec: type/size rejection, tenant 404, RBAC, delete auth.
6. **Web client** — a dedicated `uploadXxx` in `apps/web/lib/api.ts` that uses raw `fetch` with `FormData` and
   `authHeaders()` only (NO `Content-Type` — let the browser set the multipart boundary); reuse `ApiError`.
7. **UI** — a drag-drop + click uploader with a file list (download via the signed URL, delete where permitted);
   surface `ApiError.message` with `toast`.

## Verify
`pnpm --filter @tonyai/api test && pnpm typecheck`, then live: upload a valid file (200 + row), a bad type/size
(400, nothing stored), a signed URL (opens), and a cross-tenant read (404). Re-run `pnpm db:seed` and confirm the
bucket + seeded files exist.
