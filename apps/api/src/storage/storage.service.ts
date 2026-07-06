import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
      .upload(path, body, { contentType, upsert: true });
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
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn);
    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to sign file URL: ${error?.message ?? 'unknown error'}`,
      );
    }
    return data.signedUrl;
  }

  /** Remove one or more objects. Best-effort: a missing object is not an error. */
  async remove(bucket: string, paths: string[]): Promise<void> {
    const { error } = await this.client.storage.from(bucket).remove(paths);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to remove file: ${error.message}`,
      );
    }
  }
}
