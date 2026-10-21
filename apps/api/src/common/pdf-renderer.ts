import { Injectable, OnModuleDestroy } from '@nestjs/common';
import puppeteer, { TimeoutError, type Browser, type Page } from 'puppeteer';
import { QueryTooBroadError } from './api-error';
import { readRuntimeConfig } from './runtime-config';
import { CapacityError } from './runtime-limits';

/** One printed PDF, and the browser that printed it (`Browser.version()`). */
export interface RenderedPdf {
  bytes: Buffer;
  engine: string;
}

/**
 * The replica's one PDF renderer — the report exports' (`ReportsService`) and
 * the issuances' (LP3-04 PR D) — moved out of `ReportsService` into `common/`
 * (`reports/` is a sink) so both share ONE Chromium, provided once by
 * `PdfRendererModule`, and its one-at-a-time ownership: cancelling a render kills the
 * shared process, so a second render while one runs is refused (429), whatever
 * `REPORT_CONCURRENCY` allows the CSV and Excel exports.
 *
 * The page is an API-built HTML string (`page.setContent`), never a web route.
 * A render that outlives `PDF_TIMEOUT_MS`, or prints more than
 * `REPORT_MAX_BYTES`, is refused (422); a timed-out one kills the browser,
 * which the next render relaunches.
 */
@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private readonly limits = readRuntimeConfig();
  private active = false;
  // Memoized launch promise: two concurrent first requests must share ONE
  // Chromium instance (a naive null-check race would leak the loser).
  private browserPromise: Promise<Browser> | null = null;

  async onModuleDestroy(): Promise<void> {
    const browser = await this.browserPromise?.catch(() => null);
    await browser?.close();
    this.browserPromise = null;
  }

  async render(html: string): Promise<RenderedPdf> {
    // Cancellation kills the shared Chromium process. Keep its ownership
    // exclusive even when operators allow concurrent CSV/Excel exports.
    if (this.active) throw new CapacityError();
    this.active = true;
    try { return await this.print(html); }
    finally { this.active = false; }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browserPromise) {
      const existing = await this.browserPromise.catch(() => null);
      if (existing?.connected) return existing;
    }
    this.browserPromise = puppeteer.launch({
      headless: true,
      timeout: this.limits.PDF_TIMEOUT_MS,
      protocolTimeout: this.limits.PDF_TIMEOUT_MS,
      // In containers we use the distro Chromium (PUPPETEER_EXECUTABLE_PATH);
      // locally the var is unset and Puppeteer falls back to its bundled Chrome.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    return this.browserPromise;
  }

  private killBrowser(browser?: Browser): void {
    const child = browser?.process();
    if (!child) return;
    try {
      if (process.platform === 'win32' || !child.pid) child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch { child.kill('SIGKILL'); }
  }

  private async print(html: string): Promise<RenderedPdf> {
    let browser: Browser | undefined;
    let page: Page | undefined;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      // This replica admits one renderer. Killing its process aborts protocol
      // work too, including a stuck newPage/print command; no detached render.
      this.killBrowser(browser);
    }, this.limits.PDF_TIMEOUT_MS);
    timer.unref();
    try {
      browser = await this.getBrowser();
      if (expired) throw new QueryTooBroadError();
      const engine = await browser.version();
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: this.limits.PDF_TIMEOUT_MS });
      const stream = await page.createPDFStream({
        timeout: this.limits.PDF_TIMEOUT_MS,
        format: 'A4', printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = stream.getReader();
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > this.limits.REPORT_MAX_BYTES) throw new QueryTooBroadError();
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (expired) throw new QueryTooBroadError();
      clearTimeout(timer);
      return { bytes: Buffer.concat(chunks), engine };
    } catch (error) {
      if (expired || error instanceof TimeoutError) throw new QueryTooBroadError();
      throw error;
    } finally {
      clearTimeout(timer);
      if (expired && browser) {
        this.killBrowser(browser);
        this.browserPromise = null;
      }
      await page?.close().catch(() => undefined);
    }
  }
}
