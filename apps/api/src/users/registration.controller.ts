import { Body, CanActivate, Controller, Get, HttpCode, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { RegistrationStatus } from '@tonyai/shared-types';
import { Public } from '../auth/public.decorator';
import { ResourceNotFoundError } from '../common/api-error';
import { RegistrationDto } from './dto/users.dto';
import { RegistrationService } from './registration.service';

/** 404 `registration_unavailable` while no registration code is configured —
 *  as a guard, so it answers before the body is validated: a switched-off
 *  environment says nothing else about the endpoint. */
@Injectable()
export class RegistrationEnabledGuard implements CanActivate {
  constructor(private readonly registrations: RegistrationService) {}

  canActivate(): boolean {
    if (!this.registrations.enabled) throw new ResourceNotFoundError('registration_unavailable');
    return true;
  }
}

/** Self-service registration (owner decisions 2026-11-11). */
@Controller('auth/registration')
@UseGuards(RegistrationEnabledGuard)
export class RegistrationController {
  constructor(private readonly registrations: RegistrationService) {}

  /** Public: the notice version the form must show and send back. */
  @Public()
  @Get()
  status(): RegistrationStatus {
    return this.registrations.status();
  }

  /**
   * Public, behind the registration code. 202 with no body for every address
   * once the code is right — new, invited or active — and the work runs after
   * the response. 403 `registration_code_invalid` on a wrong code; 429 past
   * the per-client-address quota, which wrong codes spend too.
   */
  @Public()
  @Post()
  @HttpCode(202)
  async register(@Req() req: Request, @Body() dto: RegistrationDto): Promise<void> {
    // `req.ip` follows the configured proxy trust boundary only (runtime-http.ts).
    await this.registrations.request(req.ip ?? req.socket.remoteAddress ?? 'unknown', dto);
  }
}
