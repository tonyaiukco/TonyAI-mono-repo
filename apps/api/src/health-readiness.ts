import type { PrismaService } from './prisma/prisma.service';

const TIMEOUT_MS = 2_000;
const CACHE_MS = 5_000;

/** Process-local single flight: public polling cannot accumulate DB work. */
export class HealthReadiness {
  private pending?: Promise<boolean>;
  private cached?: { ready: boolean; until: number };

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<boolean> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.ready;
    // Keep the underlying single flight even if the response deadline wins.
    // A stuck driver must not cause a new query on every probe request.
    this.pending ??= this.probe().finally(() => { this.pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([
        this.pending,
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
