import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * A row names an object Storage does not hold — bytes lost, or a database
 * restored ahead of its files. Not an HttpException: each caller says what is
 * missing in its own words, and reports it, because it is an integrity
 * incident rather than a bad request.
 */
export class StorageObjectMissingError extends Error {
  constructor(
    readonly bucket: string,
    readonly path: string,
  ) {
    super(`Storage holds no object ${bucket}/${path}`);
    this.name = 'StorageObjectMissingError';
  }
}

/** Storage answers a missing object with HTTP 400 and `statusCode: "404"` in the body (measured, storage-js 2.x). */
function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: unknown } | null)?.statusCode === '404';
}

/**
 * Thin wrapper over Supabase Storage using the SERVICE-ROLE key. All object
 * access flows through here (never the browser): the API validates tenant access
 * + file type/size first, then reads/writes the private bucket on the user's
 * behalf. Buckets stay private; downloads are short-lived signed URLs.
 */
@Injectable()
export class StorageService {
  private readonly client: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRole) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for storage',
      );
    }
    this.client = createClient(url, serviceRole, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async upload(
    bucket: string,
    path: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const { error } = await this.client.storage
      .from(bucket)
      // Never overwrite: every key carries a fresh uuid, so an existing object
      // here is a bug, and replacing its bytes would change evidence a row
      // (and its sha256) already describes. Storage answers 409.
      .upload(path, body, { contentType, upsert: false });
    if (error) {
      throw new InternalServerErrorException(
        `Failed to store file: ${error.message}`,
      );
    }
  }

  /** Create a short-lived signed download URL for a private object. */
  async createSignedUrl(
    bucket: string,
    path: string,
    expiresIn: number,
    /** Filename the browser should save under. Object keys are sanitised to
     *  ASCII and prefixed with a uuid, so without this a download of
     *  "Şubat-Faturası.pdf" landed as "<uuid>-_ubat-Fatura_.pdf". */
    downloadAs?: string,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(
        path,
        expiresIn,
        downloadAs ? { download: downloadAs } : undefined,
      );
    if (isNotFound(error)) throw new StorageObjectMissingError(bucket, path);
    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to sign file URL: ${error?.message ?? 'unknown error'}`,
      );
    }
    return data.signedUrl;
  }

  /** The object's bytes — for verifying them against a stored hash, never for serving them. */
  async download(bucket: string, path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(bucket).download(path);
    if (isNotFound(error)) throw new StorageObjectMissingError(bucket, path);
    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to read file: ${error?.message ?? 'unknown error'}`,
      );
    }
    return Buffer.from(await data.arrayBuffer());
  }

  /**
   * Remove one or more objects. Idempotent: a missing object is not an error,
   * so a retried removal (`StorageIntentsService`) succeeds.
   */
  async remove(bucket: string, paths: string[]): Promise<void> {
    const { error } = await this.client.storage.from(bucket).remove(paths);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to remove file: ${error.message}`,
      );
    }
  }
}
