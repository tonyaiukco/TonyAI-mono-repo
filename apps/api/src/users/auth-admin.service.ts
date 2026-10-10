import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * A failed Supabase Auth step, as the onboarding state records it — a short
 * code, never the provider's message (which can echo the address).
 */
export class AuthAdminError extends Error {
  constructor(readonly code: 'email_unavailable' | 'auth_user_mismatch' | 'auth_unavailable' | 'auth_user_missing') {
    super(`Supabase Auth step failed: ${code}`);
    this.name = 'AuthAdminError';
  }
}

/** Ten years and then some: "banned" in GoTrue is a time, not a flag. */
const BAN_DURATION = '876000h';

/**
 * The Supabase Auth admin calls onboarding makes (service-role key, server
 * only). Each is idempotent, so a half-done step completes on a retry:
 * every behaviour below was measured against the local stack's GoTrue
 * (LP4-01 PR B) — a second `createUser` answers `email_exists`, a re-minted
 * invitation link voids the previous one, a ban refuses the next refresh
 * (`user_banned`), banning an unknown id answers 404.
 */
@Injectable()
export class AuthAdminService {
  private client: SupabaseClient | null = null;

  private admin() {
    if (!this.client) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new AuthAdminError('auth_unavailable');
      this.client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    }
    return this.client.auth.admin;
  }

  /**
   * The Auth user for `profileId` — created with the profile's own id, so the
   * profile written first (the database before Auth, K4) and the Auth user
   * name each other without a lookup. An address that already belongs to
   * another Auth user is `email_unavailable`.
   */
  async ensureUser(profileId: string, email: string): Promise<void> {
    const admin = this.admin();
    const created = await admin.createUser({ id: profileId, email, email_confirm: false });
    if (!created.error) return;
    if (created.error.code !== 'email_exists') throw new AuthAdminError('auth_unavailable');
    const existing = await admin.getUserById(profileId);
    if (existing.data.user) {
      if (existing.data.user.email?.toLowerCase() !== email.toLowerCase()) throw new AuthAdminError('auth_user_mismatch');
      return;
    }
    throw new AuthAdminError('email_unavailable');
  }

  /** A fresh invitation token for `email` (voids the last one). */
  async inviteToken(profileId: string, email: string): Promise<string> {
    return this.token('invite', profileId, email);
  }

  /** A fresh recovery token for `email`. */
  async recoveryToken(profileId: string, email: string): Promise<string> {
    return this.token('recovery', profileId, email);
  }

  private async token(type: 'invite' | 'recovery', profileId: string, email: string): Promise<string> {
    const { data, error } = await this.admin().generateLink({ type, email });
    if (error) {
      if (error.code === 'email_exists') throw new AuthAdminError('email_unavailable');
      if (error.code === 'user_not_found') throw new AuthAdminError('auth_user_missing');
      throw new AuthAdminError('auth_unavailable');
    }
    // The link must belong to the profile it is sent for — never mail a token
    // for another account that happens to hold the address.
    if (data.user?.id !== profileId) throw new AuthAdminError('auth_user_mismatch');
    return data.properties.hashed_token;
  }

  /**
   * Bans or unbans the Auth user (D19): no refresh, no sign-in. An id Auth does
   * not know (an invitation whose Auth step never ran) has nothing to ban.
   */
  async setBanned(profileId: string, banned: boolean): Promise<void> {
    const { error } = await this.admin().updateUserById(profileId, { ban_duration: banned ? BAN_DURATION : 'none' });
    if (error && error.code !== 'user_not_found') throw new AuthAdminError('auth_unavailable');
  }
}
