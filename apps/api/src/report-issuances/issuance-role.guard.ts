import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types';
import { ISSUANCE_READ_ROLES, ISSUE_ROLES } from './report-issuances.service';

/**
 * The issuance routes' roles (W4), refused before a body is read — guards run
 * before the global pipe. The service keeps its own check, and refuses a
 * consultant a final once the dataset is read (`report_final_forbidden`).
 */
const requireRole = (context: ExecutionContext, roles: ReadonlySet<string>, refusal: string): true => {
  const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
  if (user === undefined || !roles.has(user.role)) throw new ForbiddenException(refusal);
  return true;
};

/** super_admin and consultant issue (W4); a final is super_admin's alone. */
@Injectable()
export class IssuerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireRole(context, ISSUE_ROLES, 'Only super_admin or consultant may issue a report');
  }
}

/** Every role but data_entry reads (W3, W4). */
@Injectable()
export class IssuanceReaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireRole(context, ISSUANCE_READ_ROLES, 'data_entry users do not read report issuances');
  }
}
