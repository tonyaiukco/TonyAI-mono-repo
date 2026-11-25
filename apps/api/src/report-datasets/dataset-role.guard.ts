import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types';
import { CAPTURE_ROLES, DATASET_READ_ROLES } from './report-datasets.service';

/**
 * The dataset routes' roles (W4, V7), refused before a body is read — guards
 * run before the global pipe. The service keeps its own check.
 */
const requireRole = (context: ExecutionContext, roles: ReadonlySet<string>, refusal: string): true => {
  const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
  if (user === undefined || !roles.has(user.role)) throw new ForbiddenException(refusal);
  return true;
};

/** masterkey and consultant capture (W4). */
@Injectable()
export class DatasetCapturerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireRole(context, CAPTURE_ROLES, 'Only masterkey or consultant may capture a report dataset');
  }
}

/** Every role but data_entry reads (W3, V7). */
@Injectable()
export class DatasetReaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireRole(context, DATASET_READ_ROLES, 'data_entry users do not read report datasets');
  }
}
