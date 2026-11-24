import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { summariseCspReports } from './csp-report';

/**
 * The web's CSP violation reports (`web-response-security`;
 * `pre-g5-security-hardening`). Public, 204 whatever the body. Its own
 * per-address quota, its media types and its 16 KiB cap are enforced at
 * admission (`runtime-http.ts`), before the body is read and apart from the
 * address's application budget. Each report becomes one structured warning in
 * the logs — directive, blocked origin, page path, disposition — and nothing
 * is stored. The body arrives as text.
 */
@Controller('security')
export class SecurityReportsController {
  private readonly logger = new Logger('CspReport');

  @Public()
  @Post('csp-reports')
  @HttpCode(204)
  receive(@Req() req: Request): void {
    for (const report of summariseCspReports(req.body)) {
      this.logger.warn(JSON.stringify({ event: 'csp_violation', ...report }));
    }
  }
}
