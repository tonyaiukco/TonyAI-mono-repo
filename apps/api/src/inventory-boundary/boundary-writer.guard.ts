import { BadRequestException, ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types';
import { errorBody } from '../common/api-error';
import { INVENTORY_DECLARATION_LIMITS } from './dto/inventory-boundary.dto';

/**
 * The boundary's writes, refused before their body is transformed and
 * validated (`security-rls` P1). Guards run before pipes, and the global
 * pipe's work grows with a body's rows — every element is built and checked
 * before a list's size is — so a reader's 1 MB declaration of empty rows held
 * the API for seconds and answered tens of megabytes of messages, though the
 * service would refuse it outright. These answer as the service does
 * (`forbidden`, E2; `validation_failed`), and the service keeps its own check.
 */

/** super_admin alone writes a boundary (E2) — refused here before the body is read. */
@Injectable()
export class BoundaryWriterGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    if (user?.role !== 'super_admin') throw new ForbiddenException('Only super_admin may change an inventory boundary');
    if (!user.organisationId) throw new ForbiddenException('No organisation context for this user');
    return true;
  }
}

/** A declaration's lists within the DTO's limits, counted before a row is
 * built; whatever is not a list of rows is the pipe's to refuse. */
@Injectable()
export class DeclarationSizeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const body = context.switchToHttp().getRequest<{ body?: unknown }>().body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return true;
    for (const [list, max] of Object.entries(INVENTORY_DECLARATION_LIMITS)) {
      const rows = (body as Record<string, unknown>)[list];
      if (Array.isArray(rows) && rows.length > max) {
        throw new BadRequestException(errorBody('validation_failed', [`${list} must contain no more than ${max} elements`]));
      }
    }
    return true;
  }
}
