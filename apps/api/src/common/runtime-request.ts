import type { Request, Response } from 'express';
import type { CanActivate, ExecutionContext, CallHandler, NestInterceptor } from '@nestjs/common';
import { defer, finalize } from 'rxjs';
import type { SupabaseAuthGuard } from '../auth/auth.guard';
import { CapacityError, routeGroup, RuntimeLimits } from './runtime-limits';

export type LimitedRequest = Request & { runtimeMultipart?: boolean; runtimeAdmitWork?: () => void; runtimeLease?: {
  executing: boolean; releases: Array<() => void>; release: () => void;
} };

/** Compose around the existing guard: authentication and tenant derivation are unchanged. */
export class RuntimeAuthGuard implements CanActivate {
  constructor(private readonly auth: SupabaseAuthGuard, private readonly limits: RuntimeLimits) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<LimitedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const lease = req.runtimeLease;
    if (lease) lease.executing = true;
    try {
      try {
        if (!await this.auth.canActivate(context)) { lease?.release(); return false; }
      }
      catch (error) {
        // This phase has made no mutation. Pool acquisition failures are safe
        // admission refusals; never apply this mapping to a running mutation.
        if ((error as { code?: string })?.code === 'P2024') throw new CapacityError();
        throw error;
      }
      if (res.destroyed || res.writableEnded) { lease?.release(); return false; }
      const user = (req as Request & { user?: { id: string } }).user;
      if (!user) return true; // Public health endpoints only; the auth guard decides.
      const group = routeGroup(req.method, req.path);
      const c = this.limits.config;
      await this.limits.quota(`user:${user.id}:${group}`, c[`RATE_${group}_PER_MINUTE`]);
      req.runtimeAdmitWork = () => {
        if (this.limits.stopping || res.destroyed || res.writableEnded) throw new CapacityError();
        lease?.releases.push(this.limits.acquire('http', c.HTTP_MAX_INFLIGHT));
        if (group === 'IMPORT') lease?.releases.push(this.limits.acquire('imports', c.IMPORT_CONCURRENCY));
        if (group === 'EXPORT') lease?.releases.push(this.limits.acquire('reports', c.REPORT_CONCURRENCY));
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          lease?.releases.push(this.limits.acquire('mutations', c.MUTATION_CONCURRENCY));
          lease?.releases.push(this.limits.acquire(`mutation:${user.id}`, c.MUTATION_USER_CONCURRENCY));
        }
      };
      if (req.runtimeMultipart) {
        lease?.releases.push(this.limits.acquire(`upload:${user.id}`, c.UPLOAD_USER_CONCURRENCY));
      } else req.runtimeAdmitWork();
      return true;
    } catch (error) {
      lease?.release();
      if (error instanceof CapacityError) res.setHeader('Retry-After', error.retryAfter);
      throw error;
    }
  }
}

/** An aborted client does not free a permit while its mutation is still running. */
export class RuntimeRequestInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<LimitedRequest>();
    return next.handle().pipe(finalize(() => req.runtimeLease?.release()));
  }
}

/** Must follow FileInterceptor: receiving a body consumes upload slots only. */
export class RuntimeUploadWorkInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return defer(() => {
      context.switchToHttp().getRequest<LimitedRequest>().runtimeAdmitWork?.();
      return next.handle();
    });
  }
}
