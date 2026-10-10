import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
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

/** An administrator acting on their own account. */
export class OwnAccountError extends ForbiddenException {
  constructor(what: 'role' | 'disable') {
    super(
      errorBody(
        'own_account_forbidden',
        what === 'role'
          ? 'You cannot change your own role; ask another super_admin.'
          : 'You cannot disable your own account; ask another super_admin.',
      ),
    );
  }
}

/** Grants belong to data_entry users only (LP1-03). */
export class AccessRoleMismatchError extends ConflictException {
  constructor() {
    super(
      errorBody(
        'access_role_mismatch',
        'Only data_entry users are granted subsidiaries; other roles read their whole organisation.',
      ),
    );
  }
}

/** The address already has an account, here or in another organisation (D17). */
export class EmailUnavailableError extends ConflictException {
  constructor() {
    super(errorBody('email_unavailable', 'This email address already has an account.'));
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
