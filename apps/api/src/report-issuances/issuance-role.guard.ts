import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { can, type Capability } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';

/**
 * The issuance routes' roles (W4), refused before a body is read — guards run
 * before the global pipe. The service keeps its own check, and refuses a
 * final to a role without `report.issue_final` (`report_final_forbidden`).
 */
const requireCapability = (context: ExecutionContext, capability: Capability, refusal: string): true => {
  const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
  if (user === undefined || !can(user.role, capability)) throw new ForbiddenException(refusal);
  return true;
};

/** A masterkey issues (W4, INC-2.6 ruling R4). */
@Injectable()
export class IssuerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireCapability(context, 'report.issue', 'Only a masterkey may issue a report');
  }
}

/** Issued reports cover the organisation: a masterkey and an auditor read them. */
@Injectable()
export class IssuanceReaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireCapability(context, 'dataset.read', 'Only a masterkey or an auditor reads report issuances');
  }
}
