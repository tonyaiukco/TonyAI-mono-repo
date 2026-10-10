import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { PasswordResetDto } from './dto/users.dto';
import { PasswordResetService } from './password-reset.service';

/** "Forgot password" (LP4-01, K5). */
@Controller('auth')
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  /**
   * Public, and 202 for every address — known or not, enabled or not, inside
   * its cooldown or not; the work runs after the response. 429 past the
   * per-client-address quota.
   */
  @Public()
  @Post('password-reset')
  @HttpCode(202)
  async request(@Req() req: Request, @Body() dto: PasswordResetDto): Promise<void> {
    // `req.ip` follows the configured proxy trust boundary only (runtime-http.ts).
    await this.resets.request(req.ip ?? req.socket.remoteAddress ?? 'unknown', dto.email);
  }
}
