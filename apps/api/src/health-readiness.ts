import type { PrismaService } from './prisma/prisma.service';

const TIMEOUT_MS = 2_000;
const CACHE_MS = 5_000;
const FLIGHT_MAX_AGE_MS = 10_000;
const MAX_OUTSTANDING = 2;
type Flight = { started: number; result: Promise<boolean> };

/** Coalesce probes; allow one recovery flight while bounding stalled DB work. */
export class HealthReadiness {
  private pending?: Flight;
  private outstanding = new Set<Flight>();
  private cached?: { ready: boolean; until: number };

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<boolean> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.ready;
    if (this.pending && Date.now() - this.pending.started >= FLIGHT_MAX_AGE_MS) {
      this.pending = undefined;
    }
    if (!this.pending) {
      if (this.outstanding.size >= MAX_OUTSTANDING) return false;
      const flight: Flight = { started: Date.now(), result: this.probe() };
      this.pending = flight;
      this.outstanding.add(flight);
      void flight.result.finally(() => {
        this.outstanding.delete(flight);
        if (this.pending === flight) this.pending = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        this.pending.result,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2_500); }),
      ]);
      this.cached = { ready, until: Date.now() + CACHE_MS };
      return ready;
    } finally {
      clearTimeout(timer);
    }
  }

  private async probe(): Promise<boolean> {
    const results = await Promise.allSettled([this.database(), this.storage()]);
    return results.every((result) => result.status === 'fulfilled');
  }

  private async database(): Promise<void> {
    // Neither ownership, catalogue access nor tenant-table grants are required.
    // Transaction timeout bounds execution; maxWait bounds pool acquisition.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '1000', true)`;
      await tx.$queryRaw`SELECT 1`;
    }, { maxWait: 500, timeout: 1_500 });
  }

  private async storage(): Promise<void> {
    const origin = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!origin || !key) throw new Error('Storage configuration unavailable');
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    await Promise.all(['evidence', 'import-sources'].map(async (bucket) => {
      const response = await fetch(`${origin.replace(/\/$/, '')}/storage/v1/bucket/${bucket}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Storage unavailable');
      }
      const metadata = await response.json() as { id?: string; public?: boolean };
      if (metadata.id !== bucket || metadata.public !== false) throw new Error('Storage bucket unavailable');
    }));
  }
}
