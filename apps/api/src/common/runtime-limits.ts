import { REPORTING_CONTEXT_API_PATHS } from '@tonyai/shared-types';
import { HttpException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { errorBody } from './api-error';
import { readRuntimeConfig, type RuntimeConfig } from './runtime-config';

export class CapacityError extends HttpException {
  constructor(readonly retryAfter = 1) {
    super(errorBody('rate_limited', 'Request capacity is exhausted. Try again later.'), 429);
  }
}

const EXPORT_PATHS = new Set([
  ...['pdf', 'excel', 'csv'].map((format) => `/api/v1/reports/${format}`),
  ...[REPORTING_CONTEXT_API_PATHS.pdf, REPORTING_CONTEXT_API_PATHS.excel, REPORTING_CONTEXT_API_PATHS.csv]
    .map((path) => `/api/v1${path}`),
]);

/** LP3-04 PR C (V7): a capture reads up to the report limits in one snapshot,
 * and one retained dataset is served whole (up to `REPORT_MAX_BYTES`) — both
 * take the report exports' quota and their one-at-a-time lease. The list is
 * an ordinary read. */
const REPORT_DATASETS_ROUTE = '/api/v1/report-datasets';
const REPORT_DATASET_ROUTE = /^\/api\/v1\/report-datasets\/[^/]+$/;
/** LP3-04 PR D: an issuance renders a PDF on the one Chromium and stores it;
 * a download re-hashes up to `REPORT_MAX_BYTES` — both take the exports'
 * quota and lease. The list and one issuance's metadata are ordinary reads. */
const REPORT_ISSUANCES_ROUTE = '/api/v1/report-issuances';
const REPORT_ISSUANCE_PDF_ROUTE = /^\/api\/v1\/report-issuances\/[^/]+\/pdf$/;
/** A POST that only reads: Data Entry's debounced live preview looks up a
 * factor and stores nothing, so it is admitted as a read — the READ quota and
 * no mutation permit. With one, it held the user's single permit
 * (`MUTATION_USER_CONCURRENCY`), and a Save or Submit pressed while it ran was
 * refused 429; it also held one of the API-wide permits every write needs. */
const READ_ONLY_POSTS = new Set(['/api/v1/calculations/preview']);

export type RouteGroup = 'READ' | 'WRITE' | 'IMPORT' | 'EXPORT' | 'SUBMIT';
export const routeGroup = (method: string, path: string): RouteGroup => {
  const route = path.split('?')[0].toLowerCase().replace(/\/+$/, '');
  if (method === 'POST' && route === '/api/v1/bulk-upload/activity-records') return 'IMPORT';
  if (method === 'POST' && (route === '/api/v1/activity-records/bulk-submit'
    || /^\/api\/v1\/import-batches\/[^/]+\/submit$/.test(route))) return 'SUBMIT';
  if (['GET', 'HEAD'].includes(method) && EXPORT_PATHS.has(route)) return 'EXPORT';
  if (method === 'POST' && route === REPORT_DATASETS_ROUTE) return 'EXPORT';
  if (['GET', 'HEAD'].includes(method) && REPORT_DATASET_ROUTE.test(route)) return 'EXPORT';
  if (method === 'POST' && route === REPORT_ISSUANCES_ROUTE) return 'EXPORT';
  if (['GET', 'HEAD'].includes(method) && REPORT_ISSUANCE_PDF_ROUTE.test(route)) return 'EXPORT';
  if (method === 'POST' && READ_ONLY_POSTS.has(route)) return 'READ';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'READ' : 'WRITE';
};

/**
 * LP3-04's whole-subsidiary PUT (E1; write-path contract follow-up (4)): one
 * subsidiary's declaration is one body, so its cap is its own — 1 MB, which
 * holds the DTOs' limits (500 sites, 2,000 sources) at ordinary lengths —
 * set here in code, never by an environment value (owner, 2026-10-15). Only
 * `super_admin` writes there, but a JSON body is read and parsed before
 * authentication — so any client can make the API parse up to this much on
 * this one path, bounded by the per-IP in-flight and rate quotas (multipart
 * alone waits for authentication). Every other route keeps `BODY_MAX_BYTES`.
 */
export const INVENTORY_DECLARATION_BODY_MAX_BYTES = 1_048_576;
const INVENTORY_DECLARATION_ROUTE = /^\/api\/v1\/inventory-boundaries\/[^/]+\/subsidiaries\/[^/]+$/;

/** Is this LP3-04's declaration PUT — normalised as `routeGroup` normalises? */
export const isInventoryDeclarationPut = (method: string, path: string): boolean =>
  method === 'PUT' && INVENTORY_DECLARATION_ROUTE.test(path.split('?')[0].toLowerCase().replace(/\/+$/, ''));

/** A non-multipart body's cap on this route. */
export const jsonBodyLimit = (method: string, path: string, global: number): number =>
  isInventoryDeclarationPut(method, path) ? INVENTORY_DECLARATION_BODY_MAX_BYTES : global;

@Injectable()
export class RuntimeLimits implements OnApplicationShutdown {
  stopping = false;
  readonly config: RuntimeConfig;
  private readonly rates = new ThrottlerStorageService();
  private readonly active = new Map<string, number>();
  constructor() { this.config = readRuntimeConfig(); }

  async quota(key: string, limit: number): Promise<void> {
    // The public storage accessor is used only for admission, never to mutate
    // library counters/timers. A full map cannot evict a still-limited caller.
    if (!this.rates.storage.has(key) && this.rates.storage.size >= this.config.RATE_MAX_KEYS) {
      throw new CapacityError(60);
    }
    const result = await this.rates.increment(key, 60_000, limit, 60_000, 'runtime');
    if (result.isBlocked) throw new CapacityError(Math.max(1, result.timeToBlockExpire));
  }

  acquire(key: string, maximum: number): () => void {
    const count = this.active.get(key) ?? 0;
    if (count >= maximum) throw new CapacityError();
    this.active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(key) ?? 1) - 1;
      if (next) this.active.set(key, next); else this.active.delete(key);
    };
  }

  async settle(): Promise<void> {
    this.stopping = true;
    const until = Date.now() + this.config.SHUTDOWN_GRACE_MS - 5_000;
    while (this.active.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  onApplicationShutdown(): void { this.rates.onApplicationShutdown(); }
}
