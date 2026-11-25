import { ConflictException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { errorBody } from '../common/api-error';

/**
 * The coded refusals of the user lifecycle (LP1-03's mutation boundary and
 * LP4-01's onboarding). Each is a screen's to word (`localise-ui`, recipe B);
 * `message` is the English sentence an untranslated reader shows.
 */

/** D19: the account — or its organisation, offboarded — is disabled. 401, so
 *  the web signs the session out; refused on the next request whatever token
 *  it carries. */
export class AccountDisabledError extends UnauthorizedException {
  constructor() {
    super(errorBody('account_disabled', 'This account is disabled. Ask your administrator.'));
  }
}

/** The access token predates the account's session revocation (a disable):
 *  a fresh sign-in is needed, even if the account was re-enabled since. */
export class SessionRevokedError extends UnauthorizedException {
  constructor() {
    super(errorBody('session_revoked', 'This session has ended. Sign in again.'));
  }
}

/** An administrator acting on their own account. */
export class OwnAccountError extends ForbiddenException {
  constructor(what: 'role' | 'disable') {
    super(
      errorBody(
        'own_account_forbidden',
        what === 'role'
          ? 'You cannot change your own role; ask another masterkey.'
          : 'You cannot disable your own account; ask another masterkey.',
      ),
    );
  }
}

/** Company grants belong to super_admin and standard_user accounts, and
 *  categories to a standard user's (INC-2.6 §1). */
export class AccessRoleMismatchError extends ConflictException {
  constructor() {
    super(
      errorBody(
        'access_role_mismatch',
        'Only super_admin and standard_user accounts are granted companies, and only a standard user\'s grant names categories; the other roles read their whole organisation.',
      ),
    );
  }
}

/** A standard user is assigned one company (INC-2.6 §1, ruling R6). */
export class StandardUserSingleCompanyError extends ConflictException {
  constructor() {
    super(
      errorBody(
        'standard_user_single_company',
        'A standard user is assigned one company; withdraw the one they hold before adding another.',
      ),
    );
  }
}

/**
 * `pre-g5-security-hardening`: the inviting organisation met its bound of
 * refused invitations (`INVITE_REFUSALS_PER_HOUR`). 429 with its own code, so
 * a screen can tell it from the runtime's capacity refusals, and `Retry-After`
 * until the oldest refusal of the hour ages out (the exception filter sets it).
 */
export class InviteRefusalsExhaustedError extends HttpException {
  constructor(readonly retryAfter: number) {
    super(
      errorBody('invite_refusals_exhausted', 'Too many invitations went to addresses that already have an account. Try again later.'),
      429,
    );
  }
}

/** The address already has an account, here or in another organisation (D17). */
export class EmailUnavailableError extends ConflictException {
  constructor() {
    super(errorBody('email_unavailable', 'This email address already has an account.'));
  }
}

/** Self-service registration: the code is not the environment's. Worded on
 *  purpose — the code says nothing about any address. */
export class RegistrationCodeInvalidError extends ForbiddenException {
  constructor() {
    super(errorBody('registration_code_invalid', 'The registration code is not valid.'));
  }
}

export class InvitationClosedError extends ConflictException {
  constructor() {
    super(errorBody('invitation_closed', 'This invitation was already accepted.'));
  }
}

export class UserDisabledError extends ConflictException {
  constructor() {
    super(errorBody('user_disabled', 'This account is disabled; enable it before re-sending its invitation.'));
  }
}
