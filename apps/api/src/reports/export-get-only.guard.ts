import { Injectable, MethodNotAllowedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Express answers HEAD with a GET route's handler and drops the body, so a
 * HEAD on an export assembled the whole artifact and wrote its generation
 * audit row for nothing (LP3-02 follow-up (15)). An export has no cheaper
 * header-only answer — its length is the artifact's — so HEAD is refused
 * before anything is read or assembled. It still counts against the EXPORT
 * quota: the runtime limits run first, so a refused method is no free probe.
 */
@Injectable()
export class ExportGetOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    if (http.getRequest<Request>().method !== 'HEAD') return true;
    http.getResponse<Response>().setHeader('Allow', 'GET');
    throw new MethodNotAllowedException('Exports are downloaded with GET');
  }
}
