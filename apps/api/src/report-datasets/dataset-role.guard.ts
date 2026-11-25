import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { can, type Capability } from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';

/**
 * The dataset routes' roles (W4, V7), refused before a body is read — guards
 * run before the global pipe. The service keeps its own check.
 */
const requireCapability = (context: ExecutionContext, capability: Capability, refusal: string): true => {
  const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
  if (user === undefined || !can(user.role, capability)) throw new ForbiddenException(refusal);
  return true;
};

/** A masterkey captures (W4, INC-2.6 ruling R4). */
@Injectable()
export class DatasetCapturerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireCapability(context, 'dataset.capture', 'Only a masterkey may capture a report dataset');
  }
}

/** Datasets cover the organisation: a masterkey and an auditor read them. */
@Injectable()
export class DatasetReaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return requireCapability(context, 'dataset.read', 'Only a masterkey or an auditor reads report datasets');
  }
}
